import { createRequire } from 'node:module';
import { chromium, type Browser } from '@playwright/test';
import { AccessToken } from 'livekit-server-sdk';
import { livekitRoomPrefix } from '../e2e-support/mock-server';

/**
 * A second LiveKit participant that publishes a *static* screen-share (or camera) track — a
 * canvas with flat colour blocks — so the stream stage, the PiP and the video tiles can be
 * photographed deterministically. Joins the same LiveKit room the mock server hands out
 * (`mock_<roomId>`). The client's own camera is Chromium's fake device (CALABA_FAKE_MEDIA).
 */
const LK_URL = process.env['MOCK_LIVEKIT_URL'] ?? 'ws://127.0.0.1:7880';
const LK_KEY = process.env['MOCK_LIVEKIT_KEY'] ?? 'devkey';
const LK_SECRET = process.env['MOCK_LIVEKIT_SECRET'] ?? 'secret';

export async function startPublisher(args: { userId: string; name: string; roomId: string; source?: 'screen' | 'camera' }): Promise<{ stop(): Promise<void> }> {
  const camera = args.source === 'camera';
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity: `${args.userId}:${camera ? 'camera' : 'publisher'}`, name: args.name, ttl: '10m' });
  at.addGrant({ roomJoin: true, room: `${livekitRoomPrefix()}${args.roomId}`, canPublish: true, canSubscribe: false });
  const token = await at.toJwt();
  const browser: Browser = await chromium.launch();
  const page = await browser.newPage();
  const umd = createRequire(import.meta.url).resolve('livekit-client');
  await page.addScriptTag({ path: umd.replace(/[^/]+$/, 'livekit-client.umd.js') });
  await page.evaluate(
    async ({ url, token, camera }) => {
      const LK = (window as unknown as { LivekitClient: typeof import('livekit-client') }).LivekitClient;
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2d context');
      // Redraw periodically: an unchanging canvas may stop producing frames.
      const draw = (): void => {
        g.fillStyle = '#2b2d31';
        g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#0a84ff';
        g.fillRect(80, 80, 520, 300);
        g.fillStyle = '#30d158';
        g.fillRect(680, 80, 520, 300);
        g.fillStyle = '#ececf0';
        g.fillRect(80, 460, 1120, 40);
        g.fillRect(80, 540, 800, 40);
      };
      draw();
      setInterval(draw, 200);
      const track = canvas.captureStream(5).getVideoTracks()[0];
      if (!track) throw new Error('no canvas track');
      const room = new LK.Room();
      (window as unknown as { __room: unknown }).__room = room;
      await room.connect(url, token);
      await room.localParticipant.publishTrack(track, { source: camera ? LK.Track.Source.Camera : LK.Track.Source.ScreenShare, simulcast: false, videoCodec: 'vp8' });
    },
    { url: LK_URL, token, camera },
  );
  return {
    async stop() {
      // Leave explicitly: a closed browser lingers in the LiveKit room until its timeout.
      await page.evaluate(() => (window as unknown as { __room?: { disconnect(): Promise<void> } }).__room?.disconnect()).catch(() => undefined);
      await browser.close();
    },
  };
}
