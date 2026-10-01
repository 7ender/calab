package gateway

import (
	"context"
	"errors"
	"fmt"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
)

func receiptEvent(s *Session, ws uuid.UUID) *encEvent {
	a := &v1.RoomAdmission{RoomId: uuid.NewString(), WorkspaceId: ws.String(), User: &v1.User{Id: s.user.String()}, RoomName: "Waiting room", WorkspaceName: "Workspace", Status: v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED}
	return newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_RoomAdmissionDecided{RoomAdmissionDecided: &v1.RoomAdmissionDecided{Admission: a}}})
}

func TestIdentityCompatibilityOwnReceiptFinalAdmission(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	s.leases.workspaces = nil // declined membership was removed
	h.checkAdmissionPolicy = func(context.Context, uuid.UUID) (int64, error) { return 0, nil }
	enc := receiptEvent(s, ws)
	s.prepareAdmissionReceipts(context.Background(), enc)
	if !s.allowsEvent(enc) || s.workspaceLeaseAllows(ws) {
		t.Fatal("own receipt must survive without creating workspace authority")
	}
	ready := newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_Ready{Ready: &v1.Ready{PendingAdmissions: []*v1.RoomAdmission{enc.ev.GetRoomAdmissionDecided().Admission}}}})
	s.prepareAdmissionReceipts(context.Background(), ready)
	if !s.allowsEvent(ready) {
		t.Fatal("own declined receipt missing from READY")
	}
	// The socket queue and replay admission both retain exact-session proof.
	s.dispatchEnc(uuid.New(), enc)
	entries := drain(s)
	if len(entries) != 1 || !s.replayAllowed(entries) {
		t.Fatal("own receipt did not survive valid replay admission")
	}
	other := leasedSession(h, uuid.New())
	other.user = s.user
	if other.allowsEvent(enc) {
		t.Fatal("receipt proof reused across devices")
	}
	h.identityNotification(fmt.Sprintf(`{"workspace":%q,"policy_version":2}`, ws.String()))
	if s.allowsEvent(enc) || s.allowsEvent(ready) {
		t.Fatal("final admission retained invalidated receipt after membership removal")
	}
	h.checkAdmissionPolicy = func(context.Context, uuid.UUID) (int64, error) { return 2, errors.New("enforced or unavailable") }
	if s.replayAllowed(entries) {
		t.Fatal("replay bypassed current durable policy")
	}
}

func TestIdentityCompatibilityReceiptDenials(t *testing.T) {
	for _, kind := range []string{"scoped", "recovery", "bot", "other user", "profile", "author", "DB error", "expired session", "expired receipt"} {
		t.Run(kind, func(t *testing.T) {
			h := leaseTestHub()
			ws := uuid.New()
			s := leasedSession(h, ws)
			s.leases.workspaces = nil
			h.checkAdmissionPolicy = func(context.Context, uuid.UUID) (int64, error) { return 0, nil }
			enc := receiptEvent(s, ws)
			switch kind {
			case "scoped":
				s.principal.Authority, s.principal.WorkspaceID = identitypolicy.WorkspaceSSO, ws
			case "recovery":
				s.principal.Authority = identitypolicy.Recovery
			case "bot":
				s.bot = true
			case "other user":
				enc.ev.GetRoomAdmissionDecided().Admission.User.Id = uuid.NewString()
			case "profile":
				enc.ev.GetRoomAdmissionDecided().Admission.User.DisplayName = "Protected profile"
			case "author":
				enc.ev.GetRoomAdmissionDecided().Admission.InviteCreatedBy = uuid.NewString()
			case "DB error":
				h.checkAdmissionPolicy = func(context.Context, uuid.UUID) (int64, error) { return 0, errors.New("DB unavailable") }
			case "expired session":
				s.leases.session.until = time.Now().Add(-time.Second)
			}
			s.prepareAdmissionReceipts(context.Background(), enc)
			if kind == "expired receipt" {
				p := enc.receipts[ws]
				p.until = time.Now().Add(-time.Second)
				enc.receipts[ws] = p
			}
			if s.allowsEvent(enc) {
				t.Fatal("receipt bypassed authority, ownership, shape or deadline")
			}
		})
	}
}

