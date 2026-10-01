//go:build integration

package oauthprovider

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/oauthprovider/signing"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestProviderCodeBindingsAndWireErrors(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, false)
	req, code := f.code(c.Client, false)
	for _, modify := range []func(*rpRequest){func(r *rpRequest) { r.verifier = opaque("") }, func(r *rpRequest) { r.redirect += "/child" }} {
		bad := req
		modify(&bad)
		st, _, b := f.exchange(c, bad, code)
		if st != 400 || !strings.Contains(string(b), `"error":"invalid_grant"`) {
			t.Fatalf("binding %d %s", st, b)
		}
	}
	other := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, false)
	if st, _, _ := f.exchange(other, req, code); st != 400 {
		t.Fatal("wrong client redeemed code")
	}
	bad := &v1.OAuthClientSecretResponse{Client: c.Client, SecretOnce: opaque("calab_os_")}
	if st, _, _ := f.exchange(bad, req, code); st != 401 {
		t.Fatal("wrong secret accepted")
	}
	fm := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {req.redirect}, "code_verifier": {req.verifier}, "client_id": {c.Client.ClientId}, "client_secret": {c.SecretOnce}}
	st, _, b := f.wire("POST", "/oidc/workspaces/"+f.ws.String()+"/token", "application/x-www-form-urlencoded", []byte(fm.Encode()), "", "")
	if st != 401 || strings.Contains(string(b), "ERROR_CODE") {
		t.Fatalf("secret post accepted/proto error %d %s", st, b)
	}
	st, _, _ = f.wire("POST", "/oidc/workspaces/"+f.ws.String()+"/token", "application/json", []byte(`{}`), "", "")
	if st != 400 {
		t.Fatal("JSON token body accepted")
	}
	if st, _, b := f.exchange(c, req, code); st != 200 {
		t.Fatalf("failed binding consumed code %d %s", st, b)
	}
	q := url.Values{"client_id": {c.Client.ClientId}, "redirect_uri": {"https://attacker.example/callback"}, "response_type": {"code"}}
	st, h, _ := f.wire("GET", "/oidc/workspaces/"+f.ws.String()+"/authorize?"+q.Encode(), "", nil, "", "")
	if st != 400 || h.Get("Location") != "" {
		t.Fatal("invalid redirect received redirect error")
	}
}

func TestProviderPromptAndMaxAge(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, false)
	q := url.Values{"response_type": {"code"}, "client_id": {c.Client.ClientId}, "redirect_uri": {c.Client.RedirectUris[0]}, "scope": {"openid"}, "state": {"state"}, "nonce": {"nonce"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(hash(opaque("")))}, "prompt": {" none "}}
	path := "/oidc/workspaces/" + f.ws.String() + "/authorize?"
	check := func(want string) {
		t.Helper()
		st, h, b := f.wire("GET", path+q.Encode(), "", nil, "", "")
		if st != 303 {
			t.Fatalf("prompt %d %s", st, b)
		}
		u, err := url.Parse(h.Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		if want != "" && u.Query().Get("error") != want {
			t.Fatalf("wanted %s got %s", want, h.Get("Location"))
		}
		if u.Path == "/oauth/consent" {
			t.Fatal("prompt none opened UI")
		}
		if want == "" && u.Query().Get("code") == "" {
			t.Fatal("prompt none missing code")
		}
	}
	check("login_required")
	root, _ := url.Parse(f.server.URL)
	f.http.Jar.SetCookies(root, []*http.Cookie{{Name: "rp_test_session", Value: f.session.String(), Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode}})
	check("consent_required")
	_, _ = f.code(c.Client, false)
	check("")
	q.Set("max_age", "0")
	check("login_required")
	q.Del("max_age")
	q.Set("prompt", "none consent")
	check("invalid_request")
	req := f.begin(c.Client, url.Values{"prompt": {"login"}})
	if st, _, _ := f.proto("POST", "/api/oauth/requests/"+req.handle+"/bind", &v1.BindOAuthRequest{CsrfToken: req.handle}); st == 200 {
		t.Fatal("prompt login accepted old authentication")
	}
	f.sql("UPDATE sessions SET local_authenticated_at=clock_timestamp() WHERE id=$1", f.session)
	req = f.bindRequest(req)
	if code := f.decision(req, true, false); code == "" {
		t.Fatal("fresh login rejected")
	}
}

