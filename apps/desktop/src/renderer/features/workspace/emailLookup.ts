import type { InviteLookupResponse, User } from '@calaba/protocol';
import { errorText, isAbort } from '../../lib/api/errors';
import { isEmail } from '../auth/emailCode';

/** Pause after the last keystroke before the lookup (ADR-0023: 20 lookups a minute per user). */
export const LOOKUP_DEBOUNCE_MS = 400;

export type LookupState =
  | { kind: 'idle' }
  /** Not an email yet: no request, no error while typing. */
  | { kind: 'typing' }
  | { kind: 'searching'; email: string }
  | { kind: 'found'; email: string; user: User; member: boolean }
  | { kind: 'none'; email: string }
  | { kind: 'error'; email: string; text: string };

export interface LookupDeps {
  lookup: (email: string, signal: AbortSignal) => Promise<InviteLookupResponse>;
  onChange: (s: LookupState) => void;
}

/**
 * «Пригласить по email» search without React (unit-tested): only a well-formed address is looked
 * up, 400 ms after the last keystroke; a newer input aborts the request in flight, so a late
 * answer never overwrites the card of the current address.
 */
export class EmailLookup {
  state: LookupState = { kind: 'idle' };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ctrl: AbortController | null = null;

  constructor(private readonly deps: LookupDeps) {}

  private set(s: LookupState): void {
    this.state = s;
    this.deps.onChange(s);
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ctrl?.abort();
    this.ctrl = null;
  }

  input(value: string): void {
    this.cancel();
    const email = value.trim();
    if (!email || !isEmail(email)) {
      this.set({ kind: email ? 'typing' : 'idle' });
      return;
    }
    this.set({ kind: 'searching', email });
    this.timer = setTimeout(() => void this.run(email), LOOKUP_DEBOUNCE_MS);
  }

  /** Look the current address up again (after an add / invite changed the answer). */
  refresh(): void {
    if (this.state.kind === 'idle' || this.state.kind === 'typing') return;
    const email = this.state.email;
    this.cancel();
    void this.run(email);
  }

  private async run(email: string): Promise<void> {
    this.timer = null;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.set({ kind: 'searching', email });
    try {
      const r = await this.deps.lookup(email, ctrl.signal);
      if (ctrl.signal.aborted) return;
      this.set(r.user ? { kind: 'found', email, user: r.user, member: r.member } : { kind: 'none', email });
    } catch (e) {
      if (ctrl.signal.aborted || isAbort(e)) return;
      this.set({ kind: 'error', email, text: errorText(e) });
    } finally {
      if (this.ctrl === ctrl) this.ctrl = null;
    }
  }

  dispose(): void {
    this.cancel();
  }
}
