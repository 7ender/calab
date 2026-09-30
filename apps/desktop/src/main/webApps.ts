import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  session,
  shell,
  WebContentsView,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from 'electron';
import log from 'electron-log/main';
import { hostOf, validateAppUrl } from '../shared/appUrl';
import { safeFileName } from '../shared/fileName';
import { IPC, type WebAppNavAction, type WebAppNavState } from '../shared/ipc';
import { isAppSession, markAppSession } from './appSessions';
import { markFromInternet } from './downloads';
import { mainStrings } from './strings';
import {
  dropLru,
  mayNavigate,
  mayNavigateFrame,
  partitionOf,
  permissionCheck,
  permissionDecision,
  resolveWithRemembered,
  touchLru,
  windowOpenDecision,
  type AskKind,
  type Remembered,
  type ViewBounds,
} from './webAppPolicy';
import { getMainWindow, isShown } from './windows';

/**
 * Workspace web apps (ADR-0050 §4–§5): each app is a WebContentsView of the main window —
 * sandboxed, no preload, no IPC, its own persistent session `persist:app-<id>` (site logins
 * stay, isolated from Calab and from each other). The renderer only says which app to show and
 * where (IPC `webapp:*`); it never reaches the site's content and the site never reaches Calab.
 *
 * A view is created on first open, hidden (not destroyed) when the user goes back to rooms, and
 * at most MAX_LIVE_VIEWS stay alive (LRU); a minimized / hidden window hides the view too.
 * Deleting the app destroys its view and clears its session and remembered permissions.
 */

interface Entry {
  appId: string;
  view: WebContentsView;
  /** The app's address as last opened (a changed address reloads the view). */
  home: string;
  failed: string;
  crashed: boolean;
}

const entries = new Map<string, Entry>();
/** Sign-in popups and same-site windows an app opened, by app. */
const children = new Map<string, Set<BrowserWindow>>();
let lru: string[] = [];
/** The app the renderer shows now; null = none (rooms, an overlay over the app). */
let shown: string | null = null;
let bounds: ViewBounds = { x: 0, y: 0, width: 0, height: 0 };
/** Main windows whose show / hide / minimize we follow. */
const followed = new WeakSet<BrowserWindow>();

// ---------------------------------------------------------------- remembered permissions

type PermFile = Record<string, Remembered>;
let perms: PermFile | null = null;
const permPath = (): string => join(app.getPath('userData'), 'web-app-permissions.json');

function loadPerms(): PermFile {
  if (perms) return perms;
  try {
    perms = JSON.parse(readFileSync(permPath(), 'utf8')) as PermFile;
  } catch {
    perms = {};
  }
  return perms;
}

function savePerms(): void {
  try {
    writeFileSync(permPath(), JSON.stringify(perms ?? {}));
  } catch (e) {
    log.warn('[webapp] could not save permissions', e);
  }
}

function remembered(appId: string): Remembered {
  return loadPerms()[appId] ?? {};
}

function remember(appId: string, kinds: readonly AskKind[], granted: boolean): void {
  const all = loadPerms();
  const cur = { ...(all[appId] ?? {}) };
  for (const k of kinds) cur[k] = granted;
  all[appId] = cur;
  savePerms();
}

// ---------------------------------------------------------------- sessions

const configured = new WeakSet<Session>();
/** One consent dialog at a time per app (a site asking for camera and mic in a row). */
const askChain = new Map<string, Promise<unknown>>();

function appIdOf(ses: Session): string | null {
  for (const e of entries.values()) if (e.view.webContents.session === ses) return e.appId;
  for (const [id, set] of children) for (const w of set) if (!w.isDestroyed() && w.webContents.session === ses) return id;
  return null;
}

/** The request comes from what the user sees: the shown view, or a visible popup of it. */
function inForeground(wc: WebContents, appId: string): boolean {
  const e = entries.get(appId);
  if (e && e.view.webContents === wc) return shown === appId && windowShown();
  const win = BrowserWindow.fromWebContents(wc);
  return !!win && !win.isDestroyed() && win.isVisible() && (children.get(appId)?.has(win) ?? false);
}

const KIND_STRING: Record<AskKind, keyof ReturnType<typeof mainStrings>> = {
  camera: 'webAppCamera',
  microphone: 'webAppMicrophone',
  notifications: 'webAppNotifications',
  geolocation: 'webAppGeolocation',
  'clipboard-read': 'webAppClipboard',
};

