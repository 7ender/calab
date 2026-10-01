//go:build integration

package sso

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

func ownerTestFlow(t *testing.T, f *serviceFixture, native bool, age time.Duration) (BeginResult, CallbackResult, string) {
	t.Helper()
	ctx := t.Context()
	begin, cb := f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LINK, "owner-subject")
	if _, err := f.s.Finish(ctx, cb.FlowID, begin.Browser); err != nil {
		t.Fatal(err)
	}
	req := &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_TEST, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB}
	verifier := ""
	if native {
		req.ClientKind = pb.SSOClientKind_SSO_CLIENT_KIND_DESKTOP
		var err error
		verifier, err = identitycrypto.Secret()
		if err != nil {
			t.Fatal(err)
		}
		req.DesktopChallenge, err = identitycrypto.S256(verifier)
		if err != nil {
			t.Fatal(err)
		}
	}
	begin, err := f.s.Begin(ctx, f.p, f.ws, req)
	if err != nil {
		t.Fatal(err)
	}
	authorization := begin.Response.AuthorizationUrl
	if native {
		_, begin.Browser, authorization, err = f.s.BrowserStart(ctx, mustURL(begin.Response.BrowserStartUrl).Query().Get("handle"))
		if err != nil {
			t.Fatal(err)
		}
	}
	code, state := f.idp.code(t, authorization, "owner-subject", map[string]any{"auth_time": time.Now().Add(-age).Unix()})
	cb, err = f.s.Callback(ctx, f.connection, state, begin.Browser, code)
	if err != nil {
		t.Fatal(err)
	}
	return begin, cb, verifier
}

