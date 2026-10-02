import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bot, BoardFeature, EstimateScale, parseBoardWebhookEvent, signBoardWebhook, verifyBoardWebhook, type BotOptions } from '../src/index.js';
import { FakeServer, TOKEN, WS_ID } from './fake-server.js';

let srv: FakeServer;
let bots: Bot[] = [];
const fast: Partial<BotOptions> = { sleep: () => Promise.resolve() };
const newBot = (): Bot => {
  const b = new Bot(TOKEN, { server: srv.url, ...fast });
  bots.push(b);
  return b;
};

beforeEach(async () => {
  srv = new FakeServer();
  await srv.start();
});
afterEach(async () => {
  for (const b of bots) b.stop();
  bots = [];
  await srv.close();
});

describe('board webhook verification', () => {
  const secret = 'a-board-webhook-secret';
  const body = readFileSync(new URL('./board-webhook-event.json', import.meta.url), 'utf8');
  const ts = '1790000000';
  const now = 1790000000;

  it('signs as v1=HMAC-SHA256(secret, ts.body)', () => {
    const want = 'v1=' + createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
    expect(signBoardWebhook(secret, ts, body)).toBe(want);
  });

  it('accepts a valid signature inside the window, on text and bytes', () => {
    const sig = signBoardWebhook(secret, ts, body);
    expect(verifyBoardWebhook(secret, ts, body, sig, now)).toBe(true);
    expect(verifyBoardWebhook(secret, ts, new TextEncoder().encode(body), sig, now + 299)).toBe(true);
    expect(verifyBoardWebhook(secret, ts, body, sig, now - 299)).toBe(true);
  });

  it('rejects a replayed (stale or future) timestamp', () => {
    const sig = signBoardWebhook(secret, ts, body);
    expect(verifyBoardWebhook(secret, ts, body, sig, now + 301)).toBe(false);
    expect(verifyBoardWebhook(secret, ts, body, sig, now - 301)).toBe(false);
  });

  it('rejects a tampered body, wrong secret, other timestamp and missing or odd headers', () => {
    const sig = signBoardWebhook(secret, ts, body);
    expect(verifyBoardWebhook(secret, ts, body + ' ', sig, now)).toBe(false);
    expect(verifyBoardWebhook('other-secret-other-secret', ts, body, sig, now)).toBe(false);
    expect(verifyBoardWebhook(secret, '1790000001', body, sig, now)).toBe(false);
    expect(verifyBoardWebhook(secret, null, body, sig, now)).toBe(false);
    expect(verifyBoardWebhook(secret, ts, body, undefined, now)).toBe(false);
    expect(verifyBoardWebhook(secret, ts, body, 'sha256=' + sig.slice(3), now)).toBe(false);
    expect(verifyBoardWebhook(secret, 'abc', body, sig, now)).toBe(false);
    expect(verifyBoardWebhook(secret, ts, body, sig.slice(0, -2), now)).toBe(false);
  });

  it('parses the golden payload (snake_case, uint64 as string)', () => {
    const ev = parseBoardWebhookEvent(body);
    expect(ev.type).toBe('task.updated');
    expect(ev.sequence).toBe(42);
    expect(ev.board?.key).toBe('FNG');
    expect(ev.task?.key).toBe('FNG-12');
    expect(ev.task?.checklistTotal).toBe(7);
    expect(ev.taskUrl).toBe('https://app.example.com/t/FNG-12');
    expect(ev.changes[0]?.field).toBe('status');
    expect(ev.comment?.attachments[0]?.size).toBe(1024n);
  });
});

