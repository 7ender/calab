/**
 * Screen Recording onboarding step (macOS, docs/09 P0 #3): one pure mapping from the OS state to
 * what the step shows. macOS lists Calab under Privacy → Screen Recording only after a capture
 * attempt, and a new grant usually takes effect only after a relaunch — until then the OS may
 * keep reporting «denied» to this process. So once the user has been sent to the settings and
 * comes back without a working grant, the step offers «Перезапустить» next to «Открыть настройки».
 */
import type { ScreenAccess } from '../../shared/ipc';

export type ScreenStepState =
  /** Status not read yet. */
  | 'loading'
  /** Not granted, not asked in this run: «Запросить доступ и открыть настройки». */
  | 'ask'
  /** Asked and sent to the settings, still not working: enable Calab there, or relaunch if done. */
  | 'waiting'
  /** The OS reports the grant but this process cannot capture yet: relaunch. */
  | 'restart'
  /** Capture works. */
  | 'granted'
  /** Blocked by a profile (MDM): nothing to do here. */
  | 'restricted';

export function screenStepState(access: ScreenAccess | null, requested: boolean): ScreenStepState {
  if (!access) return 'loading';
  if (access.status === 'granted') return access.canCapture ? 'granted' : 'restart';
  // Not a macOS grant question (web / other OS): capture is asked for at share time.
  if (access.status === 'n/a') return 'granted';
  if (access.status === 'restricted') return 'restricted';
  return requested ? 'waiting' : 'ask';
}

export interface ScreenStepView {
  /** Line in the body: hint before asking, what to do while waiting, restart, ok, restricted. */
  note: 'hint' | 'waiting' | 'restart' | 'granted' | 'restricted';
  /** Primary action. */
  primary: 'request' | 'reopen' | 'restart' | 'next';
  /** «Перезапустить» inside the note (the grant may already be given but not visible yet). */
  restartInNote: boolean;
  /** «Позже» next to the primary action. */
  later: boolean;
}

export function screenStepView(state: ScreenStepState): ScreenStepView {
  switch (state) {
    case 'loading':
    case 'ask':
      return { note: 'hint', primary: 'request', restartInNote: false, later: true };
    case 'waiting':
      return { note: 'waiting', primary: 'reopen', restartInNote: true, later: true };
    case 'restart':
      return { note: 'restart', primary: 'restart', restartInNote: false, later: true };
    case 'granted':
      return { note: 'granted', primary: 'next', restartInNote: false, later: false };
    case 'restricted':
      return { note: 'restricted', primary: 'next', restartInNote: false, later: false };
  }
}
