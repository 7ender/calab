/**
 * Per-tab gateway identity (#40, proto Identify.tab_id). Tabs of one browser share the auth
 * session, so the server tells their gateway sessions apart by this id: random per tab, kept in
 * sessionStorage so a reload replaces its own leftover session instead of piling up new ones.
 * Chrome's «Duplicate tab» copies sessionStorage: the copy then replaces the original's session
 * (close 4000 «replaced by a new session»), and the original calls renew() — no loop.
 * The desktop app sends no tab id (one window = one device).
 */

export const TAB_ID_KEY = 'calaba.gatewayTab';
/** Server rule (gateway/tabs.go validTabID): 1–64 of [A-Za-z0-9_-]. */
export const TAB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type TabStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function randomTabId(): string {
  const c = globalThis.crypto;
  // randomUUID exists only in secure contexts (https, localhost).
  if (typeof (c as Partial<Crypto>).randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export class TabId {
  private id = '';

  constructor(
    private readonly storage: TabStorage | null,
    private readonly gen: () => string = randomTabId,
  ) {}

  /** This tab's id: from sessionStorage when valid, else a new one (stored best effort). */
  get(): string {
    if (this.id) return this.id;
    let stored: string | null = null;
    try {
      stored = this.storage?.getItem(TAB_ID_KEY) ?? null;
    } catch {
      // storage blocked (private mode, sandbox): an in-memory id still works for this page
    }
    if (stored && TAB_ID_RE.test(stored)) this.id = stored;
    else this.renew();
    return this.id;
  }

  /** A new id for this tab (another tab took over the old one). */
  renew(): string {
    this.id = this.gen();
    try {
      this.storage?.setItem(TAB_ID_KEY, this.id);
    } catch {
      // see get()
    }
    return this.id;
  }
}
