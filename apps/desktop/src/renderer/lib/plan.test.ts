import { Plan, PlanLimitsSchema, ScreenSharePreset } from '@calaba/protocol';
import { create } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, toApiError } from './api/client';
import {
  FREE_LIMITS,
  allowedCameraPreset,
  allowedStreamPreset,
  cameraPresetLock,
  capFps,
  contactHref,
  limitsFormFrom,
  limitsFromForm,
  planErrorNotice,
  planUsage,
  setPlanBody,
  streamPresetLock,
  validUntilFromInput,
  videoLimitText,
} from './plan';

vi.mock('../platform', () => ({ platform: { kind: 'web' } }));

const { ECONOMY, H720, H1080, ORIGINAL, UNSPECIFIED } = ScreenSharePreset;

describe('preset locks (ADR-0024)', () => {
  it('room lock wins over the plan; UNSPECIFIED plan = no limit', () => {
    expect(streamPresetLock(H1080, H1080, H720)).toBe('plan');
    expect(streamPresetLock(ORIGINAL, H1080, H720)).toBe('room');
    expect(streamPresetLock(H720, H1080, H720)).toBeNull();
    expect(streamPresetLock(ORIGINAL, ORIGINAL, UNSPECIFIED)).toBeNull();
    expect(streamPresetLock(ORIGINAL, ORIGINAL, undefined)).toBeNull();
  });

  it('the picked preset falls to the highest allowed one', () => {
    expect(allowedStreamPreset(H1080, H1080, H720)).toBe(H720);
    expect(allowedStreamPreset(ORIGINAL, ORIGINAL, ECONOMY)).toBe(ECONOMY);
    expect(allowedStreamPreset(H1080, ORIGINAL, UNSPECIFIED)).toBe(H1080);
  });

  it('camera: 1080p locked on free, allowed on team', () => {
    expect(cameraPresetLock(H1080, H720)).toBe('plan');
    expect(cameraPresetLock(H720, H720)).toBeNull();
    expect(cameraPresetLock(H1080, UNSPECIFIED)).toBeNull();
    expect(allowedCameraPreset(H1080, H720)).toBe(H720);
    expect(allowedCameraPreset(H1080, H1080)).toBe(H1080);
  });

  it('fps never above the granted one; 0 = no cap', () => {
    expect(capFps(30, 15)).toBe(15);
    expect(capFps(5, 15)).toBe(5);
    expect(capFps(30, 0)).toBe(30);
    expect(capFps(30, undefined)).toBe(30);
  });

  it('limit texts', () => {
    expect(videoLimitText(H720, 15)).toBe('720p · 15 fps');
    expect(videoLimitText(UNSPECIFIED, 0)).toBe('Без ограничений');
  });
});

describe('plan contact', () => {
  it('only mailto: and http(s)', () => {
    expect(contactHref('mailto:it@gptunnel.ai')).toBe('mailto:it@gptunnel.ai');
    expect(contactHref(' https://calab.ru/buy ')).toBe('https://calab.ru/buy');
    expect(contactHref('javascript:alert(1)')).toBeNull();
    expect(contactHref('file:///etc/passwd')).toBeNull();
    expect(contactHref('')).toBeNull();
  });
});

describe('toApiError: plan fields', () => {
  it('reads reason / used / limit (uint64 as strings)', async () => {
    const res = new Response(JSON.stringify({ code: 'ERROR_CODE_ROOM_FULL', message: 'full', reason: 'PLAN_LIMIT', used: '5', limit: '5' }), { status: 409 });
    const e = await toApiError(res);
    expect(e.reason).toBe('PLAN_LIMIT');
    expect(e.extra).toEqual({ reason: 'PLAN_LIMIT', used: 5, limit: 5 });
    const plain = await toApiError(new Response(JSON.stringify({ code: 'ERROR_CODE_CONFLICT', message: 'x' }), { status: 409 }));
    expect(plain.extra).toEqual({});
  });
});

