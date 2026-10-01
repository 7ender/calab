package gateway

import (
	"context"
	"errors"
	"sync"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/workspaces"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func newScopedEnc(ws uuid.UUID, ev *v1.DispatchEvent) *encEvent {
	return &encEvent{ev: ev, workspace: ws}
}
func (s *Session) dispatchScoped(ws, id uuid.UUID, ev *v1.DispatchEvent) {
	s.dispatchEnc(id, newScopedEnc(ws, ev))
}
func (s *Session) identity() auth.Identity {
	return auth.Identity{UserID: s.user, SessionID: s.asess, IsBot: s.bot, Principal: s.principal}
}

func (s *Session) allowsWorkspace(ctx context.Context, ws uuid.UUID) bool {
	return s.hub.auth.CheckWorkspace(ctx, s.identity(), ws, identitypolicy.Realtime) == nil
}

// eventResources extracts durable parent references, including nested task notifications
// and room move tokens. User-channel delivery never assumes all sessions share authority.
func (h *Hub) eventResources(ctx context.Context, ev *v1.DispatchEvent) (map[uuid.UUID]bool, bool) {
	workspaces := map[uuid.UUID]bool{}
	valid := true
	var visit func(protoreflect.Message)
	visit = func(m protoreflect.Message) {
		m.Range(func(f protoreflect.FieldDescriptor, v protoreflect.Value) bool {
			if f.IsList() {
				if f.Kind() == protoreflect.MessageKind {
					list := v.List()
					for i := 0; i < list.Len(); i++ {
						visit(list.Get(i).Message())
					}
				}
				return true
			}
			if f.Kind() == protoreflect.MessageKind {
				visit(v.Message())
				return true
			}
			if f.Kind() != protoreflect.StringKind || v.String() == "" {
				return true
			}
			name := string(f.Name())
			kind := string(m.Descriptor().Name())
			if name == "id" {
				switch kind {
				case "Workspace":
					name = "workspace_id"
				case "Room":
					name = "room_id"
				case "Board":
					name = "board_id"
				case "Task":
					name = "task_id"
				}
			}
			if name != "workspace_id" && name != "room_id" && name != "board_id" && name != "task_id" {
				return true
			}
			id, err := uuid.Parse(v.String())
			if err != nil || id == uuid.Nil {
				valid = false
				return true
			}
			ws := uuid.Nil
			switch name {
			case "workspace_id":
				ws = id
			case "room_id":
				row, e := h.db.Q.GetRoom(ctx, id)
				if e != nil {
					valid = false
				} else if row.WorkspaceID != nil {
					ws = *row.WorkspaceID
				}
			case "board_id":
				row, e := h.db.Q.GetBoard(ctx, id)
				if e != nil {
					valid = false
				} else {
					ws = row.WorkspaceID
				}
			case "task_id":
				row, e := h.db.Q.GetTaskRow(ctx, id)
				if e != nil {
					valid = false
				} else {
					board, e := h.db.Q.GetBoard(ctx, row.BoardID)
					if e != nil {
						valid = false
					} else {
						ws = board.WorkspaceID
					}
				}
			}
			workspaces[ws] = true
			return true
		})
	}
	visit(ev.ProtoReflect())
	return workspaces, valid
}

