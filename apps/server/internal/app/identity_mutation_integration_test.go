//go:build integration

package app_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type identityWriteResult struct {
	code int
	err  error
}

func identityWrite(t *testing.T, u *user, method, path string, in proto.Message) <-chan identityWriteResult {
	t.Helper()
	raw, err := protojson.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan identityWriteResult, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, method, srv.URL+path, bytes.NewReader(raw))
		if err != nil {
			result <- identityWriteResult{err: err}
			return
		}
		req.Header.Set("Authorization", "Bearer "+u.token)
		req.Header.Set("X-Forwarded-For", u.ip)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			result <- identityWriteResult{err: err}
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		result <- identityWriteResult{code: resp.StatusCode}
	}()
	return result
}
func identityWriteStatus(t *testing.T, ch <-chan identityWriteResult, want int) {
	t.Helper()
	select {
	case got := <-ch:
		if got.err != nil || got.code != want {
			t.Fatalf("write=%d err=%v want=%d", got.code, got.err, want)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("write did not settle")
	}
}
func identityWaitBlocked(t *testing.T, pid uint32) {
	t.Helper()
	until := time.Now().Add(3 * time.Second)
	for time.Now().Before(until) {
		var blocked bool
		err := testDB.Pool.QueryRow(context.Background(), `SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname=current_database() AND CASE WHEN $1::integer=0 THEN cardinality(pg_blocking_pids(pid))>0 ELSE $1::integer=ANY(pg_blocking_pids(pid)) END)`, pid).Scan(&blocked)
		if err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("write never reached the source-lock barrier")
}
func identitySourceTx(t *testing.T, ws uuid.UUID) (pgx.Tx, *sqlc.Queries) {
	t.Helper()
	tx, err := testDB.Pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	q := testDB.Q.WithTx(tx)
	if _, err = q.LockOAuthWorkspace(context.Background(), ws); err != nil {
		t.Fatal(err)
	}
	return tx, q
}

func TestIdentityMutationRevokeWinsAndDirectQuery(t *testing.T) {
	for _, direct := range []bool{false, true} {
		t.Run(fmt.Sprintf("direct=%v", direct), func(t *testing.T) {
			f := identitySetup(t, "enforced")
			ws := uuid.MustParse(f.a.Id)
			uid := uuid.MustParse(f.local.id)
			var msg *v1.Message
			if direct {
				msg = send(t, f.scoped, f.roomA, "Before revocation", uniq("guard-"))
			}
			tx, q := identitySourceTx(t, ws)
			var write <-chan identityWriteResult
			if direct {
				write = identityWrite(t, f.scoped, "PUT", "/api/messages/"+msg.Id+"/embeds-hidden", &v1.SetEmbedsHiddenRequest{Hidden: true})
			} else {
				write = identityWrite(t, f.scoped, "POST", "/api/rooms/"+f.roomA+"/messages", &v1.CreateMessageRequest{Content: "Must not commit", Nonce: uniq("guard-")})
			}
			identityWaitBlocked(t, tx.Conn().PgConn().PID())
			// An unrelated workspace and independent local session keep making progress
			// while A waits; a shared source lock is not a workspace-wide write mutex.
			identityWriteStatus(t, identityWrite(t, f.local, "POST", "/api/rooms/"+f.roomB+"/messages", &v1.CreateMessageRequest{Content: "Independent B", Nonce: uniq("guard-b-")}), 201)
			if err := auth.InvalidateIdentity(context.Background(), q, ws, &uid, nil, "mutation_test"); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(context.Background()); err != nil {
				t.Fatal(err)
			}
			identityWriteStatus(t, write, 401)
			if direct {
				row, err := testDB.Q.GetMessage(context.Background(), uuid.MustParse(msg.Id))
				if err != nil || row.EmbedsHidden {
					t.Fatalf("denied direct write persisted: %v", err)
				}
			} else {
				var count int
				err := testDB.Pool.QueryRow(context.Background(), `SELECT count(*) FROM messages WHERE room_id=$1 AND content='Must not commit'`, uuid.MustParse(f.roomA)).Scan(&count)
				if err != nil || count != 0 {
					t.Fatalf("denied create persisted=%d err=%v", count, err)
				}
			}
		})
	}
}

func TestIdentityMutationWriteWinsAndSharedProgress(t *testing.T) {
	f := identitySetup(t, "enforced")
	ws := uuid.MustParse(f.a.Id)
	uid := uuid.MustParse(f.local.id)
	id := auth.Identity{UserID: uid, SessionID: f.scopedSession.ID, Principal: auth.SessionPrincipal(f.scopedSession)}
	ctx := testApp.Auth.WithMutation(context.Background(), id, auth.MutationOptions{Workspace: ws})
	admitted := make(chan struct{})
	finish := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(finish) }) })
	written := make(chan error, 1)
	go func() {
		written <- testDB.Tx(ctx, func(q *sqlc.Queries) error {
			close(admitted)
			<-finish
			_, err := q.InsertMessage(ctx, sqlc.InsertMessageParams{RoomID: uuid.MustParse(f.roomA), AuthorID: uid, Content: "Admitted before revoke"})
			return err
		})
	}()
	select {
	case <-admitted:
	case err := <-written:
		t.Fatalf("writer never admitted: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("writer admission timed out")
	}
	// A second ordinary writer shares workspace/user/session admission locks.
	identityWriteStatus(t, identityWrite(t, f.scoped, "POST", "/api/rooms/"+f.roomA+"/messages", &v1.CreateMessageRequest{Content: "Concurrent admitted", Nonce: uniq("guard-shared-")}), 201)
	revoker, err := testDB.Pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = revoker.Rollback(context.Background()) }()
	revoked := make(chan error, 1)
	go func() {
		q := testDB.Q.WithTx(revoker)
		err := auth.InvalidateIdentity(context.Background(), q, ws, &uid, nil, "write_wins")
		if err == nil {
			err = revoker.Commit(context.Background())
		}
		revoked <- err
	}()
	identityWaitBlocked(t, 0) // below uses pg_locks directly when the blocker is a writer
	release.Do(func() { close(finish) })
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := <-revoked; err != nil {
		t.Fatal(err)
	}
	var count int
	if err := testDB.Pool.QueryRow(context.Background(), `SELECT count(*) FROM messages WHERE room_id=$1 AND content='Admitted before revoke'`, uuid.MustParse(f.roomA)).Scan(&count); err != nil || count != 1 {
		t.Fatalf("admitted write persisted=%d err=%v", count, err)
	}
	f.scoped.must(401, "GET", "/api/rooms/"+f.roomA, nil, nil)
}

