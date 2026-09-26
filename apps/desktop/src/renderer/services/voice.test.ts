import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VoiceEngine with LiveKit, the API and the mic pipeline mocked (review test gaps: H1 room
 * switch, M1 leave during mic test, M2 concurrent restartMic, M4 SPEAK granted mid-call,
 * rejoin abort, L2 mute race).
 */

// ---------------------------------------------------------------- DOM stubs (node env)

const el = (): Record<string, unknown> => ({ hidden: false, id: '', appendChild: () => undefined, remove: () => undefined });
vi.stubGlobal('document', {
  createElement: el,
  body: { appendChild: () => undefined },
  addEventListener: () => undefined,
  visibilityState: 'visible',
  hasFocus: () => true,
});
vi.stubGlobal('window', globalThis);
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
/** The audio devices `enumerateDevices()` reports; `devicechange` handlers are kept to fire them. */
let deviceList: { deviceId: string; groupId: string; kind: string; label: string }[] = [];
const deviceChange: (() => void)[] = [];
vi.stubGlobal('navigator', {
  userAgent: 'test',
  mediaDevices: {
    addEventListener: (ev: string, fn: () => void) => {
      if (ev === 'devicechange') deviceChange.push(fn);
    },
    enumerateDevices: () => Promise.resolve(deviceList),
  },
});

// ---------------------------------------------------------------- livekit-client mock

type Handler = (...a: unknown[]) => void;

class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  enabled = true;
  stop(): void {
    this.readyState = 'ended';
  }
}