async function askUser(appId: string, site: string, kinds: readonly AskKind[]): Promise<boolean> {
  const s = mainStrings();
  const what = kinds.map((k) => s[KIND_STRING[k]]).join(', ');
  const parent = getMainWindow();
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    message: s.webAppAsk.replace('{site}', site || '—').replace('{what}', what),
    detail: s.webAppAskDetail,
    buttons: [s.webAppAllow, s.webAppDeny],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  const granted = r.response === 0;
  remember(appId, kinds, granted);
  log.info('[webapp] permission', { appId, site, kinds, granted });
  return granted;
}

function configureSession(ses: Session): void {
  if (configured.has(ses)) return;
  configured.add(ses);
  // Sites (Google sign-in above all) refuse embedded browsers by the Electron token: present the
  // plain Chromium user agent.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|Calaba?)\/\S+/gi, ''));
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const appId = appIdOf(ses);
    const d = permissionDecision(permission, 'mediaTypes' in details ? (details.mediaTypes ?? []) : []);
    if (!appId || d.kind === 'deny') {
      callback(false);
      return;
    }
    if (d.kind === 'allow') {
      callback(true);
      return;
    }
    const r = resolveWithRemembered(d.ask, remembered(appId));
    if ('grant' in r) {
      callback(r.grant);
      return;
    }
    // A background view or a hidden popup never raises a dialog.
    if (!inForeground(wc, appId)) {
      callback(false);
      return;
    }
    const site = hostOf(details.requestingUrl || wc.getURL());
    const prev = askChain.get(appId) ?? Promise.resolve();
    const next = prev
      .then(() => {
        // Answered meanwhile (the same site asked twice)?
        const again = resolveWithRemembered(r.ask, remembered(appId));
        return 'grant' in again ? again.grant : askUser(appId, site, r.ask);
      })
      .then(callback, (e: unknown) => {
        log.warn('[webapp] permission dialog failed', e);
        callback(false);
      });
    askChain.set(appId, next);
  });
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    const appId = appIdOf(ses);
    return !!appId && permissionCheck(permission, details.mediaType === 'unknown' ? undefined : details.mediaType, remembered(appId));
  });
  // Screen capture, HID / serial / USB / Bluetooth devices: never.
  ses.setDisplayMediaRequestHandler((_req, cb) => cb({}));
  ses.setDevicePermissionHandler(() => false);
  ses.on('select-hid-device', (e, _d, cb) => {
    e.preventDefault();
    cb();
  });
  ses.on('select-serial-port', (e, _p, _wc, cb) => {
    e.preventDefault();
    cb('');
  });
  ses.on('select-usb-device', (e, _d, cb) => {
    e.preventDefault();
    cb();
  });
  // Downloads: the OS save dialog (Chromium's default without a save path), in ~/Downloads by
  // default; the saved file is marked as downloaded from the Internet (downloads.ts).
  ses.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), safeFileName(item.getFilename() || 'download')) });
    const origin = (() => {
      try {
        return new URL(item.getURL()).origin;
      } catch {
        return '';
      }
    })();
    item.once('done', (_ev, state) => {
      if (state === 'completed' && item.getSavePath()) void markFromInternet(item.getSavePath(), origin);
    });
  });
}

// ---------------------------------------------------------------- guards of app webContents

/** Guards of every webContents in an app session (views and their popups; ADR-0050 §4). */
function guardAppContents(wc: WebContents): void {
  wc.on('will-navigate', (e, url) => {
    if (mayNavigate(url)) return;
    e.preventDefault();
    // A plain-http link to a public site: the browser, not Calab.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  wc.on('will-redirect', (e, url) => {
    if (!mayNavigate(url)) e.preventDefault();
  });
  wc.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !mayNavigateFrame(e.url)) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url, disposition }) => {
    const d = windowOpenDecision(wc.getURL(), url, disposition);
    if (d === 'external') {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    }
    if (d === 'deny') return { action: 'deny' };
    const popup = disposition === 'new-window';
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: popup ? 520 : 1100,
        height: popup ? 700 : 800,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: viewPreferences(wc.session),
      },
    };
  });
  wc.on('did-create-window', (win) => {
    const appId = appIdOf(wc.session);
    if (!appId) {
      win.close();
      return;
    }
    const set = children.get(appId) ?? new Set<BrowserWindow>();
    set.add(win);
    children.set(appId, set);
    win.on('closed', () => set.delete(win));
  });
  wc.on('context-menu', (_e, params) => {
    const host = BrowserWindow.fromWebContents(wc) ?? getMainWindow();
    Menu.buildFromTemplate(contextMenu(wc, params)).popup(host ? { window: host } : {});
  });
}