// allowsEvent runs both before queueing and immediately before emission. It deliberately
// has no positive policy cache: DB epochs and proof expiry take effect on the next event
// even when Redis invalidations were lost. Unknown scoped events are refused.
func (s *Session) allowsEvent(enc *encEvent) bool {
	if s.hub.auth == nil {
		return false
	}
	if s.bot {
		return true
	} // the existing machine route and viewer gates are separate
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ev := enc.ev
	if enc.workspace != uuid.Nil && ev.GetWorkspaceDelete() == nil {
		return s.allowsWorkspace(ctx, enc.workspace)
	}
	if gone := ev.GetWorkspaceDelete(); gone != nil {
		ws := parseID(gone.GetWorkspaceId())
		return ws != uuid.Nil && (s.principal.Authority == identitypolicy.LocalAccount || s.principal.WorkspaceID == ws) && s.hub.auth.CheckSession(ctx, s.asess) == nil
	}
	if ready := ev.GetReady(); ready != nil {
		for _, snap := range ready.Workspaces {
			if !s.allowsWorkspace(ctx, parseID(snap.GetWorkspace().GetId())) {
				return false
			}
		}
		return s.principal.Authority != identitypolicy.Recovery
	}
	if ev.GetResumed() != nil {
		return s.hub.auth.CheckSession(ctx, s.asess) == nil
	}
	if status := ev.GetWorkspaceIdentityAccessUpdate(); status != nil {
		return status.GetSessionId() == s.asess.String()
	}
	scopes, valid := s.hub.eventResources(ctx, ev)
	if !valid {
		return false
	}
	for ws := range scopes {
		if ws == uuid.Nil {
			if s.hub.auth.CheckGlobal(ctx, s.identity(), identitypolicy.GlobalRead) != nil {
				return false
			}
		} else if !s.allowsWorkspace(ctx, ws) {
			return false
		}
	}
	if len(scopes) != 0 {
		return true
	}
	// These events hold local account state; absent resource attribution never implies
	// workspace access. New event types need an explicit classification here.
	switch ev.GetEvent().(type) {
	case *v1.DispatchEvent_UserUpdate, *v1.DispatchEvent_PresenceUpdate:
		return s.hub.auth.CheckGlobal(ctx, s.identity(), identitypolicy.GlobalRead) == nil
	default:
		return false
	}
}

// replayAllowed revalidates every stored event, retaining sequence continuity only when
// the entire replay is allowed. A denied event forces a filtered fresh READY.
func (s *Session) replayAllowed(es []entry) bool {
	for _, e := range es {
		if !e.identityFormat {
			return false
		} // pre-identity buffers cannot prove their source scope
		var frame v1.GatewayFrame
		if proto.Unmarshal(e.frame, &frame) != nil || frame.GetDispatch() == nil {
			return false
		}
		if !s.allowsEvent(newScopedEnc(e.workspace, frame.GetDispatch())) {
			return false
		}
	}
	return true
}

// EnforceIdentity reconciles subscriptions and sends only a content-free removal/status
// when access is lost. It works without pubsub and never closes unrelated workspace B.
func (h *Hub) EnforceIdentity(ctx context.Context) {

	jobs := make(chan *Session)
	var workers sync.WaitGroup
	for i := 0; i < 32; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for s := range jobs {
				h.enforceIdentitySession(ctx, s)
			}
		}()
	}
