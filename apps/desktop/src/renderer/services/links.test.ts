import { afterEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ status: 'anon', settings: null as { serverUrl: string } | null }));
vi.mock('../stores/session', () => ({ useSession: { getState: () => session } }));
vi.mock('../stores/ui', () => ({ useUi: { getState: () => ({ openDialog: () => undefined }) } }));
vi.mock('../features/people/roomLink', () => ({ openRoomLink: () => undefined }));

const { INVITE_EXAMPLE_CODE, inviteUrl, joinPlaceholder, parseInviteCode, parseRoomInviteCode, roomInviteUrl } = await import('./links');

describe('invite links', () => {
  it('parses https links, deep links and bare codes', () => {
    expect(parseInviteCode('https://colaba.gptunnel.ai/join/AbC_12-x')).toBe('AbC_12-x');
    expect(parseInviteCode(' https://example.org/join/abcd1234/ ')).toBe('abcd1234');
    expect(parseInviteCode('http://localhost:4173/join/abcd1234?utm=x')).toBe('abcd1234');
    expect(parseInviteCode('calab://join/abcd1234')).toBe('abcd1234');
    expect(parseInviteCode('calaba://join/abcd1234')).toBe('abcd1234'); // legacy scheme
    expect(parseInviteCode('abcd1234')).toBe('abcd1234');
  });
  it('rejects anything else', () => {
    expect(parseInviteCode('https://example.org/rooms/abcd1234')).toBeNull();
    expect(parseInviteCode('abc')).toBeNull();
    expect(parseInviteCode('https://example.org/join/abcd1234/extra')).toBeNull();
  });
  it('builds the shareable link from the server URL', () => {
    expect(inviteUrl('https://colaba.gptunnel.ai', 'abcd1234')).toBe('https://colaba.gptunnel.ai/join/abcd1234');
    expect(inviteUrl('https://colaba.gptunnel.ai/', 'abcd1234')).toBe('https://colaba.gptunnel.ai/join/abcd1234');
  });
});

describe('shared links are https only (docs/09 #53)', () => {
  afterEach(() => {
    session.settings = null;
    vi.unstubAllEnvs();
  });
  it('never falls back to a deep link', () => {
    expect(inviteUrl('', 'abcd1234')).toBeNull();
    expect(roomInviteUrl('', 'abcd1234')).toBeNull();
    expect(inviteUrl('calab://join', 'abcd1234')).toBeNull();
  });
  it('falls back to the configured server URL', () => {
    session.settings = { serverUrl: 'https://app.calab.ru/' };
    expect(inviteUrl('', 'abcd1234')).toBe('https://app.calab.ru/join/abcd1234');
    expect(roomInviteUrl('', 'abcd1234')).toBe('https://app.calab.ru/r/abcd1234');
  });
  it('prefers the session server over settings', () => {
    session.settings = { serverUrl: 'https://old.example.org' };
    expect(inviteUrl('https://app.calab.ru', 'abcd1234')).toBe('https://app.calab.ru/join/abcd1234');
  });
  it('on the web uses the page origin', () => {
    vi.stubEnv('VITE_PLATFORM', 'web');
    vi.stubGlobal('location', { origin: 'https://app.calab.ru' });
    try {
      expect(inviteUrl('', 'abcd1234')).toBe('https://app.calab.ru/join/abcd1234');
      expect(roomInviteUrl('', 'abcd1234')).toBe('https://app.calab.ru/r/abcd1234');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('does not use the page origin in the desktop app (file:// or the dev server)', () => {
    vi.stubGlobal('location', { origin: 'http://localhost:5173' });
    try {
      expect(inviteUrl('', 'abcd1234')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('room links', () => {
  it('parses https and deep links', () => {
    expect(parseRoomInviteCode('https://colaba.gptunnel.ai/r/AbC_12-x')).toBe('AbC_12-x');
    expect(parseRoomInviteCode(' http://localhost:5183/r/abcd1234/?x=1 ')).toBe('abcd1234');
    expect(parseRoomInviteCode('calab://r/abcd1234')).toBe('abcd1234');
    expect(parseRoomInviteCode('calaba://r/abcd1234')).toBe('abcd1234'); // legacy scheme
  });
  it('rejects bare codes and workspace invites', () => {
    expect(parseRoomInviteCode('abcd1234')).toBeNull();
    expect(parseRoomInviteCode('https://example.org/join/abcd1234')).toBeNull();
    expect(parseInviteCode('https://example.org/r/abcd1234')).toBeNull();
    expect(parseRoomInviteCode('https://example.org/r/abcd1234/extra')).toBeNull();
  });
  it('builds the shareable link', () => {
    expect(roomInviteUrl('https://colaba.gptunnel.ai/', 'abcd1234')).toBe('https://colaba.gptunnel.ai/r/abcd1234');
  });
});

describe('join dialog placeholder', () => {
  afterEach(() => {
    session.settings = null;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it('is a real-looking link on the session server', () => {
    expect(joinPlaceholder('https://app.calab.ru')).toBe('https://app.calab.ru/join/AbC123xYz');
    expect(joinPlaceholder('https://app.calab.ru/')).toBe('https://app.calab.ru/join/AbC123xYz');
  });
  it('falls back to the configured server, then to the web page origin', () => {
    session.settings = { serverUrl: 'https://team.example.org' };
    expect(joinPlaceholder('')).toBe('https://team.example.org/join/AbC123xYz');
    session.settings = null;
    vi.stubEnv('VITE_PLATFORM', 'web');
    vi.stubGlobal('location', { origin: 'https://web.example.org' });
    expect(joinPlaceholder('')).toBe('https://web.example.org/join/AbC123xYz');
  });
  it('is the bare example code without a server', () => {
    expect(joinPlaceholder('')).toBe('AbC123xYz');
  });
  it('the example itself is accepted by the parser (it shows a valid shape)', () => {
    expect(parseInviteCode(joinPlaceholder('https://app.calab.ru'))).toBe(INVITE_EXAMPLE_CODE);
    expect(parseInviteCode(joinPlaceholder(''))).toBe(INVITE_EXAMPLE_CODE);
  });
});
