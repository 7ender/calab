import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CameraController with LiveKit, the API and capture mocked: the request → grant → publish
 * order, 409 (camera limit), a stop overtaking a start, a server stop, CPU → 360p.
 */

vi.stubGlobal('window', globalThis);
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

vi.mock('../lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web' } }));
vi.mock('livekit-client', () => ({ RoomEvent: { ParticipantPermissionsChanged: 'perm' }, Track: { Source: { Camera: 'camera' } } }));

class FakeTrack {
  stopped = false;
  mediaStreamTrack = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  stop(): void {
    this.stopped = true;
  }
}
const captured: FakeTrack[] = [];
let captureError: Error | null = null;
const limitCpu = vi.fn(() => Promise.resolve());
const switchDevice = vi.fn(() => Promise.resolve());
vi.mock('../lib/media/camera', () => ({
  captureCamera: vi.fn(() => {
    if (captureError) return Promise.reject(captureError);
    const t = new FakeTrack();
    captured.push(t);
    return Promise.resolve(t);
  }),
  cameraPublishOptions: () => ({ source: 'camera' }),
  limitCameraForCpu: (...a: unknown[]) => limitCpu(...(a as [])),
  switchCameraDevice: (...a: unknown[]) => switchDevice(...(a as [])),
}));

let requestGate: Promise<void> | null = null;
let requestError: Error | null = null;
const requestCamera = vi.fn(async (_roomId: string) => {
  if (requestGate) await requestGate;
  if (requestError) throw requestError;
});
const stopCamera = vi.fn((_roomId: string) => Promise.resolve());
vi.mock('../lib/api/endpoints', () => ({ api: { voice: { requestCamera: (id: string) => requestCamera(id), stopCamera: (id: string) => stopCamera(id) } } }));

const info = vi.fn();
vi.mock('../stores/toasts', () => ({ toast: { info: (...a: unknown[]) => void info(...a), error: vi.fn() } }));
const report = vi.fn();
vi.mock('./mediaErrors', () => ({ reportMediaError: (...a: unknown[]) => void report(...a) }));

function fakeRoom(): {
  localParticipant: Record<string, unknown>;
  on: () => void;
  off: () => void;
  pub: { track: FakeTrack } | undefined;
  published: FakeTrack[];
  unpublished: FakeTrack[];
} {
  const r = {
    pub: undefined as { track: FakeTrack } | undefined,
    published: [] as FakeTrack[],
    unpublished: [] as FakeTrack[],
    on: () => undefined,
    off: () => undefined,
    localParticipant: {} as Record<string, unknown>,
  };
  r.localParticipant = {
    permissions: { canPublishSources: [] },
    publishTrack: (t: FakeTrack) => {
      r.published.push(t);
      r.pub = { track: t };
      return Promise.resolve();
    },
    unpublishTrack: (t: FakeTrack) => {
      r.unpublished.push(t);
      if (r.pub?.track === t) r.pub = undefined;
      return Promise.resolve();
    },
    getTrackPublication: () => r.pub,
  };
  return r;
}

type Ctl = import('./camera').CameraController;
let ctl: Ctl;
let room: ReturnType<typeof fakeRoom>;
let useVoice: (typeof import('../stores/voice'))['useVoice'];
let ApiError: (typeof import('../lib/api/client'))['ApiError'];

beforeEach(async () => {
  vi.resetModules();
  captured.length = 0;
  captureError = null;
  requestGate = null;
  requestError = null;
  requestCamera.mockClear();
  stopCamera.mockClear();
  info.mockClear();
  report.mockClear();
  limitCpu.mockClear();
  switchDevice.mockClear();
  ({ useVoice } = await import('../stores/voice'));
  ({ ApiError } = await import('../lib/api/client'));
  const { CameraController } = await import('./camera');
  room = fakeRoom();
  const host = { room: room as never, roomId: 'r1' };
  ctl = new CameraController(host);
});

const phase = (): string => useVoice.getState().camera;

