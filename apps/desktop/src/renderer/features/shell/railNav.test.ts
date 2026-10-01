import { beforeEach, describe, expect, it } from 'vitest';
import { useBoardsUi } from '../../stores/boardsUi';
import { useUi } from '../../stores/ui';
import { useWebApps } from '../../stores/webApps';
import { openWorkspaceVoice } from './railNav';

describe('workspace icon click', () => {
  beforeEach(() => {
    useBoardsUi.setState({ active: false });
    useWebApps.setState({ open: null });
    useUi.setState({ activeWorkspaceId: 'a', calDay: null, calEvent: null, miniCal: false, lastRoom: { a: 'r1', b: 'r2' } });
  });

  it('returns from the calendar to «Голос» of the same workspace', () => {
    useUi.getState().openCalendarDay('2026-09-30', null);
    openWorkspaceVoice('a');
    expect(useUi.getState().calDay).toBeNull();
    expect(useUi.getState().activeWorkspaceId).toBe('a');
    expect(useUi.getState().lastRoom.a).toBe('r1');
  });

  it('returns from the boards', () => {
    useBoardsUi.getState().setActive(true);
    openWorkspaceVoice('a');
    expect(useBoardsUi.getState().active).toBe(false);
  });

  it('closes an open web app', () => {
    useWebApps.setState({ open: 'app1' });
    openWorkspaceVoice('a');
    expect(useWebApps.getState().open).toBeNull();
  });

  it('another workspace opens on «Голос» too', () => {
    useBoardsUi.getState().setActive(true);
    openWorkspaceVoice('b');
    expect(useUi.getState().activeWorkspaceId).toBe('b');
    expect(useBoardsUi.getState().active).toBe(false);
    expect(useUi.getState().calDay).toBeNull();
  });
});