func TestProviderDurableBoundaryInvalidation(t *testing.T) {
	for _, tc := range []struct{ name, sql string }{
		{"plan_downgrade", "UPDATE workspace_plans SET plan='free' WHERE workspace_id=$1"},
		{"entitlement_off", "UPDATE workspace_identity_grants SET enabled=false WHERE workspace_id=$1"},
		{"policy_version", "UPDATE workspace_identity_policies SET version=version+1 WHERE workspace_id=$1"},
		{"session_revoke", "UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$2"},
		{"membership_suspended", "INSERT INTO workspace_identity_access(workspace_id,user_id,status) VALUES($1,$2,'suspended')"},
		{"idle_expired", "UPDATE oauth_grants SET idle_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1"},
		{"absolute_expired", "UPDATE oauth_grants SET expires_at=created_at+interval '1 millisecond',idle_expires_at=created_at+interval '1 millisecond' WHERE workspace_id=$1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := fixture(t)
			c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
			req, code := f.code(c.Client, true)
			st, tokens, b := f.exchange(c, req, code)
			if st != 200 {
				t.Fatalf("exchange %d %s", st, b)
			}
			// Each query has a different placeholder count; fixture argument selection
			// keeps mutations targeted without broad updates or another worker's database.
			switch tc.name {
			case "session_revoke":
				f.sql(tc.sql+" AND $1::uuid IS NOT NULL", f.ws, f.session)
			case "membership_suspended":
				f.sql(tc.sql+" ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='suspended'", f.ws, f.user)
			default:
				f.sql(tc.sql, f.ws)
			}
			if st, _ := f.info(tokens.AccessToken); st != 401 {
				t.Fatalf("stale grant accepted %d", st)
			}
			if st, _, _ := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens.RefreshToken}}); st != 400 {
				t.Fatal("stale refresh accepted")
			}
			var reason *string
			if err := f.d.Pool.QueryRow(context.Background(), "SELECT revoked_reason FROM oauth_grants LIMIT 1").Scan(&reason); err != nil || reason == nil {
				t.Fatalf("lost access not durably revoked %v", err)
			}
		})
	}
}

func TestProviderSecretRotationAndClientRevision(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, true)
	req, code := f.code(c.Client, true)
	clientPath := "/api/workspaces/" + f.ws.String() + "/oauth/clients/" + c.Client.Id
	in := &v1.UpdateOAuthClientRequest{Version: c.Client.Version, Name: "Renamed RP", RedirectUris: c.Client.RedirectUris, Scopes: c.Client.Scopes, RefreshEnabled: true}
	st, _, b := f.proto("PATCH", clientPath, in)
	if st != 200 {
		t.Fatalf("rename %d %s", st, b)
	}
	renamed := &v1.OAuthClient{}
	if err := protojson.Unmarshal(b, renamed); err != nil {
		t.Fatal(err)
	}
	if renamed.Version != c.Client.Version {
		t.Fatal("name-only update bumped security revision")
	}
	st, tokens, b := f.exchange(c, req, code)
	if st != 200 {
		t.Fatalf("rename invalidated code %d %s", st, b)
	}
	st, _, b = f.proto("POST", clientPath+"/rotate-secret", &v1.RotateOAuthClientSecretRequest{})
	if st != 200 {
		t.Fatalf("rotate %d %s", st, b)
	}
	rotated := &v1.OAuthClientSecretResponse{}
	if err := protojson.Unmarshal(b, rotated); err != nil {
		t.Fatal(err)
	}
	if rotated.SecretOnce == "" || rotated.SecretOnce == c.SecretOnce || rotated.OldSecretValidUntil == nil {
		t.Fatal("rotation did not reveal new secret/overlap")
	}
	if st, _ := f.info(tokens.AccessToken); st != 401 {
		t.Fatal("security revision retained old grant")
	}
	if st, _, _ := f.proto("POST", clientPath+"/rotate-secret", &v1.RotateOAuthClientSecretRequest{}); st != 409 {
		t.Fatal("third valid secret created")
	}
	req, code = f.code(rotated.Client, true)
	if st, _, b := f.exchange(c, req, code); st != 200 {
		t.Fatalf("old secret overlap rejected %d %s", st, b)
	}
	st, _, b = f.proto("GET", clientPath, nil)
	if st != 200 || strings.Contains(string(b), rotated.SecretOnce) || strings.Contains(string(b), c.SecretOnce) || strings.Contains(string(b), "secret") {
		t.Fatal("secret exposed in client GET")
	}
	st, _, b = f.proto("POST", clientPath+"/rotate-secret", &v1.RotateOAuthClientSecretRequest{RevokeOld: true})
	if st != 200 {
		t.Fatalf("revoke old %d %s", st, b)
	}
	latest := &v1.OAuthClientSecretResponse{}
	if err := protojson.Unmarshal(b, latest); err != nil {
		t.Fatal(err)
	}
	req, code = f.code(latest.Client, true)
	if st, _, _ := f.exchange(c, req, code); st != 401 {
		t.Fatal("revoked old secret authenticated")
	}
	if st, _, b := f.exchange(latest, req, code); st != 200 {
		t.Fatalf("new secret failed %d %s", st, b)
	}
}

