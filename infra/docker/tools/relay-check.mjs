// Headless relay-check (TESTING.md "Стенд", step 7): runs relay-check.html in Chromium for each mode and
// fails unless the selected candidate pair is as expected and media bytes arrive.
//
//   node infra/docker/tools/relay-check.mjs <wss://rtc.domain> <join token> [modes=tls,udp,any]
//
// Run from the repo root (resolves @playwright/test from apps/desktop). The token is put in the URL
// #fragment of a local file:// page only — it never leaves this machine except to LiveKit itself.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../../apps/desktop/package.json'));
const { chromium } = require('@playwright/test');

const [url, token, modesArg = 'tls,udp,any'] = process.argv.slice(2);
if (!url || !token) {
  console.error('usage: relay-check.mjs <wss://rtc.domain> <token> [tls,udp,any]');
  process.exit(2);
}
const page0 = pathToFileURL(path.join(here, 'relay-check.html')).href;
const browser = await chromium.launch();
let failed = 0;
for (const mode of modesArg.split(',')) {
  const page = await browser.newPage();
  const hash = new URLSearchParams({ url, token, mode }).toString();
  await page.goto(`${page0}?run=${mode}-${Date.now()}#${hash}`);
  await page
    .waitForFunction(() => /PASS|FAIL|missing/.test(document.getElementById('verdict').textContent), null, { timeout: 90_000 })
    .catch(() => {});
  const verdict = (await page.locator('#verdict').textContent()) ?? '';
  const pairs = JSON.parse(verdict.replace(/^(PASS|FAIL) /, '') || '[]');
  const p = Array.isArray(pairs) ? pairs[0] : undefined;
  const ok =
    verdict.startsWith('PASS') &&
    p && p.bytesIn > 0 &&
    (mode === 'tls' ? p.local === 'relay' && p.relayProtocol === 'tls'
      : mode === 'udp' ? p.local === 'relay' && p.relayProtocol === 'udp'
      : true);
  if (!ok) failed++;
  console.log(JSON.stringify({ mode, ok, local: p?.local, relayProtocol: p?.relayProtocol, rttMs: p?.rttMs, bytesIn: p?.bytesIn, verdict: ok ? undefined : verdict.slice(0, 200) }));
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
