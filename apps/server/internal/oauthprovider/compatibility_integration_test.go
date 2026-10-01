//go:build integration

package oauthprovider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/google/uuid"
)

func TestProviderPublicDocumentsSPACORS(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA, false)
	origin := c.Client.AllowedOrigins[0]
	paths := []string{
		"/oidc/workspaces/" + f.ws.String() + "/.well-known/openid-configuration",
		"/.well-known/oauth-authorization-server/oidc/workspaces/" + f.ws.String(),
		"/oidc/workspaces/" + f.ws.String() + "/jwks",
	}
	check := func(path, origin string, want int) {
		t.Helper()
		st, h, b := f.wire(http.MethodGet, path, "", nil, "", origin)
		if st != want {
			t.Fatalf("document %s origin=%q: %d %s", path, origin, st, b)
		}
		allowed := ""
		if want == http.StatusOK && origin != f.s.c.PublicOrigin {
			allowed = origin
		}
		if h.Get("Access-Control-Allow-Origin") != allowed || h.Get("Access-Control-Allow-Credentials") != "" || !strings.Contains(h.Get("Vary"), "Origin") {
			t.Fatalf("document CORS headers: %v", h)
		}
		if want != http.StatusOK {
			if h.Get("Cache-Control") != "no-store" {
				t.Fatalf("cached CORS rejection: %v", h)
			}
			return
		}
		if strings.HasSuffix(path, "/jwks") {
			if h.Get("Cache-Control") != "public, max-age=60" || h.Get("Pragma") != "" {
				t.Fatalf("JWKS cache headers: %v", h)
			}
			return
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		if m["request_uri_parameter_supported"] != false || m["authorization_response_iss_parameter_supported"] != true {
			t.Fatalf("incorrect capability metadata: %+v", m)
		}
		if got := m["response_types_supported"].([]any); len(got) != 1 || got[0] != "code" {
			t.Fatalf("unsupported response type: %v", got)
		}
		if got := m["grant_types_supported"].([]any); len(got) != 2 || got[0] != "authorization_code" || got[1] != "refresh_token" {
			t.Fatalf("unsupported grant type: %v", got)
		}
	}
	for _, path := range paths {
		check(path, origin, http.StatusOK)
		check(path, "", http.StatusOK)
		check(path, f.s.c.PublicOrigin, http.StatusOK)
		for _, bad := range []string{"https://unknown.example.test", origin + "/", origin + ":443", "null", "https://rp.example.test.evil.test"} {
			check(path, bad, http.StatusBadRequest)
		}
	}
	// The same registered origin must not carry into another issuer.
	otherWS := uuid.New()
	f.sql("INSERT INTO workspaces(id,slug,name,owner_id) VALUES($1,$2,'Other workspace',$3)", otherWS, "other-"+otherWS.String()[:8], f.user)
	for _, path := range paths {
		check(strings.ReplaceAll(path, f.ws.String(), otherWS.String()), origin, http.StatusBadRequest)
	}
	f.sql("UPDATE oauth_clients SET disabled_at=clock_timestamp() WHERE id=$1", uuid.MustParse(c.Client.Id))
	for _, path := range paths {
		check(path, origin, http.StatusBadRequest)
		check(path, "", http.StatusOK)
	}
	// A non-SPA registration cannot authorize public document CORS.
	native := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, false)
	f.sql("UPDATE oauth_clients SET allowed_origins=$2 WHERE id=$1", uuid.MustParse(native.Client.Id), []string{origin})
	for _, path := range paths {
		check(path, origin, http.StatusBadRequest)
	}
}

