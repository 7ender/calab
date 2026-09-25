// SPIKE ONLY: dev token minting in the main process. In the real app tokens
// are issued by the API (apps/server) and mirror computePermissions; the
// desktop never holds a LiveKit secret. Remove this file after stage 1.
import { AccessToken } from 'livekit-server-sdk';
import type { MintTokenRequest } from '../shared/ipc';

// SPIKE ONLY: `livekit-server --dev` well-known credentials, overridable via env.
const apiKey = process.env['LIVEKIT_API_KEY'] ?? 'devkey';
const apiSecret = process.env['LIVEKIT_API_SECRET'] ?? 'secret';

export async function mintDevToken(req: MintTokenRequest): Promise<string> {
  const at = new AccessToken(apiKey, apiSecret, {
    identity: req.identity,
    name: req.name,
    ttl: '2h',
  });
  at.addGrant({
    roomJoin: true,
    room: req.room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}
