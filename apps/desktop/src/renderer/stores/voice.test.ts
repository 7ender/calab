import { describe, expect, it } from 'vitest';
import { streamCoversChat, type RemoteStream, type VoiceStore } from './voice';

const stream = (trackSid: string): RemoteStream => ({ trackSid, userId: 'u', identity: `u:${trackSid}`, hasAudio: false });

type Slice = Pick<VoiceStore, 'roomId' | 'stage' | 'streams' | 'watching'>;
const state = (p: Partial<Slice> = {}): Slice => ({ roomId: 'a', stage: 'expanded', streams: [stream('t1')], watching: 't1', ...p });

// Issue #35: the chat behind the stream stage / stream full screen is not on screen —
// messages there count as unread and the read marker must not move.
describe('streamCoversChat', () => {
  it('covers while the room watches a stream on the stage', () => {
    expect(streamCoversChat(state(), 'a')).toBe(true);
    // The pop-out keeps the covering stage placeholder in this window.
    expect(streamCoversChat(state({ stage: 'popout' }), 'a')).toBe(true);
  });

  it('the PiP leaves the feed visible', () => {
    expect(streamCoversChat(state({ stage: 'pip' }), 'a')).toBe(false);
  });

  it('stream full screen covers even at the pip stage flag', () => {
    expect(streamCoversChat(state({ stage: 'pip' }), 'a', true)).toBe(true);
    expect(streamCoversChat(state(), 'a', true)).toBe(true);
  });

  it('only the room that shows the stream is covered', () => {
    expect(streamCoversChat(state(), 'b')).toBe(false);
    expect(streamCoversChat(state({ roomId: null }), 'a')).toBe(false);
  });

  it('no watched stream — nothing covers (live bar / empty)', () => {
    expect(streamCoversChat(state({ watching: null }), 'a')).toBe(false);
    expect(streamCoversChat(state({ watching: 'gone' }), 'a')).toBe(false);
    expect(streamCoversChat(state({ streams: [] }), 'a')).toBe(false);
    expect(streamCoversChat(state({ watching: null }), 'a', true)).toBe(false);
  });
});
