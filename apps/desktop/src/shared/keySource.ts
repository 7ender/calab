/**
 * Merging the two macOS key sources of the patched uiohook (pure; unit-tested).
 *
 * - `tap`: the regular CGEventTap hook (all keys; Windows/Linux only ever have this one).
 * - `hid`: the IOHIDManager keyboard listener (patches/uiohook-napi@*.patch, darwin only). It reads
 *   the physical Caps Lock (HID usage 0x39) as a real press/release, whatever «Caps Lock switches
 *   the input source» does — the tap sees nothing then (owner, 0.2.1).
 *
 * Both sources can report the same key (Caps Lock → keycode 58 via NX_SYSDEFINED on some systems).
 * Rules, per keycode:
 * - A duplicate of the current state is dropped: if the tap already delivered the press, the HID
 *   press is ignored (and vice versa), so the gate sees exactly one down and one up per press.
 * - Once HID has reported a key, HID owns it: later tap events of that key are dropped. The tap
 *   copy of a HID key may arrive after the HID release, and replaying it would re-press the key
 *   (in toggle mode: a second flip).
 * - Tap events of keys HID never reported pass untouched (auto-repeat included: the gate swallows it).
 */

export type KeySource = 'tap' | 'hid';

export interface RawKeyEvent {
  source: KeySource;
  code: number;
  down: boolean;
  /** Platform raw code (macOS tap: kVK_*, HID: usage). */
  rawcode?: number;
  /** libuiohook modifier mask. */
  mask?: number;
}

export class KeySourceMerger {
  private readonly hidKeys = new Set<number>();
  private readonly downKeys = new Set<number>();

  /** Returns true when the event goes on to the capture / gate. */
  accept(e: RawKeyEvent): boolean {
    if (e.source === 'hid') {
      this.hidKeys.add(e.code);
      if (e.down === this.downKeys.has(e.code)) return false; // the tap already delivered it
      this.track(e);
      return true;
    }
    if (this.hidKeys.has(e.code)) return false; // HID owns this key
    this.track(e);
    return true;
  }

  /** Sleep / binding change: forget held keys (a release lost meanwhile must not eat the next press). */
  reset(): void {
    this.downKeys.clear();
  }

  private track(e: RawKeyEvent): void {
    if (e.down) this.downKeys.add(e.code);
    else this.downKeys.delete(e.code);
  }
}