func TestIdentityMutationDeadlineWhileWaiting(t *testing.T) {
	f := identitySetup(t, "enforced")
	ws := uuid.MustParse(f.a.Id)
	// Keep the proof valid for the preliminary HTTP check, then age it out while
	// the writer is blocked on the authoritative workspace lock.
	until := time.Now().Add(800 * time.Millisecond)
	if _, err := testDB.Pool.Exec(context.Background(), `UPDATE session_workspace_assurances SET valid_until=$1 WHERE workspace_id=$2 AND session_id=$3`, until, ws, f.scopedSession.ID); err != nil {
		t.Fatal(err)
	}
	tx, _ := identitySourceTx(t, ws)
	write := identityWrite(t, f.scoped, "POST", "/api/rooms/"+f.roomA+"/messages", &v1.CreateMessageRequest{Content: "Expired at commit", Nonce: uniq("guard-expiry-")})
	identityWaitBlocked(t, tx.Conn().PgConn().PID())
	time.Sleep(time.Until(until) + 30*time.Millisecond)
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	identityWriteStatus(t, write, 403)
}

func TestIdentityMutationSSOOffAndLateScopeFailClosed(t *testing.T) {
	f := identitySetup(t, "off")
	f.local.must(201, "POST", "/api/rooms/"+f.roomA+"/messages", &v1.CreateMessageRequest{Content: "Normal local mutation", Nonce: uniq("guard-local-")}, nil)
	uid := uuid.MustParse(f.local.id)
	sid := uuid.MustParse(f.local.session)
	p, err := testApp.Auth.ResolvePrincipal(context.Background(), auth.Identity{UserID: uid, SessionID: sid})
	if err != nil {
		t.Fatal(err)
	}
	ctx := testApp.Auth.WithPolicy(context.Background(), auth.Identity{UserID: uid, SessionID: sid, Principal: p}, identitypolicy.WorkspaceWrite)
	ctx = testApp.Auth.WithMutation(ctx, auth.Identity{UserID: uid, SessionID: sid, Principal: p}, auth.MutationOptions{Workspace: uuid.MustParse(f.a.Id)})
	err = testDB.Tx(ctx, func(_ *sqlc.Queries) error { return auth.RecordMutationWorkspace(ctx, uuid.MustParse(f.b.Id)) })
	if err == nil {
		t.Fatal("late cross-workspace scope silently admitted")
	}
}
