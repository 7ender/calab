/**
 * «Упомянуть» from a member menu: the open room's composer appends `@name ` to its draft and
 * takes focus (Composer listens). A window event keeps the menu free of the composer's state.
 */
export const MENTION_EVENT = 'calaba:mention';

export interface MentionRequest {
  userId: string;
  name: string;
}

export function requestMention(userId: string, name: string): void {
  window.dispatchEvent(new CustomEvent<MentionRequest>(MENTION_EVENT, { detail: { userId, name } }));
}