describe('boards 2.0 REST', () => {
  it('manages board categories and the board order', async () => {
    srv.route(`GET /api/workspaces/${WS_ID}/board-categories`, { json: { categories: [{ id: 'c1', workspaceId: WS_ID, name: 'Dev', position: 0 }] } });
    srv.route(`POST /api/workspaces/${WS_ID}/board-categories`, { status: 201, json: { category: { id: 'c2', name: 'Ops', position: 1 } } });
    srv.route('PATCH /api/board-categories/c2', { json: { category: { id: 'c2', name: 'Infra', position: 0 } } });
    srv.route('DELETE /api/board-categories/c2', { status: 204 });
    srv.route(`PUT /api/workspaces/${WS_ID}/boards/order`, { json: { boards: [{ id: 'b1', categoryId: 'c1' }], categories: [] } });
    const bot = newBot();
    expect((await bot.boards.categories.list(WS_ID)).map((c) => c.name)).toEqual(['Dev']);
    expect((await bot.boards.categories.create(WS_ID, 'Ops', 1)).id).toBe('c2');
    expect(srv.requests.at(-1)?.json).toEqual({ name: 'Ops', position: 1 });
    expect((await bot.boards.categories.update('c2', { name: 'Infra' })).name).toBe('Infra');
    expect(srv.requests.at(-1)?.json).toEqual({ name: 'Infra' });
    await bot.boards.categories.delete('c2');
    const o = await bot.boards.setOrder(WS_ID, { boards: [{ boardId: 'b1', categoryId: 'c1', position: 0 }] });
    expect(o.boards[0]?.categoryId).toBe('c1');
    expect(srv.requests.at(-1)?.json).toEqual({ boards: [{ boardId: 'b1', categoryId: 'c1' }] });
  });

  it('sets board features and the estimate scale', async () => {
    srv.route('PATCH /api/boards/b1', { json: { board: { id: 'b1', disabledFeatures: ['BOARD_FEATURE_ESTIMATE'], estimateScale: 'ESTIMATE_SCALE_TSHIRT' } } });
    const b = await newBot().boards.setFeatures('b1', { disabledFeatures: [BoardFeature.ESTIMATE], estimateScale: EstimateScale.TSHIRT });
    expect(b.disabledFeatures).toEqual([BoardFeature.ESTIMATE]);
    expect(srv.requests.at(-1)?.json).toEqual({
      setDisabledFeatures: true,
      disabledFeatures: ['BOARD_FEATURE_ESTIMATE'],
      estimateScale: 'ESTIMATE_SCALE_TSHIRT',
    });
    await newBot().boards.setFeatures('b1', { estimateScale: EstimateScale.LINEAR });
    expect(srv.requests.at(-1)?.json).toEqual({ estimateScale: 'ESTIMATE_SCALE_LINEAR' });
  });

  it('works with checklists and their items', async () => {
    const list = { id: 'l1', taskId: 't1', title: 'QA', items: [{ id: 'i1', text: 'Smoke', done: true }] };
    srv.route('POST /api/tasks/t1/checklists', { status: 201, json: { checklist: list, checklistTotal: 1, checklistDone: 1 } });
    srv.route('PATCH /api/checklists/l1', { json: { checklist: { ...list, title: 'Tests' }, checklistTotal: 1, checklistDone: 1 } });
    srv.route('POST /api/checklists/l1/items', { status: 201, json: { checklist: list, checklistTotal: 2, checklistDone: 1 } });
    srv.route('PATCH /api/checklist-items/i1', { json: { checklist: list, checklistTotal: 2, checklistDone: 2 } });
    srv.route('DELETE /api/checklist-items/i1', { json: { checklist: list, checklistTotal: 1, checklistDone: 0 } });
    srv.route('DELETE /api/checklists/l1', { json: { checklistTotal: 0, checklistDone: 0 } });
    srv.route('POST /api/checklist-items/i2/convert', { status: 201, json: { task: { id: 't2', key: 'FNG-13' }, checklist: list, checklistTotal: 1, checklistDone: 1 } });
    const c = newBot().tasks.checklists;
    const made = await c.create('t1', 'QA');
    expect(made.checklist?.items[0]?.text).toBe('Smoke');
    expect(srv.requests.at(-1)?.json).toEqual({ title: 'QA' });
    expect((await c.update('l1', { title: 'Tests' })).checklist?.title).toBe('Tests');
    expect((await c.addItem('l1', 'Regress')).checklistTotal).toBe(2);
    expect(srv.requests.at(-1)?.json).toEqual({ text: 'Regress' });
    expect((await c.updateItem('i1', { done: true })).checklistDone).toBe(2);
    expect(srv.requests.at(-1)?.json).toEqual({ done: true });
    expect((await c.deleteItem('i1')).checklistDone).toBe(0);
    const gone = await c.delete('l1');
    expect(gone.checklist).toBeUndefined();
    expect(gone.checklistTotal).toBe(0);
    const conv = await c.convertItem('i2');
    expect(conv.task.key).toBe('FNG-13');
  });
});
