import { describe, expect, it, vi } from 'vitest';

vi.mock('../stores/session', () => ({ useSession: { getState: () => ({ status: 'anon' }) } }));
vi.mock('../stores/ui', () => ({ useUi: { getState: () => ({ openDialog: () => undefined }) } }));

const { inviteUrl, parseInviteCode } = await import('./links');

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
