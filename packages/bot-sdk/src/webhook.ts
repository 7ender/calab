import { createHmac, timingSafeEqual } from 'node:crypto';
import { fromJsonString } from '@bufbuild/protobuf';
import { BoardWebhookEventSchema, BotWebhookUpdateSchema, type BoardWebhookEvent, type BotWebhookUpdate } from '@calaba/protocol';

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

/** Tolerated clock skew of a board webhook timestamp (ADR-0058 §4: ±5 minutes). */
export const BOARD_WEBHOOK_TOLERANCE_SECONDS = 300;

/** `v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>` — what the server puts in X-Calab-Signature of a board webhook. */
export function signBoardWebhook(secret: string, timestamp: string | number, body: string | Uint8Array): string {
  return 'v1=' + createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

/**
 * Verifies a board webhook delivery (docs/19 «Вебхук доски»): X-Calab-Signature over the exact raw body and
 * X-Calab-Timestamp, which must be within ±5 minutes of `now` (unix seconds; replay protection). Constant-time compare.
 */
export function verifyBoardWebhook(
  secret: string,
  timestamp: string | null | undefined,
  body: string | Uint8Array,
  signature: string | null | undefined,
  now: number = Date.now() / 1000,
): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp)) > BOARD_WEBHOOK_TOLERANCE_SECONDS) return false;
  const want = Buffer.from(signBoardWebhook(secret, timestamp, body));
  const got = Buffer.from(signature.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Parses a board webhook body (protojson `BoardWebhookEvent`, snake_case names). Unknown fields are ignored. */
export function parseBoardWebhookEvent(body: string | Uint8Array): BoardWebhookEvent {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  return fromJsonString(BoardWebhookEventSchema, text, { ignoreUnknownFields: true });
}
