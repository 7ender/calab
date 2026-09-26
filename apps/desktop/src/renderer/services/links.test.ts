import { describe, expect, it, vi } from 'vitest';

vi.mock('../stores/session', () => ({ useSession: { getState: () => ({ status: 'anon' }) } }));
vi.mock('../stores/ui', () => ({ useUi: { getState: () => ({ openDialog: () => undefined }) } }));
vi.mock('../features/people/roomLink', () => ({ openRoomLink: () => undefined }));

const { inviteUrl, parseInviteCode, parseRoomInviteCode, roomInviteUrl } = await import('./links');

describe('invite links', () => {
  it('parses https links, deep links and bare codes', () => {
    expect(parseInviteCode('https://colaba.gptunnel.ai/join/AbC_12-x')).toBe('AbC_12-x');
    expect(parseInviteCode(' https://example.org/join/abcd1234/ ')).toBe('abcd1234');
    expect(parseInviteCode('http://localhost:4173/join/abcd1234?utm=x')).toBe('abcd1234');
    expect(parseInviteCode('calaba://join/abcd1234')).toBe('abcd1234');
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
    expect(inviteUrl('', 'abcd1234')).toBe('calaba://join/abcd1234');
  });
});

describe('room links', () => {
  it('parses https and deep links', () => {
    expect(parseRoomInviteCode('https://colaba.gptunnel.ai/r/AbC_12-x')).toBe('AbC_12-x');
    expect(parseRoomInviteCode(' http://localhost:5183/r/abcd1234/?x=1 ')).toBe('abcd1234');
    expect(parseRoomInviteCode('calaba://r/abcd1234')).toBe('abcd1234');
  });
  it('rejects bare codes and workspace invites', () => {
    expect(parseRoomInviteCode('abcd1234')).toBeNull();
    expect(parseRoomInviteCode('https://example.org/join/abcd1234')).toBeNull();
    expect(parseInviteCode('https://example.org/r/abcd1234')).toBeNull();
    expect(parseRoomInviteCode('https://example.org/r/abcd1234/extra')).toBeNull();
  });
  it('builds the shareable link', () => {
    expect(roomInviteUrl('https://colaba.gptunnel.ai/', 'abcd1234')).toBe('https://colaba.gptunnel.ai/r/abcd1234');
    expect(roomInviteUrl('', 'abcd1234')).toBe('calaba://r/abcd1234');
  });
});
