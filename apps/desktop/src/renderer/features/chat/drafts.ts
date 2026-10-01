/** Draft content stays in memory and is scoped to rooms for identity revocation. */
export const drafts = new Map<string, string>();
export const draftMentions = new Map<string, Map<string, string>>();
export function clearRoomDrafts(roomIds: ReadonlySet<string>): void {
  for (const id of roomIds) {
    drafts.delete(id);
    draftMentions.delete(id);
  }
}