func TestIdentityCompatibilityLocalDepartureAndNotesDeletion(t *testing.T) {
	h := leaseTestHub()
	s := leasedSession(h, uuid.New())
	events := []*v1.DispatchEvent{
		{Event: &v1.DispatchEvent_VoiceStateUpdate{VoiceStateUpdate: &v1.VoiceStateUpdate{State: &v1.VoiceState{UserId: uuid.NewString()}}}},
		{Event: &v1.DispatchEvent_NotesDelete{NotesDelete: &v1.NotesDelete{RoomId: uuid.NewString()}}},
	}
	for _, ev := range events {
		enc := newEnc(ev)
		h.prepareEvent(context.Background(), enc)
		if !s.allowsEvent(enc) {
			t.Fatal("explicit local deletion/departure was dropped")
		}
		for _, authority := range []identitypolicy.Authority{identitypolicy.WorkspaceSSO, identitypolicy.Recovery} {
			s.principal.Authority = authority
			if s.allowsEvent(enc) {
				t.Fatal("scoped/recovery received local deletion/departure")
			}
		}
		s.principal.Authority = identitypolicy.LocalAccount
	}
	for _, ev := range []*v1.DispatchEvent{
		{Event: &v1.DispatchEvent_MessageDelete{MessageDelete: &v1.MessageDelete{MessageId: uuid.NewString()}}},
		{Event: &v1.DispatchEvent_NotesDelete{NotesDelete: &v1.NotesDelete{RoomId: "invalid"}}},
		{Event: &v1.DispatchEvent_VoiceStateUpdate{VoiceStateUpdate: &v1.VoiceStateUpdate{State: &v1.VoiceState{UserId: "invalid"}}}},
	} {
		enc := newEnc(ev)
		h.prepareEvent(context.Background(), enc)
		if s.allowsEvent(enc) {
			t.Fatal("unattributed/malformed event got a global fallback")
		}
	}
}

func TestIdentityCompatibilityColdAdmissionLeaseOffLock(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	s.leases.workspaces[ws] = identityLease{}
	checked := make(chan struct{})
	release := make(chan struct{})
	h.checkWorkspace = func(ctx context.Context, id auth.Identity, _ uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		close(checked)
		select {
		case <-release:
		case <-ctx.Done():
		}
		now := time.Now()
		return identitypolicy.Decision{Allowed: true, ValidUntil: now.Add(time.Hour), Versions: identitypolicy.Versions{Session: id.Principal.Version}}, now, ctx.Err()
	}
	ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomAdmissionRequest{RoomAdmissionRequest: &v1.RoomAdmissionRequest{Admission: &v1.RoomAdmission{RoomId: uuid.NewString(), WorkspaceId: ws.String(), User: &v1.User{Id: uuid.NewString()}}}}}
	s.dispatchEnc(uuid.New(), newScopedEnc(ws, ev))
	job := <-h.preparations
	done := make(chan struct{})
	go func() { job(); close(done) }()
	<-checked
	// A blocked DB call must hold neither session nor workspace fan-out locks.
	s.mu.Lock()
	paused := s.paused
	s.mu.Unlock()
	if paused != 1 {
		t.Fatal("cold preparation did not retain its ordered pause")
	}
	close(release)
	<-done
	got := drain(s)
	if len(got) != 1 || !proto.Equal(decode(t, got[0]).GetDispatch(), ev) {
		t.Fatal("fresh durable admission lost the queued request")
	}
}

func TestIdentityCompatibilityLeasePrunesRemovedMemberships(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	_, _ = s.refreshWorkspaceLease(context.Background(), uuid.New())
	h.identityWorkspaces = func(context.Context, uuid.UUID) ([]uuid.UUID, error) { return []uuid.UUID{ws}, nil }
	h.enforceIdentitySession(context.Background(), s)
	if len(s.leases.workspaces) != 1 || !s.workspaceLeaseAllows(ws) {
		t.Fatal("lease cache did not follow confirmed durable memberships")
	}
}

func TestIdentityCompatibilityReceiptWorkspaceIsolationAndPruning(t *testing.T) {
	h := leaseTestHub()
	a, b := uuid.New(), uuid.New()
	s := leasedSession(h, a)
	s.leases.workspaces = nil
	h.checkAdmissionPolicy = func(context.Context, uuid.UUID) (int64, error) { return 1, nil }
	ea, eb := receiptEvent(s, a), receiptEvent(s, b)
	s.prepareAdmissionReceipts(context.Background(), ea)
	s.prepareAdmissionReceipts(context.Background(), eb)
	readyB := newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_Ready{Ready: &v1.Ready{PendingAdmissions: []*v1.RoomAdmission{eb.ev.GetRoomAdmissionDecided().Admission}}}})
	s.prepareAdmissionReceipts(context.Background(), readyB)
	bDeadline := eb.receipts[b].until
	notice := fmt.Sprintf("{\"workspace\":%q,\"policy_version\":2,\"access_version\":3}", a.String())
	h.identityNotification(notice)
	if s.allowsEvent(ea) || !s.allowsEvent(eb) || !s.allowsEvent(readyB) {
		t.Fatal("A invalidation altered B receipt/READY authority")
	}
	epoch := s.leases.receipts[a].epoch
	h.identityNotification(notice)
	h.identityNotification(fmt.Sprintf("{\"workspace\":%q,\"policy_version\":1,\"access_version\":2}", a.String()))
	if s.leases.receipts[a].epoch != epoch || !eb.receipts[b].until.Equal(bDeadline) || !s.allowsEvent(readyB) {
		t.Fatal("duplicate/stale notice altered receipts or extended lease")
	}
	for range 300 {
		h.identityNotification(fmt.Sprintf("{\"workspace\":%q,\"policy_version\":9}", uuid.NewString()))
	}
	if len(s.leases.receipts) != 2 || len(s.leases.workspaces) != 0 {
		t.Fatal("unknown notice allocated positive state")
	}
	s.leases.receipts[a] = receiptPolicyState{until: time.Now().Add(-time.Second)}
	h.identityNotification(notice)
	if len(s.leases.receipts) != 1 || s.allowsEvent(ea) || !s.allowsEvent(eb) {
		t.Fatal("expired receipt state did not prune independently")
	}
}

