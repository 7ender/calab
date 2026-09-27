import { describe, expect, it } from 'vitest';
import { AnnotScene, MAX_STROKES, POINTER_TTL_MS, STROKE_TTL_MS, fadeAlpha, type SceneEvent } from './scene';

const ev = (p: Partial<SceneEvent>): SceneEvent => ({ from: 'u1:s1', name: 'Анна', kind: 'stroke', color: 0xff0000, points: [], strokeId: 1, strokeEnd: false, owner: false, ...p });

describe('annot scene', () => {
  it('fades alpha linearly over the last part of the lifetime', () => {
    expect(fadeAlpha(0, 1000, 250)).toBe(1);
    expect(fadeAlpha(750, 1000, 250)).toBe(1);
    expect(fadeAlpha(875, 1000, 250)).toBeCloseTo(0.5);
    expect(fadeAlpha(1000, 1000, 250)).toBe(0);
  });

  it('a pointer shows the name and is gone 1 s after its last message', () => {
    const s = new AnnotScene();
    s.apply(ev({ kind: 'pointer', points: [0.5, 0.5] }), 0);
    s.apply(ev({ kind: 'pointer', points: [0.6, 0.5] }), 500);
    expect(s.visiblePointers(600)).toMatchObject([{ name: 'Анна', x: 0.6, alpha: 1 }]);
    expect(s.visiblePointers(500 + POINTER_TTL_MS - 100)[0]?.alpha).toBeLessThan(1);
    expect(s.prune(500 + POINTER_TTL_MS)).toBe(false);
    expect(s.visiblePointers(500 + POINTER_TTL_MS)).toEqual([]);
  });

  it('joins the batches of one stroke and fades it 5 s after its last point', () => {
    const s = new AnnotScene();
    s.apply(ev({ points: [0.1, 0.1, 0.2, 0.2] }), 0);
    s.apply(ev({ points: [0.3, 0.3] }), 100);
    s.apply(ev({ points: [], strokeEnd: true }), 150);
    s.apply(ev({ strokeId: 2, points: [0.9, 0.9] }), 200);
    const strokes = s.visibleStrokes(300);
    expect(strokes.map((x) => x.points)).toEqual([[0.1, 0.1, 0.2, 0.2, 0.3, 0.3], [0.9, 0.9]]);
    expect(s.visibleStrokes(100 + STROKE_TTL_MS - 500)[0]?.alpha).toBeCloseTo(0.5);
    expect(s.prune(100 + STROKE_TTL_MS)).toBe(true); // the second stroke is younger
    expect(s.prune(200 + STROKE_TTL_MS)).toBe(false);
  });

  it('an ended stroke is not continued by a late batch with the same id', () => {
    const s = new AnnotScene();
    s.apply(ev({ points: [0.1, 0.1], strokeEnd: true }), 0);
    s.apply(ev({ points: [0.2, 0.2] }), 10);
    expect(s.visibleStrokes(20)).toHaveLength(2);
  });

  it("a viewer's clear erases only their strokes, the presenter's — everything", () => {
    const s = new AnnotScene();
    s.apply(ev({ from: 'a', points: [0.1, 0.1] }), 0);
    s.apply(ev({ from: 'b', points: [0.2, 0.2] }), 0);
    s.apply(ev({ from: 'b', kind: 'pointer', points: [0.2, 0.2] }), 0);
    s.apply(ev({ from: 'a', kind: 'clear' }), 1);
    expect(s.visibleStrokes(2).map((x) => x.from)).toEqual(['b']);
    s.apply(ev({ from: 'owner', kind: 'clear', owner: true }), 3);
    expect(s.empty).toBe(true);
  });

  it('forgets a participant who left', () => {
    const s = new AnnotScene();
    s.apply(ev({ from: 'a', points: [0.1, 0.1] }), 0);
    s.apply(ev({ from: 'a', kind: 'pointer', points: [0.1, 0.1] }), 0);
    s.forget('a');
    expect(s.empty).toBe(true);
  });

  it('bounds memory against a flood', () => {
    const s = new AnnotScene();
    for (let i = 0; i < MAX_STROKES + 50; i++) s.apply(ev({ strokeId: i + 1, points: [0.5, 0.5], strokeEnd: true }), 0);
    expect(s.visibleStrokes(1)).toHaveLength(MAX_STROKES);
  });
});
