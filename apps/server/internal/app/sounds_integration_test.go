//go:build integration

package app_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// toneWav is a mono 16-bit PCM WAV of a 440 Hz tone.
func toneWav(seconds float64) []byte {
	const rate = 16000
	n := int(seconds * rate)
	data := make([]byte, 2*n)
	for i := range n {
		v := int16(math.Sin(2*math.Pi*440*float64(i)/rate) * 12000)
		binary.LittleEndian.PutUint16(data[2*i:], uint16(v)) //nolint:gosec // two's complement
	}
	var b bytes.Buffer
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(36+len(data))) //nolint:gosec // small
	b.WriteString("WAVEfmt ")
	for _, v := range []any{uint32(16), uint16(1), uint16(1), uint32(rate), uint32(rate * 2), uint16(2), uint16(16)} {
		_ = binary.Write(&b, binary.LittleEndian, v)
	}
	b.WriteString("data")
	_ = binary.Write(&b, binary.LittleEndian, uint32(len(data))) //nolint:gosec // small
	b.Write(data)
	return b.Bytes()
}

func soundUpload(t *testing.T, u *user, wsID, name, mime string, data []byte) string {
	t.Helper()
	st, f := uploadAs(t, u, "/api/workspaces/"+wsID+"/files", name, mime, data)
	if st != 201 {
		t.Fatalf("upload %s: %d", name, st)
	}
	return f.GetId()
}

