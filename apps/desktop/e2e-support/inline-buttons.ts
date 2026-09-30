import { create } from '@bufbuild/protobuf';
import { InlineKeyboardSchema, type Message } from '@calaba/protocol';
import { IDS, type MockServer } from './mock-server';

/** A public, author-bound bot draft shared by the desktop/mobile/behaviour checks. */
export function seedInlineButtons(mock: MockServer): Message {
  mock.seedBots();
  const m = mock.injectMessage({ roomId: IDS.rooms.general, authorId: IDS.bots.deploy, content: 'Черновик готов. Подтвердите действие или предложите правки.' });
  m.inlineKeyboard = create(InlineKeyboardSchema, {
    allowedUserIds: [IDS.users.anna],
    rows: [{ buttons: [
      { id: 'confirm', label: 'Подтвердить', data: 'draft:v1' },
      { id: 'revise', label: 'Изменить' },
    ] }, { buttons: [{ id: 'unavailable', label: 'Недоступно', disabled: true }] }],
  });
  m.keyboardRevision = 1n;
  mock.dispatch({ event: { case: 'messageUpdate', value: { workspaceId: IDS.workspaces.main, message: m } } });
  return m;
}
