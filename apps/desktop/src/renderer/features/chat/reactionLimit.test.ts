import { create } from '@bufbuild/protobuf';
import { ReactionSchema, type Reaction } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { canToggleReaction, MAX_REACTIONS_PER_USER, myReactionCount, reactionLimitReached } from './reactionLimit';

const r = (emoji: string, me: boolean, count = 1): Reaction => create(ReactionSchema, { emoji, me, count });

describe('reaction limit (docs/09 #27)', () => {
  it('counts only the viewer’s own emojis', () => {
    const rs = [r('👍', true, 3), r('❤️', false, 5), r('😂', true)];
    expect(myReactionCount(rs)).toBe(2);
    expect(reactionLimitReached(rs)).toBe(false);
    expect(canToggleReaction(rs, '🎉')).toBe(true);
  });

  it('at the limit: new emojis are blocked, own ones can be removed', () => {
    const rs = [r('👍', true), r('❤️', true), r('😂', true), r('🎉', false, 2)];
    expect(MAX_REACTIONS_PER_USER).toBe(3);
    expect(reactionLimitReached(rs)).toBe(true);
    expect(canToggleReaction(rs, '❤️')).toBe(true); // remove own
    expect(canToggleReaction(rs, '🎉')).toBe(false); // join someone else's
    expect(canToggleReaction(rs, '🔥')).toBe(false); // brand new
  });

  it('others’ reactions do not count towards the viewer’s limit', () => {
    const rs = [r('👍', false, 9), r('❤️', false), r('😂', false), r('🎉', false)];
    expect(reactionLimitReached(rs)).toBe(false);
    expect(canToggleReaction(rs, '👍')).toBe(true);
  });
});
