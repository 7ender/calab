import { VoiceStreamStopReason, type DispatchEvent, type Message } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { log } from '../lib/log';
import { useMessages } from '../stores/messages';
import { toast } from '../stores/toasts';
import { useRooms } from '../stores/rooms';
import { myUserId, useSession } from '../stores/session';
import { activeRoomId, useUi } from '../stores/ui';
import { useVoice } from '../stores/voice';
import { useWorkspaces } from '../stores/workspaces';
import { onIncomingMessage } from './notify';
import { applyUserSettings } from './profile';
import { fetchLatestMessages } from './unread';
import { voice } from './voice';

const TYPING_MS = 8000;

/** Applies one gateway DISPATCH event to the stores. */
export function applyDispatch(ev: DispatchEvent): void {
  const e = ev.event;
  switch (e.case) {
    case 'ready': {
      const r = e.value;
      const ws = useWorkspaces.getState();
      const rooms = useRooms.getState();
      ws.reset();
      rooms.reset();
      useMessages.getState().reset();
      for (const snap of r.workspaces) {
        ws.applySnapshot(snap);
        rooms.upsertMany(snap.rooms);
      }
      for (const rs of r.readStates) rooms.setRead(rs.roomId, rs.lastReadMessageId);
      useSession.getState().set({ me: r.me ?? null, ready: true });
      if (r.me?.settings) applyUserSettings(r.me.settings);
      ensureActiveWorkspace();
      void fetchLatestMessages(Object.keys(useRooms.getState().byId));
      return;
    }
    case 'resumed':
      log.info(`gateway resumed, replayed ${e.value.replayed}`);
      return;
    case 'workspaceCreate': {
      const snap = e.value.snapshot;
      if (!snap) return;
      useWorkspaces.getState().applySnapshot(snap);
      useRooms.getState().upsertMany(snap.rooms);
      ensureActiveWorkspace();
      void fetchLatestMessages(snap.rooms.map((r) => r.id));
      return;
    }
    case 'workspaceUpdate':
      if (e.value.workspace) useWorkspaces.getState().updateWorkspace(e.value.workspace);
      return;
    case 'workspaceDelete': {
      const id = e.value.workspaceId;
      useWorkspaces.getState().remove(id);
      useRooms.getState().removeWorkspace(id);
      if (useVoice.getState().workspaceId === id) void voice.leave();
      if (useUi.getState().activeWorkspaceId === id) useUi.getState().setWorkspace(null);
      ensureActiveWorkspace();
      return;
    }
    case 'workspaceMemberAdd':
    case 'workspaceMemberUpdate':
      if (e.value.member) useWorkspaces.getState().upsertMember(e.value.member);
      return;
    case 'workspaceMemberRemove':
      useWorkspaces.getState().removeMember(e.value.workspaceId, e.value.userId);
      return;
    case 'roomCreate':
    case 'roomUpdate':
      if (e.value.room) useRooms.getState().upsert(e.value.room);
      return;
    case 'roomDelete': {
      useRooms.getState().remove(e.value.roomId);
      useMessages.getState().unload(e.value.roomId);
      if (voice.currentRoomId === e.value.roomId) void voice.leave();
      return;
    }
    case 'roomPermissionsUpdate':
      useRooms.getState().setOverrides(e.value.roomId, e.value.permissions);
      return;
    case 'messageCreate':
      if (e.value.message) onMessage(e.value.message, e.value.workspaceId);
      return;
    case 'messageUpdate':
      if (e.value.message) useMessages.getState().upsert(e.value.message);
      return;
    case 'messageDelete':
      useMessages.getState().remove(e.value.roomId, e.value.messageId);
      return;
    case 'typingStart': {
      const { roomId, userId } = e.value;
      if (userId === myUserId()) return;
      const at = e.value.timestamp ? timestampMs(e.value.timestamp) : Date.now();
      const until = Math.max(Date.now(), at) + TYPING_MS;
      useMessages.getState().setTyping(roomId, userId, until);
      window.setTimeout(() => {
        const cur = useMessages.getState().typing[roomId]?.[userId];
        if (cur !== undefined && cur <= Date.now()) useMessages.getState().clearTyping(roomId, userId);
      }, TYPING_MS + 50);
      return;
    }
    case 'presenceUpdate':
      if (e.value.presence) useWorkspaces.getState().setPresence(e.value.presence);
      return;
    case 'voiceStateUpdate':
      if (e.value.state) {
        useWorkspaces.getState().setVoiceState(e.value.state);
        // Our optimistic PATCH /api/voice/self may have raced the server learning we joined (409).
        if (e.value.state.userId === myUserId()) voice.reconcileSelfState(e.value.state);
      }
      return;
    case 'voiceStreamStart':
    case 'voiceStreamStop':
      // Our own room's streams come from LiveKit; the sidebar uses VoiceState.streaming.
      if (e.case === 'voiceStreamStop' && e.value.userId === myUserId()) {
        if (e.value.reason === VoiceStreamStopReason.LIMIT_REACHED) toast.info('Стрим остановлен: в комнате превышен лимит стримов');
        if (e.value.reason === VoiceStreamStopReason.MODERATOR) toast.info('Модератор остановил ваш стрим');
        if (e.value.reason !== VoiceStreamStopReason.ENDED) void voice.stopStream();
      }
      return;
    case 'readStateUpdate':
      if (e.value.readState) useRooms.getState().setRead(e.value.readState.roomId, e.value.readState.lastReadMessageId);
      return;
    case 'userUpdate':
      if (e.value.me) {
        useSession.getState().set({ me: e.value.me });
        if (e.value.me.user) useWorkspaces.getState().upsertUser(e.value.me.user);
        if (e.value.me.settings) applyUserSettings(e.value.me.settings);
      }
      return;
    default:
      return;
  }
}

function onMessage(m: Message, workspaceId: string): void {
  useMessages.getState().upsert(m);
  const rooms = useRooms.getState();
  rooms.setLastMessage(m.roomId, m.id);
  if (m.authorId === myUserId()) {
    rooms.setRead(m.roomId, m.id);
    return;
  }
  onIncomingMessage(m, workspaceId, activeRoomId() === m.roomId && document.hasFocus());
}

/** Keeps a valid workspace selected after READY / membership changes. */
export function ensureActiveWorkspace(): void {
  const ui = useUi.getState();
  const { byId, order } = useWorkspaces.getState();
  if (ui.activeWorkspaceId && byId[ui.activeWorkspaceId]) return;
  ui.setWorkspace(order[0] ?? null);
}
