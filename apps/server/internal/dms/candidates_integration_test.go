//go:build integration

package dms

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

// A session that may not read workspace B (e.g. password-only in an enforced workspace,
// ADR-0054) gets no DM candidates, nickname matches or new DMs through B's membership.
func TestCandidatesFollowIdentityPolicy(t *testing.T) {
	d := dbtest.Connect(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	tag := strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	user := func(name string) uuid.UUID {
		id := uuid.New()
		exec(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, id, name+tag+"@example.com", name+tag)
		return id
	}
	me, alice, bob, carol := user("me"), user("alice"), user("bob"), user("carol")
	open, enforced := uuid.New(), uuid.New()
	exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'A', $3)`, open, "a-"+tag, me)
	exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'B', $3)`, enforced, "b-"+tag, me)
	member := func(ws, u uuid.UUID, nickname string) {
		exec(`INSERT INTO workspace_members (workspace_id, user_id, role, nickname) VALUES ($1, $2, 'member', $3)`, ws, u, nickname)
	}
	member(open, me, "")
	member(enforced, me, "")
	member(open, alice, "")
	member(enforced, bob, "")
	member(open, carol, "")
	member(enforced, carol, "zed"+tag) // B's nickname must not be searchable without B

	h := NewHandlers(d, nil, nil)
	request := func(guard perm.AccessGuard, q string) []string {
		t.Helper()
		r := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/dms/candidates?q="+q, nil)
		c := auth.WithIdentity(r.Context(), auth.Identity{UserID: me, SessionID: uuid.New()})
		if guard != nil {
			c = perm.WithAccessGuard(c, guard)
		}
		w := httptest.NewRecorder()
		if err := h.candidates(w, r.WithContext(c)); err != nil {
			t.Fatal(err)
		}
		var out v1.ListDmCandidatesResponse
		if err := protojson.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, u := range out.GetUsers() {
			ids = append(ids, u.GetId())
		}
		return ids
	}
	denyB := func(_ context.Context, ws, _ uuid.UUID) error {
		if ws == enforced {
			return errors.New("sso required")
		}
		return nil
	}
	has := func(ids []string, u uuid.UUID) bool {
		for _, id := range ids {
			if id == u.String() {
				return true
			}
		}
		return false
	}
	if all := request(nil, tag); !has(all, alice) || !has(all, bob) || !has(all, carol) {
		t.Fatalf("without a policy gate everyone shared: %v", all)
	}
	got := request(denyB, tag)
	if !has(got, alice) || !has(got, carol) || has(got, bob) {
		t.Fatalf("policy-filtered candidates: %v (bob is only in B)", got)
	}
	if got := request(denyB, "zed"+tag); has(got, carol) {
		t.Fatal("matched by a nickname of an unreadable workspace")
	}
	if got := request(nil, "zed"+tag); !has(got, carol) {
		t.Fatal("nickname search broken without a gate")
	}
	gated := perm.WithAccessGuard(ctx, denyB)
	if ok, err := h.shareReadableWorkspace(gated, me, bob); err != nil || ok {
		t.Fatalf("new DM through an unreadable workspace: %v %v", ok, err)
	}
	if ok, err := h.shareReadableWorkspace(gated, me, carol); err != nil || !ok {
		t.Fatalf("shared readable workspace refused: %v %v", ok, err)
	}
	if ok, err := h.shareReadableWorkspace(ctx, me, bob); err != nil || !ok {
		t.Fatalf("ungated share: %v %v", ok, err)
	}
}
