import { RemoteVideoTrack, type ElementInfo, type LocalVideoTrack } from 'livekit-client';

/** The detached window owns visibility and size, even while its opener is hidden. */
export function bindPopoutVideo(track: RemoteVideoTrack | LocalVideoTrack, video: HTMLVideoElement, win: Window): () => void {
  video.srcObject = new MediaStream([track.mediaStreamTrack]);
  void video.play().catch(() => undefined);

  // LiveKit 2.22's default HTMLElementInfo observes the opener's document, including its
  // background pause. Use its typed ElementInfo adapter for this separate window instead.
  // These SDK methods are marked @internal: exercise the real track when upgrading LiveKit.
  let shown = true;
  let live = true;
  let off: (() => void) | undefined;
  const bridge = (win as Partial<Pick<Window, 'calaba'>>).calaba?.window;
  const visible = (): boolean => shown && !win.closed && win.document.visibilityState === 'visible';
  const resize = new ResizeObserver(() => info.handleResize?.());
  const changed = (): void => {
    info.visibilityChangedAt = Date.now();
    info.handleVisibilityChanged?.();
    info.handleResize?.();
  };
  const info: ElementInfo = {
    element: video,
    width: () => visible() ? video.clientWidth : 0,
    height: () => visible() ? video.clientHeight : 0,
    get visible() { return visible(); },
    // A visible detached window must bypass the opener's background pause, like native PiP.
    get pictureInPicture() { return visible(); },
    visibilityChangedAt: undefined,
    observe: () => {
      resize.observe(video);
      win.document.addEventListener('visibilitychange', changed);
      off = bridge?.onShownChange((next) => { shown = next; changed(); });
      void bridge?.isShown().then((next) => {
        if (live) { shown = next; changed(); }
      }).catch(() => undefined);
    },
    stopObserving: () => {
      live = false;
      resize.disconnect();
      win.document.removeEventListener('visibilitychange', changed);
      off?.();
    },
  };
  if (track instanceof RemoteVideoTrack && track.isAdaptiveStream) track.observeElementInfo(info);
  return () => {
    if (track instanceof RemoteVideoTrack && track.isAdaptiveStream) track.stopObservingElementInfo(info);
    // The shared capture/receiver belongs to VoiceService, never stop it here.
    video.srcObject = null;
  };
}