func TestProviderRevocationWithoutEntitlementAndSubjects(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	req, code := f.code(c.Client, true)
	st, tokens, b := f.exchange(c, req, code)
	if st != 200 {
		t.Fatalf("exchange %d %s", st, b)
	}
	_, info := f.info(tokens.AccessToken)
	subject := info["sub"]
	other := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, false)
	req, code = f.code(other.Client, false)
	st, otherTokens, b := f.exchange(other, req, code)
	if st != 200 {
		t.Fatalf("other app %d %s", st, b)
	}
	_, otherInfo := f.info(otherTokens.AccessToken)
	if otherInfo["sub"] != subject {
		t.Fatal("same workspace subject changed across client")
	}
	f.sql("UPDATE workspace_identity_grants SET enabled=false WHERE workspace_id=$1", f.ws)
	st, _, b = f.proto("GET", "/api/me/oauth-grants", nil)
	if st != 200 {
		t.Fatalf("own grants locked by plan %d %s", st, b)
	}
	var grants v1.ListOAuthGrantsResponse
	if err := protojson.Unmarshal(b, &grants); err != nil {
		t.Fatal(err)
	}
	if st, _, b := f.proto("DELETE", "/api/me/oauth-grants/"+grants.Grants[0].Id, nil); st != 204 {
		t.Fatalf("revoke without plan %d %s", st, b)
	}
	// A restored entitlement cannot resurrect the revoked consent/family.
	f.sql("UPDATE workspace_identity_grants SET enabled=true WHERE workspace_id=$1", f.ws)
	if st, _ := f.info(otherTokens.AccessToken); st != 401 {
		t.Fatal("revoked grant resurrected")
	}
	f.sql("UPDATE users SET email_verified_at=NULL WHERE id=$1", f.user)
	req, code = f.code(c.Client, false)
	st, tokens, b = f.exchange(c, req, code)
	if st != 200 {
		t.Fatalf("unverified email exchange %d %s", st, b)
	}
	_, info = f.info(tokens.AccessToken)
	if _, ok := info["email"]; ok {
		t.Fatal("unverified email claim exposed")
	}
	claims := f.verifyID(tokens.IDToken, c.Client.ClientId, req.nonce)
	if _, ok := claims["email"]; ok {
		t.Fatal("unverified email in ID token")
	}
}