scheduling:
	for _, s := range h.sessionsWhere(func(s *Session) bool { return !s.bot }) {
		select {
		case jobs <- s:
		case <-ctx.Done():
			break scheduling
		}
	}
	close(jobs)
	workers.Wait()
}
func (h *Hub) enforceIdentitySession(ctx context.Context, s *Session) {
	query, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	ids, err := h.db.Q.ListUserWorkspaceIDs(query, s.user)
	cancel()
	if err != nil {
		ids = nil
	}
	allowed := map[uuid.UUID]bool{}
	decisions := map[uuid.UUID]*v1.WorkspaceIdentityAccess{}
	for _, ws := range ids {
		gate, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		decision, err := h.auth.CheckWorkspaceDecision(gate, s.identity(), ws, identitypolicy.Realtime)
		cancel()
		decisions[ws] = identityAccessStatus(ws, decision, err, s.principal)
		if err == nil && decision.Allowed {
			allowed[ws] = true
		}
	}
	s.mu.Lock()
	old := make(map[uuid.UUID]bool, len(s.workspaces))
	for ws := range s.workspaces {
		old[ws] = true
	}
	s.mu.Unlock()
	for ws := range old {
		if allowed[ws] {
			continue
		}
		if decisions[ws] == nil {
			decisions[ws] = identityAccessStatus(ws, identitypolicy.Decision{Reason: identitypolicy.ScopeDenied}, nil, s.principal)
		}
		s.dispatch(uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceDelete{WorkspaceDelete: &v1.WorkspaceDelete{WorkspaceId: ws.String()}}})
		s.dispatch(uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceIdentityAccessUpdate{WorkspaceIdentityAccessUpdate: &v1.WorkspaceIdentityAccessUpdate{SessionId: s.asess.String(), Access: decisions[ws]}}})
		h.leaveWorkspace(s, ws)
	}
	for ws := range allowed {
		if old[ws] {
			continue
		}
		// A new assurance can open just this workspace without reauthenticating B.
		row, err := h.db.Q.GetWorkspace(ctx, ws)
		if err != nil {
			continue
		}
		member, err := perm.NewResolver(h.db.Q).Member(ctx, ws, s.user)
		if err != nil {
			continue
		}
		snap, err := workspaces.Snapshot(ctx, h.db.Q, h.cfg.Plans, row, s.user, member)
		if err != nil {
			continue
		}
		h.fillLive(ctx, ws, snap)
		h.joinWorkspace(s, ws)
		h.ensureState(ctx, ws)
		s.dispatchScoped(ws, uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceCreate{WorkspaceCreate: &v1.WorkspaceCreate{Snapshot: snap}}})
	}
}

func (h *Hub) runIdentityEnforcement(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-h.identityWake:
		}
		{
			work, cancel := context.WithTimeout(ctx, 20*time.Second)
			h.EnforceIdentity(work)
			cancel()
		}
	}
}

// IdentityChanged coalesces durable, versioned invalidations into a fresh DB reconciliation.
// No positive lease is extended by a notification, including stale or duplicate delivery.
func (h *Hub) IdentityChanged() {
	select {
	case h.identityWake <- struct{}{}:
	default:
	}
}

func identityAccessStatus(ws uuid.UUID, d identitypolicy.Decision, err error, p identitypolicy.Principal) *v1.WorkspaceIdentityAccess {
	reason := v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_SCOPE_DENIED
	switch d.Reason {
	case identitypolicy.Allowed:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_ALLOWED
	case identitypolicy.SSORequired:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_SSO_REQUIRED
	case identitypolicy.EntitlementRequired:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_ENTITLEMENT_REQUIRED
	case identitypolicy.DirectoryStale, identitypolicy.MembershipSuspended:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_DIRECTORY_DENIED
	case identitypolicy.WorkspaceSuspended:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_SUSPENDED
	case identitypolicy.RecentAuthRequired:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_RECENT_AUTH_REQUIRED
	case identitypolicy.StateUnavailable:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_DEPENDENCY_UNAVAILABLE
	}
	if err != nil && !errors.Is(err, identitypolicy.ErrDenied) {
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_DEPENDENCY_UNAVAILABLE
	}
	if p.Authority == identitypolicy.Recovery {
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_RECOVERY_ONLY
	}
	out := &v1.WorkspaceIdentityAccess{WorkspaceId: ws.String(), Reason: reason, PolicyVersion: uint64(max(d.Versions.Policy, 0)), MembershipVersion: uint64(max(d.Versions.Access, 0))}
	if !d.ValidUntil.IsZero() {
		out.ValidUntil = timestamppb.New(d.ValidUntil)
	}
	return out
}

func identityMode(mode string) v1.IdentityPolicyMode {
	switch identitypolicy.Mode(mode) {
	case identitypolicy.Off:
		return v1.IdentityPolicyMode_IDENTITY_POLICY_MODE_OFF
	case identitypolicy.Optional:
		return v1.IdentityPolicyMode_IDENTITY_POLICY_MODE_OPTIONAL
	case identitypolicy.Enforced:
		return v1.IdentityPolicyMode_IDENTITY_POLICY_MODE_ENFORCED
	default:
		return v1.IdentityPolicyMode_IDENTITY_POLICY_MODE_UNSPECIFIED
	}
}
