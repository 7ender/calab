import { createRequire } from 'node:module';
import { chromium, type Browser } from '@playwright/test';
import { AccessToken } from 'livekit-server-sdk';

/**
 * A second LiveKit participant that publishes a *static* screen-share track (a canvas with
 * flat colour blocks), so the stream stage and PiP can be photographed deterministically.
 * Joins the same LiveKit room the mock server hands out (`mock_<roomId>`).
 * `image` (a 1280×720 PNG) replaces the colour blocks (marketing screenshots only).
 */
const LK_URL = process.env['MOCK_LIVEKIT_URL'] ?? 'ws://127.0.0.1:7880';
const LK_KEY = process.env['MOCK_LIVEKIT_KEY'] ?? 'devkey';
const LK_SECRET = process.env['MOCK_LIVEKIT_SECRET'] ?? 'secret';

export async function startPublisher(args: { userId: string; name: string; roomId: string; image?: Buffer }): Promise<{ stop(): Promise<void> }> {
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity: `${args.userId}:publisher`, name: args.name, ttl: '10m' });
  at.addGrant({ roomJoin: true, room: `mock_${args.roomId}`, canPublish: true, canSubscribe: false });
  const token = await at.toJwt();
  const browser: Browser = await chromium.launch();
  const page = await browser.newPage();
  const umd = createRequire(import.meta.url).resolve('livekit-client');
  await page.addScriptTag({ path: umd.replace(/[^/]+$/, 'livekit-client.umd.js') });
  await page.evaluate(
    async ({ url, token, image }) => {
      const LK = (window as unknown as { LivekitClient: typeof import('livekit-client') }).LivekitClient;
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2d context');
      const picture = image ? new Image() : null;
      if (picture && image) {
        picture.src = image;
        await picture.decode();
      }
      // Redraw periodically: an unchanging canvas may stop producing frames.
      const draw = (): void => {
        if (picture) {
          g.drawImage(picture, 0, 0, 1280, 720);
          return;
        }
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
      await room.connect(url, token);
      await room.localParticipant.publishTrack(track, { source: LK.Track.Source.ScreenShare, simulcast: false, videoCodec: 'vp8' });
    },
    { url: LK_URL, token, image: args.image ? `data:image/png;base64,${args.image.toString('base64')}` : '' },
  );
  return {
    async stop() {
      await browser.close();
    },
  };
}
