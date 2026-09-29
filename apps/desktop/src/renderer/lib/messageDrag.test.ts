import { describe, expect, it } from 'vitest';
import { MESSAGE_MIME, decodeDragged, encodeDragged, resolveDrop, type DropTarget } from './messageDrag';

const MSG = [MESSAGE_MIME, 'text/plain'];
const FILES = ['Files'];
const shelf = (roomId = 'shelf-1'): DropTarget => ({ kind: 'shelf', roomId, files: true, canSend: true });
const dm: DropTarget = { kind: 'dm', roomId: 'dm-1', files: false, canSend: true };
const dragged = { roomId: 'room-1', messageId: 'm-1' };

describe('resolveDrop', () => {
  it('forwards a message into another chat', () => {
    expect(resolveDrop(MSG, dragged, shelf())).toEqual({ kind: 'forward', fromRoomId: 'room-1', messageId: 'm-1', toRoomId: 'shelf-1' });
    expect(resolveDrop(MSG, dragged, dm)).toEqual({ kind: 'forward', fromRoomId: 'room-1', messageId: 'm-1', toRoomId: 'dm-1' });
  });

  it('never back into its own chat, nowhere without a room or the right to send', () => {
    expect(resolveDrop(MSG, { roomId: 'shelf-1', messageId: 'm' }, shelf())).toBeNull();
    expect(resolveDrop(MSG, dragged, shelf(''))).toBeNull();
    expect(resolveDrop(MSG, dragged, { ...dm, canSend: false })).toBeNull();
    expect(resolveDrop(MSG, null, dm)).toBeNull();
  });

  it('takes OS files on shelves only', () => {
    expect(resolveDrop(FILES, null, shelf())).toEqual({ kind: 'files', toRoomId: 'shelf-1' });
    expect(resolveDrop(FILES, null, dm)).toBeNull();
    expect(resolveDrop(['text/plain'], null, shelf())).toBeNull();
    expect(resolveDrop(null, dragged, shelf())).toBeNull();
  });

  it('a message drag wins over its image data', () => {
    expect(resolveDrop([MESSAGE_MIME, 'Files'], dragged, shelf())?.kind).toBe('forward');
  });
});

describe('drag data', () => {
  it('round-trips and rejects anything else', () => {
    expect(decodeDragged(encodeDragged(dragged))).toEqual(dragged);
    expect(decodeDragged('')).toBeNull();
    expect(decodeDragged('not json')).toBeNull();
    expect(decodeDragged('{"roomId":1}')).toBeNull();
    expect(decodeDragged('{"roomId":"a","messageId":""}')).toBeNull();
  });
});
