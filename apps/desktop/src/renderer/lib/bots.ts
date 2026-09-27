import type { BotWebhook } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';

/*
 * Bots on the client (ADR-0031), pure: username rules as the server checks them, the plan's
 * bot slots and the webhook state of a bot row («Настройки пространства → Боты»).
 */

/** The server's username rule: 3..32 of a-z, 0-9, _ (stored lower case). */
const USERNAME = /^[a-z0-9_]{3,32}$/;

/** What the field keeps while typing: lower case, no «@», no characters the server refuses. */
export function normalizeUsername(v: string): string {
  return v
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 32);
}

export const validBotUsername = (v: string): boolean => USERNAME.test(v);

/** Bots against the plan (PlanLimits.bots, 0 = no limit): whether one more fits. */
export function botSlots(used: number, limit: number): { used: number; limit: number; full: boolean } {
  return { used, limit, full: limit > 0 && used >= limit };
}

export type WebhookState =
  | { kind: 'none' }
  | { kind: 'ok'; lastOk: Date | null; pending: number }
  | { kind: 'failing'; since: Date; error: string; pending: number }
  | { kind: 'disabled'; at: Date | null; error: string };

/**
 * A bot's webhook as its row tells it: none (events over the gateway), delivering (the last
 * success), failing since … (the last error, retries queued), or switched off after a day of
 * errors (PUT …/webhook turns it back on).
 */
export function webhookState(w: BotWebhook | undefined): WebhookState {
  if (!w || (!w.url && !w.disabledAt)) return { kind: 'none' };
  if (w.disabledAt || !w.enabled) return { kind: 'disabled', at: w.disabledAt ? timestampDate(w.disabledAt) : null, error: w.lastError };
  if (w.failingSince) return { kind: 'failing', since: timestampDate(w.failingSince), error: w.lastError, pending: w.pending };
  return { kind: 'ok', lastOk: w.lastOkAt ? timestampDate(w.lastOkAt) : null, pending: w.pending };
}
