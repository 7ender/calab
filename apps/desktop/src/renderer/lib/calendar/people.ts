/*
 * The day view's «Люди» filter and «Подобрать время» chips (ADR-0041 §3): who is selected per
 * workspace, ≤ 20 (the server's free / busy limit), each with a colour of their column. Pure.
 */

/** Free / busy answers for at most 20 people at once (ADR-0041 §1). */
export const MAX_PEOPLE = 20;

/**
 * Column colours of «Доступность» (Apple Calendar): the avatar identity tokens, without green
 * (free windows are green) and grey (outside work hours is grey).
 */
export const PERSON_COLORS = ['var(--avatar-1)', 'var(--avatar-3)', 'var(--avatar-4)', 'var(--avatar-5)', 'var(--avatar-6)', 'var(--avatar-7)'] as const;

export const personColor = (index: number): string => PERSON_COLORS[((index % PERSON_COLORS.length) + PERSON_COLORS.length) % PERSON_COLORS.length] ?? 'var(--avatar-1)';

export type PeopleAction =
  | { type: 'add'; workspaceId: string; ids: readonly string[] }
  | { type: 'remove'; workspaceId: string; id: string }
  | { type: 'clear'; workspaceId: string }
  | { type: 'set'; workspaceId: string; ids: readonly string[] };

export type PeopleMap = Readonly<Record<string, readonly string[]>>;

/** Adds ids in order, without repeats, up to MAX_PEOPLE; `capped` = some did not fit. */
export function addPeople(list: readonly string[], ids: readonly string[]): { list: string[]; capped: boolean } {
  const out = [...list];
  let capped = false;
  for (const id of ids) {
    if (!id || out.includes(id)) continue;
    if (out.length >= MAX_PEOPLE) {
      capped = true;
      continue;
    }
    out.push(id);
  }
  return { list: out, capped };
}

/** The filter's reducer: a workspace without anyone selected has no entry. */
export function peopleReducer(state: PeopleMap, a: PeopleAction): PeopleMap {
  const cur = state[a.workspaceId] ?? [];
  let next: readonly string[];
  switch (a.type) {
    case 'add':
      next = addPeople(cur, a.ids).list;
      break;
    case 'set':
      next = addPeople([], a.ids).list;
      break;
    case 'remove':
      next = cur.filter((id) => id !== a.id);
      break;
    case 'clear':
      next = [];
      break;
  }
  if (next.length === cur.length && next.every((id, i) => id === cur[i])) return state;
  const out: Record<string, readonly string[]> = { ...state };
  if (next.length) out[a.workspaceId] = next;
  else delete out[a.workspaceId];
  return out;
}
