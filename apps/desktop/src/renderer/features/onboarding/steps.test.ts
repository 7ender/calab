import { describe, expect, it } from 'vitest';
import { micStateAfterRequest, micStateOnArrival, nextStep, onboardingSteps, prevStep, resolveStep } from './steps';

const base = { verify: false, mac: false, hasWorkspace: true, invited: false };

describe('onboarding steps (docs/09 #36)', () => {
  it('settings come before the workspace; no language step', () => {
    expect(onboardingSteps({ verify: true, mac: true, hasWorkspace: false, invited: false })).toEqual([
      'verify',
      'mic',
      'screen',
      'notifications',
      'mode',
      'join',
      'done',
    ]);
  });

  it('skips what does not apply', () => {
    expect(onboardingSteps(base)).toEqual(['mic', 'notifications', 'mode', 'done']);
    // macOS desktop only: the screen step.
    expect(onboardingSteps({ ...base, mac: true })).toContain('screen');
    // Already a member of a workspace: no join step.
    expect(onboardingSteps({ ...base, hasWorkspace: true })).not.toContain('join');
    // Signed up by an invitation (link or emailed code): joined, or joins on confirming — no join step.
    expect(onboardingSteps({ ...base, verify: true, hasWorkspace: false, invited: true })).toEqual(['verify', 'mic', 'notifications', 'mode', 'done']);
    // No workspace, no invitation: join is the last step before «Готово».
    const s = onboardingSteps({ ...base, hasWorkspace: false });
    expect(s.slice(-2)).toEqual(['join', 'done']);
  });

  it('resumes the saved step after a relaunch', () => {
    const steps = onboardingSteps({ ...base, verify: true, mac: true });
    expect(resolveStep(steps, 'screen')).toBe('screen');
    expect(resolveStep(steps, 'mode')).toBe('mode');
    // Nothing saved / garbage (e.g. the removed language step): from the start.
    expect(resolveStep(steps, '')).toBe('verify');
    expect(resolveStep(steps, null)).toBe('verify');
    expect(resolveStep(steps, 'lang')).toBe('verify');
  });

  it('a step that left the run moves forward, never back', () => {
    // Confirmed on another device → no verify step: on to the microphone.
    expect(resolveStep(onboardingSteps(base), 'verify')).toBe('mic');
    // The join step, and WORKSPACE_CREATE arrives (verified an emailed invitation): «Готово».
    expect(resolveStep(onboardingSteps(base), 'join')).toBe('done');
    // A screen step saved on a Mac build, resumed elsewhere: the next step.
    expect(resolveStep(onboardingSteps(base), 'screen')).toBe('notifications');
  });

  it('next / back walk the run', () => {
    const steps = onboardingSteps({ ...base, hasWorkspace: false });
    expect(nextStep(steps, 'mode')).toBe('join');
    expect(nextStep(steps, 'done')).toBeNull();
    expect(prevStep(steps, 'mic')).toBeNull();
    expect(prevStep(steps, 'notifications')).toBe('mic');
  });
});

describe('microphone step', () => {
  it('a grant goes straight on to the check — no relaunch state exists', () => {
    expect(micStateAfterRequest(true, null)).toBe('ok');
    expect(micStateAfterRequest(false, null)).toBe('denied');
    expect(micStateAfterRequest(true, 'Device busy')).toBe('denied');
  });

  it('back after a relaunch with the access given: the check starts by itself', () => {
    expect(micStateOnArrival('granted')).toBe('granted');
    expect(micStateOnArrival('not-determined')).toBe('idle');
    expect(micStateOnArrival('denied')).toBe('idle');
    expect(micStateOnArrival(undefined)).toBe('idle');
  });
});
