//go:build integration

package app_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// The moderator's request is canceled (tab closed) right after the target LiveKit room was
// created, i.e. just before voice state starts to change: the move must still complete —
// the member is recorded in the target room — instead of stopping half-way with devices in
// the target but no VOICE_MOVED, timers or rollback.
func TestMoveSurvivesCanceledRequest(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, roomA := setupTeam(t)
	wid := ws.GetId()
	dst := voiceRoom(t, o, wid, "Target", 0)
	lkRec.mu.Lock()
	lkRec.fakeMove = true
	lkRec.mu.Unlock()
	defer func() { lkRec.mu.Lock(); lkRec.fakeMove, lkRec.afterCreateRoom = false, nil; lkRec.mu.Unlock() }()
	joinVoice(t, bob, wid, roomA.GetId())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	lkRec.mu.Lock()
	lkRec.afterCreateRoom = cancel
	lkRec.mu.Unlock()
	body, err := protojson.Marshal(&v1.MoveMemberRequest{TargetRoomId: dst})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/rooms/"+roomA.GetId()+"/voice/"+bob.id+"/move", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+o.token)
	rec := httptest.NewRecorder()
	testApp.Handler.ServeHTTP(rec, req)
	if ctx.Err() == nil {
		t.Fatal("hook did not run: request context was never canceled")
	}
	if !inVoice(t, o, bob.id, dst) {
		t.Fatalf("move stopped half-way after the moderator's request was canceled (status %d)", rec.Code)
	}
}