function contextMenu(wc: WebContents, p: ContextMenuParams): MenuItemConstructorOptions[] {
  const s = mainStrings();
  const items: MenuItemConstructorOptions[] = [];
  const link = /^https?:\/\//i.test(p.linkURL) ? p.linkURL : '';
  if (link) {
    items.push({ label: s.webAppOpenLink, click: () => void shell.openExternal(link) });
    items.push({ label: s.webAppCopyLink, click: () => void clipboard.writeText(link) });
    items.push({ type: 'separator' });
  }
  if (p.isEditable) {
    items.push({ label: s.menuCut, role: 'cut', enabled: p.editFlags.canCut });
    items.push({ label: s.menuCopy, role: 'copy', enabled: p.editFlags.canCopy });
    items.push({ label: s.menuPaste, role: 'paste', enabled: p.editFlags.canPaste });
    items.push({ label: s.menuSelectAll, role: 'selectAll' });
    items.push({ type: 'separator' });
  } else if (p.selectionText) {
    items.push({ label: s.menuCopy, role: 'copy' });
    items.push({ type: 'separator' });
  }
  const nav = wc.navigationHistory;
  items.push({ label: s.webAppBack, enabled: nav.canGoBack(), click: () => nav.goBack() });
  items.push({ label: s.webAppForward, enabled: nav.canGoForward(), click: () => nav.goForward() });
  items.push({ label: s.webAppReload, click: () => wc.reload() });
  const page = wc.getURL();
  if (/^https?:\/\//i.test(page)) items.push({ label: s.webAppOpenPage, click: () => void shell.openExternal(page) });
  return items;
}

/** webPreferences of a view and of the windows it opens (ADR-0050 §4). */
function viewPreferences(ses: Session): Electron.WebPreferences {
  return {
    session: ses,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    // Unlike our own page: a hidden site is throttled (docs/14).
    backgroundThrottling: true,
    safeDialogs: true,
    navigateOnDragDrop: false,
    spellcheck: true,
    autoplayPolicy: 'document-user-activation-required',
  };
}

export function installWebAppGuards(): void {
  app.on('web-contents-created', (_e, wc) => {
    if (isAppSession(wc.session)) guardAppContents(wc);
  });
}

// ---------------------------------------------------------------- views

function windowShown(): boolean {
  const win = getMainWindow();
  return !!win && isShown(win);
}

function sendState(e: Entry): void {
  const win = getMainWindow();
  if (!win || e.view.webContents.isDestroyed()) return;
  const wc = e.view.webContents;
  const state: WebAppNavState = {
    appId: e.appId,
    url: wc.getURL() || e.home,
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
    failed: e.failed,
    crashed: e.crashed,
  };
  win.webContents.send(IPC.webAppState, state);
}

/** Shows the view the renderer wants (if the window is on screen and the page is fine), hides the rest. */
function applyVisibility(): void {
  const on = windowShown();
  for (const e of entries.values()) {
    const visible = on && e.appId === shown && !e.failed && !e.crashed && bounds.width > 0 && bounds.height > 0;
    if (visible) e.view.setBounds(bounds);
    e.view.setVisible(visible);
  }
}

function follow(win: BrowserWindow): void {
  if (followed.has(win)) return;
  followed.add(win);
  win.on('show', applyVisibility);
  win.on('hide', applyVisibility);
  win.on('minimize', applyVisibility);
  win.on('restore', applyVisibility);
  // Our page reloaded (a server change, ⌘R in dev) or crashed: it no longer shows an app.
  win.webContents.on('did-navigate', hideApp);
  win.webContents.on('render-process-gone', hideApp);
  win.on('closed', () => {
    for (const id of [...entries.keys()]) destroy(id);
    shown = null;
  });
}

function create(appId: string, url: string): Entry | null {
  const win = getMainWindow();
  if (!win) return null;
  follow(win);
  const ses = session.fromPartition(partitionOf(appId));
  markAppSession(ses); // before the webContents exists: web-contents-created sees an app session
  configureSession(ses);
  const view = new WebContentsView({ webPreferences: viewPreferences(ses) });
  view.setVisible(false);
  view.setBackgroundColor('#ffffff');
  const e: Entry = { appId, view, home: url, failed: '', crashed: false };
  entries.set(appId, e);
  win.contentView.addChildView(view);
  const wc = view.webContents;
  const update = (): void => sendState(e);
  wc.on('did-start-loading', () => {
    if (e.failed) {
      e.failed = '';
      applyVisibility();
    }
    update();
  });
  wc.on('did-stop-loading', update);
  wc.on('did-navigate', update);
  wc.on('did-navigate-in-page', update);
  wc.on('page-title-updated', update);
  wc.on('did-fail-load', (_ev, code, description, _url, isMainFrame) => {
    // -3 = ABORTED (a new navigation replaced this one).
    if (!isMainFrame || code === -3) return;
    e.failed = description || String(code);
    applyVisibility();
    update();
  });
  wc.on('render-process-gone', (_ev, details) => {
    log.warn('[webapp] page process gone', { appId, reason: details.reason });
    e.crashed = true;
    applyVisibility();
    update();
  });
  void wc.loadURL(url).catch(() => undefined); // failures arrive as did-fail-load
  return e;
}

function destroy(appId: string): void {
  const e = entries.get(appId);
  if (!e) return;
  entries.delete(appId);
  lru = dropLru(lru, appId);
  const win = getMainWindow();
  try {
    win?.contentView.removeChildView(e.view);
  } catch {
    // the window is gone
  }
  if (!e.view.webContents.isDestroyed()) e.view.webContents.close();
}

/** Show app `appId` at `b` (window DIPs); `url` is its address (loaded on first open or when it changed). */
export function openApp(appId: string, url: string, b: ViewBounds): void {
  const checked = validateAppUrl(url);
  if (!checked.ok) throw new Error('invalid app url');
  bounds = b;
  let e = entries.get(appId);
  if (e?.crashed) {
    destroy(appId);
    e = undefined;
  }
  if (!e) {
    e = create(appId, checked.url) ?? undefined;
    if (!e) return;
  } else if (e.home !== checked.url) {
    e.home = checked.url;
    e.failed = '';
    void e.view.webContents.loadURL(checked.url).catch(() => undefined);
  }
  const t = touchLru(lru, appId);
  lru = t.order;
  for (const id of t.evicted) destroy(id);
  shown = appId;
  applyVisibility();
  sendState(e);
}

export function hideApp(): void {
  shown = null;
  applyVisibility();
}

export function setAppBounds(b: ViewBounds): void {
  bounds = b;
  if (shown) applyVisibility();
}

export function navigateApp(action: WebAppNavAction): void {
  const e = shown ? entries.get(shown) : undefined;
  if (!e) return;
  const wc = e.view.webContents;
  if (action === 'reload' && e.crashed) {
    const { appId, home } = e;
    destroy(appId);
    openApp(appId, home, bounds);
    return;
  }
  if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (action === 'reload') {
    // After a failed load the error page is not the address: load the page that failed again.
    if (e.failed) void wc.loadURL(wc.getURL() && !wc.getURL().startsWith('chrome-error:') ? wc.getURL() : e.home).catch(() => undefined);
    else wc.reload();
  }
}

/** «Открыть в браузере»: the shown app's current page (its address if the page did not load). */
export function openAppExternal(): void {
  const e = shown ? entries.get(shown) : undefined;
  if (!e) return;
  const cur = e.view.webContents.getURL();
  const url = /^https?:\/\//i.test(cur) ? cur : e.home;
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

/** The app was deleted: its view, popups, site data and remembered permissions go. */
export async function forgetApp(appId: string): Promise<void> {
  if (shown === appId) shown = null;
  destroy(appId);
  for (const w of children.get(appId) ?? []) if (!w.isDestroyed()) w.close();
  children.delete(appId);
  const all = loadPerms();
  if (appId in all) {
    delete all[appId];
    savePerms();
  }
  await clearPartition(partitionOf(appId));
}

async function clearPartition(partition: string): Promise<void> {
  try {
    const ses = session.fromPartition(partition);
    await Promise.all([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache()]);
  } catch (e) {
    log.warn('[webapp] could not clear site data', partition, e);
  }
}

/**
 * The Calab session ended (logout, revoked, expired): every view and popup closes and the site
 * data of every app on this device is cleared — the next account must not find the previous
 * one's site logins.
 */
export async function forgetAllApps(): Promise<void> {
  shown = null;
  for (const id of [...entries.keys()]) destroy(id);
  for (const set of children.values()) for (const w of set) if (!w.isDestroyed()) w.close();
  children.clear();
  perms = {};
  savePerms();
  const dir = join(app.getPath('userData'), 'Partitions');
  if (!existsSync(dir)) return;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^app-[0-9a-f-]{36}$/.test(n));
  } catch {
    return;
  }
  await Promise.all(names.map((n) => clearPartition(`persist:${n}`)));
}
