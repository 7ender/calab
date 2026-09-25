import type { CalabaApi } from '../../preload/api';

/**
 * Platform layer (ADR-0015): everything the renderer needs from its host.
 * `electron` — preload bridge (IPC to main); `web` — browser APIs, same-origin API.
 */
export interface Platform extends CalabaApi {
  kind: 'electron' | 'web';
  /** Prefix for API paths (`calaba-api://api` in Electron, '' on the web = same origin). */
  apiBase: string;
  /** Authenticated API request (Bearer + one refresh-and-retry on 401 where needed). */
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
  /** Headers for requests the platform cannot wrap itself (XHR uploads). */
  authHeaders(): Promise<Record<string, string>>;
  /**
   * URL usable in <img>/<video> for an API media path. Electron: direct (main adds auth).
   * Web: a blob: URL of an authenticated fetch (cached).
   */
  mediaUrl(path: string): Promise<string>;
  /** Whether the platform can hand out a synchronous media URL (no blob fetch needed). */
  directMedia: boolean;
}