describe('planErrorNotice (toasts on API errors)', () => {
  const roomFull = new ApiError('ERROR_CODE_ROOM_FULL', 'full', 409, undefined, { reason: 'PLAN_LIMIT', used: 5, limit: 5 });

  it('409 ROOM_FULL PLAN_LIMIT → «до N человек» with contact; wording by plan', () => {
    expect(planErrorNotice(roomFull, Plan.FREE)).toEqual({ text: 'В бесплатном тарифе до 5 человек в комнате', contact: true });
    expect(planErrorNotice(roomFull, Plan.CUSTOM)?.text).toBe('По тарифу пространства — до 5 человек в комнате');
  });

  it('a room over its own user limit is not a plan matter', () => {
    expect(planErrorNotice(new ApiError('ERROR_CODE_ROOM_FULL', 'full', 409), Plan.FREE)).toBeNull();
    expect(planErrorNotice(new Error('x'), Plan.FREE)).toBeNull();
  });

  it('413 quota → usage; contact only when the plan is the cause', () => {
    const mb = 1024 * 1024;
    const byPlan = new ApiError('ERROR_CODE_FILE_QUOTA_EXCEEDED', 'quota', 413, undefined, { reason: 'PLAN_LIMIT', used: 900 * mb, limit: 1024 * mb });
    expect(planErrorNotice(byPlan, Plan.FREE)).toEqual({ text: 'Хранилище файлов заполнено: 900,0 МБ из 1,00 ГБ', contact: true });
    const own = new ApiError('ERROR_CODE_FILE_QUOTA_EXCEEDED', 'quota', 413);
    expect(planErrorNotice(own, Plan.TEAM)).toEqual({ text: 'Хранилище файлов пространства заполнено', contact: false });
  });
});

describe('admin CUSTOM form', () => {
  it('starts from the free limits unless the workspace is custom already', () => {
    const f = limitsFormFrom(Plan.FREE, undefined);
    expect(f.roomMembers).toBe(String(FREE_LIMITS.roomMembers));
    expect(f.storageMb).toBe('1024');
    expect(f.streamMaxPreset).toBe(H720);
    const custom = create(PlanLimitsSchema, { roomMembers: 12, storageMb: 5120n, streamMaxPreset: H1080 });
    expect(limitsFormFrom(Plan.CUSTOM, custom)).toMatchObject({ roomMembers: '12', storageMb: '5120', streamMaxPreset: H1080, cameraMaxFps: '0' });
    // Team → Custom: the free defaults, not Team's.
    expect(limitsFormFrom(Plan.TEAM, custom).roomMembers).toBe('5');
  });

  it('validates whole numbers ≥ 0 (empty = 0 = no limit)', () => {
    const f = limitsFormFrom(Plan.FREE, undefined);
    expect(limitsFromForm({ ...f, roomMembers: '' })).toMatchObject({ limits: { roomMembers: 0 } });
    expect(limitsFromForm({ ...f, streamMaxFps: '2.5' })).toEqual({ error: 'streamMaxFps' });
    expect(limitsFromForm({ ...f, members: '-1' })).toEqual({ error: 'members' });
    expect(limitsFromForm(f)).toMatchObject({ limits: { storageMb: 1024n, cameraMaxPreset: H720 } });
  });

  it('PUT body: limits only with CUSTOM, end of the chosen day, trimmed note', () => {
    const limits = limitsFormFrom(Plan.FREE, undefined);
    const team = setPlanBody({ plan: Plan.TEAM, limits, validUntil: '2026-12-31', note: '  счёт 42 ' });
    expect(team).toEqual({ body: { plan: Plan.TEAM, validUntil: new Date('2026-12-31T23:59:59Z'), note: 'счёт 42' } });
    const custom = setPlanBody({ plan: Plan.CUSTOM, limits: { ...limits, roomMembers: '10' }, validUntil: '', note: '' });
    expect('body' in custom && custom.body.limits?.roomMembers).toBe(10);
    expect('body' in custom ? custom.body.validUntil : null).toBeUndefined();
    expect(setPlanBody({ plan: Plan.CUSTOM, limits: { ...limits, storageMb: 'x' }, validUntil: '', note: '' })).toEqual({ error: 'storageMb' });
    expect(validUntilFromInput('garbage')).toBeNull();
  });
});

describe('planUsage', () => {
  it('fullest room, most streams in one room, members without guests', () => {
    const voice = [
      { roomId: 'a', streaming: true },
      { roomId: 'a', streaming: false },
      { roomId: 'b', streaming: true },
      { roomId: 'b', streaming: true },
      { roomId: 'b', streaming: false },
      { roomId: '', streaming: false },
    ];
    expect(planUsage(voice, [{ guest: false }, { guest: true }, { guest: false }])).toEqual({ roomPeak: 3, streamPeak: 2, members: 2 });
    expect(planUsage([], [])).toEqual({ roomPeak: 0, streamPeak: 0, members: 0 });
  });
});
