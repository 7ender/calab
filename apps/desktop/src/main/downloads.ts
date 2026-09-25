import { createWriteStream, existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app, net, shell } from 'electron';
import type { DownloadArgs } from '../shared/ipc';
import { currentServerUrl, getAccessToken } from './auth';

function uniquePath(dir: string, name: string): string {
  // eslint-disable-next-line no-control-regex -- strip control chars from user-supplied file names
  const safe = basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'file';
  const ext = extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let p = join(dir, safe);
  for (let i = 1; existsSync(p); i++) p = join(dir, `${stem} (${i})${ext}`);
  return p;
}

/** Saves an attachment into ~/Downloads and reveals it. Returns the saved path. */
export async function downloadFile(args: DownloadArgs): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(args.fileId)) throw new Error('invalid file id');
  const token = await getAccessToken();
  const res = await net.fetch(`${currentServerUrl()}/api/files/${args.fileId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const path = uniquePath(app.getPath('downloads'), args.name);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
  shell.showItemInFolder(path);
  return path;
}