// Hold the actual revocation boundary until the operation is observed waiting in PG.
func waitOwnerBoundary(t *testing.T, f *serviceFixture, operation func(context.Context) error, advance func()) error {
	return waitOwnerSQLLock(t, f, operation, advance, `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, f.ws)
}

func waitOwnerSQLLock(t *testing.T, f *serviceFixture, operation func(context.Context) error, advance func(), query string, args ...any) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	tx, err := f.s.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err = tx.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
	var pid int32
	if err = tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- operation(ctx) }()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err = f.s.DB.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case err = <-done:
			t.Fatalf("operation completed before reaching boundary: %v", err)
		case <-ctx.Done():
			t.Fatal("operation never waited on boundary")
		case <-ticker.C:
		}
	}
	advance()
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return <-done
}

func TestSSOOwnerActivationRechecksProofAfterRevocationWait(t *testing.T) {
	f := newServiceFixture(t)
	begin, cb, _ := ownerTestFlow(t, f, false, 4*time.Minute)
	if _, err := f.s.Finish(t.Context(), cb.FlowID, begin.Browser); err != nil {
		t.Fatal(err)
	}
	session, err := f.s.DB.Q.CreateScopedIdentitySession(t.Context(), sqlc.CreateScopedIdentitySessionParams{UserID: f.user, RefreshTokenHash: identitycrypto.Hash("affected-fixture"), ExpiresAt: time.Now().Add(time.Hour), AuthorityKind: "workspace_sso", AuthorityWorkspaceID: &f.ws, AuthorityConnectionID: &f.connection})
	if err != nil {
		t.Fatal(err)
	}
	var offset atomic.Int64
	f.s.Now = func() time.Time { return time.Now().Add(time.Duration(offset.Load())) }
	err = waitOwnerSQLLock(t, f, func(ctx context.Context) error {
		_, err := f.s.ActivateConnection(ctx, f.p, f.ws, f.connection, 1)
		return err
	}, func() { offset.Store(int64(2 * time.Minute)) }, `SELECT id FROM sessions WHERE id=$1 FOR UPDATE`, session.ID)
	requireRecentOwnerProof(t, err)
	c, err := f.s.DB.Q.GetIdentityConnection(t.Context(), sqlc.GetIdentityConnectionParams{WorkspaceID: f.ws, ID: f.connection})
	if err != nil || c.Status != "tested" {
		t.Fatalf("expired activation did not rollback: %s %v", c.Status, err)
	}
}

func requireRecentOwnerProof(t *testing.T, err error) {
	t.Helper()
	var access *AccessError
	if !errors.As(err, &access) || access.Decision.Reason != identitypolicy.RecentAuthRequired {
		t.Fatalf("want RECENT_AUTH_REQUIRED, got %v", err)
	}
}

func TestSSOOwnerTestFinishRechecksProofAfterLock(t *testing.T) {
	for _, native := range []bool{false, true} {
		for _, stale := range []bool{false, true} {
			name := "web"
			if native {
				name = "native"
			}
			if stale {
				name += "/expired"
			} else {
				name += "/fresh"
			}
			t.Run(name, func(t *testing.T) {
				f := newServiceFixture(t)
				age := time.Duration(0)
				if stale {
					age = 4 * time.Minute
				}
				begin, cb, verifier := ownerTestFlow(t, f, native, age)
				var offset atomic.Int64
				f.s.Now = func() time.Time { return time.Now().Add(time.Duration(offset.Load())) }
				var out Result
				err := waitOwnerBoundary(t, f, func(ctx context.Context) error {
					var err error
					if native {
						out, err = f.s.Exchange(ctx, cb.FlowID, cb.Ticket, verifier)
					} else {
						out, err = f.s.Finish(ctx, cb.FlowID, begin.Browser)
					}
					return err
				}, func() { offset.Store(int64(2 * time.Minute)) })
				if stale {
					requireRecentOwnerProof(t, err)
					c, err := f.s.DB.Q.GetIdentityConnection(t.Context(), sqlc.GetIdentityConnectionParams{WorkspaceID: f.ws, ID: f.connection})
					if err != nil || c.TestedAt != nil || c.TestedVersion != nil {
						t.Fatalf("expired proof marked connection tested: %v", err)
					}
					flow, err := f.s.DB.Q.GetIdentityLoginTransactionByID(t.Context(), cb.FlowID)
					if err != nil || flow.FinishedAt != nil {
						t.Fatalf("rejected completion consumed flow: %v", err)
					}
				} else if err != nil || !out.Tested || out.Tokens != nil || out.Assurance != nil {
					t.Fatalf("fresh test completion: %+v %v", out, err)
				}
			})
		}
	}
}

func TestSSOOwnerActivationRechecksProofAfterLock(t *testing.T) {
	for _, stale := range []bool{false, true} {
		name := "fresh"
		if stale {
			name = "expired"
		}
		t.Run(name, func(t *testing.T) {
			f := newServiceFixture(t)
			age := time.Duration(0)
			if stale {
				age = 4 * time.Minute
			}
			begin, cb, _ := ownerTestFlow(t, f, false, age)
			if _, err := f.s.Finish(t.Context(), cb.FlowID, begin.Browser); err != nil {
				t.Fatal(err)
			}
			var offset atomic.Int64
			f.s.Now = func() time.Time { return time.Now().Add(time.Duration(offset.Load())) }
			err := waitOwnerBoundary(t, f, func(ctx context.Context) error {
				_, err := f.s.ActivateConnection(ctx, f.p, f.ws, f.connection, 1)
				return err
			}, func() { offset.Store(int64(2 * time.Minute)) })
			if stale {
				requireRecentOwnerProof(t, err)
			} else if err != nil {
				t.Fatal(err)
			}
			c, err := f.s.DB.Q.GetIdentityConnection(t.Context(), sqlc.GetIdentityConnectionParams{WorkspaceID: f.ws, ID: f.connection})
			if err != nil || (c.Status == "active") == stale {
				t.Fatalf("activation status %s: %v", c.Status, err)
			}
		})
	}
}

func TestSSOOwnerProofUsesDatabaseClock(t *testing.T) {
	for _, activate := range []bool{false, true} {
		name := "finish"
		if activate {
			name = "activate"
		}
		t.Run(name, func(t *testing.T) {
			f := newServiceFixture(t)
			begin, cb, _ := ownerTestFlow(t, f, false, 4*time.Minute)
			if activate {
				if _, err := f.s.Finish(t.Context(), cb.FlowID, begin.Browser); err != nil {
					t.Fatal(err)
				}
			}
			flow, err := f.s.DB.Q.GetIdentityLoginTransactionByID(t.Context(), cb.FlowID)
			if err != nil {
				t.Fatal(err)
			}
			var proof completion
			if err = f.s.open(flow, "sso-completion", flow.ResultBox, &proof); err != nil {
				t.Fatal(err)
			}
			// Age only the original sealed authentication, leaving completion/test times fresh.
			proof.Proof.AuthenticatedAt = time.Now().Add(-6 * time.Minute)
			box, err := f.s.seal(flow, "sso-completion", proof)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.s.DB.Pool.Exec(t.Context(), `UPDATE identity_login_transactions SET result_box=$2 WHERE id=$1`, flow.ID, box); err != nil {
				t.Fatal(err)
			}
			f.s.Now = func() time.Time { return time.Now().Add(-2 * time.Minute) }
			if activate {
				_, err = f.s.ActivateConnection(t.Context(), f.p, f.ws, f.connection, 1)
			} else {
				_, err = f.s.Finish(t.Context(), cb.FlowID, begin.Browser)
			}
			requireRecentOwnerProof(t, err)
		})
	}
}
