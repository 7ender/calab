import { describe, expect, it } from 'vitest';
import { workspaceInitials } from './initials';

describe('workspaceInitials', () => {
  it('two words → first letters, uppercase', () => {
    expect(workspaceInitials('Команда Calab')).toBe('КC');
    expect(workspaceInitials('design team')).toBe('DT');
  });
  it('one word → first two letters, uppercase', () => {
    expect(workspaceInitials('Дизайн')).toBe('ДИ');
    expect(workspaceInitials('x')).toBe('X');
  });
  it('ignores punctuation and emoji-only words', () => {
    expect(workspaceInitials('  «Сообщество» — открытое  ')).toBe('СО');
    expect(workspaceInitials('🚀 Launch')).toBe('LA');
    expect(workspaceInitials('')).toBe('?');
  });
});
