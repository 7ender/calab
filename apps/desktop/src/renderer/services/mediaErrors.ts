import { t } from '../i18n';
import { log } from '../lib/log';
import { ACTION_LABEL, describeMediaError, type HumanError, type MediaContext, type MediaErrorAction, type MediaErrorCode } from '../lib/media/errors';
import { platform } from '../platform';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';

/**
 * The only way media / voice / stream errors reach the user (docs/09 #16): the raw error goes to
 * the log (log.warn), the user gets the human text from lib/media/errors.ts and, where it helps,
 * one action.
 */

export function humanMediaError(err: unknown, ctx: MediaContext, code?: MediaErrorCode): HumanError {
  log.warn(`media error [${ctx}]`, err);
  return describeMediaError(err, ctx, { web: platform.kind === 'web' }, code);
}

/** Logs, maps and shows a toast (unless the user caused it, e.g. closed the browser picker). */
export function reportMediaError(err: unknown, ctx: MediaContext, code?: MediaErrorCode): HumanError {
  const h = humanMediaError(err, ctx, code);
  if (!h.silent) {
    const kind = h.code === 'room-full' || h.code === 'no-loopback' ? 'info' : 'error';
    toast[kind](h.text);
    // A toast has no room for a button yet: the action lives where the error is shown inline
    // (voice panel, settings). See mediaActionLabel / runMediaAction.
  }
  return h;
}

export function mediaActionLabel(a: MediaErrorAction): string {
  return t(ACTION_LABEL[a]);
}

export function runMediaAction(a: MediaErrorAction): void {
  switch (a) {
    case 'mic-privacy':
      void platform.system.openPrivacySettings('microphone');
      break;
    case 'screen-privacy':
      void platform.system.openPrivacySettings('screen');
      break;
    case 'voice-settings':
      useUi.getState().openDialog({ kind: 'settings', tab: 'voice' });
      break;
    case 'connection':
      useUi.getState().openDialog({ kind: 'settings', tab: 'connection' });
      break;
  }
}
