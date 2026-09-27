//go:build integration

package app_test

import (
	"context"
	"net/http"
	"net/url"
	"sync"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestReactionLimit: at most 3 different emojis per user per message (docs/09 item 27), in a
// workspace room and in a DM; repeats are idempotent, removal is always allowed, concurrent
// adds never exceed the cap.
func TestReactionLimit(t *testing.T) {
	o, bob, _, room := setupTeam(t)
	dm := openDM(t, o, bob.id, 201)
	emojis := []string{"👍", "❤️", "😂", "🎉", "🔥", "👀", "🚀", "✅"}
	path := func(mid, e string) string { return "/api/messages/" + mid + "/reactions/" + url.PathEscape(e) }
	count := func(u *user, rid, mid string) (mine, total int) {
		t.Helper()
		var page v1.ListMessagesResponse
		u.must(200, "GET", "/api/rooms/"+rid+"/messages?limit=50", nil, &page)
		for _, m := range page.GetMessages() {
			if m.GetId() != mid {
				continue
			}
			for _, r := range m.GetReactions() {
				total++
				if r.GetMe() {
					mine++
				}
			}
		}
		return mine, total
	}

	for _, rid := range []string{room.GetId(), dm.GetRoom().GetId()} {
		mid := send(t, o, rid, "limit", "").GetId()
		for _, e := range emojis[:3] {
			bob.must(204, "PUT", path(mid, e), nil, nil)
		}
		bob.must(204, "PUT", path(mid, emojis[0]), nil, nil) // repeat: idempotent, not a 4th
		bob.must(409, "PUT", path(mid, emojis[3]), nil, nil)
		if e := bob.rawErr("PUT", path(mid, emojis[3])); e.GetCode() != v1.ErrorCode_ERROR_CODE_CONFLICT ||
			e.GetReason() != "REACTION_LIMIT" || e.GetLimit() != 3 || e.GetUsed() != 3 {
			t.Fatalf("limit error: %v", e)
		}
		// Another user's cap is separate: o can add a 4th emoji to the message.
		o.must(204, "PUT", path(mid, emojis[3]), nil, nil)
		// Removing one frees a slot.
		bob.must(204, "DELETE", path(mid, emojis[1]), nil, nil)
		bob.must(204, "PUT", path(mid, emojis[4]), nil, nil)
		if mine, total := count(bob, rid, mid); mine != 3 || total != 4 {
			t.Fatalf("room %s: mine=%d total=%d", rid, mine, total)
		}
	}

	// Concurrency: parallel adds of different emojis → exactly 3 succeed.
	mid := send(t, o, room.GetId(), "race", "").GetId()
	var wg sync.WaitGroup
	codes := make([]int, len(emojis))
	for i, e := range emojis {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequestWithContext(context.Background(), "PUT", srv.URL+path(mid, e), http.NoBody)
			req.Header.Set("Authorization", "Bearer "+bob.token)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			_ = resp.Body.Close()
			codes[i] = resp.StatusCode
		}()
	}
	wg.Wait()
	ok, conflict := 0, 0
	for _, c := range codes {
		switch c {
		case 204:
			ok++
		case 409:
			conflict++
		}
	}
	if ok != 3 || conflict != len(emojis)-3 {
		t.Fatalf("parallel adds: %v", codes)
	}
	if mine, _ := count(bob, room.GetId(), mid); mine != 3 {
		t.Fatalf("parallel adds stored %d reactions", mine)
	}
}
