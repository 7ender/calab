import { join } from 'node:path';
import { app, crashReporter } from 'electron';
import log from 'electron-log/main';

/** File logs + crash dumps under userData/logs (for bug reports). */
export function initLogging(): void {
  const dir = join(app.getPath('userData'), 'logs');
  log.transports.file.resolvePathFn = () => join(dir, 'main.log');
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.transports.console.level = app.isPackaged ? 'warn' : 'info';
  log.errorHandler.startCatching({ showDialog: false });
  app.setPath('crashDumps', join(dir, 'crashes'));
  crashReporter.start({ uploadToServer: false });
  log.info(`Calaba ${app.getVersion()} starting (${process.platform} ${process.arch}, Electron ${process.versions.electron})`);
}

export { log };
