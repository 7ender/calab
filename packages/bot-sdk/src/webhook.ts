import { createHmac, timingSafeEqual } from 'node:crypto';
import { fromJsonString } from '@bufbuild/protobuf';
import { BotWebhookUpdateSchema, type BotWebhookUpdate } from '@calaba/protocol';

/** Header names of a webhook delivery (docs/05 «Боты», ADR-0031 §4). */
export const SIGNATURE_HEADER = 'x-calab-signature';
export const DELIVERY_HEADER = 'x-calab-delivery';

/** `sha256=<hex HMAC-SHA256(secret, body)>` — what the server puts in X-Calab-Signature. */
export function signWebhook(secret: string, body: string | Uint8Array): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Checks X-Calab-Signature against the raw request body (the exact bytes; do not re-serialize parsed
 * JSON). Constant-time comparison.
 */
export function verifyWebhookSignature(secret: string, body: string | Uint8Array, signature: string | null | undefined): boolean {
  if (!signature) return false;
  const want = Buffer.from(signWebhook(secret, body));
  const got = Buffer.from(signature.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Parses a delivery body (protojson `BotWebhookUpdate`). Unknown fields are ignored. */
export function parseWebhookUpdate(body: string | Uint8Array): BotWebhookUpdate {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  return fromJsonString(BotWebhookUpdateSchema, text, { ignoreUnknownFields: true });
}
