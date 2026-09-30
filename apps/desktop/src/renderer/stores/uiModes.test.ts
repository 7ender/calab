import { beforeEach, describe, expect, it } from 'vitest';
import { useBoardsUi } from './boardsUi';
import { useUi } from './ui';

// The workspace modes (docs/09 #140): the day view and the boards are never on together, whichever
// path turns one of them on.
describe('workspace modes', () => {
  beforeEach(() => {
    useBoardsUi.setState({ active: false });
    useUi.setState({ calDay: null, calEvent: null });
  });

  it('a day opened (tab, a room meeting badge) turns the boards off', () => {
    useBoardsUi.getState().setActive(true);
    useUi.getState().openCalendarDay('2026-09-30', null);
    expect(useBoardsUi.getState().active).toBe(false);
    expect(useUi.getState().calDay).toBe('2026-09-30');
  });

  it('the boards turned on from anywhere close the day view', () => {
    useUi.getState().openCalendarDay('2026-09-30', 'e@1');
    useBoardsUi.getState().openBoard('ws', 'mine');
    expect(useUi.getState().calDay).toBeNull();
    expect(useUi.getState().calEvent).toBeNull();

    useUi.getState().openCalendarDay('2026-09-30', null);
    useBoardsUi.getState().toggle();
    expect(useUi.getState().calDay).toBeNull();
    expect(useBoardsUi.getState().active).toBe(true);
  });

  it('a room opened leaves both', () => {
    useBoardsUi.getState().setActive(true);
    useUi.getState().openRoom('ws', 'room');
    expect(useBoardsUi.getState().active).toBe(false);
    expect(useUi.getState().calDay).toBeNull();
  });
});
