/**
 * Truthful Page Visibility on desktop (docs/14-energy.md). A voice client runs with
 * `backgroundThrottling: false` (timers must not be throttled while hidden), and Electron then
 * also pins `document.visibilityState` to «visible» — so nothing that waits for «hidden» ever
 * fires: LiveKit's adaptive stream kept decoding every video of a hidden window, the stream code's
 * own check never paused, toasts timed out unseen.
 *
 * This combines the page's own state with the window's (shown and not minimized, from main) as
 * own-property getters on `document` and fires `visibilitychange` when the combination flips, so
 * every existing listener — ours and livekit-client's — sees the real state without knowing about
 * Electron. The web client needs nothing (`isShown` is always true there).
 */
export interface ShownSource {
  isShown(): Promise<boolean>;
  onShownChange(cb: (shown: boolean) => void): () => void;
}

export function installWindowVisibility(doc: Document, win: ShownSource, native: () => DocumentVisibilityState = nativeVisibility(doc)): () => void {
  let shown = true;
  const state = (): DocumentVisibilityState => (shown && native() === 'visible' ? 'visible' : 'hidden');
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: state });
  Object.defineProperty(doc, 'hidden', { configurable: true, get: () => state() === 'hidden' });
  const set = (next: boolean): void => {
    const before = state();
    shown = next;
    // CSS hook: endless animations pause while the window is hidden (styles.css).
    doc.documentElement.classList.toggle('window-hidden', !shown);
    if (state() !== before) doc.dispatchEvent(new Event('visibilitychange'));
  };
  let live = true;
  void win.isShown().then(
    (v) => {
      if (live) set(v);
    },
    () => undefined,
  );
  const off = win.onShownChange(set);
  return () => {
    live = false;
    off();
    delete (doc as unknown as Record<string, unknown>)['visibilityState'];
    delete (doc as unknown as Record<string, unknown>)['hidden'];
  };
}

/** The browser's own getter (Document.prototype), before our override shadows it. */
function nativeVisibility(doc: Document): () => DocumentVisibilityState {
  // A native accessor, always called with the document as `this` below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const get = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')?.get;
  return () => (get ? (Reflect.apply(get, doc, []) as DocumentVisibilityState) : 'visible');
}