describe('CameraController', () => {
  it('capture → /camera/request → publish → on; stop → unpublish + /camera/stop → off', async () => {
    await ctl.start();
    expect(requestCamera).toHaveBeenCalledWith('r1');
    expect(room.published).toHaveLength(1);
    expect(phase()).toBe('on');
    expect(ctl.localTrack).toBe(captured[0]);
    await ctl.stop();
    expect(room.unpublished).toEqual([captured[0]]);
    expect(captured[0]?.stopped).toBe(true);
    expect(stopCamera).toHaveBeenCalledWith('r1');
    expect(phase()).toBe('off');
  });

  it('409 (limit): «Достигнут лимит камер», capture released, nothing published', async () => {
    requestError = new ApiError('ERROR_CODE_CONFLICT', 'limit', 409);
    await ctl.start();
    expect(info).toHaveBeenCalledWith('Достигнут лимит камер');
    expect(captured[0]?.stopped).toBe(true);
    expect(room.published).toHaveLength(0);
    expect(stopCamera).not.toHaveBeenCalled(); // nothing was reserved
    expect(phase()).toBe('off');
  });

  it('a denied camera never costs a slot', async () => {
    captureError = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    await ctl.start();
    expect(requestCamera).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(captureError, 'camera');
    expect(phase()).toBe('off');
  });

  it('stop while the request is in flight: no publish, reservation released', async () => {
    let open!: () => void;
    requestGate = new Promise<void>((r) => (open = r));
    const starting = ctl.start();
    await vi.waitFor(() => expect(requestCamera).toHaveBeenCalled());
    expect(phase()).toBe('starting');
    const stopping = ctl.stop();
    open();
    await Promise.all([starting, stopping]);
    expect(room.published).toHaveLength(0);
    expect(captured[0]?.stopped).toBe(true);
    expect(stopCamera).toHaveBeenCalled();
    expect(phase()).toBe('off');
  });

  it('VOICE_CAMERA_STOP{MODERATOR}: toast, local stop', async () => {
    await ctl.start();
    ctl.onServerStop('moderator');
    expect(info).toHaveBeenCalledWith('Модератор выключил вашу камеру');
    expect(phase()).toBe('off');
    await vi.waitFor(() => expect(room.unpublished).toHaveLength(1));
    expect(ctl.localTrack).toBeNull();
  });

  it('grant withdrawn first, VOICE_CAMERA_STOP right after: stopped quietly, then the toast', async () => {
    await ctl.start();
    ctl.onGrantLost();
    expect(phase()).toBe('off');
    expect(info).not.toHaveBeenCalled();
    ctl.onServerStop('limit');
    expect(info).toHaveBeenCalledWith('Камера выключена: в комнате достигнут лимит камер');
  });

  it('VOICE_CAMERA_STOP for another device of mine is ignored', () => {
    ctl.onServerStop('moderator');
    expect(info).not.toHaveBeenCalled();
  });

  it('CPU-bound encoder for 3 samples: capture drops to 360p once', async () => {
    await ctl.start();
    const cpu = [{ qualityLimitation: 'cpu' }] as never;
    for (let i = 0; i < 5; i++) ctl.onStats(cpu);
    await vi.waitFor(() => expect(limitCpu).toHaveBeenCalledTimes(1));
    expect(useVoice.getState().cameraCpuLimited).toBe(true);
  });

  it('device switch keeps the 360p CPU limit of the session (L3)', async () => {
    await ctl.start();
    await ctl.setDevice('cam-2');
    expect(limitCpu).not.toHaveBeenCalled();
    useVoice.getState().set({ cameraCpuLimited: true });
    await ctl.setDevice('cam-3');
    expect(switchDevice).toHaveBeenCalledTimes(2);
    expect(limitCpu).toHaveBeenCalledTimes(1);
  });

  it('full reconnect: the lost publication is re-requested and republished (L11)', async () => {
    await ctl.start();
    await ctl.restore(); // plain resume: publication and grant intact → nothing
    expect(requestCamera).toHaveBeenCalledTimes(1);
    room.pub = undefined; // the new session has no camera
    await ctl.restore();
    expect(requestCamera).toHaveBeenCalledTimes(2);
    expect(room.published).toEqual([captured[0], captured[0]]);
    expect(phase()).toBe('on');
  });

  it('full reconnect without a free slot: camera off with a notice', async () => {
    await ctl.start();
    room.pub = undefined;
    requestError = new ApiError('ERROR_CODE_CONFLICT', 'limit', 409);
    await ctl.restore();
    expect(phase()).toBe('off');
    expect(info).toHaveBeenCalledWith('Связь восстановлена — включите камеру снова');
    expect(captured[0]?.stopped).toBe(true);
  });

  it('leaving the call releases the camera', async () => {
    await ctl.start();
    ctl.onLeave();
    expect(captured[0]?.stopped).toBe(true);
    expect(phase()).toBe('off');
  });
});
