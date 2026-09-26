// Package events publishes gateway events to Redis pub/sub. The gateway (next stage)
// subscribes to these channels and fans events out to sockets, filtering per recipient
// (e.g. VIEW_ROOM). Payload = 16-byte event id (uuid) + binary calaba.v1.DispatchEvent;
// the id lets the gateway deliver an event published to several channels only once.
//
// Channels:
//
//	ws:<workspace_id>            events for all members of a workspace
//	user:<user_id>               events for one user (all their sessions)
//	session:revoked:<session_id> payload-less: close that gateway session with 4010
package events

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Publisher sends events after the DB transaction that caused them has committed.
// Publishing is best-effort: failures are logged, never returned to the REST caller
// (Postgres is the source of truth; clients resync on IDENTIFY).
type Publisher interface {
	Workspace(ctx context.Context, workspaceID uuid.UUID, ev *v1.DispatchEvent)
	User(ctx context.Context, userID uuid.UUID, ev *v1.DispatchEvent)
	// Workspaces publishes one event (same id) to several workspaces, e.g. presence.
	Workspaces(ctx context.Context, workspaceIDs []uuid.UUID, ev *v1.DispatchEvent)
	SessionRevoked(ctx context.Context, sessionID uuid.UUID)
}

// Redis publishes to Redis pub/sub.
type Redis struct{ C rueidis.Client }

// publishTimeout bounds one PUBLISH. Events are published after the change is committed,
// so they must not depend on the request that made it: a client that goes away right
// after its POST (reload) must not make the other members miss the event.
const publishTimeout = 3 * time.Second

func (r Redis) publish(ctx context.Context, channel string, payload []byte) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), publishTimeout)
	defer cancel()
	if err := r.C.Do(ctx, r.C.B().Publish().Channel(channel).Message(rueidis.BinaryString(payload)).Build()).Error(); err != nil {
		slog.WarnContext(ctx, "publish event failed", "channel", channel, "err", err)
	}
}

// Encode builds a pub/sub payload with a fresh event id.
func Encode(ev *v1.DispatchEvent) ([]byte, error) {
	b, err := proto.Marshal(ev)
	if err != nil {
		return nil, err
	}
	id := uuid.New()
	return append(id[:], b...), nil
}

// Decode splits a payload into event id and event.
func Decode(payload []byte) (uuid.UUID, *v1.DispatchEvent, error) {
	if len(payload) < 16 {
		return uuid.Nil, nil, errors.New("events: short payload")
	}
	id, _ := uuid.FromBytes(payload[:16])
	ev := &v1.DispatchEvent{}
	if err := proto.Unmarshal(payload[16:], ev); err != nil {
		return uuid.Nil, nil, err
	}
	return id, ev, nil
}

func (r Redis) event(ctx context.Context, channels []string, ev *v1.DispatchEvent) {
	b, err := Encode(ev)
	if err != nil {
		slog.ErrorContext(ctx, "marshal event", "err", err)
		return
	}
	for _, ch := range channels {
		r.publish(ctx, ch, b)
	}
}

// Workspace publishes ev to all members of a workspace.
func (r Redis) Workspace(ctx context.Context, id uuid.UUID, ev *v1.DispatchEvent) {
	r.event(context.WithoutCancel(ctx), []string{WorkspaceChannel(id)}, ev)
}

// Workspaces publishes ev (one event id) to several workspaces.
func (r Redis) Workspaces(ctx context.Context, ids []uuid.UUID, ev *v1.DispatchEvent) {
	chs := make([]string, len(ids))
	for i, id := range ids {
		chs[i] = WorkspaceChannel(id)
	}
	r.event(context.WithoutCancel(ctx), chs, ev)
}

// User publishes ev to all sessions of a user.
func (r Redis) User(ctx context.Context, id uuid.UUID, ev *v1.DispatchEvent) {
	r.event(context.WithoutCancel(ctx), []string{UserChannel(id)}, ev)
}

// SessionRevoked asks the gateway to close the session's socket with 4010.
func (r Redis) SessionRevoked(ctx context.Context, id uuid.UUID) {
	r.publish(context.WithoutCancel(ctx), RevokedChannel(id), nil)
}

// Channel names and prefixes (the gateway PSUBSCRIBEs to the prefixes + "*").
const (
	WorkspacePrefix = "ws:"
	UserPrefix      = "user:"
	RevokedPrefix   = "session:revoked:"
)

// WorkspaceChannel is the channel of a workspace.
func WorkspaceChannel(id uuid.UUID) string { return WorkspacePrefix + id.String() }

// UserChannel is the channel of a user.
func UserChannel(id uuid.UUID) string { return UserPrefix + id.String() }

// RevokedChannel is the revocation channel of an auth session.
func RevokedChannel(id uuid.UUID) string { return RevokedPrefix + id.String() }

// Nop discards events (tests, tools).
type Nop struct{}

// Workspace implements Publisher.
func (Nop) Workspace(context.Context, uuid.UUID, *v1.DispatchEvent) {}

// User implements Publisher.
func (Nop) User(context.Context, uuid.UUID, *v1.DispatchEvent) {}

// Workspaces implements Publisher.
func (Nop) Workspaces(context.Context, []uuid.UUID, *v1.DispatchEvent) {}

// SessionRevoked implements Publisher.
func (Nop) SessionRevoked(context.Context, uuid.UUID) {}
