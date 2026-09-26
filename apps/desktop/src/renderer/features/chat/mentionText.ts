import { t } from '../../i18n';
import { parseMarkdown, toPlainText } from '../../lib/markdown/parse';
import { memberName, useWorkspaces } from '../../stores/workspaces';

/**
 * How a mention reads (docs/05, «Упоминания»): `@everyone` / `@here` as such, a user id as
 * `@<nickname-aware name>`, an id nobody here knows as «@неизвестный».
 */
export function mentionLabel(wsId: string | null, v: string): string {
  if (v === 'everyone' || v === 'here') return `@${v}`;
  const st = useWorkspaces.getState();
  const known = (wsId && st.byId[wsId]?.members[v]) || st.users[v];
  return known ? `@${memberName(wsId, v)}` : `@${t('chat.mentionUnknown')}`;
}

/** Reactive mentionLabel(): follows nickname / profile name changes. */
export function useMentionLabel(wsId: string | null, v: string): string {
  return useWorkspaces(() => mentionLabel(wsId, v));
}

/** One-line plain text of a message with mentions as names (previews, notifications, snippets). */
export function previewText(wsId: string | null, content: string): string {
  return toPlainText(parseMarkdown(content), (v) => mentionLabel(wsId, v));
}
