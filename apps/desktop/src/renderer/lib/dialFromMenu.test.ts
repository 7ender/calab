import { describe, expect, it, vi } from 'vitest';
import { dialFromMenu, type DialFromMenuDeps } from './dialFromMenu';

function deps(over: Partial<DialFromMenuDeps> = {}): DialFromMenuDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    inCall: () => false,
    openRoom: () => void log.push('openRoom'),
    join: () => {
      log.push('join');
      return Promise.resolve();
    },
    reveal: () => void log.push('reveal'),
    open: () => void log.push('open'),
    ...over,
  };
}

describe('dialFromMenu', () => {
  it('in the call: no join, opens the popover', async () => {
    const d = deps({ inCall: () => true });
    await dialFromMenu(d);
    expect(d.log).toEqual(['openRoom', 'reveal', 'open']);
  });

  it('not in the call: chat, join, then the popover once connected', async () => {
    let connected = false;
    const d = deps({
      inCall: () => connected,
      join: () => {
        d.log.push('join');
        connected = true;
        return Promise.resolve();
      },
    });
    await dialFromMenu(d);
    expect(d.log).toEqual(['openRoom', 'join', 'reveal', 'open']);
  });

  it('the popover is asked only after the join resolved', async () => {
    let connected = false;
    let done!: () => void;
    const open = vi.fn();
    const p = dialFromMenu(
      deps({
        inCall: () => connected,
        join: () =>
          new Promise<void>((r) => {
            done = () => {
              connected = true;
              r();
            };
          }),
        open,
      }),
    );
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
    done();
    await p;
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('join failed or pending: no popover', async () => {
    const d = deps();
    await dialFromMenu(d);
    expect(d.log).toEqual(['openRoom', 'join']);
  });
});
