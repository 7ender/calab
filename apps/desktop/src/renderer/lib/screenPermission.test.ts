import { describe, expect, it } from 'vitest';
import { screenStepState, screenStepView } from './screenPermission';

describe('onboarding screen-recording step (docs/09 P0 #3)', () => {
  it('before asking: request + open the settings, never «denied» wording', () => {
    expect(screenStepState(null, false)).toBe('loading');
    expect(screenStepState({ status: 'denied', canCapture: false }, false)).toBe('ask');
    expect(screenStepState({ status: 'not-determined', canCapture: false }, false)).toBe('ask');
    expect(screenStepView('ask')).toEqual({ note: 'hint', primary: 'request', restartInNote: false, later: true });
    expect(screenStepView('loading').primary).toBe('request');
  });
  it('back from the settings without a working grant: reopen + relaunch offered', () => {
    expect(screenStepState({ status: 'denied', canCapture: false }, true)).toBe('waiting');
    expect(screenStepView('waiting')).toEqual({ note: 'waiting', primary: 'reopen', restartInNote: true, later: true });
  });
  it('granted but this process cannot capture yet: relaunch is the primary action', () => {
    expect(screenStepState({ status: 'granted', canCapture: false }, true)).toBe('restart');
    expect(screenStepState({ status: 'granted', canCapture: false }, false)).toBe('restart');
    expect(screenStepView('restart').primary).toBe('restart');
  });
  it('granted and capture works: no relaunch button, just continue', () => {
    expect(screenStepState({ status: 'granted', canCapture: true }, true)).toBe('granted');
    expect(screenStepView('granted')).toEqual({ note: 'granted', primary: 'next', restartInNote: false, later: false });
  });
  it('restricted (MDM) and non-macOS', () => {
    expect(screenStepState({ status: 'restricted', canCapture: false }, true)).toBe('restricted');
    expect(screenStepView('restricted').primary).toBe('next');
    expect(screenStepState({ status: 'n/a', canCapture: true }, false)).toBe('granted');
  });
});
