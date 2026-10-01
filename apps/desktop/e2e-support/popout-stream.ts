/** Synthetic media only: the actual LiveKit adaptive track, without a microphone or SFU. */
import { RemoteVideoTrack, TrackEvent } from 'livekit-client';
import { voice } from '../src/renderer/services/voice';
import { setVoice, useVoice } from '../src/renderer/stores/voice';
import { useUi } from '../src/renderer/stores/ui';

let track: RemoteVideoTrack;
let timer: ReturnType<typeof setInterval>;
let visible = false;
let size = { width: 0, height: 0 };

export function start(workspaceId: string, roomId: string, userId: string): void {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext('2d');
  let frame = 0;
  timer = setInterval(() => {
    if (!context) return;
    context.fillStyle = `hsl(${frame++ % 360},60%,35%)`;
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = 'white';
    context.font = '32px sans-serif';
    context.fillText(`Detached stream ${frame}`, 40, 180);
  }, 100);
  const media = canvas.captureStream(10).getVideoTracks()[0];
  if (!media) throw new Error('No synthetic track');
  track = new RemoteVideoTrack(media, 'popout-test', {} as RTCRtpReceiver, {});
  track.on(TrackEvent.VisibilityChanged, (next: boolean) => { visible = next; });
  track.on(TrackEvent.VideoDimensionsChanged, (next: typeof size) => { size = next; });
  voice.streamVideo = () => track;
  useUi.getState().openRoom(workspaceId, roomId);
  setVoice({ workspaceId, roomId, phase: 'connected', canSpeak: true,
    watching: 'popout-test', stage: 'expanded',
    streams: [{ trackSid: track.sid ?? '', userId, identity: `${userId}:synthetic`, hasAudio: false }],
  });
}

export function state(): { visible: boolean; size: typeof size; live: boolean; stage: string } {
  return { visible, size, live: track.mediaStreamTrack.readyState === 'live', stage: useVoice.getState().stage };
}
export function navigate(calendar: boolean): void {
  useUi.setState({ calDay: calendar ? '2026-01-15' : null });
}
export function replace(): void {
  visible = false;
  size = { width: 0, height: 0 };
  track = new RemoteVideoTrack(track.mediaStreamTrack, 'popout-test', {} as RTCRtpReceiver, {});
  track.on(TrackEvent.VisibilityChanged, (next: boolean) => { visible = next; });
  track.on(TrackEvent.VideoDimensionsChanged, (next: typeof size) => { size = next; });
  setVoice({ trackEpoch: useVoice.getState().trackEpoch + 1 });
}
export function stop(): void {
  setVoice({ streams: [], watching: null, stage: 'pip', phase: 'idle', roomId: null });
  clearInterval(timer);
}
