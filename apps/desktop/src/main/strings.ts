import { MAIN_STRING_KEYS, type MainStrings } from '../shared/ipc';

/**
 * The few strings main shows itself (tray menu, update notification, stream window title). The
 * dictionaries live in the renderer (ADR-0022): it pushes the translated set on start and on
 * every language change; until then main uses the Russian source strings.
 */
let strings: MainStrings = {
  trayOpen: 'Открыть Calab',
  trayMute: 'Выключить микрофон',
  trayDeafen: 'Выключить звук',
  trayDisconnect: 'Отключиться от голоса',
  trayQuit: 'Выход',
  trayInVoice: 'Calab — в голосе',
  trayInVoiceMuted: 'Calab — в голосе (микрофон выкл.)',
  updateAvailable: 'Доступна версия {version} — Скачать',
  trayRestartUpdate: 'Перезапустить для обновления {version}',
  streamWindow: 'Calab — стрим',
  quitInCall: 'Вы в голосовой комнате. Выйти из Calab?',
  quitInCallDetail: 'Звонок прервётся.',
  quitConfirm: 'Выйти',
  quitCancel: 'Отмена',
  trayHintTitle: 'Calab продолжает работать в трее',
  trayHintBody: 'Звонок не прерывается. Выйти — через меню значка в трее.',
};

const listeners = new Set<() => void>();

export const mainStrings = (): MainStrings => strings;

/** Validates an IPC payload: every key a non-empty string (≤ 200 chars); anything else is ignored. */
export function parseMainStrings(v: unknown): MainStrings | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const out = { ...strings };
  for (const k of MAIN_STRING_KEYS) {
    const s = r[k];
    if (typeof s !== 'string' || !s || s.length > 200) return null;
    out[k] = s;
  }
  return out;
}

export function setMainStrings(next: MainStrings): void {
  strings = next;
  for (const l of listeners) l();
}

export function onMainStrings(cb: () => void): void {
  listeners.add(cb);
}
