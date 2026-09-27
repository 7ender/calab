import type { Reaction } from '@calaba/protocol';

/** Different emojis one user may put on one message: the server's messages.MaxReactionsPerUser. */
export const MAX_REACTIONS_PER_USER = 3;

/** How many different emojis the viewer has on the message. */
export function myReactionCount(reactions: readonly Reaction[]): number {
  return reactions.filter((r) => r.me).length;
}

/** The viewer has used all the reactions allowed on this message (docs/09 #27). */
export function reactionLimitReached(reactions: readonly Reaction[]): boolean {
  return myReactionCount(reactions) >= MAX_REACTIONS_PER_USER;
}

/** Toggling `emoji` is allowed: removing an own reaction always is, adding only below the limit. */
export function canToggleReaction(reactions: readonly Reaction[], emoji: string): boolean {
  return reactions.some((r) => r.emoji === emoji && r.me) || !reactionLimitReached(reactions);
}
