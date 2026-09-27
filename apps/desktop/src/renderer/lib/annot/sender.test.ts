import { describe, expect, it } from 'vitest';
import { MAX_POINTS } from './codec';
import { SEND_INTERVAL_MS } from './limits';
import { AnnotSender, type Clock, type OutMessage } from './sender';

/** A manual clock: timers fire on advance(). */
function fakeClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

function setup(): { sent: OutMessage[]; s: AnnotSender; clock: ReturnType<typeof fakeClock> } {
  const sent: OutMessage[] = [];
  const clock = fakeClock();
  return { sent, clock, s: new AnnotSender((m) => sent.push(m), clock) };
}

describe('annot sender', () => {
  it('sends the pointer at most every 50 ms, only its latest position', () => {
    const { sent, s, clock } = setup();
    // 1 s of a mouse at ~250 Hz.
    for (let t = 0; t < 1000; t += 4) {
      s.movePointer('TR_1', 0xff0000, (t % 100) / 100, 0.5);
      clock.advance(4);
    }
    clock.advance(100);
    expect(sent.length).toBeLessThanOrEqual(1000 / SEND_INTERVAL_MS + 1);
    expect(sent.length).toBeGreaterThanOrEqual(1000 / SEND_INTERVAL_MS - 1);
    expect(sent.every((m) => m.kind === 'pointer' && m.points.length === 2)).toBe(true);
  });

  it('batches a stroke, thins it, splits over 60 points and ends it', () => {
    const { sent, s, clock } = setup();
    s.startStroke('TR_1', 0x00ff00, 0, 0);
    for (let i = 1; i <= 150; i++) s.moveStroke(i / 200, 0.5);
    s.moveStroke(150 / 200 + 0.0005, 0.5); // too close: dropped
    s.endStroke();
    clock.advance(1000);
    expect(sent.every((m) => m.kind === 'stroke' && m.points.length <= MAX_POINTS * 2)).toBe(true);
    const ids = new Set(sent.map((m) => m.strokeId));
    expect(ids.size).toBe(1);
    expect(sent.flatMap((m) => m.points)).toHaveLength(151 * 2);
    expect(sent.at(-1)?.strokeEnd).toBe(true);
    expect(sent.filter((m) => m.strokeEnd)).toHaveLength(1);
    // Batches were spaced by the send interval.
    expect(sent.length).toBe(3);
  });

  it('a new stroke gets a new id and flushes the previous one first', () => {
    const { sent, s, clock } = setup();
    s.startStroke('TR_1', 1, 0.1, 0.1);
    s.moveStroke(0.2, 0.2);
    s.startStroke('TR_1', 1, 0.5, 0.5);
    clock.advance(200);
    expect(sent[0]).toMatchObject({ points: [0.1, 0.1, 0.2, 0.2], strokeEnd: true });
    expect(sent[1]?.strokeId).not.toBe(sent[0]?.strokeId);
  });

  it('clear goes out at once, after what was pending', () => {
    const { sent, s } = setup();
    s.startStroke('TR_1', 1, 0.1, 0.1);
    s.clear('TR_1', 1);
    expect(sent.map((m) => m.kind)).toEqual(['stroke', 'clear']);
  });

  it('reset drops pending points', () => {
    const { sent, s, clock } = setup();
    s.movePointer('TR_1', 1, 0.1, 0.1);
    clock.advance(0);
    s.movePointer('TR_1', 1, 0.2, 0.2);
    s.reset();
    clock.advance(500);
    expect(sent).toHaveLength(1);
  });
});
