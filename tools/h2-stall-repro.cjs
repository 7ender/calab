// Reproduces the «all REST requests hang until restart» bug (docs/09 #146, docs/12 «спиннер чата»)
// in a real Electron against a local HTTP/2 server — no app build, no network.
//
//   node_modules/.bin/electron --mute-audio tools/h2-stall-repro.cjs            # HOW=reader (the bug)
//   HOW=signal node_modules/.bin/electron --mute-audio tools/h2-stall-repro.cjs # the fix
//   HOW=reader RESET=1 node_modules/.bin/electron --mute-audio tools/h2-stall-repro.cjs # recovery
//
// The renderer fetches N large bodies through a `calaba-api`-like protocol.handle proxy, reads one
// chunk of each and cancels it (what a <video> does with its range requests), then fetches a tiny
// JSON. HOW=reader releases the upstream body the way apiProtocol.ts did before the fix
// (`reader.cancel()` only): the HTTP/2 streams stay open, their buffered bytes eat the
// connection's receive window, and the tiny request gets its headers but never its body.
// HOW=signal aborts the upstream net.fetch signal on cancel (the fix): streams are reset at once.
// RESET=1 then calls `session.closeAllConnections()` (the stall detector's action) and retries.
// Needs `openssl` (a throwaway self-signed certificate in a temp dir). Electron 44.4.5: N=4 wedges.
const { app, protocol, session, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http2 = require('node:http2');
const os = require('node:os');
const path = require('node:path');

const HOW = process.env.HOW || 'reader';
const N = Number(process.env.N || 4);
const RESET = process.env.RESET === '1';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

protocol.registerSchemesAsPrivileged([
  { scheme: 'repro-api', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-stall-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const server = http2.createSecureServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) });
server.on('session', () => log('server: new HTTP/2 connection'));
server.on('stream', (stream, headers) => {
  if (headers[':path'] === '/small') {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    return void stream.end('{"ok":true}');
  }
  const BIG = 40 * 1024 * 1024;
  let sent = 0;
  const chunk = Buffer.alloc(64 * 1024, 1);
  stream.respond({ ':status': 200, 'content-type': 'application/octet-stream', 'content-length': String(BIG) });
  const pump = () => {
    while (sent < BIG) {
      sent += chunk.length;
      if (!stream.write(chunk)) return void stream.once('drain', pump);
    }
    stream.end();
  };
  stream.on('close', () => log(`server: big stream closed (${(sent / 1e6).toFixed(1)} MB sent)`));
  pump();
});

const PAGE = `
async function small() {
  const t = performance.now(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
  try { const r = await fetch('repro-api://x/small', { signal: ctl.signal }); await r.text(); return 'OK in ' + Math.round(performance.now() - t) + ' ms'; }
  catch (e) { return 'HUNG (no body after ' + Math.round(performance.now() - t) + ' ms)'; }
  finally { clearTimeout(timer); }
}
async function run(n) {
  for (let i = 0; i < n; i++) {
    const r = await fetch('repro-api://x/big?' + i);
    const reader = r.body.getReader();
    await reader.read();
    await reader.cancel();
  }
  await new Promise((r) => setTimeout(r, 1000));
  return small();
}`;

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `https://localhost:${server.address().port}`;
  const ses = session.fromPartition('h2-stall-repro');
  ses.setCertificateVerifyProc((_req, cb) => cb(0));
  protocol.handle('repro-api', async (req) => {
    const u = new URL(req.url);
    const release = new AbortController();
    const res = await ses.fetch(base + u.pathname, { signal: release.signal });
    const reader = res.body.getReader();
    const body = new ReadableStream({
      async pull(c) {
        const r = await reader.read();
        if (r.done) c.close();
        else c.enqueue(r.value);
      },
      cancel(reason) {
        if (HOW === 'signal') release.abort(reason);
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, headers: { 'access-control-allow-origin': '*' } });
  });
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<meta charset=utf-8>');
  await win.webContents.executeJavaScript(PAGE);
  const verdict = await win.webContents.executeJavaScript(`run(${N})`);
  log(`HOW=${HOW}: after ${N} cancelled large responses a tiny request is ${verdict}`);
  if (RESET) {
    await ses.closeAllConnections();
    log(`after closeAllConnections(): ${await win.webContents.executeJavaScript('small()')}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(0);
});
