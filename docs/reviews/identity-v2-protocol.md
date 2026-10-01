# Identity 2.0 independent protocol/security review

Reviewed source: `479d99c8f42ffe3c5f9be47d4dbb298fcbc2707a` against `99a60fc54cb1989c26c1a114a77631ea3380ecde`, 2026-10-01. Independent pass completed without reading another review. ADR-0054, ADR-0055, release contract including section 13, implementation, SQL, root wiring, native/web clients, proxy routes and official standards were inspected. Only this report is committed; reproduction tests use Go overlays outside the checkout.

**Verdict: REJECT this source for release: six confirmed major findings, no confirmed blocker.** This is an initial exact-SHA assessment; subsequent fixes and integrated final SHA require delta review. Coordinator has assigned a provider correction and explicitly chosen same-client/exact-redirect/PKCE code-replay revocation in specification commit `3e576cf4`.

## Confirmed findings

### P1 — Major: discovery describes incompatible protocol capabilities

`apps/server/internal/oauthprovider/http.go:192` omits `request_uri_parameter_supported` although `consent.go:92` rejects `request_uri`. Its OIDC-defined omitted default is **true**; the response therefore announces an unsupported feature. It also omits `authorization_response_iss_parameter_supported` despite `redirectURL` returning `iss` on success and errors; RFC 9207 requires support to be announced as true. A client selecting issuer-based mix-up protection through discovery sees false. These are metadata contract defects, not evidence of an exercised cross-issuer token forgery. [OIDC Discovery §3](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata), [RFC 9207 §2.1/§3](https://www.rfc-editor.org/rfc/rfc9207.html#section-2.1).

Reproduction: `TestProtocolReviewMetadataDefaults` below fails on both OIDC and RFC 8414 documents: both fields are absent. Required correction: explicit `request_uri_parameter_supported:false` and `authorization_response_iss_parameter_supported:true` on both paths; retain issuer on successful and redirected error responses. Existing explicit response/grant/algorithm/subject/scope lists are otherwise consistent with this release profile.

### P2 — Major: supported cross-origin SPA cannot discover issuer or validate signatures

`http.go:181` and `http.go:194` return metadata/JWKS without CORS. An active registered public SPA with origin `https://rp.example.test` receives HTTP 200 but no `Access-Control-Allow-Origin` at either document. Browser fetch cannot read discovery or JWKS, so normal browser OIDC clients fail before discovery or ID-token verification. Successful token/UserInfo CORS does not repair this. Discovery/JWKS CORS is a standards **SHOULD**, while the severity comes from unusable advertised SPA support. [OIDC Discovery §3 and §4](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfig).

Reproduction: `TestProtocolReviewSPADiscoveryCORS` below. Required correction per lead decision: permit the exact origin of an active registered SPA in this workspace on both metadata routes and JWKS, add `Vary: Origin`, omit credentials/wildcards, deny unregistered/disabled/cross-workspace origins. No CORS should be added to authorize merely to address this finding. Wire headers prove the browser restriction; this probe is not a browser-rendering QA pass.

### P3 — Major: proven authorization-code replay leaves the compromised family usable

`token.go:220` maps consumed-code lookup failure directly to `invalid_grant`. `queries/oauth.sql:157` filters away consumed codes, preventing the caller from identifying/revoking the family. After a successful exchange, an identical authenticated-client/redirect/PKCE exchange fails, but the issued access token still returns UserInfo 200 and its refresh token still issues new tokens. This preserves attacker credentials if a party possessing a code and its verifier redeems first and the legitimate client subsequently detects replay. Code theft alone does not defeat PKCE, and this finding does not assert that it does.

RFC 6749 requires denial (**MUST**, already satisfied) and recommends revocation of previously issued tokens when possible (**SHOULD**, currently unsatisfied). Here the durable consumed code and grant make revocation possible; the release lead has explicitly adopted it. Existing `TestProviderIndependentRPAndTokenIsolation` actually relies on tokens remaining usable after code replay, so its green result cannot establish this property. [RFC 6749 §4.1.2](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.2).

Reproduction: `TestProtocolReviewCodeReplayRevocation` below: incorrect client cannot exchange or revoke the victim; correct client plus all original bindings receives 400, then victim UserInfo and refresh both receive 200. Required correction: detect exactly bound consumed code and commit family revocation before returning `invalid_grant`; retain non-revocation for incorrect client/issuer/redirect/verifier and nonexistent codes. Concurrent double exchange still has one issuance, with the replay loser revoking that issuance. Add durable DB and descendant-refresh checks.

### P4 — Major: valid OIDC authorization POST is rejected

`http.go:33` registers only GET authorize; `consent.go` reads only the query. Valid form-urlencoded POST with the same client, redirect, scope, state, nonce and S256 challenge that works over GET receives **405**, `Allow: GET, HEAD, OPTIONS`. OIDC Core requires GET **and** POST at the authorization endpoint; the OAuth-only rule permits POST as optional, but this release advertises OIDC. The GET-only internal release table does not remove the normative OIDC requirement. [OIDC Core §3.1.2.1](https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest).

Reproduction: `TestProtocolReviewAuthorizationPOST` below, Go1.26.5/own PG18, `/tmp/identity-v2-protocol-post.log`. Required correction: register POST, parse bounded single-valued form body, reject query/body ambiguity, preserve exact redirect/PKCE/prompt rules and identity quotas. Review root recorder/resolver assumptions about method/query as part of integration. Form navigation must retain 303 redirects without forwarding the form body to the client.

### P5 — Major: all-OP minimum `acr_values` support returns an error

`parseAuthorize` explicitly rejects `acr_values`. OIDC Core §15.1 applies to **all** OPs, including statically registered ones: the minimum support for this optional preference is that using it does not cause an error. Valid authorization with `acr_values=urn:example:unsupported-acr` currently redirects `invalid_request`; the same wire probe accepts `display`, `ui_locales` and `claims_locales`. [OIDC Core §15.1](https://openid.net/specs/openid-connect-core-1_0.html#MandatoryToImplement).

Reproduction: `TestProtocolReviewMinimumUIAndACRParameters`; `/tmp/identity-v2-protocol-minimum.log`. Required correction accepted in lead spec `e1685b30`: accept/ignore unsupported optional ACR preferences, retain malformed/duplicate checks, and do not fabricate `acr`, `amr` or MFA evidence. Dynamic-OP requirements in §15.2 do not apply to this static-client profile; this finding does not require implicit flow, dynamic registration or Request URI support.

### P6 — Major: invalid `id_token_hint` is silently ignored

`parseAuthorize` accepts `id_token_hint=not-a-jwt` and starts a normal consent request. OIDC Core §3.1.2.2 steps 4–5 require issuer validation when a hint is supplied and prohibit a positive response for another hinted subject. Silently dropping a recognized subject hint bypasses those checks. The confirmed wire failure is malformed-hint acceptance; no cross-account exploit or token forgery is claimed. [OIDC Core §3.1.2.2](https://openid.net/specs/openid-connect-core-1_0.html#AuthRequestValidation).

Reproduction: `TestProtocolReviewIDTokenHintValidation`; `/tmp/identity-v2-protocol-hint.log`. Required narrow correction: explicitly reject unsupported hints before creating a request/code; full validation/subject selection is unnecessary for this release. Continue rejecting unsupported claims/request/request_uri inputs without fetching remote data.

## Independent assessment of the remaining protocol boundaries

- Path issuer discovery uses the OIDC suffix and RFC 8414 prefix correctly, with the exact trusted origin/workspace issuer in both documents. Caddy proxies both before SPA fallback; Host/forwarded input does not construct issuer. Maintained `coreos/go-oidc/v3` RP successfully discovered, fetched JWKS, and verified RS256/issuer/audience/expiry plus the original nonce. [OIDC Discovery §4.1](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfigurationRequest), [RFC 8414 §3](https://www.rfc-editor.org/rfc/rfc8414.html#section-3).
- Authorization/token redirects are exact except the deliberate native loopback port exception; the actual complete redirect is saved and matched at exchange. S256 is mandatory, verifier syntax/challenge binding are strict, authorization errors redirect only after registered URI lookup. State/nonce are mandatory as a documented Calaba profile restriction. Native handoff adds a separate initiating verifier, expiry and atomic consume; pending contexts are cancelled on account/server switch. [RFC 8252 §7](https://www.rfc-editor.org/rfc/rfc8252.html#section-7), [RFC 7636 §4](https://www.rfc-editor.org/rfc/rfc7636.html#section-4).
- Inbound SSO state ties connection/callback/browser to the saved flow; distinct connection callback paths and verified exact upstream issuer protect mix-up. Upstream ID verification restricts RS256 and checks nonce, audience/azp, issuer, expiry/iat/nbf/auth_time and Entra tenant; no email autolink/global privileges. Guarded discovery/token/JWKS endpoints have no redirects/proxy/private-network fallback. Tests distinguish local TLS fake IdP from actual Keycloak.
- Prompt/consent/max_age are validated; none returns protocol errors instead of UI, login requires authentication after request creation. Auth time is authority-specific; same-session scoped step-up preserves SID/authority/absolute deadline and rejects changed subject/version/revocation. Refresh ID token keeps original auth_time and omits nonce, matching the refresh rules. This pass found no new bypass in these paths. [OIDC Core §3.1.2.1 and §12.2](https://openid.net/specs/openid-connect-core-1_0.html#RefreshTokenResponse).
- Consent requires exact Origin, HttpOnly Secure per-request cookie, first-party bearer, atomic one-session bind and one-use hashed decision CSRF. Snapshot fixes client/workspace/redirect/scopes; account substitution/rebind/replay fail. Same-session return context is bounded, single-use and restricted to the consent route. Browser round-trip/manual UI QA remains a separate coordinator gate.
- Refresh rotation locks the identified client/family, commits revocation on replay even on HTTP error, preserves absolute/idle/session/original-assurance deadlines and scope narrowing. Wrong-client refresh/revoke does not revoke the victim. Post-lock DB/application clocks constrain issuance and source policy versions; entitlement loss does not prevent user withdrawal. [RFC 9700 §4.14](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14).
- Signing fixes RSA/RS256/kid, rejects weak/duplicate/config-confused keys, exposes only public JWK fields and pins issuer/audience. First-party HMAC, bot, provider opaque access/refresh and provider ID tokens have distinct parsing/authority paths. Rotation retains public verification keys via immutable operator snapshots; deployment must perform documented publish/activate/retire overlap. This review does not certify production key custody/rotation execution.
- Added protobuf fields preserve prior numbers and authority comes from DB, not absent/attacker claims. Local refresh stays local, scoped refresh stays workspace-scoped, old local/bot/guest behavior with SSO off is covered only to the extent of selected App and client tests. Full historical-client builds, complete API/WS/RTC regression, PG17 and generated drift belong to the assigned QA runner and are not claimed here.

## Integrated RTC/DM delta assessment

Source delta `479d99c8..fbaabf8a` incorporates RTC correction `7c9e0a81` and its root DM gate repair. Enumeration now streams room responses into bounded enforcement workers instead of waiting for all rooms; a serialized sweep and sorted-room cursor handle cancellation and slow prefixes. Local DM retains global local-authority/member checks and exact DM row type while requiring ViewRoom; workspace voice still requires Connect. No provider/session authority was widened by this delta.

At `fbaabf8a`, with the same own DB/Redis and Go1.26.5, `go test -race -count=1 -run TestIdentity -v ./internal/rtc` passed 9 tests, and `go test -race -tags integration -count=1 -run '^TestIdentityRTCEnumerationLostRedisEvictsBeforeBarrierPreservesBAndDM$' -v ./internal/app` passed. Logs: `/tmp/identity-v2-protocol-rtc-delta.log`, `/tmp/identity-v2-protocol-rtc-app-delta.log`. This establishes the tested topology; the stated 30-second bound is measured for the supported fixture topology, not arbitrary overload. Final-SHA provider corrections and impact confirmation are still pending.

## Evidence and reproduction

Final review runs use Go **1.26.5 darwin/arm64**, PostgreSQL **18** in the original retained local harness, own `identity_protocol` DB on `127.0.0.1:57418`; App uses dedicated Redis DB10 on port57479 with `identity-protocol:review:` prefix and `TEST_RTC_REDIS_DB=10`. Provider/SSO/App fixtures create/drop unique child DBs. Initial Go1.27.1/independent disposable port59718 runs were superseded by these CI-aligned runs. Missing `identity_protocol`, absent Vitest dependencies and missing live-Keycloak env caused setup failures; each was corrected before final evidence.

| SHA 479d99c8 check | Actual result |
|---|---|
| `go test -race -tags integration -count=1 -json ./internal/oauthprovider/... ./internal/sso/... ./internal/identitynet/... ./internal/identitycrypto/...` | PASS; identitycrypto: 3 passing cases, oauthprovider/signing: 48 passing cases, identitynet: 65 passing cases, sso: 74 passing cases, oauthprovider: 71 passing cases. Default live Keycloak case skipped, separately executed below. |
| `go test -race -tags integration -count=1 -json -run 'TestIdentityHTTP\|TestIdentityAuthorityAndStepUp\|TestIdentityRouteInventoryAndCrossWorkspace\|TestIdentityRefreshAndRecoveryScope\|TestIdentityNoGrantAndLostRedisRevocation\|TestIdentityGatewayPerSessionFanoutAndStaleReplay' ./internal/app` | PASS, 238 cases including route subtests. |
| Independent provider overlay, `-run TestProtocolReview` | maintained RP PASS; six finding probes FAIL as expected; no race report. |
| Keycloak26.4.7 TLS live RP, `CALABA_KEYCLOAK_LIVE=1`, `-run TestKeycloakLiveRP` | PASS, eight subtests; only overlay alteration is fixture DB admission from `identity_keycloak` to own `identity_protocol`. |
| `pnpm -F @calaba/desktop test src/main/auth.identity.test.ts src/main/ssoHandoff.test.ts src/main/deeplink.test.ts src/renderer/platform/web.identity.test.ts src/shared/ssoReturn.test.ts src/shared/identityOrigin.test.ts src/renderer/services/identity.test.ts` | PASS, 7 files / 136 tests; installed frozen lockfile with scripts disabled. |

Raw local evidence: `/tmp/identity-v2-protocol-final.json`, `/tmp/identity-v2-protocol-app-final.json`, `/tmp/identity-v2-protocol-probes-final.log`, `/tmp/identity-v2-protocol-post.log`, `/tmp/identity-v2-protocol-minimum.log`, `/tmp/identity-v2-protocol-hint.log`, `/tmp/identity-v2-protocol-keycloak-final.log`, `/tmp/identity-v2-protocol-desktop.log`. These paths are ephemeral, so executable finding probes are included below. Report-only changes do not justify rerunning common lint/full integration; no visual suites, media or production mutations were run.

Not verified here: Entra, AD FS2019+, Windows AD/LDAPS interoperability, actual external browser consent render/navigation, production proxy/key/secret/backup setup, PG17, full server integration and legacy application binaries. Positive Keycloak evidence proves generic local OIDC interoperability only. Coordinator must ensure two independent final-SHA reviews and QA gates; this report is one independent review.

To reproduce without source edits, save the following as `/tmp/protocol_review_probes_test.go`, then from the repository root run:

```sh
python3 - <<'PYCODE'
from pathlib import Path
import json
virtual = Path.cwd() / 'apps/server/internal/oauthprovider/protocol_review_probes_test.go'
Path('/tmp/protocol-review-overlay.json').write_text(json.dumps({'Replace': {str(virtual): '/tmp/protocol_review_probes_test.go'}}))
PYCODE
cd apps/server
export GOTOOLCHAIN=go1.26.5
export TEST_PG_URL=postgres://identity_test:fixture-only-password@127.0.0.1:57418/identity_protocol
go test -race -tags integration -overlay /tmp/protocol-review-overlay.json -count=1 -run TestProtocolReview -v ./internal/oauthprovider
```

The admin URL must point to this reviewer's dedicated local database, with permission to create/drop disposable child DBs; never use production.

```go
//go:build integration
package oauthprovider
import (
 "context"
 "encoding/json"
 "encoding/base64"
 "net/http"
 "net/url"
 "testing"
 v1 "github.com/calaba/calaba/server/gen/calaba/v1"
 "github.com/coreos/go-oidc/v3/oidc"
)
func TestProtocolReviewMaintainedRP(t *testing.T) {
 f:=fixture(t); c:=f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB,true)
 ctx:=oidc.ClientContext(context.Background(),f.http)
 rp,err:=oidc.NewProvider(ctx,f.s.issuer(f.ws)); if err!=nil {t.Fatal(err)}
 req,code:=f.code(c.Client,true); status,tokens,b:=f.exchange(c,req,code)
 if status!=200 {t.Fatalf("token %d %s",status,b)}
 id,err:=rp.Verifier(&oidc.Config{ClientID:c.Client.ClientId,SupportedSigningAlgs:[]string{"RS256"}}).Verify(ctx,tokens.IDToken)
 if err!=nil || id.Nonce!=req.nonce {t.Fatalf("maintained RP rejects ID: %v",err)}
 t.Log("maintained go-oidc discovery, JWKS, RS256, issuer, audience, expiry and nonce PASS")
}
func TestProtocolReviewMetadataDefaults(t *testing.T) {
 f:=fixture(t)
 for _,path:=range []string{"/oidc/workspaces/"+f.ws.String()+"/.well-known/openid-configuration","/.well-known/oauth-authorization-server/oidc/workspaces/"+f.ws.String()} {
  status,_,b:=f.wire("GET",path,"",nil,"",""); if status!=200 {t.Fatalf("metadata %d",status)}
  var m map[string]any; if err:=json.Unmarshal(b,&m);err!=nil {t.Fatal(err)}
  if m["request_uri_parameter_supported"]!=false {t.Errorf("%s: request_uri unsupported but metadata defaults to true: %v",path,m["request_uri_parameter_supported"])}
  if m["authorization_response_iss_parameter_supported"]!=true {t.Errorf("%s: response includes iss but metadata defaults to false: %v",path,m["authorization_response_iss_parameter_supported"])}
 }
}
func TestProtocolReviewSPADiscoveryCORS(t *testing.T) {
 f:=fixture(t); _=f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA,false)
 origin:="https://rp.example.test"
 for _,suffix:=range []string{"/.well-known/openid-configuration","/jwks"} {
  status,h,_:=f.wire(http.MethodGet,"/oidc/workspaces/"+f.ws.String()+suffix,"",nil,"",origin)
  if status!=200 || (h.Get("Access-Control-Allow-Origin")!=origin && h.Get("Access-Control-Allow-Origin")!="*") {t.Errorf("browser cannot read %s: status=%d ACAO=%q",suffix,status,h.Get("Access-Control-Allow-Origin"))}
 }
}
func TestProtocolReviewCodeReplayRevocation(t *testing.T) {
 f:=fixture(t); c:=f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE,true)
 req,code:=f.code(c.Client,true); status,tokens,b:=f.exchange(c,req,code); if status!=200 {t.Fatalf("initial %d %s",status,b)}
 other:=f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE,true)
 if status,_,_:=f.exchange(other,req,code);status!=400 {t.Fatalf("cross-client replay %d",status)}
 if status,_:=f.info(tokens.AccessToken);status!=200 {t.Fatal("cross-client replay revoked victim")}
 if status,_,_:=f.exchange(c,req,code);status!=400 {t.Fatalf("replay %d",status)}
 if status,_:=f.info(tokens.AccessToken);status!=401 {t.Errorf("correct-client code replay left access valid: %d",status)}
 if status,_,_:=f.token(c,url.Values{"grant_type":{"refresh_token"},"refresh_token":{tokens.RefreshToken}});status!=400 {t.Errorf("correct-client code replay left refresh usable: %d",status)}
}

func TestProtocolReviewAuthorizationPOST(t *testing.T) {
 f:=fixture(t); c:=f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB,false)
 req:=f.begin(c.Client,nil)
 form:=url.Values{"response_type":{"code"},"client_id":{c.Client.ClientId},"redirect_uri":{req.redirect},"scope":{"openid"},"state":{req.state},"nonce":{req.nonce},"code_challenge_method":{"S256"},"code_challenge":{base64.RawURLEncoding.EncodeToString(hash(req.verifier))}}
 status,h,b:=f.wire("POST","/oidc/workspaces/"+f.ws.String()+"/authorize","application/x-www-form-urlencoded",[]byte(form.Encode()),"","")
 if status!=303 {t.Fatalf("valid OIDC POST authorization rejected: %d allow=%q body=%s",status,h.Get("Allow"),b)}
 u,err:=url.Parse(h.Get("Location")); if err!=nil || u.Path!="/oauth/consent" || u.Query().Get("request")=="" {t.Fatal("missing POST consent request")}
}

func TestProtocolReviewMinimumUIAndACRParameters(t *testing.T) {
 for _,parameter:=range []string{"display","ui_locales","claims_locales","acr_values"} {
  t.Run(parameter,func(t *testing.T) {
   f:=fixture(t); c:=f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB,false)
   req:=f.begin(c.Client,nil)
   q:=url.Values{"response_type":{"code"},"client_id":{c.Client.ClientId},"redirect_uri":{req.redirect},"scope":{"openid"},"state":{req.state},"nonce":{req.nonce},"code_challenge_method":{"S256"},"code_challenge":{base64.RawURLEncoding.EncodeToString(hash(req.verifier))}}
   q.Set(parameter,map[string]string{"display":"popup","ui_locales":"de","claims_locales":"de","acr_values":"urn:example:unsupported-acr"}[parameter])
   status,h,b:=f.wire("GET","/oidc/workspaces/"+f.ws.String()+"/authorize?"+q.Encode(),"",nil,"","")
   u,err:=url.Parse(h.Get("Location")); if status!=303 || err!=nil || u.Path!="/oauth/consent" || u.Query().Get("request")=="" {t.Fatalf("mandatory minimum parameter support failed: status=%d location=%s body=%s",status,h.Get("Location"),b)}
  })
 }
}

func TestProtocolReviewIDTokenHintValidation(t *testing.T) {
 f:=fixture(t); c:=f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB,false)
 req:=f.begin(c.Client,nil)
 q:=url.Values{"response_type":{"code"},"client_id":{c.Client.ClientId},"redirect_uri":{req.redirect},"scope":{"openid"},"state":{req.state},"nonce":{req.nonce},"code_challenge_method":{"S256"},"code_challenge":{base64.RawURLEncoding.EncodeToString(hash(req.verifier))},"id_token_hint":{"not-a-jwt"}}
 status,h,b:=f.wire("GET","/oidc/workspaces/"+f.ws.String()+"/authorize?"+q.Encode(),"",nil,"","")
 u,err:=url.Parse(h.Get("Location")); if status==303 && err==nil && u.Path=="/oauth/consent" {t.Fatalf("invalid ID-token hint ignored, request accepted: status=%d body=%s",status,b)}
}
```
