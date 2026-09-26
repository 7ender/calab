import { describe, expect, it } from 'vitest';
import { SOUND_EVENTS } from '../../lib/sounds';
import { GROUPS } from './SoundSettings';

describe('sound settings', () => {
  it('lists every event exactly once', () => {
    const listed = GROUPS.flatMap((g) => g.names);
    expect([...listed].sort()).toEqual([...SOUND_EVENTS].sort());
  });
});
