import { RoomType } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { useUi } from '../stores/ui';
import { setVoice, useVoice } from '../stores/voice';
import { isVoicePreview, joinOutcome } from './voiceEntry';

const base = { inRoom: false, canConnect: true, canMove: false, people: 0, limit: 0 };

describe('joinOutcome', () => {
  it('joins a room with space', () => {
    expect(joinOutcome(base)).toBe('join');
    expect(joinOutcome({ ...base, people: 3, limit: 4 })).toBe('join');
  });
  it('does nothing when already in it or without CONNECT', () => {
    expect(joinOutcome({ ...base, inRoom: true, people: 4, limit: 4 })).toBe('none');
    expect(joinOutcome({ ...base, canConnect: false })).toBe('none');
  });
  it('a full room says so, unless I may move members', () => {
    expect(joinOutcome({ ...base, people: 4, limit: 4 })).toBe('full');
    expect(joinOutcome({ ...base, people: 4, limit: 4, canMove: true })).toBe('join');
  });
});

describe('voice room chat without voice (docs/09 #14)', () => {
  const voiceRoom = { id: 'v2', type: RoomType.VOICE };
  it('is a preview when I am not in that room’s voice', () => {
    expect(isVoicePreview(voiceRoom, null)).toBe(true);
    expect(isVoicePreview(voiceRoom, 'v1')).toBe(true);
    expect(isVoicePreview(voiceRoom, 'v2')).toBe(false);
    expect(isVoicePreview({ id: 't', type: RoomType.TEXT }, null)).toBe(false);
    expect(isVoicePreview(undefined, null)).toBe(false);
  });

  it('opening the chat keeps the call in another room', () => {
    setVoice({ roomId: 'v1', workspaceId: 'w' });
    useUi.getState().openRoom('w', 'v2');
    expect(useUi.getState().lastRoom['w']).toBe('v2');
    expect(useVoice.getState().roomId).toBe('v1');
    expect(isVoicePreview(voiceRoom, useVoice.getState().roomId)).toBe(true);
  });
});
