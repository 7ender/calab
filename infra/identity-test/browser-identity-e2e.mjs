// Production web bundle + App + real TLS Keycloak. The only intercepted URL is
// this run's synthetic downstream relying-party callback; no API is mocked.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(resolve(fileURLToPath(new URL('../../apps/desktop/package.json', import.meta.url))));
const { chromium, request } = require('@playwright/test');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const f = JSON.parse(input);
assert.equal(new URL(f.origin).hostname, '127.0.0.1');
assert.equal(new URL(f.issuer).pathname, '/realms/identity.test');
const callback = `https://rp.identity.test/${f.runID}/callback`;
const callbackRoute = new RegExp(`^https://rp\\.identity\\.test/${f.runID}/callback(?:\\?.*)?$`);
const clientID = `calaba-browser-${f.runID}`;
const upstreamSecret = randomBytes(32).toString('base64url');
const kcUser = `browser-${f.runID}`;
const kcPassword = 'fixture-only-browser-keycloak-password';
const upstreamBase = new URL(f.issuer).origin;
const upstream = await request.newContext({ baseURL: upstreamBase, ignoreHTTPSErrors: true });
const browser = await chromium.launch({ headless: true, args: ['--mute-audio', '--disable-features=WebRtcAllowInputVolumeAdjustment'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: [], reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
let adminToken, ownedClient, ownedUser, stage = 'bootstrap';
const bindOutcomes = [];
page.on('response', async response => {
 if (response.url().includes('/api/oauth/requests/') && response.url().endsWith('/bind') && response.status() !== 200) {
  try { bindOutcomes.push({ status: response.status(), code: (await response.json()).code }); } catch { bindOutcomes.push({ status: response.status() }); }
 }
});
const checkpoint = (name) => { stage = name; console.log(`PASS ${name}`); };
async function jsonResponse(response, status, label) {
 assert.equal(response.status(), status, `${stage}: ${label}: HTTP ${response.status()}`);
 return status === 204 ? null : response.json();
}
async function admin(method, path, data, status = 200) {
 const response = await upstream.fetch(path, { method, headers: { Authorization: `Bearer ${adminToken}` }, ...(data ? { data } : {}) });
 return jsonResponse(response, status, `Keycloak ${method} ${path.split('?')[0]}`);
}
async function api(method, path, token, data, status = 200, ctx = context) {
 const response = await ctx.request.fetch(f.origin + path, { method, headers: { Origin: f.origin, 'X-Client': 'web', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data !== undefined ? { data } : {}) });
 return jsonResponse(response, status, `${method} ${path}`);
}
async function loginUI(p, ctx) {
 await p.goto(f.origin);
 await p.locator('input[type=email]').fill(f.email);
 await p.locator('input[autocomplete=current-password]').fill(f.password);
 const result = p.waitForResponse(r => r.url() === f.origin + '/api/auth/login' && r.request().method() === 'POST');
 await p.locator('button[type=submit]').click();
 const login = await jsonResponse(await result, 200, 'web login');
 assert.equal(login.tokens.authority.kind, 'SESSION_AUTHORITY_KIND_LOCAL_ACCOUNT');
 assert.equal(login.tokens.refreshToken ?? '', '');
 const cookies = await ctx.cookies(f.origin);
 assert(cookies.some(c => c.httpOnly && c.secure && c.path === '/'));
 return login.tokens;
}
async function keycloakLogin(p) {
 await p.waitForURL(u => u.origin === upstreamBase || (u.origin === f.origin && u.pathname === '/sso/complete'));
 if (await p.locator('#password').count()) {
  if (await p.locator('#username').count()) await p.locator('#username').fill(kcUser);
  await p.locator('#password').fill(kcPassword);
  await p.locator('#kc-login').click();
 }
 try { await p.waitForURL(u => u.origin === f.origin && u.pathname === '/sso/complete'); } catch { console.error(`Keycloak page ${new URL(p.url()).pathname}: ${(await p.locator('body').innerText()).slice(0, 500)}`); throw new Error('Keycloak did not return to App completion'); }
}
async function ssoHTTP(purpose, token, flowPage = page, flowContext = context) {
 const page = flowPage;
 stage = `real ${purpose} flow`;
 const path = purpose === 'TEST' ? `/api/workspaces/${f.workspaceA}/identity/test` : `/api/auth/sso/workspaces/${f.workspaceA}/begin`;
 const begun = await api('POST', path, token, { purpose: `SSO_FLOW_PURPOSE_${purpose}`, clientKind: 'SSO_CLIENT_KIND_WEB' }, 200, flowContext);
 // HTTP control-plane acceptance deliberately does not install web platform state.
 // Callback/finish still traverse the real browser binding and production issuer.
 await page.goto(begun.authorizationUrl);
 await keycloakLogin(page);
 const result = await api('POST', '/api/auth/sso/finish', token, { flowId: begun.flowId }, 200, flowContext);
 if (purpose === 'TEST') assert.equal(result.tested, true);
 else if (purpose === 'LINK') { assert.equal(result.tokens, undefined); assert.equal(result.assurance, undefined); }
 else { assert.equal(result.assurance.workspaceId, f.workspaceA); assert.equal(result.tokens, undefined); }
 return result;
}
async function createRP(workspace, token) {
 const result = await api('POST', `/api/workspaces/${workspace}/oauth/clients`, token, { name: `Browser RP ${workspace.slice(0, 8)}`, type: 'OAUTH_CLIENT_TYPE_PUBLIC_SPA', redirectUris: [callback], allowedOrigins: ['https://rp.identity.test'], scopes: ['openid', 'profile', 'email'] }, 201);
 return result.client;
}
async function consentJourney(workspace, client, token, proof, journeyPage = page, journeyContext = context, scoped = false) {
 const page = journeyPage;
 const context = journeyContext;
 stage = `${proof} consent repair`;
 const nonce = randomBytes(32).toString('base64url');
 const state = randomBytes(32).toString('base64url');
 const verifier = randomBytes(32).toString('base64url');
 const issuer = `${f.origin}/oidc/workspaces/${workspace}`;
 const args = new URLSearchParams({ client_id: client.clientId, redirect_uri: callback, response_type: 'code', scope: 'openid profile email', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'login' });
 let captured, authenticatedAt;
 await page.route(callbackRoute, async route => { captured = new URL(route.request().url()); await route.fulfill({ status: 200, contentType: 'text/plain', body: 'Synthetic relying-party callback received' }); });
 // prompt=login requires authentication after request creation even while the
 // ordinary workspace read summary is ALLOWED. No fixture proof timestamps change.
 await new Promise(r => setTimeout(r, 1100));
 await page.goto(`${issuer}/authorize?${args}`);
 await page.getByTestId('consent-auth-repair').waitFor();
 const consentURL = page.url();
 assert.equal(new URL(consentURL).pathname, '/oauth/consent');
 const handle = new URL(consentURL).searchParams.get('request');
 assert(handle, 'saved consent request handle');
 assert.equal((await api('GET', `/api/workspaces/${workspace}/identity`, token, undefined, 200, context)).access.reason, 'IDENTITY_ACCESS_REASON_ALLOWED');
 await page.getByTestId('consent-auth-repair').locator('[role=alert]').waitFor();
 assert.equal(await page.getByRole('button', { name: 'Allow', exact: true }).count(), 0);
 await new Promise(r => setTimeout(r, 1100));
 if (proof === 'local' || !scoped) {
  await page.locator('input[autocomplete=current-password]').fill(f.password);
  const reauth = page.waitForResponse(r => r.url().endsWith('/api/auth/local/reauth'));
  await page.getByRole('button', { name: 'Confirm password', exact: true }).click();
  authenticatedAt = (await jsonResponse(await reauth, 200, 'local reauth UI')).authenticatedAt;
  if (proof === 'local') await page.getByTestId('consent-auth-repair').getByRole('button', { name: 'Refresh', exact: true }).click();
 }
 if (proof !== 'local') {
  const select = page.getByTestId('consent-auth-repair').locator('select');
  await select.selectOption(workspace);
  const finish = page.waitForResponse(r => r.url().endsWith('/api/auth/sso/finish')).then(r => { assert.equal(r.status(), 200, 'SSO finish UI'); });
  await page.getByTestId('sso-step_up').getByRole('button').click();
  await keycloakLogin(page);
  await finish;
  await api('GET', `/api/workspaces/${f.workspaceB}/identity`, token, undefined, scoped ? 403 : 200, context);
  const confirmed = await api('GET', `/api/workspaces/${workspace}/identity`, token, undefined, 200, context);
  assert.equal(confirmed.access.assurance.workspaceId, workspace);
  if (scoped) authenticatedAt = confirmed.access.assurance.authenticatedAt;
  await page.waitForURL(consentURL);
  assert.equal(new URL(page.url()).searchParams.get('request'), handle, 'same request restored after SSO');
 }
 await page.getByRole('button', { name: 'Allow', exact: true }).waitFor();
 await page.getByTestId('oauth-consent').getByText(client.name, { exact: true }).waitFor();
 await page.getByRole('button', { name: 'Allow', exact: true }).click();
 await page.waitForURL(u => u.origin === 'https://rp.identity.test');
 assert(captured);
 assert.equal(captured.searchParams.get('state'), state);
 assert.equal(captured.searchParams.get('iss'), issuer);
 assert.equal(captured.searchParams.get('error'), null);
 const code = captured.searchParams.get('code'); assert(code);
 const exchange = { grant_type: 'authorization_code', client_id: client.clientId, redirect_uri: callback, code, code_verifier: verifier };
 const tokens = await jsonResponse(await context.request.post(`${issuer}/token`, { form: exchange }), 200, 'S256 exchange');
 assert(tokens.access_token && tokens.id_token);
 // Fetch from the registered RP document: APIRequestContext does not enforce
 // browser CORS and cannot prove SPA discovery/JWKS interoperability.
 assert.equal(new URL(page.url()).origin, 'https://rp.identity.test');
 const publicMetadata = await page.evaluate(async issuer => {
  const options = { mode: 'cors', credentials: 'omit', redirect: 'error' };
  const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, options);
  const jwks = await fetch(`${issuer}/jwks`, options);
  return {
   discoveryStatus: discovery.status, discoveryType: discovery.type,
   discovery: await discovery.json(),
   jwksStatus: jwks.status, jwksType: jwks.type, jwks: await jwks.json(),
  };
 }, issuer);
 assert.equal(publicMetadata.discoveryStatus, 200, 'browser discovery CORS');
 assert.equal(publicMetadata.jwksStatus, 200, 'browser JWKS CORS');
 assert.equal(publicMetadata.discoveryType, 'cors');
 assert.equal(publicMetadata.jwksType, 'cors');
 const { discovery, jwks } = publicMetadata;
 assert.equal(discovery.issuer, issuer);
 assert.equal(discovery.jwks_uri, `${issuer}/jwks`);
 assert.equal(discovery.request_uri_parameter_supported, false);
 assert.equal(discovery.authorization_response_iss_parameter_supported, true);
 const [h, p, s] = tokens.id_token.split('.');
 const header = JSON.parse(Buffer.from(h, 'base64url'));
 const claims = JSON.parse(Buffer.from(p, 'base64url'));
 assert.equal(header.alg, 'RS256');
 const jwk = jwks.keys.find(k => k.kid === header.kid); assert(jwk);
 assert.equal(jwk.d, undefined);
 assert(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url')), 'independent Node crypto signature');
 assert.equal(claims.iss, issuer); assert.equal(claims.aud, client.clientId);
 assert.equal(claims.nonce, nonce); assert.match(claims.sub, /^[A-Za-z0-9_-]{43}$/);
 assert.notEqual(claims.sub, f.userID);
 const now = Math.floor(Date.now() / 1000);
 assert(authenticatedAt, 'authentication receipt');
 assert.equal(claims.auth_time, Math.floor(new Date(authenticatedAt).getTime() / 1000));
 assert(Number.isInteger(claims.auth_time) && claims.auth_time <= now + 60 && claims.auth_time >= now - 300);
 assert(claims.iat <= now + 60 && claims.exp > now && claims.exp <= now + 300);
 const info = await jsonResponse(await context.request.get(`${issuer}/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}` } }), 200, 'UserInfo');
 assert.equal(info.name, 'Browser Fixture');
 assert.equal(info.sub, claims.sub); assert.equal(info.email, f.email); assert.equal(info.email_verified, true);
 for (const privateField of ['user_id', 'userId', 'roles', 'workspaces', 'superadmin']) assert.equal(info[privateField], undefined);
 await api('GET', '/api/me', tokens.access_token, undefined, 401, context);
 await jsonResponse(await context.request.post(`${issuer}/token`, { form: exchange }), 400, 'code replay denied');
 const revoke = await context.request.post(`${issuer}/revoke`, { form: { client_id: client.clientId, token: tokens.access_token } }); assert.equal(revoke.status(), 200);
 const denied = await context.request.get(`${issuer}/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}` } }); assert.equal(denied.status(), 401);
 await page.unroute(callbackRoute);
 checkpoint(`${proof} consent, same request, S256, browser discovery/JWKS CORS, independent JWKS verification, UserInfo and revoke`);
 return claims.sub;
}
try {
 const adminLogin = await upstream.post('/realms/master/protocol/openid-connect/token', { form: { grant_type: 'password', client_id: 'admin-cli', username: 'fixture-admin', password: 'fixture-only-admin-password' } });
 adminToken = (await jsonResponse(adminLogin, 200, 'synthetic fixture admin')).access_token;
 assert.equal((await admin('GET', '/admin/serverinfo')).systemInfo.version, '26.4.7');
 const user = await upstream.post('/admin/realms/identity.test/users', { headers: { Authorization: `Bearer ${adminToken}` }, data: { username: kcUser, enabled: true, email: `${kcUser}@identity.test`, emailVerified: true, firstName: 'Browser', lastName: 'Fixture', credentials: [{ type: 'password', value: kcPassword, temporary: false }] } });
 assert.equal(user.status(), 201); ownedUser = user.headers().location.split('/').at(-1);
 stage = 'local UI login';
 const local = await loginUI(page, context);
 const token = local.accessToken;
 const roomA = (await api('POST', `/api/workspaces/${f.workspaceA}/rooms`, token, { name: 'Browser protected A', type: 'ROOM_TYPE_TEXT' }, 201)).room.id;
 const roomB = (await api('POST', `/api/workspaces/${f.workspaceB}/rooms`, token, { name: 'Browser independent B', type: 'ROOM_TYPE_TEXT' }, 201)).room.id;
 const rpB = await createRP(f.workspaceB, token);
 const localSub = await consentJourney(f.workspaceB, rpB, token, 'local');
 stage = 'connection setup';
 const connection = await api('PUT', `/api/workspaces/${f.workspaceA}/identity/connection`, token, { name: 'Browser real Keycloak', provider: 'IDENTITY_PROVIDER_GENERIC', issuer: f.issuer, clientId: clientID, clientSecret: upstreamSecret });
 const created = await upstream.post('/admin/realms/identity.test/clients', { headers: { Authorization: `Bearer ${adminToken}` }, data: { clientId: clientID, enabled: true, protocol: 'openid-connect', publicClient: false, secret: upstreamSecret, standardFlowEnabled: true, directAccessGrantsEnabled: false, serviceAccountsEnabled: false, redirectUris: [`${f.origin}/api/auth/sso/callback/${connection.id}`], defaultClientScopes: ['basic', 'profile', 'email'], attributes: { 'pkce.code.challenge.method': 'S256' } } });
 assert.equal(created.status(), 201); ownedClient = created.headers().location.split('/').at(-1);
 await ssoHTTP('LINK', token);
 await ssoHTTP('TEST', token);
 const active = await api('POST', `/api/workspaces/${f.workspaceA}/identity/connections/${connection.id}/activate`, token, { version: connection.version });
 assert.equal(active.status, 'IDENTITY_CONNECTION_STATUS_ACTIVE');
 await ssoHTTP('STEP_UP', token);
 const rpA = await createRP(f.workspaceA, token);
 const kit = await api('POST', `/api/workspaces/${f.workspaceA}/identity/recovery-kit`, token, {}); assert.equal(kit.codesOnce.length, 10);
 const view = await api('GET', `/api/workspaces/${f.workspaceA}/identity`, token);
 await api('PUT', `/api/workspaces/${f.workspaceA}/identity/policy`, token, { version: view.access.policyVersion, mode: 'IDENTITY_POLICY_MODE_ENFORCED' }, 204);
 // Policy changes invalidate prior proof. Re-prove through real HTTP before
 // prompt=login tests the subtler ALLOWED read / fresh OAuth proof boundary.
 await ssoHTTP('STEP_UP', token);
 await api('GET', `/api/rooms/${roomA}`, token);
 const independent = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: [] });
 try {
  const independentPage = await independent.newPage();
  const other = await loginUI(independentPage, independent);
  const locked = await api('GET', `/api/rooms/${roomA}`, other.accessToken, undefined, 403, independent);
  assert.equal(locked.code, 'ERROR_CODE_SSO_REQUIRED');
  await api('GET', `/api/rooms/${roomB}`, other.accessToken, undefined, 200, independent);
  await api('GET', '/api/me', other.accessToken, undefined, 200, independent);
 } finally { await independent.close(); }
 checkpoint('real linking, test, activation, recovery setup, enforcement and independent B access');
 const ssoSub = await consentJourney(f.workspaceA, rpA, token, 'SSO');
 assert.notEqual(localSub, ssoSub, 'workspace subjects differ');
 // Standalone SSO uses the actual App issuer and scoped browser cookies.
 stage = 'standalone scoped login';
 const scopedContext = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: [] });
 try {
  const scopedPage = await scopedContext.newPage();
  await scopedPage.goto(f.origin);
  await scopedPage.getByLabel('Workspace address', { exact: true }).fill(f.slugA);
  await scopedPage.getByRole('button', { name: 'Find workspace', exact: true }).click();
  const installed = scopedPage.waitForResponse(r => r.url().endsWith('/api/auth/sso/finish')).then(r => jsonResponse(r, 200, 'scoped UI finish'));
  await scopedPage.getByTestId('sso-login').getByRole('button').click();
  await keycloakLogin(scopedPage);
  const done = await installed;
  assert.equal(done.tokens.authority.kind, 'SESSION_AUTHORITY_KIND_WORKSPACE_SSO'); assert.equal(done.tokens.authority.workspaceId, f.workspaceA);
  const refreshed = await api('POST', `/api/auth/sso/workspaces/${f.workspaceA}/refresh`, '', {}, 200, scopedContext);
  assert.equal(refreshed.tokens.authority.kind, 'SESSION_AUTHORITY_KIND_WORKSPACE_SSO');
  assert.equal(refreshed.tokens.authority.workspaceId, f.workspaceA);
  assert.equal(refreshed.tokens.refreshToken ?? '', '');
  assert.equal(refreshed.tokens.sessionId, done.tokens.sessionId);
  assert.equal(refreshed.tokens.refreshExpiresAt, done.tokens.refreshExpiresAt);
  assert.equal(refreshed.tokens.authority.localAuthenticatedAt, undefined);
  const scoped = refreshed.tokens.accessToken;
  await api('GET', `/api/rooms/${roomA}`, scoped, undefined, 200, scopedContext);
  for (const path of [`/api/rooms/${roomB}`, '/api/dms', '/api/me/sessions']) {
   const denied = await api('GET', path, scoped, undefined, 403, scopedContext); assert.equal(denied.code, 'ERROR_CODE_IDENTITY_SCOPE_DENIED');
  }
  const cookies = await scopedContext.cookies();
  assert(cookies.some(c => c.httpOnly && c.secure && c.path === `/api/auth/sso/workspaces/${f.workspaceA}`));
  // Explicit HTTP step-up asserts no new tokens before the UI round trip.
  await ssoHTTP('STEP_UP', scoped, scopedPage, scopedContext);
  const scopedSub = await consentJourney(f.workspaceA, rpA, scoped, 'scoped SSO', scopedPage, scopedContext, true);
  const again = await api('POST', `/api/auth/sso/workspaces/${f.workspaceA}/refresh`, '', {}, 200, scopedContext);
  assert.equal(again.tokens.sessionId, done.tokens.sessionId);
  assert.equal(again.tokens.refreshExpiresAt, done.tokens.refreshExpiresAt);
  assert.deepEqual(again.tokens.authority, done.tokens.authority);
  assert.equal(again.tokens.authority.localAuthenticatedAt, undefined);
  for (const path of [`/api/rooms/${roomB}`, '/api/dms', '/api/me/sessions']) await api('GET', path, again.tokens.accessToken, undefined, 403, scopedContext);
  assert.notEqual(scopedSub, localSub);
  await api('POST', `/api/auth/sso/workspaces/${f.workspaceA}/logout`, again.tokens.accessToken, {}, 204, scopedContext);
 } finally { await scopedContext.close(); }
 checkpoint('production scoped issuer/cookies, same-session reauth, unchanged authority/deadline and B/DM/global denial');
 console.log('IDENTITY_BROWSER_GOLDEN_PASS');
} catch (error) {
 // Assertion errors may contain tokens/authorization query values: print only
 // the named stage and safe HTTP labels; preserve failures without secrets.
 console.error(`Observed bind denials: ${JSON.stringify(bindOutcomes)}`);
 console.error(`FAIL ${stage}: ${String(error.message).split('\n')[0].replace(/https:\/\/\S+/g, '[URL redacted]')}`);
 process.exitCode = 1;
} finally {
 await context.close(); await browser.close();
 // Refresh synthetic admin credentials, then delete only recorded owned IDs.
 try {
  const refreshed = await upstream.post('/realms/master/protocol/openid-connect/token', { form: { grant_type: 'password', client_id: 'admin-cli', username: 'fixture-admin', password: 'fixture-only-admin-password' } });
  adminToken = (await jsonResponse(refreshed, 200, 'cleanup admin')).access_token;
  if (ownedClient) await admin('DELETE', `/admin/realms/identity.test/clients/${ownedClient}`, undefined, 204);
  if (ownedUser) await admin('DELETE', `/admin/realms/identity.test/users/${ownedUser}`, undefined, 204);
  assert.equal((await admin('GET', `/admin/realms/identity.test/clients?clientId=${encodeURIComponent(clientID)}`)).length, 0);
  assert.equal((await admin('GET', `/admin/realms/identity.test/users?username=${encodeURIComponent(kcUser)}&exact=true`)).length, 0);
  console.log('PASS owned Keycloak cleanup');
 } catch { console.error('FAIL owned Keycloak cleanup'); process.exitCode = 1; }
 await upstream.dispose();
}