// insertSound adds a library row straight to the database (tests of play and of the limit do
// not need a converted clip).
func insertSound(t *testing.T, wsID, fileID, name string) sqlc.WorkspaceSound {
	t.Helper()
	s, err := testDB.Q.InsertWorkspaceSound(context.Background(), sqlc.InsertWorkspaceSoundParams{
		WorkspaceID: uuid.MustParse(wsID), Name: name, FileID: uuid.MustParse(fileID), DurationMs: 1000})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// TestSoundsLibrary (ADR-0036 §2): create / edit / move / replace / delete with MANAGE_STICKERS,
// the source rules (the caller's own upload of this workspace), the server-made Ogg/Opus clip,
// at most 50, events and READY; the clip is readable by members and guests, not by outsiders;
// members, guests and bots cannot manage, bots can list.
func TestSoundsLibrary(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid + "/sounds"
	src := soundUpload(t, o, wid, "tss.wav", "audio/wav", toneWav(1))
	create := func(name, emoji, fileID string) *v1.CreateSoundRequest {
		return &v1.CreateSoundRequest{Name: name, Emoji: emoji, FileId: fileID}
	}

	// Source and field rules.
	o.must(422, "POST", base, create("Tss", "🥁", "nope"), nil)
	o.must(422, "POST", base, create("Tss", "🥁", bgUpload(t, o, wid, pngBytes(16, 16))), nil)
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	o.must(422, "POST", base, create("Tss", "🥁", soundUpload(t, o, other.GetId(), "a.wav", "audio/wav", toneWav(0.5))), nil)
	bobClip := soundUpload(t, bob, wid, "bob.wav", "audio/wav", toneWav(0.5))
	o.must(422, "POST", base, create("Tss", "🥁", bobClip), nil) // someone else's file
	o.must(422, "POST", base, create("  ", "🥁", src), nil)
	o.must(422, "POST", base, create(strings.Repeat("x", 33), "🥁", src), nil)
	o.must(422, "POST", base, create("Tss", "ab", src), nil)

	// Rights: a member, a guest and a bot (even with MANAGE_STICKERS) cannot manage; a bot lists.
	bob.must(403, "POST", base, create("Tss", "🥁", bobClip), nil)
	g := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+g.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	g.must(403, "POST", base, create("Tss", "🥁", src), nil)
	b := createBot(t, o, wid, "Drummer")
	role := newRole(t, o, wid, "Sounds", perm.ManageStickers)
	if st, _ := setMemberRoles(o, wid, b.id, role.GetId()); st != 200 {
		t.Fatalf("bot role: %d", st)
	}
	b.must(403, "POST", base, create("Tss", "🥁", src), nil)
	b.must(200, "GET", base, nil, nil)

	gb := dialGW(t)
	gb.identify(bob.token)
	var cr v1.SoundResponse
	// Conversion needs ffmpeg ≥ 7.1 with ffprobe on the host (the api image and CI have 8.0).
	if st := o.do("POST", base, create(" Ba dum tss ", "🥁", src), &cr); st == 503 {
		t.Skip("no ffmpeg ≥ 7.1 on this host: conversion is not tested")
	} else if st != 201 {
		t.Fatalf("create: %d", st)
	}
	// A file that only looks like audio.
	junk := soundUpload(t, o, wid, "junk.wav", "audio/wav", append([]byte("RIFF\x24\x00\x00\x00WAVE"), bytes.Repeat([]byte{7}, 300)...))
	o.must(422, "POST", base, create("Tss", "🥁", junk), nil)
	tss := cr.GetSound()
	if tss.GetName() != "Ba dum tss" || tss.GetEmoji() != "🥁" || tss.GetWorkspaceId() != wid || tss.GetFileId() == src ||
		tss.GetDurationMs() < 950 || tss.GetDurationMs() > 1050 || tss.GetPosition() != 0 {
		t.Fatalf("created: %v", tss)
	}
	gb.wait("SOUND_CREATE", func(e *v1.DispatchEvent) bool { return e.GetSoundCreate().GetSound().GetId() == tss.GetId() })

	// The clip: Ogg/Opus, read by members and guests, not by outsiders; the upload stays private.
	resp, clip := get(t, bob, "/api/files/"+tss.GetFileId(), nil)
	if resp.StatusCode != 200 || !bytes.HasPrefix(clip, []byte("OggS")) || !bytes.Contains(clip[:100], []byte("OpusHead")) {
		t.Fatalf("clip: %d %q", resp.StatusCode, clip[:min(len(clip), 40)])
	}
	if st := fileStatus(t, g, tss.GetFileId()); st != 200 {
		t.Fatalf("clip for a guest: %d", st)
	}
	outsider := register(t, invite(t, o, other.GetId()))
	if st := fileStatus(t, outsider, tss.GetFileId()); st != 404 {
		t.Fatalf("clip for an outsider: %d", st)
	}
	if st := fileStatus(t, bob, src); st != 404 {
		t.Fatalf("source upload for a member: %d", st)
	}
	// A clip is not a source again.
	o.must(422, "POST", base, create("Again", "", tss.GetFileId()), nil)

	// A longer source is cut to 5 s.
	long := soundUpload(t, o, wid, "long.wav", "audio/wav", toneWav(7))
	o.must(201, "POST", base, create("Long", "", long), &cr)
	longS := cr.GetSound()
	if longS.GetDurationMs() < 4900 || longS.GetDurationMs() > 5000 || longS.GetPosition() != 1 {
		t.Fatalf("long: %v", longS)
	}

	// READY carries the library in order.
	found := 0
	for _, s := range dialGW(t).identify(g.token).GetWorkspaces() {
		if s.GetWorkspace().GetId() == wid {
			for i, x := range s.GetSounds() {
				if (i == 0 && x.GetId() == tss.GetId()) || (i == 1 && x.GetId() == longS.GetId()) {
					found++
				}
			}
		}
	}
	if found != 2 {
		t.Fatal("READY lacks the sounds in order")
	}

	// Edit: rename + emoji, then move the second to the front (both are announced).
	name, emoji, zero := "Tss", "🎺", uint32(0)
	var up v1.SoundResponse
	o.must(200, "PATCH", base+"/"+tss.GetId(), &v1.UpdateSoundRequest{Name: &name, Emoji: &emoji}, &up)
	if up.GetSound().GetName() != "Tss" || up.GetSound().GetEmoji() != "🎺" || up.GetSound().GetFileId() != tss.GetFileId() {
		t.Fatalf("renamed: %v", up.GetSound())
	}
	gb.wait("SOUND_UPDATE rename", func(e *v1.DispatchEvent) bool { return e.GetSoundUpdate().GetSound().GetName() == "Tss" })
	o.must(200, "PATCH", base+"/"+longS.GetId(), &v1.UpdateSoundRequest{Position: &zero}, &up)
	if up.GetSound().GetPosition() != 0 {
		t.Fatalf("moved: %v", up.GetSound())
	}
	gb.wait("SOUND_UPDATE moved", func(e *v1.DispatchEvent) bool {
		s := e.GetSoundUpdate().GetSound()
		return s.GetId() == tss.GetId() && s.GetPosition() == 1
	})
	var list v1.ListSoundsResponse
	g.must(200, "GET", base, nil, &list)
	if len(list.GetSounds()) != 2 || list.GetSounds()[0].GetId() != longS.GetId() {
		t.Fatalf("order: %v", list.GetSounds())
	}

	// Replace the clip.
	again := soundUpload(t, o, wid, "again.wav", "audio/wav", toneWav(2))
	o.must(200, "PATCH", base+"/"+tss.GetId(), &v1.UpdateSoundRequest{FileId: &again}, &up)
	if up.GetSound().GetFileId() == tss.GetFileId() || up.GetSound().GetDurationMs() < 1950 || up.GetSound().GetName() != "Tss" {
		t.Fatalf("replaced: %v", up.GetSound())
	}
	bob.must(403, "PATCH", base+"/"+tss.GetId(), &v1.UpdateSoundRequest{Name: &name}, nil)
	o.must(404, "PATCH", base+"/"+uuid.NewString(), &v1.UpdateSoundRequest{Name: &name}, nil)

	// Delete.
	bob.must(403, "DELETE", base+"/"+tss.GetId(), nil, nil)
	o.must(204, "DELETE", base+"/"+tss.GetId(), nil, nil)
	gb.wait("SOUND_DELETE", func(e *v1.DispatchEvent) bool { return e.GetSoundDelete().GetSoundId() == tss.GetId() })
	o.must(404, "DELETE", base+"/"+tss.GetId(), nil, nil)

	// At most 50.
	for i := 1; i < 50; i++ {
		insertSound(t, wid, longS.GetFileId(), "filler")
	}
	o.must(409, "POST", base, create("One more", "", soundUpload(t, o, wid, "more.wav", "audio/wav", toneWav(0.3))), nil)
}

// joinSoundCall joins u to the voice room and connects its device (LiveKit webhook); the owner's
// gateway o sees the connected state.
func joinSoundCall(t *testing.T, g *gw, u interface {
	must(int, string, string, proto.Message, proto.Message)
}, userID, wsID, rid string) {
	t.Helper()
	var j v1.JoinVoiceResponse
	u.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	webhook(t, whEvent("participant_joined", "ws_"+wsID+"_room_"+rid, j.GetIdentity(), nil), "secret")
	g.wait("in the call", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == userID && s.GetRoomId() == rid && !s.GetPending()
	})
}