class FakeLocalAudioTrack {
  isMuted = false;
  stopped = false;
  replaced: FakeTrack[] = [];
  /** Pending mute/unmute resolvers (tests settle them to simulate LiveKit's async lock). */
  static lockMs = 0;
  constructor(public mediaStreamTrack: FakeTrack) {}
  async mute(): Promise<void> {
    await new Promise((r) => setTimeout(r, FakeLocalAudioTrack.lockMs));
    this.isMuted = true;
  }
  async unmute(): Promise<void> {
    await new Promise((r) => setTimeout(r, FakeLocalAudioTrack.lockMs));
    this.isMuted = false;
    this.mediaStreamTrack.enabled = true;
  }
  stop(): void {
    this.stopped = true;
    this.mediaStreamTrack.stop();
  }
  /** When set, the next replaceTrack rejects (RTCRtpSender.replaceTrack failure). */
  static failReplace = false;
  replaceTrack(t: FakeTrack): Promise<void> {
    if (FakeLocalAudioTrack.failReplace) {
      FakeLocalAudioTrack.failReplace = false;
      return Promise.reject(new Error('replaceTrack failed'));
    }
    this.replaced.push(t);
    this.mediaStreamTrack = t;
    return Promise.resolve();
  }
  getRTCStatsReport(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

class FakeRoom {
  static all: FakeRoom[] = [];
  handlers = new Map<string, Handler[]>();
  disconnects: boolean[] = [];
  published: FakeLocalAudioTrack[] = [];
  remoteParticipants = new Map();
  name = '';
  engine = {};
  localParticipant = {
    permissions: undefined as undefined | { canPublish: boolean; canPublishSources: number[] },
    publishTrack: vi.fn((t: FakeLocalAudioTrack) => {
      this.published.push(t);
      return Promise.resolve();
    }),
    unpublishTrack: vi.fn((t: FakeLocalAudioTrack) => {
      this.published = this.published.filter((x) => x !== t);
      return Promise.resolve();
    }),
    getTrackPublication: (source: string) => (source === 'microphone' && this.published.length ? {} : undefined),
    publishData: () => Promise.resolve(),
  };
  constructor() {
    FakeRoom.all.push(this);
  }
  on(ev: string, fn: Handler): this {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    return this;
  }
  off(): this {
    return this;
  }
  emit(ev: string, ...a: unknown[]): void {
    for (const h of this.handlers.get(ev) ?? []) h(...a);
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  /** When set, disconnect() waits for it (a slow network disconnect). */
  static disconnectGate: Promise<void> | null = null;
  async disconnect(stopTracks = true): Promise<void> {
    this.disconnects.push(stopTracks);
    if (FakeRoom.disconnectGate) await FakeRoom.disconnectGate;
    if (stopTracks) for (const t of this.published) t.stop();
    this.published = [];
  }
}

const names = new Proxy({}, { get: (_t, k) => String(k) });
vi.mock('livekit-client', () => ({
  Room: FakeRoom,
  LocalAudioTrack: FakeLocalAudioTrack,
  RoomEvent: names,
  ConnectionState: names,
  DisconnectReason: names,
  Track: { Source: { Microphone: 'microphone', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' }, Kind: { Audio: 'audio', Video: 'video' } },
  VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
}));

// ---------------------------------------------------------------- app mocks

const joinVoice = vi.fn((roomId: string) => Promise.resolve({ url: 'wss://lk', token: `t-${roomId}`, canSpeak: true, canStream: true, media: { audioBitrateKbps: 32 } }));
vi.mock('../lib/api/endpoints', () => ({
  api: { voice: { join: (id: string) => joinVoice(id), updateSelf: () => Promise.resolve() }, me: { update: () => Promise.resolve({}) } },
}));

interface FakePipeline {
  track: FakeTrack;
  stop: ReturnType<typeof vi.fn>;
  deviceId: string | null;
  deviceLabel: string;
  onEnded?: () => void;
}
/** Device ids that are unplugged (getUserMedia with {exact} fails). */
const gone = new Set<string>();
const pipelines: FakePipeline[] = [];
let gate: Promise<void> | null = null; // when set, MicPipeline.start waits for it
vi.mock('../lib/media/micPipeline', () => ({
  MicPipeline: {
    start: vi.fn(async (opts: { deviceId: string | null; onEnded?: () => void }) => {
      if (gate) await gate;
      if (opts.deviceId && gone.has(opts.deviceId)) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
      const track = new FakeTrack();
      const p: FakePipeline = { track, deviceId: opts.deviceId, deviceLabel: opts.deviceId ?? 'Default - Built-in Mic', stop: vi.fn(() => track.stop()), ...(opts.onEnded ? { onEnded: opts.onEnded } : {}) };
      pipelines.push(p);
      return p;
    }),
  },
}));
vi.mock('../lib/media/screenShare', () => ({ applyPreset: vi.fn(), captureScreen: vi.fn(), startScreenShare: vi.fn() }));
vi.mock('../lib/sounds', () => ({ playSound: () => undefined }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
const announce = vi.fn();
vi.mock('./deviceToast', () => ({ announceDeviceSwitch: (...a: unknown[]) => void announce(...a) }));
vi.mock('./mediaErrors', () => ({
  humanMediaError: () => ({ text: 'err', action: null }),
  reportMediaError: () => ({ text: 'err', action: null }),
}));
vi.mock('../platform', () => ({
  platform: {
    kind: 'web',
    ptt: { onEvent: () => () => undefined, setBinding: () => Promise.resolve({}) },
    tray: { setState: () => undefined },
    system: { metrics: () => Promise.resolve({ rendererCpu: null }) },
    app: { log: () => undefined },
  },
}));

type Engine = (typeof import('./voice'))['voice'];
let voice: Engine;
let useVoice: (typeof import('../stores/voice'))['useVoice'];
let usePrefs: (typeof import('../stores/prefs'))['usePrefs'];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeRoom.all = [];
  FakeLocalAudioTrack.lockMs = 0;
  FakeLocalAudioTrack.failReplace = false;
  FakeRoom.disconnectGate = null;
  pipelines.length = 0;
  gate = null;
  gone.clear();
  joinVoice.mockClear();
  deviceChange.length = 0;
  deviceList = [];
  announce.mockClear();
  ({ voice } = await import('./voice'));
  ({ useVoice } = await import('../stores/voice'));
  ({ usePrefs } = await import('../stores/prefs'));
  voice.init();
});
afterEach(() => {
  vi.useRealTimers();
});

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('VoiceEngine', () => {
  it('join A → join B connects to B (review H1)', async () => {
    await voice.join('A', 'ws');
    expect(useVoice.getState().phase).toBe('connected');
    await voice.join('B', 'ws');
    expect(useVoice.getState().phase).toBe('connected');
    expect(useVoice.getState().roomId).toBe('B');
    expect(voice.currentRoomId).toBe('B');
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A', 'B']);
    expect(FakeRoom.all[0]?.disconnects).toHaveLength(1);
    expect(FakeRoom.all[1]?.published).toHaveLength(1);
  });

  it('a newer join wins over one still waiting for /join', async () => {
    const first = voice.join('A', 'ws');
    const second = voice.join('B', 'ws');
    await Promise.all([first, second]);
    expect(voice.currentRoomId).toBe('B');
    expect(useVoice.getState().phase).toBe('connected');
  });

  it('leave() while the old room is still disconnecting wins over the pending switch (review N1)', async () => {
    await voice.join('A', 'ws');
    let release!: () => void;
    FakeRoom.disconnectGate = new Promise<void>((r) => (release = r));
    const switching = voice.join('B', 'ws');
    await settle();
    const leaving = voice.leave();
    FakeRoom.disconnectGate = null;
    release();
    await Promise.all([switching, leaving]);
    await settle();
    expect(useVoice.getState().phase).toBe('idle');
    expect(voice.currentRoomId).toBeNull();
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['A']); // never connected to B
    expect(FakeRoom.all).toHaveLength(1);
  });

  it('a fast B → A switch ends in A, the last click (review N1)', async () => {
    await voice.join('X', 'ws');
    let release!: () => void;
    FakeRoom.disconnectGate = new Promise<void>((r) => (release = r));
    const toB = voice.join('B', 'ws');
    await settle();
    const toA = voice.join('A', 'ws');
    FakeRoom.disconnectGate = null;
    release();
    await Promise.all([toB, toA]);
    await settle();
    expect(voice.currentRoomId).toBe('A');
    expect(useVoice.getState().roomId).toBe('A');
    expect(useVoice.getState().phase).toBe('connected');
    expect(joinVoice.mock.calls.map((c) => c[0])).toEqual(['X', 'A']);
  });

  it('a failed replaceTrack keeps the published capture and stops the new one (review N4)', async () => {
    await voice.join('A', 'ws');
    const old = pipelines[0];
    FakeLocalAudioTrack.failReplace = true;
    usePrefs.getState().setPrefs({ micDeviceId: 'd1' });
    await settle();
    await settle();
    expect(pipelines).toHaveLength(2);
    expect(pipelines[1]?.track.readyState).toBe('ended'); // the new capture does not leak
    expect(old?.track.readyState).toBe('live'); // still the published one
    expect(FakeRoom.all[0]?.published[0]?.mediaStreamTrack).toBe(old?.track);
    await voice.leave();
    expect(pipelines.every((p) => p.track.readyState === 'ended')).toBe(true);
  });

  it('leaving during the mic test keeps a live mic for the next call (review M1)', async () => {
    await voice.startMicTest();
    await voice.join('A', 'ws');
    const pipe = pipelines[0];
    expect(pipelines).toHaveLength(1);
    await voice.leave();
    expect(FakeRoom.all[0]?.disconnects).toEqual([false]); // unpublish without stopping
    expect(pipe?.track.readyState).toBe('live');
    expect(pipe?.stop).not.toHaveBeenCalled();
    await voice.join('B', 'ws');
    const published = FakeRoom.all[1]?.published[0];
    expect(published?.mediaStreamTrack.readyState).toBe('live');
    voice.stopMicTest();
    await voice.leave();
    expect(pipe?.stop).toHaveBeenCalled();
  });

  it('an ended pipeline track is rebuilt instead of being published dead', async () => {
    await voice.startMicTest();
    pipelines[0]?.track.stop(); // e.g. LiveKit stopped it on a server unpublish
    await voice.join('A', 'ws');
    expect(pipelines).toHaveLength(2);
    expect(FakeRoom.all[0]?.published[0]?.mediaStreamTrack).toBe(pipelines[1]?.track);
  });

  it('concurrent restartMic never leaks a pipeline (review M2)', async () => {
    await voice.join('A', 'ws');
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    usePrefs.getState().setPrefs({ micDeviceId: 'd1' });
    usePrefs.getState().setPrefs({ micDeviceId: 'd2' });
    gate = null;
    open();
    await settle();
    await settle();
    const live = pipelines.filter((p) => p.track.readyState === 'live');
    expect(live).toHaveLength(1);
    expect(live[0]?.deviceId).toBe('d2');
    const track = FakeRoom.all[0]?.published[0];
    expect(track?.mediaStreamTrack).toBe(live[0]?.track);
  });

  it('leaving while a restart is building stops the new capture too', async () => {
    await voice.join('A', 'ws');
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    usePrefs.getState().setPrefs({ rnnoise: !usePrefs.getState().rnnoise });
    await voice.leave();
    gate = null;
    open();
    await settle();
    expect(pipelines.every((p) => p.track.readyState === 'ended')).toBe(true);
  });

  it('SPEAK granted mid-call publishes the mic; revoked → muted (review M4)', async () => {
    joinVoice.mockImplementationOnce((roomId: string) =>
      Promise.resolve({ url: 'wss://lk', token: `t-${roomId}`, canSpeak: false, canStream: false, media: { audioBitrateKbps: 32 } }),
    );
    await voice.join('A', 'ws');
    const room = FakeRoom.all[0];
    expect(room?.published).toHaveLength(0);
    // Stream-only grant is not SPEAK.
    if (room) room.localParticipant.permissions = { canPublish: true, canPublishSources: [3, 4] };
    room?.emit('ParticipantPermissionsChanged', undefined, room.localParticipant);
    await settle();
    expect(room?.published).toHaveLength(0);
    if (room) room.localParticipant.permissions = { canPublish: true, canPublishSources: [2] };
    room?.emit('ParticipantPermissionsChanged', undefined, room.localParticipant);
    await settle();
    expect(useVoice.getState().canSpeak).toBe(true);
    expect(room?.published).toHaveLength(1);
    if (room) room.localParticipant.permissions = { canPublish: false, canPublishSources: [] };
    room?.emit('ParticipantPermissionsChanged', undefined, room.localParticipant);
    await settle();
    expect(room?.published[0]?.isMuted).toBe(true);
  });

  it('the rejoin loop stops when the user leaves', async () => {
    await voice.join('A', 'ws');
    FakeRoom.all[0]?.emit('Disconnected', 'SIGNAL_CLOSE');
    await settle();
    expect(useVoice.getState().phase).toBe('reconnecting');
    await voice.leave();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinVoice).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().phase).toBe('idle');
    expect(useVoice.getState().roomId).toBeNull();
  });

  it('mute → unmute in quick succession ends unmuted, as the UI shows (review L2)', async () => {
    await voice.join('A', 'ws');
    FakeLocalAudioTrack.lockMs = 50;
    voice.toggleMute();
    voice.toggleMute();
    await vi.advanceTimersByTimeAsync(500);
    expect(useVoice.getState().muted).toBe(false);
    expect(FakeRoom.all[0]?.published[0]?.isMuted).toBe(false);
  });

  it('the chosen mic unplugged mid-call → default device, published in place (review M3)', async () => {
    usePrefs.getState().setPrefs({ micDeviceId: 'usb' });
    await voice.join('A', 'ws');
    const first = pipelines[0];
    expect(first?.deviceId).toBe('usb');
    gone.add('usb');
    first?.track.stop();
    first?.onEnded?.(); // the OS ended the capture
    await settle();
    await settle();
    const now = pipelines.at(-1);
    expect(now?.deviceId).toBeNull();
    expect(now?.track.readyState).toBe('live');
    expect(FakeRoom.all[0]?.published[0]?.mediaStreamTrack).toBe(now?.track);
    // In a call the device-switch toast names the device now in use (docs/09 #49).
    expect(announce).toHaveBeenCalledWith({ kind: 'input', label: 'Built-in Mic' });
    const { toast } = await import('../stores/toasts');
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('the OS switching the default device is announced in a call only (docs/09 #49)', async () => {
    const mbp = { deviceId: 'default', groupId: 'g1', kind: 'audioinput', label: 'Default - MacBook Mic' };
    const air = { deviceId: 'default', groupId: 'g2', kind: 'audioinput', label: 'Default - AirPods' };
    const fire = async (list: (typeof deviceList)[number][]): Promise<void> => {
      deviceList = list;
      for (const fn of deviceChange) fn();
      await settle();
    };
    await fire([mbp]); // baseline, not in a call
    await fire([air]);
    expect(announce).not.toHaveBeenCalled();
    await voice.join('A', 'ws');
    await fire([mbp]);
    expect(announce).toHaveBeenCalledWith({ kind: 'input', label: 'MacBook Mic' });
  });

  it('resetPtt clears a stuck key (review M6)', async () => {
    await voice.join('A', 'ws');
    useVoice.setState({ pttDown: true });
    voice.resetPtt();
    expect(useVoice.getState().pttDown).toBe(false);
  });
});