func TestProviderCodeReplayBindingsAndDurableRevocation(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, true)
	req, code := f.code(c.Client, true)
	st, issued, b := f.exchange(c, req, code)
	if st != http.StatusOK {
		t.Fatalf("exchange %d %s", st, b)
	}
	other := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, true)
	otherReq, otherCode := f.code(other.Client, true)
	st, independent, b := f.exchange(other, otherReq, otherCode)
	if st != http.StatusOK {
		t.Fatalf("independent exchange %d %s", st, b)
	}
	// A separate user's family for the same client must also survive replay.
	otherUser, otherSession := uuid.New(), uuid.New()
	f.sql("INSERT INTO users(id,display_name,email,email_verified_at) VALUES($1,'Bob','bob@example.test',clock_timestamp())", otherUser)
	f.sql("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", f.ws, otherUser)
	f.sql("INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,local_authenticated_at) VALUES($1,$2,$3,clock_timestamp()+interval '8 hours',clock_timestamp())", otherSession, otherUser, hash("independent replay fixture"))
	session := f.session
	f.session = otherSession
	sameReq, sameCode := f.code(c.Client, true)
	st, sameClient, b := f.exchange(c, sameReq, sameCode)
	f.session = session
	if st != http.StatusOK {
		t.Fatalf("same client independent exchange %d %s", st, b)
	}
	// Authenticate a real client of a different workspace, using the same redirect.
	ws := f.ws
	otherWS := uuid.New()
	f.sql("INSERT INTO workspaces(id,slug,name,owner_id) VALUES($1,$2,'Other workspace',$3)", otherWS, "other-"+otherWS.String()[:8], f.user)
	f.sql("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", otherWS, f.user)
	f.sql("INSERT INTO workspace_plans(workspace_id,plan) VALUES($1,'enterprise')", otherWS)
	f.sql("INSERT INTO workspace_identity_grants(workspace_id,feature,enabled,source) VALUES($1,'oauth_provider',true,'cloud_business')", otherWS)
	f.ws = otherWS
	cross := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, true)
	f.ws = ws
	badSecret := &v1.OAuthClientSecretResponse{Client: c.Client, SecretOnce: opaque("calab_os_")}
	access := []string{issued.AccessToken}
	current := issued
	for _, negative := range []struct {
		name   string
		client *v1.OAuthClientSecretResponse
		modify func(*rpRequest)
		ws     uuid.UUID
		want   int
	}{
		{"client", other, nil, ws, 400},
		{"secret", badSecret, nil, ws, 401},
		{"verifier", c, func(r *rpRequest) { r.verifier = opaque("") }, ws, 400},
		{"malformed verifier", c, func(r *rpRequest) { r.verifier = "bad" }, ws, 400},
		{"redirect", c, func(r *rpRequest) { r.redirect += "/child" }, ws, 400},
		{"workspace", cross, nil, otherWS, 400},
	} {
		t.Run(negative.name, func(t *testing.T) {
			bad := req
			if negative.modify != nil {
				negative.modify(&bad)
			}
			f.ws = negative.ws
			st, _, b := f.exchange(negative.client, bad, code)
			f.ws = ws
			if st != negative.want {
				t.Fatalf("wrong-bound replay %d %s", st, b)
			}
			if st, _ := f.info(current.AccessToken); st != 200 {
				t.Fatal("wrong-bound replay revoked access")
			}
			st, next, b := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {current.RefreshToken}})
			if st != 200 {
				t.Fatalf("wrong-bound replay revoked refresh: %d %s", st, b)
			}
			current = next
			access = append(access, next.AccessToken)
		})
	}
	// Retain consumed-code evidence beyond its exchange deadline. Reuse must
	// revoke even then, without extending any grant or code deadline.
	f.sql("UPDATE oauth_authorization_codes SET created_at=clock_timestamp()-interval '60 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE code_hash=$1", hash(code))
	ctx := context.Background()
	var grantID uuid.UUID
	var before, idle, codeUntil time.Time
	if err := f.d.Pool.QueryRow(ctx, "SELECT g.id,g.expires_at,g.idle_expires_at,c.expires_at FROM oauth_grants g JOIN oauth_authorization_codes c ON c.grant_id=g.id WHERE c.code_hash=$1", hash(code)).Scan(&grantID, &before, &idle, &codeUntil); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		st, _, b = f.exchange(c, req, code)
		if st != 400 || !strings.Contains(string(b), `"error":"invalid_grant"`) {
			t.Fatalf("replay %d %s", st, b)
		}
	}
	for _, token := range access {
		if st, _ := f.info(token); st != 401 {
			t.Fatal("replay left an access generation usable")
		}
	}
	for _, token := range []string{issued.RefreshToken, current.RefreshToken} {
		if st, _, _ := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {token}}); st != 400 {
			t.Fatal("replay left refresh usable")
		}
	}
	if st, _ := f.info(independent.AccessToken); st != 200 {
		t.Fatal("replay revoked an unrelated client grant")
	}
	if st, _ := f.info(sameClient.AccessToken); st != 200 {
		t.Fatal("replay revoked another family for the same client")
	}
	if st, _, b := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {sameClient.RefreshToken}}); st != 200 {
		t.Fatalf("replay revoked another family's refresh: %d %s", st, b)
	}
	var revoked bool
	var reason string
	var after, afterIdle, afterCode time.Time
	if err := f.d.Pool.QueryRow(ctx, "SELECT g.revoked_at IS NOT NULL,g.revoked_reason,g.expires_at,g.idle_expires_at,c.expires_at FROM oauth_grants g JOIN oauth_authorization_codes c ON c.grant_id=g.id WHERE g.id=$1", grantID).Scan(&revoked, &reason, &after, &afterIdle, &afterCode); err != nil {
		t.Fatal(err)
	}
	if !revoked || reason != "authorization_code_reuse" || !before.Equal(after) || !idle.Equal(afterIdle) || !codeUntil.Equal(afterCode) {
		t.Fatalf("revocation/deadline mismatch: revoked=%t reason=%s", revoked, reason)
	}
	var audit, outbox int
	if err := f.d.Pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM workspace_identity_audit WHERE target_id=$1 AND action='authorization_code_reuse'),(SELECT count(*) FROM identity_invalidation_outbox WHERE workspace_id=$2 AND reason='authorization_code_reuse')", grantID, ws).Scan(&audit, &outbox); err != nil || audit != 1 || outbox != 1 {
		t.Fatalf("durable idempotent audit/outbox: %d/%d %v", audit, outbox, err)
	}
}

