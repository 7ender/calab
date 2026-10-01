//go:build integration

package oauthprovider

import (
	"context"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestProviderDatabaseAndSigningClockBounds(t *testing.T) {
	for _, offset := range []time.Duration{-2 * time.Second, 2 * time.Second} {
		t.Run(offset.String(), func(t *testing.T) {
			f := fixture(t)
			c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
			f.sql("UPDATE sessions SET local_authenticated_at=clock_timestamp()-interval '10 seconds' WHERE id=$1", f.session)
			f.s.c.Now = func() time.Time { return time.Now().Add(offset) }
			req, code := f.code(c.Client, true)
			st, tokens, b := f.exchange(c, req, code)
			if st != 200 {
				t.Fatalf("clock skew exchange %d %s", st, b)
			}
			if tokens.ExpiresIn <= 0 || tokens.ExpiresIn > 300 {
				t.Fatalf("invalid expires_in %d", tokens.ExpiresIn)
			}
			var exceeds bool
			if err := f.d.Pool.QueryRow(context.Background(), "SELECT EXISTS(SELECT FROM oauth_tokens WHERE token_type='access' AND expires_at>created_at+interval '5 minutes') OR EXISTS(SELECT FROM oauth_authorization_codes WHERE expires_at>created_at+interval '60 seconds')").Scan(&exceeds); err != nil || exceeds {
				t.Fatalf("database TTL bound %v %v", exceeds, err)
			}
			st, _, b = f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens.RefreshToken}})
			if st != 200 {
				t.Fatalf("clock skew refresh %d %s", st, b)
			}
		})
	}
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	req, code := f.code(c.Client, true)
	// A clock offset larger than the access lifetime cannot publish a token
	// whose expiration is already behind the authoritative database clock.
	f.s.c.Now = func() time.Time { return time.Now().Add(-6 * time.Minute) }
	if st, _, _ := f.exchange(c, req, code); st != 400 {
		t.Fatal("nonpositive database lifetime issued")
	}
	var count int
	if err := f.d.Pool.QueryRow(context.Background(), "SELECT count(*) FROM oauth_tokens").Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed issuance committed tokens %d %v", count, err)
	}
}

func TestProviderProofExpiresDuringBoundaryLockWait(t *testing.T) {
	f := fixture(t)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
	req, code := f.code(c.Client, true)
	ctx := context.Background()
	tx, err := f.d.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, "SELECT FROM workspaces WHERE id=$1 FOR UPDATE", f.ws); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, "UPDATE oauth_grants SET assurance_expires_at=clock_timestamp()+interval '150 milliseconds'"); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	done := make(chan int, 1)
	go func() { close(started); st, _, _ := f.exchange(c, req, code); done <- st }()
	<-started
	time.Sleep(350 * time.Millisecond)
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if status := <-done; status != 400 {
		t.Fatalf("post-wait proof accepted %d", status)
	}
	var count int
	if err = f.d.Pool.QueryRow(ctx, "SELECT count(*) FROM oauth_tokens").Scan(&count); err != nil || count != 0 {
		t.Fatalf("expired proof minted token %d %v", count, err)
	}
	var revoked bool
	if err = f.d.Pool.QueryRow(ctx, "SELECT revoked_at IS NOT NULL FROM oauth_grants LIMIT 1").Scan(&revoked); err != nil || !revoked {
		t.Fatalf("expired grant revoke rolled back %v %v", revoked, err)
	}
}

func TestProviderClientCapAndBuiltinRole(t *testing.T) {
	f := fixture(t)
	for range 19 {
		c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, false)
		if c.SecretOnce != "" {
			t.Fatal("public client received secret")
		}
	}
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for range 2 {
		wg.Go(func() {
			st, _, _ := f.proto("POST", "/api/workspaces/"+f.ws.String()+"/oauth/clients", &v1.CreateOAuthClientRequest{Name: "Cap race", Type: v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, RedirectUris: []string{"https://rp.example.test/callback"}, Scopes: []string{"openid"}})
			statuses <- st
		})
	}
	wg.Wait()
	close(statuses)
	created, denied := 0, 0
	for st := range statuses {
		if st == 201 {
			created++
		}
		if st == 409 {
			denied++
		}
	}
	if created != 1 || denied != 1 {
		t.Fatalf("cap race created=%d denied=%d", created, denied)
	}
	redirects := make([]string, 11)
	for i := range redirects {
		redirects[i] = "https://rp.example.test/cb/" + strconv.Itoa(i)
	}
	st, _, _ := f.proto("POST", "/api/workspaces/"+f.ws.String()+"/oauth/clients", &v1.CreateOAuthClientRequest{Name: "Too many redirects", Type: v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, RedirectUris: redirects, Scopes: []string{"openid"}})
	if st != 422 {
		t.Fatal("redirect limit omitted")
	}
	f.sql("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", f.ws, f.user)
	if st, _, _ := f.proto("GET", "/api/workspaces/"+f.ws.String()+"/oauth/clients", nil); st != 403 {
		t.Fatal("ordinary role managed clients")
	}
	f.sql("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", f.ws, f.user)
	if st, _, _ := f.proto("GET", "/api/workspaces/"+f.ws.String()+"/oauth/clients", nil); st != 200 {
		t.Fatal("builtin admin denied")
	}
	f.sql("UPDATE sessions SET local_authenticated_at=clock_timestamp()-interval '6 minutes' WHERE id=$1", f.session)
	if st, _, _ := f.proto("GET", "/api/workspaces/"+f.ws.String()+"/oauth/clients", nil); st != 403 {
		t.Fatal("management lacked recent local reauth")
	}
}

func TestProviderIdleExpiresWhileSessionLocked(t *testing.T) {
	for _, endpoint := range []string{"code", "refresh", "userinfo"} {
		t.Run(endpoint, func(t *testing.T) {
			f := fixture(t)
			c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, true)
			req, code := f.code(c.Client, true)
			var tokens tokenResponse
			if endpoint != "code" {
				st, out, b := f.exchange(c, req, code)
				if st != 200 {
					t.Fatalf("setup exchange %d %s", st, b)
				}
				tokens = out
			}
			ctx := context.Background()
			tx, err := f.d.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if _, err = tx.Exec(ctx, "SELECT FROM sessions WHERE id=$1 FOR UPDATE", f.session); err != nil {
				t.Fatal(err)
			}
			f.sql("UPDATE oauth_grants SET idle_expires_at=clock_timestamp()+interval '200 milliseconds'")
			done := make(chan int, 1)
			go func() {
				switch endpoint {
				case "code":
					st, _, _ := f.exchange(c, req, code)
					done <- st
				case "refresh":
					st, _, _ := f.token(c, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens.RefreshToken}})
					done <- st
				case "userinfo":
					st, _ := f.info(tokens.AccessToken)
					done <- st
				}
			}()
			time.Sleep(400 * time.Millisecond)
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			want := 400
			if endpoint == "userinfo" {
				want = 401
			}
			if st := <-done; st != want {
				t.Fatalf("%s idle deadline crossed wait: %d", endpoint, st)
			}
		})
	}
}
