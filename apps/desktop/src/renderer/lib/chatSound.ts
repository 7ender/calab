/**
 * When an incoming chat message makes a sound (docs/09 P1 #13). Pure: the caller gathers the
 * facts, services/notify.ts plays the result through lib/sounds (the rate limit lives there).
 */

/** «В открытом чате» — a message in the chat on screen (window focused): a quieter cue, or none. */
export type OpenChatSound = 'off' | 'quiet';

/** Volume multiplier of the quieter open-chat cue. */
export const OPEN_CHAT_QUIET_VOLUME = 0.35;

export interface ChatSoundFacts {
  /** The message is mine (another device of mine): never a sound. */
  own: boolean;
  /** A mention of me, or any DM message (ADR-0020). */
  mention: boolean;
  /** Its chat is open and the window has focus. */
  visible: boolean;
  /** The room is muted or its level is NONE. */
  quiet: boolean;
  /** The room's level is MENTIONS. */
  mentionsOnly: boolean;
  /** Presence «Не беспокоить». */
  dnd: boolean;
  openChat: OpenChatSound;
}

export interface ChatSound {
  name: 'mention' | 'message';
  /** Multiplier on the user's sound volume. */
  volume: number;
}

export function chatSound(f: ChatSoundFacts): ChatSound | null {
  if (f.own || f.quiet || f.dnd) return null;
  if (f.mentionsOnly && !f.mention) return null;
  const name = f.mention ? 'mention' : 'message';
  if (f.visible) return f.openChat === 'quiet' ? { name, volume: OPEN_CHAT_QUIET_VOLUME } : null;
  return { name, volume: 1 };
}