// TestSoundPlay (ADR-0036 §1): only a participant of the call plays; SOUND_PLAY reaches everyone
// in the call and nobody else; built-in and workspace sounds; 1 per 2 s per user and 5 per 10 s
// per room; a bot in the call plays.
func TestSoundPlay(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	wid, rid := ws.GetId(), room.GetId()
	play := func(id string) *v1.PlaySoundRequest { return &v1.PlaySoundRequest{SoundId: id} }
	path := "/api/rooms/" + rid + "/sounds/play"
	carol := register(t, invite(t, o, wid)) // stays out of the call

	go1, gb, gc := dialGW(t), dialGW(t), dialGW(t)
	go1.identify(o.token)
	gb.identify(bob.token)
	gc.identify(carol.token)

	// Not in the call.
	o.must(403, "POST", path, play("builtin:ba_dum_tss"), nil)
	joinSoundCall(t, go1, o, o.id, wid, rid)
	bob.must(403, "POST", path, play("builtin:ba_dum_tss"), nil)
	joinSoundCall(t, go1, bob, bob.id, wid, rid)

	// A built-in sound: to both participants, the caller included; not to carol.
	o.must(204, "POST", path, play("builtin:ba_dum_tss"), nil)
	isPlay := func(user, sound string) func(*v1.DispatchEvent) bool {
		return func(e *v1.DispatchEvent) bool {
			p := e.GetSoundPlay()
			return p != nil && p.GetRoomId() == rid && p.GetUserId() == user && p.GetSoundId() == sound &&
				time.Since(p.GetAt().AsTime()) < 5*time.Second
		}
	}
	go1.wait("SOUND_PLAY to the caller", isPlay(o.id, "builtin:ba_dum_tss"))
	gb.wait("SOUND_PLAY to bob", isPlay(o.id, "builtin:ba_dum_tss"))
	gc.quiet("SOUND_PLAY outside the call", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetSoundPlay() != nil })

	// One per 2 s per user.
	o.must(429, "POST", path, play("builtin:ba_dum_tss"), nil)

	// Unknown sounds: a bad built-in name, a random id, another workspace's sound.
	bob.must(404, "POST", path, play("builtin:Bad Name"), nil)
	bob.must(404, "POST", path, play(uuid.NewString()), nil)
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	foreign := insertSound(t, other.GetId(), soundUpload(t, o, other.GetId(), "f.wav", "audio/wav", toneWav(0.2)), "Foreign")
	bob.must(404, "POST", path, play(foreign.ID.String()), nil)

	// A workspace sound.
	own := insertSound(t, wid, soundUpload(t, o, wid, "w.wav", "audio/wav", toneWav(0.2)), "Own")
	bob.must(204, "POST", path, play(own.ID.String()), nil)
	go1.wait("SOUND_PLAY workspace sound", isPlay(bob.id, own.ID.String()))

	// A bot in the call plays.
	b := createBot(t, o, wid, "Drummer")
	joinSoundCall(t, go1, b, b.id, wid, rid)
	b.must(204, "POST", path, play("builtin:quack"), nil)
	gb.wait("SOUND_PLAY by the bot", isPlay(b.id, "builtin:quack"))

	// The room allows 5 per 10 s: six fresh participants of another room, one play each.
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "busy"}, &cr)
	busy := cr.GetRoom().GetId()
	var crowd []*user
	for range 6 {
		u := register(t, invite(t, o, wid))
		joinSoundCall(t, go1, u, u.id, wid, busy)
		crowd = append(crowd, u)
	}
	for i, u := range crowd {
		want := 204
		if i == 5 {
			want = 429
		}
		u.must(want, "POST", "/api/rooms/"+busy+"/sounds/play", play("builtin:quack"), nil)
	}
}
