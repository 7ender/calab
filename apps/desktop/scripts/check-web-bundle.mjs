// Guard for the web build (ADR-0015): no Electron-only code may reach dist-web.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../dist-web/assets/', import.meta.url).pathname;
const forbidden = ['uiohook', 'ipcRenderer', 'contextBridge', 'window.calaba', 'calaba-api://', 'safeStorage', 'desktopCapturer', 'require("electron")'];
let bad = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
  const src = readFileSync(join(dir, f), 'utf8');
  for (const w of forbidden) {
    if (src.includes(w)) {
      console.error(`dist-web/assets/${f}: contains "${w}"`);
      bad++;
    }
  }
}
if (bad) process.exit(1);
console.log('web bundle OK: no Electron-only code');
