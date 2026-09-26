import type { UpdateStatus } from '../../../shared/ipc';

/**
 * The «Calab X.Y.Z готова · Перезапустить» banner (docs/09 P1 #16), pure for tests. Main
 * re-announces a downloaded update on every later check (main/updateFlow.ts), so closing the
 * banner hides it only until the next status from main.
 */
export interface UpdateBannerState {
  update: UpdateStatus;
  /** The user closed the banner; reset by the next status from main. */
  updateDismissed: boolean;
}

/** A status from main (event or the initial read): shows the banner again. */
export const onUpdateStatus = (update: UpdateStatus): UpdateBannerState => ({ update, updateDismissed: false });

/** Version the banner shows, or null (nothing downloaded / closed). */
export function bannerVersion(s: UpdateBannerState): string | null {
  return s.update.state === 'downloaded' && !s.updateDismissed ? s.update.version : null;
}
