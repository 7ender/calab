//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/identitynet"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/sso"
	"github.com/google/uuid"
)

// Run this file directly: the package's legacy TestMain flushes leased Redis DBs.
// This fixture never injects principals, SessionIssuer, IdP responses or assurances.
func TestIdentityBrowserRealAppKeycloak(t *testing.T) {
	if os.Getenv("CALABA_IDENTITY_BROWSER_REQUIRED") != "1" {
		t.Skip("opt-in: use infra/identity-test/browser-identity-e2e.sh")
	}
	required := func(key string) string {
		t.Helper()
		value := os.Getenv(key)
		if value == "" {
			t.Fatalf("required environment: %s", key)
		}
		return value
	}
	dsn := required("TEST_PG_URL")
	pg, err := url.Parse(dsn)
	if err != nil || pg.Hostname() != "127.0.0.1" || pg.Path != "/identity_browser" {
		t.Fatal("dedicated local identity_browser database required")
	}
	issuer := required("TEST_OIDC_ISSUER")
	upstream, err := url.Parse(issuer)
	if err != nil || upstream.Scheme != "https" || upstream.Hostname() != "127.0.0.1" || upstream.Path != "/realms/identity.test" || upstream.User != nil || upstream.RawQuery != "" || upstream.Fragment != "" {
		t.Fatal("retained local TLS identity.test realm required")
	}
	ca, err := os.ReadFile(required("TEST_OIDC_CA_FILE"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		t.Fatal("invalid fixture CA")
	}
	redisURL := required("TEST_REDIS_URL")
	redisAddr, err := url.Parse(redisURL)
	if err != nil || redisAddr.Hostname() != "127.0.0.1" || redisAddr.Path != "/9" {
		t.Fatal("local Redis DB9 required")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	database, err := db.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err = database.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	rc, err := redisx.Connect(ctx, redisURL)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	runID := uuid.NewString()
	prefix := "browser:" + runID + ":"
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		var cursor uint64
		for {
			scan := rc.Do(cleanup, rc.B().Scan().Cursor(cursor).Match(prefix+"*").Count(100).Build())
			entry, e := scan.AsScanEntry()
			if e != nil {
				t.Error(e)
				return
			}
			if len(entry.Elements) > 0 {
				if e = rc.Do(cleanup, rc.B().Del().Key(entry.Elements...).Build()).Error(); e != nil {
					t.Error(e)
				}
			}
			cursor = entry.Cursor
			if cursor == 0 {
				break
			}
		}
	}()
	uid, a, b := uuid.New(), uuid.New(), uuid.New()
	email := "browser-" + runID + "@identity.test"
	password := "fixture-only-browser-password"
	hash, err := auth.HashPassword(ctx, password)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if _, e := database.Pool.Exec(cleanup, "DELETE FROM workspaces WHERE id=ANY($1::uuid[])", []uuid.UUID{a, b}); e != nil {
			t.Error(e)
		}
		if _, e := database.Pool.Exec(cleanup, "DELETE FROM users WHERE id=$1", uid); e != nil {
			t.Error(e)
		}
	}()
	if _, err = database.Pool.Exec(ctx, "INSERT INTO users(id,email,email_verified_at,display_name,password_hash) VALUES($1,$2,clock_timestamp(),'Browser Fixture',$3)", uid, email, hash); err != nil {
		t.Fatal(err)
	}
	for _, ws := range []uuid.UUID{a, b} {
		if _, err = database.Pool.Exec(ctx, "INSERT INTO workspaces(id,slug,name,owner_id) VALUES($1,$2,$3,$4)", ws, "browser-"+ws.String()[:18], "Browser "+ws.String()[:8], uid); err != nil {
			t.Fatal(err)
		}
		if _, err = database.Pool.Exec(ctx, "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", ws, uid); err != nil {
			t.Fatal(err)
		}
		if _, err = database.Pool.Exec(ctx, "INSERT INTO workspace_plans(workspace_id,plan) VALUES($1,'enterprise') ON CONFLICT(workspace_id) DO UPDATE SET plan='enterprise'", ws); err != nil {
			t.Fatal(err)
		}
		for _, feature := range []string{"corporate_sso", "oauth_provider"} {
			if _, err = database.Pool.Exec(ctx, "INSERT INTO workspace_identity_grants(workspace_id,feature,enabled,source) VALUES($1,$2,true,'cloud_business')", ws, feature); err != nil {
				t.Fatal(err)
			}
		}
	}
	mux := http.NewServeMux()
	server := httptest.NewUnstartedServer(mux)
	origin := "https://" + server.Listener.Addr().String()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signing, _ := json.Marshal(map[string]string{"browser": string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))})
	encryption, _ := json.Marshal(map[string]string{"browser": base64.StdEncoding.EncodeToString(make([]byte, 32))})
	storage := t.TempDir()
	for k, v := range map[string]string{"DATABASE_URL": dsn, "REDIS_URL": redisURL, "REDIS_KEY_PREFIX": prefix, "JWT_SECRET": "fixture-browser-secret-at-least-32-bytes", "STORAGE_PATH": storage, "PUBLIC_APP_URL": origin, "PUBLIC_APP_URL_ALT": "", "PUBLIC_APP_URLS": "", "IDENTITY_PUBLIC_ORIGIN": origin, "IDENTITY_ENCRYPTION_KEYS": string(encryption), "IDENTITY_ENCRYPTION_ACTIVE_KID": "browser", "OAUTH_SIGNING_KEYS": string(signing), "OAUTH_SIGNING_ACTIVE_KID": "browser", "IDENTITY_ENDPOINTS": "", "IDENTITY_DIRECTORY_HOSTS": "", "IDENTITY_EDITION": "cloud", "IDENTITY_ENTERPRISE_WORKSPACE_IDS": "", "LIVEKIT_URL": "", "LIVEKIT_INTERNAL_URL": "", "LIVEKIT_API_KEY": "", "LIVEKIT_API_SECRET": "", "SMTP_HOST": "", "SUPERADMIN_EMAILS": "", "STORAGE_DRIVER": "fs"} {
		t.Setenv(k, v)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	store, err := blob.NewFS(storage)
	if err != nil {
		t.Fatal(err)
	}
	policy := func(raw string) (identitynet.Endpoint, error) {
		u, e := url.Parse(raw)
		allowed := map[string]bool{upstream.Path + "/.well-known/openid-configuration": true, upstream.Path + "/protocol/openid-connect/auth": true, upstream.Path + "/protocol/openid-connect/token": true, upstream.Path + "/protocol/openid-connect/certs": true}
		if e != nil || u.Scheme != "https" || u.Host != upstream.Host || !allowed[u.Path] || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
			return identitynet.Endpoint{}, sso.ErrInvalid
		}
		return identitynet.Endpoint{URL: raw, RootCAs: roots, TestLoopbackCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}}, nil
	}
	application := app.New(app.Deps{Config: cfg, DB: database, Redis: rc, Blob: store, IdentityEndpointPolicy: policy})
	for _, path := range []string{"/api/", "/oidc/", "/.well-known/", "/gateway"} {
		mux.Handle(path, application.Handler)
	}
	web := required("IDENTITY_BROWSER_WEB_DIR")
	webRoot, err := os.OpenRoot(web)
	if err != nil {
		t.Fatal("open the current web bundle root")
	}
	defer func() { _ = webRoot.Close() }()
	webFS := webRoot.FS()
	if _, err = fs.Stat(webFS, "index.html"); err != nil {
		t.Fatal("build the current web bundle first")
	}
	files := http.FileServerFS(webFS)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if _, e := fs.Stat(webFS, strings.TrimPrefix(r.URL.Path, "/")); e != nil || r.URL.Path == "/" {
			http.ServeFileFS(w, r, webFS, "index.html")
			return
		}
		files.ServeHTTP(w, r)
	})
	application.Run(ctx)
	defer cancel() // Stop background workers before fixture rows and Redis keys are removed.
	server.StartTLS()
	defer server.Close()
	payload, _ := json.Marshal(map[string]string{"origin": origin, "workspaceA": a.String(), "workspaceB": b.String(), "slugA": "browser-" + a.String()[:18], "userID": uid.String(), "email": email, "password": password, "issuer": issuer, "runID": runID})
	script := required("IDENTITY_BROWSER_SCRIPT")
	// #nosec G204 -- Opt-in fixture entrypoint from the trusted runner environment, never HTTP input.
	command := exec.CommandContext(ctx, "node", script)
	command.Stdin = bytes.NewReader(payload)
	command.Env = os.Environ()
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("real browser journey failed: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "IDENTITY_BROWSER_GOLDEN_PASS") {
		t.Fatalf("browser exited without golden marker: %s", output)
	}
	t.Log(strings.TrimSpace(string(output)))
	digest := sha256.Sum256(payload)
	t.Logf("synthetic run=%s configuration digest=%x", runID, digest[:8])
	if _, err := fmt.Fprintln(os.Stdout, "IDENTITY_BROWSER_REQUIRED_PASS"); err != nil {
		t.Fatal("write required browser pass marker")
	}
}
