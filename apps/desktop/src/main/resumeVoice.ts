import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';
import { IPC } from '../shared/ipc';
import { parseResumeSeat, parseResumeVoice, type ResumeVoice } from '../shared/resumeVoice';
import { currentServerUrl } from './auth';
import { getMainWindow } from './windows';

/**
 * Back into the same room / call after a restart for an update (docs/09 #126).
 *
 * «Перезапустить» (bar, «О программе», tray, menu) → updateFlow's prepareRestart → the renderer
 * is asked for its voice seat (IPC.appPrepareRestart) and answers with IPC.appResumeVoice (the
 * seat or null) → main stamps it with the server and the time and writes
 * userData/resume-voice.json synchronously, then quitAndInstall. The relaunched instance reads
 * and deletes the file at startup (so only the launch right after the update sees it — never a
 * later manual one) and hands it to the renderer once (IPC.appTakeResumeVoice) on its first
 * READY. electron-updater's relaunch cannot carry argv on every platform (Squirrel.Mac, NSIS
 * start the app themselves), so the file is the flag. Install-on-quit relaunches nothing and
 * writes nothing.
 */

/** How long the quit waits for the renderer's answer (a hung renderer must not block the update). */
const PREPARE_TIMEOUT_MS = 1_500;

let taken: ResumeVoice | null = null;
let waiting: (() => void) | null = null;

function file(): string {
  return join(app.getPath('userData'), 'resume-voice.json');
}

function remove(): void {
  try {
    rmSync(file(), { force: true });
  } catch (e) {
    log.warn('[resume-voice] remove failed', e);
  }
}

/** App start: take the record left by the restart for an update (and delete it). */
export function loadResumeVoice(): void {
  let raw: string;
  try {
    raw = readFileSync(file(), 'utf8');
  } catch {
    return; // no restart for an update
  }
  remove();
  try {
    taken = parseResumeVoice(JSON.parse(raw));
  } catch {
    taken = null;
  }
  if (taken) log.info('[resume-voice] seat from the update restart', taken.kind, taken.roomId);
}

/** The renderer's first READY: the record, once (null afterwards and without a restart). */
export function takeResumeVoice(): ResumeVoice | null {
  const r = taken;
  taken = null;
  return r;
}

/** Right before quitAndInstall: ask the renderer for its seat and store it (bounded, never rejects). */
export function prepareRestart(): Promise<void> {
  remove();
  const win = getMainWindow();
  if (!win || win.webContents.isDestroyed()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn('[resume-voice] no answer from the renderer, restarting without a seat');
      done();
    }, PREPARE_TIMEOUT_MS);
    function done(): void {
      clearTimeout(timer);
      if (waiting === done) waiting = null;
      resolve();
    }
    waiting = done;
    win.webContents.send(IPC.appPrepareRestart);
  });
}

/** IPC.appResumeVoice: the renderer's answer to prepareRestart (ignored when nobody asked). */
export function setResumeSeat(v: unknown): void {
  const finish = waiting;
  if (!finish) return;
  const seat = v === null ? null : parseResumeSeat(v);
  if (seat) {
    const record: ResumeVoice = { ...seat, serverUrl: currentServerUrl(), at: Date.now() };
    try {
      writeFileSync(file(), JSON.stringify(record), { mode: 0o600 });
      log.info('[resume-voice] seat stored for the restart', seat.kind, seat.roomId);
    } catch (e) {
      log.warn('[resume-voice] store failed', e);
    }
  }
  finish();
}