func TestProviderOriginalAssuranceDeadline(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	connection, identity := uuid.New(), uuid.New()
	f.sql("INSERT INTO workspace_identity_connections(id,workspace_id,name,status,provider,issuer,client_id,tested_version) VALUES($1,$2,'Test IdP','active','generic','https://idp.example.test','upstream',1)", connection, f.ws)
	f.sql("INSERT INTO workspace_external_identities(id,workspace_id,connection_id,user_id,issuer,subject,status) VALUES($1,$2,$3,$4,'https://idp.example.test','upstream-alice','active')", identity, f.ws, connection, f.user)
	f.sql("INSERT INTO workspace_identity_grants(workspace_id,feature,enabled,source) VALUES($1,'corporate_sso',true,'cloud_business')", f.ws)
	f.sql("UPDATE workspace_identity_policies SET mode='enforced' WHERE workspace_id=$1", f.ws)
	at := time.Now().Add(-time.Second).UTC()
	deadline := at.Add(90 * time.Second)
	f.sql("INSERT INTO session_workspace_assurances(session_id,workspace_id,user_id,connection_id,identity_id,authenticated_at,valid_until,policy_version,access_version,connection_version,identity_version,entitlement_version,session_version) SELECT $1,$2,$3,$4,$5,$6,$7,p.version,1,1,1,p.entitlement_version,1 FROM workspace_identity_policies p WHERE p.workspace_id=$2", f.session, f.ws, f.user, connection, identity, at, deadline)
	req, code := f.code(c.Client, true)
	// A verified later authentication may renew this session's assurance, but
	// it cannot extend an existing provider grant's captured proof deadline.
	renewed := time.Now().UTC()
	f.sql("UPDATE session_workspace_assurances SET authenticated_at=$1,valid_until=$2", renewed, renewed.Add(time.Hour))
	st, tokens, b := f.exchange(c, req, code)
	if st != 200 {
		t.Fatalf("bound exchange %d %s", st, b)
	}
	claims := f.verifyID(tokens.IDToken, c.Client.ClientId, req.nonce)
	if claims["exp"].(float64) > float64(deadline.Unix()) {
		t.Fatal("ID lifetime extended past grant proof")
	}
	var latestExpiry time.Time
	if err := f.d.Pool.QueryRow(context.Background(), "SELECT max(expires_at) FROM oauth_tokens").Scan(&latestExpiry); err != nil || latestExpiry.After(deadline) {
		t.Fatalf("issued token deadline %v %v", latestExpiry, err)
	}
	st, rotated, b := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens.RefreshToken}})
	if st != 200 {
		t.Fatalf("bound refresh %d %s", st, b)
	}
	claims = f.verifyID(rotated.IDToken, c.Client.ClientId, "")
	if claims["exp"].(float64) > float64(deadline.Unix()) {
		t.Fatal("refreshed proof extended old grant")
	}
	f.s.c.Now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if st, _, _ := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {rotated.RefreshToken}}); st != 400 {
		t.Fatal("renewed session resurrected expired original grant proof")
	}
}

