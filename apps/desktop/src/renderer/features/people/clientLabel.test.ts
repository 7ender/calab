import { describe, expect, it } from 'vitest';
import { clientLabel } from './clientLabel';

describe('clientLabel (docs/09 #143)', () => {
  it('desktop: version and OS name', () => {
    expect(clientLabel('darwin', '1.1.0')).toEqual({ text: 'Calab 1.1.0 · macOS', web: false });
    expect(clientLabel('win32', '1.0.0')).toEqual({ text: 'Calab 1.0.0 · Windows', web: false });
    expect(clientLabel('linux', '1.1.0')).toEqual({ text: 'Calab 1.1.0 · Linux', web: false });
  });
  it('web: version with the web tag', () => {
    expect(clientLabel('web', '1.1.0')).toEqual({ text: 'Calab 1.1.0', web: true });
  });
  it('partly unknown: what is known', () => {
    expect(clientLabel('darwin', '')).toEqual({ text: 'Calab · macOS', web: false });
    expect(clientLabel('', '1.1.0')).toEqual({ text: 'Calab 1.1.0', web: false });
    expect(clientLabel('haiku', '1.1.0')).toEqual({ text: 'Calab 1.1.0', web: false });
  });
  it('unknown: nothing', () => {
    expect(clientLabel('', '')).toBeNull();
    expect(clientLabel(undefined, undefined)).toBeNull();
    expect(clientLabel('haiku', ' ')).toBeNull();
  });
});