func TestProviderCodeReplayRacesRefresh(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	req, code := f.code(c.Client, true)
	st, issued, b := f.exchange(c, req, code)
	if st != 200 {
		t.Fatalf("exchange %d %s", st, b)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	var rotated tokenResponse
	wg.Go(func() {
		<-start
		st, _, b := f.exchange(c, req, code)
		if st != 400 || !strings.Contains(string(b), `"error":"invalid_grant"`) {
			t.Errorf("reuse %d %s", st, b)
		}
	})
	wg.Go(func() {
		<-start
		st, out, b := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {issued.RefreshToken}})
		if st != 200 && st != 400 {
			t.Errorf("refresh %d %s", st, b)
		}
		rotated = out
	})
	close(start)
	wg.Wait()
	for _, token := range []string{issued.AccessToken, rotated.AccessToken} {
		if token != "" {
			if st, _ := f.info(token); st != 401 {
				t.Fatal("reuse/refresh race left access usable")
			}
		}
	}
	for _, token := range []string{issued.RefreshToken, rotated.RefreshToken} {
		if token != "" {
			if st, _, _ := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {token}}); st != 400 {
				t.Fatal("reuse/refresh race left refresh usable")
			}
		}
	}
}

// A public document registration does not widen token/revoke/UserInfo CORS.
func TestProviderPublicDocumentRegistrationDoesNotWidenTokenCORS(t *testing.T) {
	f := fixture(t)
	spa := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA, false)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, false)
	req, code := f.code(c.Client, false)
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {req.redirect}, "code_verifier": {req.verifier}}
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte(url.QueryEscape(c.Client.ClientId)+":"+url.QueryEscape(c.SecretOnce)))
	st, h, _ := f.wire("POST", "/oidc/workspaces/"+f.ws.String()+"/token", "application/x-www-form-urlencoded", []byte(form.Encode()), auth, spa.Client.AllowedOrigins[0])
	if st != 400 || h.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("workspace SPA registration widened confidential token CORS")
	}
	st, tokens, b := f.exchange(c, req, code)
	if st != 200 {
		t.Fatalf("failed CORS consumed code: %d %s", st, b)
	}
	origin := spa.Client.AllowedOrigins[0]
	st, h, _ = f.wire("GET", "/oidc/workspaces/"+f.ws.String()+"/userinfo", "", nil, "Bearer "+tokens.AccessToken, origin)
	if st != 400 || h.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("workspace SPA registration widened confidential UserInfo CORS")
	}
	form = url.Values{"token": {tokens.AccessToken}}
	st, h, _ = f.wire("POST", "/oidc/workspaces/"+f.ws.String()+"/revoke", "application/x-www-form-urlencoded", []byte(form.Encode()), auth, origin)
	if st != 400 || h.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("workspace SPA registration widened confidential revocation CORS")
	}
	if st, _ := f.info(tokens.AccessToken); st != 200 {
		t.Fatal("failed CORS revoked the family")
	}
}