func TestProviderCrossWorkspaceAndSPAOrigin(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA, false)
	req, code := f.code(c.Client, false)
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {req.redirect}, "code_verifier": {req.verifier}, "client_id": {c.Client.ClientId}}
	path := "/oidc/workspaces/" + f.ws.String() + "/token"
	if st, _, _ := f.wire("POST", path, "application/x-www-form-urlencoded", []byte(form.Encode()), "", "https://evil.example.test"); st != 400 {
		t.Fatal("foreign SPA origin accepted")
	}
	st, h, b := f.wire("POST", path, "application/x-www-form-urlencoded", []byte(form.Encode()), "", "https://rp.example.test")
	if st != 200 || h.Get("Access-Control-Allow-Origin") != "https://rp.example.test" || h.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("SPA exact CORS %d %s", st, b)
	}
	var tokens tokenResponse
	if err := json.Unmarshal(b, &tokens); err != nil {
		t.Fatal(err)
	}
	otherWS := uuid.New()
	f.sql("INSERT INTO workspaces(id,slug,name,owner_id) VALUES($1,'other-tenant','Other tenant',$2)", otherWS, f.user)
	st, _, _ = f.wire("GET", "/oidc/workspaces/"+otherWS.String()+"/userinfo", "", nil, "Bearer "+tokens.AccessToken, "")
	if st != 401 {
		t.Fatal("cross workspace access token accepted")
	}
	st, _, _ = f.wire("POST", "/oidc/workspaces/"+otherWS.String()+"/token", "application/x-www-form-urlencoded", []byte(form.Encode()), "", "")
	if st != 401 {
		t.Fatal("cross workspace code client accepted")
	}
	if st, _, _ := f.proto("DELETE", "/api/workspaces/"+otherWS.String()+"/oauth/clients/"+c.Client.Id, nil); st == 204 {
		t.Fatal("cross workspace management accepted")
	}
	_, originalInfo := f.info(tokens.AccessToken)
	f.sql("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", otherWS, f.user)
	f.sql("INSERT INTO workspace_plans(workspace_id,plan) VALUES($1,'enterprise')", otherWS)
	f.sql("INSERT INTO workspace_identity_grants(workspace_id,feature,enabled,source) VALUES($1,'oauth_provider',true,'cloud_business')", otherWS)
	f.ws = otherWS
	otherClient := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, false)
	req, code = f.code(otherClient.Client, false)
	st, otherTokens, b := f.exchange(otherClient, req, code)
	if st != 200 {
		t.Fatalf("other workspace exchange %d %s", st, b)
	}
	_, otherInfo := f.info(otherTokens.AccessToken)
	if otherInfo["sub"] == originalInfo["sub"] {
		t.Fatal("public subject correlated across workspace issuer")
	}
}

func TestProviderKeyRotationAndRevocationWire(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	req, code := f.code(c.Client, true)
	st, tokens, b := f.exchange(c, req, code)
	if st != 200 {
		t.Fatalf("initial exchange %d %s", st, b)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	next := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	f.s.c.SignerForWorkspace = func(ws uuid.UUID) (*signing.Keyring, error) {
		return signing.New(signing.Config{Issuer: f.s.issuer(ws), ActiveKID: "next-key", Keys: []signing.Key{{KID: "fixture-key", PEM: f.private}, {KID: "next-key", PEM: next}}})
	}
	f.verifyID(tokens.IDToken, c.Client.ClientId, req.nonce)
	st, rotated, b := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens.RefreshToken}})
	if st != 200 {
		t.Fatalf("key rotation refresh %d %s", st, b)
	}
	f.verifyID(rotated.IDToken, c.Client.ClientId, "")
	st, _, b = f.wire("GET", "/oidc/workspaces/"+f.ws.String()+"/jwks", "", nil, "", "")
	if st != 200 {
		t.Fatal("JWKS failed")
	}
	var set struct{ Keys []map[string]any }
	if err = json.Unmarshal(b, &set); err != nil {
		t.Fatal(err)
	}
	if len(set.Keys) != 2 {
		t.Fatal("old verification key prematurely removed")
	}
	for _, key := range set.Keys {
		for _, private := range []string{"d", "p", "q", "dp", "dq", "qi"} {
			if _, ok := key[private]; ok {
				t.Fatal("private key published")
			}
		}
	}
	other := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	revokePath := "/oidc/workspaces/" + f.ws.String() + "/revoke"
	form := url.Values{"token": {rotated.AccessToken}, "client_id": {other.Client.ClientId}}
	st, _, _ = f.wire("POST", revokePath, "application/x-www-form-urlencoded", []byte(form.Encode()), "", "")
	if st != 200 {
		t.Fatal("unknown/wrong-client revoke disclosed token")
	}
	if st, _ := f.info(rotated.AccessToken); st != 200 {
		t.Fatal("wrong client revoked another family")
	}
	form.Set("client_id", c.Client.ClientId)
	st, _, _ = f.wire("POST", revokePath, "application/x-www-form-urlencoded", []byte(form.Encode()), "", "")
	if st != 200 {
		t.Fatal("correct revoke failed")
	}
	if st, _ := f.info(rotated.AccessToken); st != 401 {
		t.Fatal("revoked access accepted")
	}
	if st, _, _ := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {rotated.RefreshToken}}); st != 400 {
		t.Fatal("revoked refresh accepted")
	}
}
