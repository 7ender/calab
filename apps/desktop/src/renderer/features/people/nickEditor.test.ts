import { describe, expect, it, vi } from 'vitest';
import { NICK_MAX, createNickEditor, type NickEditState } from './nickEditor';

function setup(save: (n: string) => Promise<void> = () => Promise.resolve(), initial = 'Боря') {
  let stored = initial;
  const states: NickEditState[] = [];
  const saveSpy = vi.fn(async (n: string) => {
    await save(n);
    stored = n;
  });
  const ed = createNickEditor({ current: () => stored, save: saveSpy, errorText: (e) => (e instanceof Error ? e.message : 'error'), onState: (s) => states.push(s) });
  return { ed, saveSpy, states, stored: () => stored };
}

describe('inline nickname editor (docs/09 #26)', () => {
  it('start opens the field with the current nickname', () => {
    const { ed } = setup();
    ed.start();
    expect(ed.state).toEqual({ mode: 'edit', value: 'Боря', saving: false, error: null });
  });

  it('Enter saves the trimmed value and closes', async () => {
    const { ed, saveSpy, stored } = setup();
    ed.start();
    ed.change('  Борис  ');
    await ed.commit('enter');
    expect(saveSpy).toHaveBeenCalledWith('Борис');
    expect(stored()).toBe('Борис');
    expect(ed.state).toEqual({ mode: 'view' });
  });

  it('blur saves too; an unchanged value closes without a request', async () => {
    const { ed, saveSpy } = setup();
    ed.start();
    await ed.commit('blur');
    expect(saveSpy).not.toHaveBeenCalled();
    expect(ed.state.mode).toBe('view');
    ed.start();
    ed.change('');
    await ed.commit('blur');
    expect(saveSpy).toHaveBeenCalledWith(''); // empty = back to the profile name
  });

  it('Esc restores: nothing is saved', async () => {
    const { ed, saveSpy } = setup();
    ed.start();
    ed.change('Другое');
    ed.cancel();
    expect(ed.state).toEqual({ mode: 'view' });
    await ed.commit('blur'); // the blur that follows Esc
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('an error stays inline with the field open; blur does not resend, Enter retries', async () => {
    let fail = true;
    const { ed, saveSpy } = setup(() => (fail ? Promise.reject(new Error('Нет прав')) : Promise.resolve()));
    ed.start();
    ed.change('Борис');
    await ed.commit('enter');
    expect(ed.state).toEqual({ mode: 'edit', value: 'Борис', saving: false, error: 'Нет прав' });
    await ed.commit('blur');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    fail = false;
    await ed.commit('enter');
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(ed.state.mode).toBe('view');
  });

  it('one save at a time; edits and Esc are ignored while saving', async () => {
    let release: () => void = () => undefined;
    const { ed, saveSpy } = setup(() => new Promise<void>((r) => (release = r)));
    ed.start();
    ed.change('Борис');
    const p = ed.commit('enter');
    expect(ed.state).toMatchObject({ saving: true });
    void ed.commit('blur');
    ed.cancel();
    ed.change('X');
    expect(ed.state).toMatchObject({ mode: 'edit', value: 'Борис', saving: true });
    release();
    await p;
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(ed.state.mode).toBe('view');
  });

  it('caps the value at NICK_MAX', () => {
    const { ed } = setup();
    ed.start();
    ed.change('x'.repeat(NICK_MAX + 10));
    expect(ed.state.mode === 'edit' && ed.state.value.length).toBe(NICK_MAX);
  });
});
