/**
 * First-run steps (docs/08 «Онбординг», docs/09 #36, #55), pure for tests. Owner's order (27.09):
 * settings BEFORE the workspace — «Подтвердите почту» (only while unverified) → microphone →
 * screen (macOS desktop) → notifications → push-to-talk → «Присоединиться» (only without any
 * workspace and not after a sign-up by an invitation: that one already joined, or joins when
 * the address is confirmed) → «Готово». No language step: the language follows the system and is
 * changed in the settings.
 */
export type Step = 'verify' | 'mic' | 'screen' | 'notifications' | 'mode' | 'join' | 'done';

/** Every step in its place; a run shows a subsequence of it. */
export const STEP_ORDER: readonly Step[] = ['verify', 'mic', 'screen', 'notifications', 'mode', 'join', 'done'];

export interface StepInput {
  /** The account's address is not confirmed yet (not a guest). */
  verify: boolean;
  /** macOS desktop: the Screen Recording grant has a step of its own. */
  mac: boolean;
  /** The account is in at least one workspace (READY / WORKSPACE_CREATE). */
  hasWorkspace: boolean;
  /** Signed up with an invitation code on this device (link or emailed code). */
  invited: boolean;
}

export function onboardingSteps(i: StepInput): Step[] {
  return STEP_ORDER.filter((s) => {
    if (s === 'verify') return i.verify;
    if (s === 'screen') return i.mac;
    if (s === 'join') return !i.hasWorkspace && !i.invited;
    return true;
  });
}

function isStep(v: string | null | undefined): v is Step {
  return !!v && (STEP_ORDER as readonly string[]).includes(v);
}

/**
 * The step to show for `current` (e.g. the step saved before a relaunch, or the join step after a
 * WORKSPACE_CREATE removed it): itself when it is in the run, else the next one of the run in the
 * canonical order (a step that is gone never sends the user back), else the first one.
 */
export function resolveStep(steps: readonly Step[], current: string | null | undefined): Step {
  const first = steps[0] ?? 'done';
  if (!isStep(current)) return first;
  if (steps.includes(current)) return current;
  const at = STEP_ORDER.indexOf(current);
  return steps.find((s) => STEP_ORDER.indexOf(s) > at) ?? 'done';
}

/** The step after / before `current` in the run (null: none). */
export function nextStep(steps: readonly Step[], current: Step): Step | null {
  const i = steps.indexOf(current);
  return i >= 0 && i + 1 < steps.length ? (steps[i + 1] ?? null) : null;
}

export function prevStep(steps: readonly Step[], current: Step): Step | null {
  const i = steps.indexOf(current);
  return i > 0 ? (steps[i - 1] ?? null) : null;
}

export type MicState = 'idle' | 'asking' | 'ok' | 'denied';

/**
 * The microphone step after asking the OS (`askForMediaAccess` / getUserMedia): a grant applies to
 * this process at once, so the step goes on to the level check — never «перезапустите Calab»
 * (only Screen Recording may need a relaunch, see lib/screenPermission). `micError`: the capture
 * failed despite the grant (device busy / missing).
 */
export function micStateAfterRequest(granted: boolean, micError: string | null): MicState {
  return granted && !micError ? 'ok' : 'denied';
}

/** On arrival (e.g. after a relaunch): an existing grant starts the check without a click. */
export function micStateOnArrival(permission: string | null | undefined): 'idle' | 'granted' {
  return permission === 'granted' ? 'granted' : 'idle';
}