func TestIdentityCompatibilityReceiptNoticeDuringPreparation(t *testing.T) {
	h := leaseTestHub()
	a, b := uuid.New(), uuid.New()
	s := leasedSession(h, a)
	s.leases.workspaces = nil
	h.checkAdmissionPolicy = func(context.Context, uuid.UUID) (int64, error) { return 1, nil }
	eb := receiptEvent(s, b)
	s.prepareAdmissionReceipts(context.Background(), eb)
	h.checkAdmissionPolicy = func(context.Context, uuid.UUID) (int64, error) {
		h.identityNotification(fmt.Sprintf("{\"workspace\":%q,\"policy_version\":2}", a.String()))
		return 1, nil
	}
	ea := receiptEvent(s, a)
	s.prepareAdmissionReceipts(context.Background(), ea)
	if s.allowsEvent(ea) || !s.allowsEvent(eb) {
		t.Fatal("notice race resurrected A proof or revoked B")
	}
}

func TestIdentityCompatibilityColdQueueOverflowRequiresResync(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	s.leases.workspaces[ws] = identityLease{}
	for len(h.preparations) < cap(h.preparations) {
		h.preparations <- func() {}
	}
	s.dispatchEnc(uuid.New(), leaseEvent(ws))
	if !s.broken.Load() || len(s.pending) != 0 || s.paused != 0 {
		t.Fatal("overload silently dropped event or retained unbounded pause")
	}
}

func TestIdentityCompatibilityReceiptFinalSocketAndReplay(t *testing.T) {
	for _, replay := range []bool{false, true} {
		t.Run(fmt.Sprint("replay=", replay), func(t *testing.T) {
			h := leaseTestHub()
			a, b := uuid.New(), uuid.New()
			s := leasedSession(h, a)
			s.leases.workspaces = nil
			h.checkAdmissionPolicy = func(context.Context, uuid.UUID) (int64, error) { return 1, nil }
			ea, eb := receiptEvent(s, a), receiptEvent(s, b)
			s.prepareAdmissionReceipts(context.Background(), ea)
			s.prepareAdmissionReceipts(context.Background(), eb)
			prepared, release := make(chan struct{}), make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ws, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer func() { _ = ws.CloseNow() }()
				c := newConn(ws, codec{})
				c.hold()
				if !replay {
					c.sendEvent(websocket.MessageBinary, []byte{2}, s, eb)
					c.sendEvent(websocket.MessageBinary, []byte{1}, s, ea)
				}
				go c.writeLoop()
				close(prepared)
				<-release
				if replay {
					c.setReplay([]outMsg{{typ: websocket.MessageBinary, data: []byte{2}, session: s, event: eb}, {typ: websocket.MessageBinary, data: []byte{1}, session: s, event: ea}})
				} else {
					c.setReplay(nil)
				}
				<-c.ctx.Done()
			}))
			defer srv.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			ws, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
			if resp != nil && resp.Body != nil {
				_ = resp.Body.Close()
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = ws.CloseNow() }()
			<-prepared
			h.identityNotification(fmt.Sprintf("{\"workspace\":%q,\"policy_version\":2}", a.String()))
			close(release)
			_, data, err := ws.Read(ctx)
			if err != nil || len(data) != 1 || data[0] != 2 {
				t.Fatalf("A revoked B at final socket boundary: %v %v", data, err)
			}
			_, data, err = ws.Read(ctx)
			if err == nil || websocket.CloseStatus(err) != 4000 {
				t.Fatalf("invalid A wrote to socket/replay: %v %v", data, err)
			}
		})
	}
}
