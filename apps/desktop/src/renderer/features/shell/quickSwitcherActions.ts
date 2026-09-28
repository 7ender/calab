/**
 * ⌘K result actions (docs/09 #66): what a row does, so the click / Enter is never a surprise.
 * A voice room (I may connect): «Подключиться» (Enter) and «Открыть чат» (⇧Enter / ⌘Enter) —
 * the chat opens without joining the voice. Everything else — one «Открыть».
 */

export type SwitcherAction = 'join' | 'chat' | 'open';

/** The part of a row that decides its actions. */
export interface SwitcherRowKind {
  kind: 'dm' | 'room' | 'member' | 'message';
  voice?: boolean;
  /** CONNECT in that voice room: without it the only action is to read its chat. */
  canConnect?: boolean;
}

const JOIN_CHAT: readonly SwitcherAction[] = ['join', 'chat'];
const CHAT_ONLY: readonly SwitcherAction[] = ['chat'];
const OPEN: readonly SwitcherAction[] = ['open'];

/** The row's actions, the primary (Enter, click on the row) first. */
export function rowActions(r: SwitcherRowKind): readonly SwitcherAction[] {
  if (r.kind === 'room' && r.voice) return r.canConnect ? JOIN_CHAT : CHAT_ONLY;
  return OPEN;
}

/** Enter — the primary action; ⇧Enter or ⌘/Ctrl+Enter — the second one, if the row has it. */
export function keyAction(r: SwitcherRowKind, keys: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): SwitcherAction {
  const acts = rowActions(r);
  const second = keys.shiftKey || keys.metaKey || keys.ctrlKey;
  return (second ? acts[1] : undefined) ?? acts[0] ?? 'open';
}
