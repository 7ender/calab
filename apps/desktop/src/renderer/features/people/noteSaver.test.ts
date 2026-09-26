import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTE_DEBOUNCE_MS, createNoteSaver, type NoteSaveState } from './noteSaver';

describe('note autosave (docs/09 #20)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (initial = '', save = vi.fn((text: string) => Promise.resolve(text))) => {
    const states: NoteSaveState[] = [];
    const s = createNoteSaver({ initial, save, onState: (x) => states.push(x) });
    return { s, save, states };
  };

  it('saves once, 800 ms after the last keystroke', async () => {
    const { s, save, states } = setup();
    s.change('З');
    await vi.advanceTimersByTimeAsync(500);
    s.change('Зн');
    await vi.advanceTimersByTimeAsync(500);
    s.change('Знает Go');
    await vi.advanceTimersByTimeAsync(NOTE_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledExactlyOnceWith('Знает Go');
    expect(states).toEqual(['pending', 'saving', 'saved']);
  });

  it('does not save an unchanged text (whitespace only differences included)', async () => {
    const { s, save } = setup('тимлид');
    s.change('тимлид ');
    await vi.advanceTimersByTimeAsync(2000);
    await s.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('flush saves at once (blur, closing the dialog); clearing the text deletes the note', async () => {
    const { s, save } = setup('старое');
    s.change('');
    await s.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith('');
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('one request at a time: an edit during a save is saved after it, newest last', async () => {
    let release!: () => void;
    const save = vi.fn((text: string) => (text === 'a' ? new Promise<string>((r) => (release = () => r(text))) : Promise.resolve(text)));
    const { s } = setup('', save);
    s.change('a');
    await vi.advanceTimersByTimeAsync(NOTE_DEBOUNCE_MS);
    s.change('ab');
    await vi.advanceTimersByTimeAsync(NOTE_DEBOUNCE_MS * 3);
    expect(save.mock.calls.map((c) => c[0])).toEqual(['a']); // still in flight
    release();
    await vi.advanceTimersByTimeAsync(NOTE_DEBOUNCE_MS);
    expect(save.mock.calls.map((c) => c[0])).toEqual(['a', 'ab']);
    expect(s.state).toBe('saved');
  });

  it('a failed save shows the error and is retried by the next edit', async () => {
    const save = vi.fn((_: string): Promise<string> => Promise.reject(new Error('503')));
    const { s } = setup('', save);
    s.change('x');
    await vi.advanceTimersByTimeAsync(NOTE_DEBOUNCE_MS);
    expect(s.state).toBe('error');
    save.mockImplementation((t: string) => Promise.resolve(t));
    s.change('xy');
    await vi.advanceTimersByTimeAsync(NOTE_DEBOUNCE_MS);
    expect(save).toHaveBeenLastCalledWith('xy');
    expect(s.state).toBe('saved');
  });

  it('dispose stops a pending save', async () => {
    const { s, save } = setup();
    s.change('x');
    s.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).not.toHaveBeenCalled();
  });
});
