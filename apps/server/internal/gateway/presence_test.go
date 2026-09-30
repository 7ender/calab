package gateway

import (
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// docs/09 #143: IDENTIFY's device reaches Presence.client_*; the most recently identified
// live session wins; offline shows the last active one; invisible hides it like last_seen.
func TestPresenceClient(t *testing.T) {
	u := uuid.New()
	now := time.Now()
	online := v1.PresenceStatus_PRESENCE_STATUS_ONLINE
	desk := newClientInfo(&v1.DeviceInfo{Name: "mac", Platform: "darwin", AppVersion: "1.0.0"}, now.Add(-time.Hour))
	web := newClientInfo(&v1.DeviceInfo{Platform: "web", AppVersion: "1.1.0"}, now)
	if desk.platform != "darwin" || desk.version != "1.0.0" {
		t.Fatalf("device: %+v", desk)
	}
	if c := newClientInfo(&v1.DeviceInfo{Platform: "haiku", AppVersion: "1.0|x"}, now); c.known() {
		t.Fatalf("junk kept: %+v", c)
	}

	p := presenceOf(u, []string{encodeSession(online, desk)}, "", manualStatus{}, false, now)
	if p.GetClientVersion() != "1.0.0" || p.GetClientPlatform() != "darwin" {
		t.Fatalf("one session: %v", p)
	}
	// Two sessions, either order: the later IDENTIFY wins; a session without a device (bot,
	// old format) is ignored.
	for _, vals := range [][]string{
		{encodeSession(online, desk), encodeSession(online, web), "2"},
		{encodeSession(online, web), encodeSession(online, desk)},
	} {
		if p := presenceOf(u, vals, "", manualStatus{}, false, now); p.GetClientVersion() != "1.1.0" || p.GetClientPlatform() != "web" {
			t.Fatalf("two sessions %v: %v", vals, p)
		}
	}
	// Offline: the client last seen active (an old seen value without it: nothing).
	p = presenceOf(u, nil, encodeSeen(now, desk), manualStatus{}, false, now)
	if p.GetStatus() != v1.PresenceStatus_PRESENCE_STATUS_OFFLINE || p.GetClientVersion() != "1.0.0" || p.GetClientPlatform() != "darwin" || p.GetLastSeen() == nil {
		t.Fatalf("offline: %v", p)
	}
	if p := presenceOf(u, nil, "1700000000000", manualStatus{}, false, now); p.GetClientVersion() != "" || p.GetLastSeen() == nil {
		t.Fatalf("old seen: %v", p)
	}
	// Invisible (manual or on every session): nothing, like last_seen.
	inv := manualStatus{status: v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE}
	p = presenceOf(u, []string{encodeSession(online, web)}, encodeSeen(now, web), inv, false, now)
	if p.GetClientVersion() != "" || p.GetClientPlatform() != "" || p.GetLastSeen() != nil {
		t.Fatalf("invisible: %v", p)
	}
	p = presenceOf(u, []string{encodeSession(v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE, web)}, "", manualStatus{}, false, now)
	if p.GetClientVersion() != "" {
		t.Fatalf("invisible session: %v", p)
	}
}
