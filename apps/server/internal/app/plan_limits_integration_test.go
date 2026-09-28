//go:build integration

package app_test

import (
	"context"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Free plan limits of 28.09 (ADR-0024 «Пометка 2026-09-28»): 50 members (bots take a seat,
// guests do not), voice up to «Нормальное» (16 kbps), one bot, one sticker pack; TEAM lifts
// them, ENTERPRISE has no limits at all.

// fillSeats adds n plain members straight in the database (registering 50 users through the
// API would only test registration).
func fillSeats(t *testing.T, wsID string, n int) {
	t.Helper()
	_, err := testDB.Pool.Exec(context.Background(), `
WITH u AS (
    INSERT INTO users (email, display_name, email_verified_at)
    SELECT 'seat-' || gen_random_uuid() || '@example.com', 'seat', now() FROM generate_series(1, $2) RETURNING id
)
INSERT INTO workspace_members (workspace_id, user_id, role) SELECT $1, id, 'member' FROM u`, wsID, n)
	if err != nil {
		t.Fatal(err)
	}
}

func setPlan(t *testing.T, wsID string, req *v1.AdminSetPlanRequest) {
	t.Helper()
	superadminUser(t).must(200, "PUT", "/api/admin/workspaces/"+wsID+"/plan", req, nil)
}

func wantPlanLimit(t *testing.T, what string, st int, e *v1.ApiError, used, limit uint64) {
	t.Helper()
	if st != 409 || e.GetCode() != v1.ErrorCode_ERROR_CODE_CONFLICT || e.GetReason() != "PLAN_LIMIT" || e.GetUsed() != used || e.GetLimit() != limit {
		t.Fatalf("%s: %d %v, want 409 PLAN_LIMIT %d/%d", what, st, e, used, limit)
	}
}

func TestPlanMembersLimit(t *testing.T) {
	withFreeLimits(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wsID := ws.GetId()
	if l := ws.GetPlan().GetLimits(); l.GetMembers() != 50 || l.GetAudioTierMaxKbps() != 16 || l.GetBots() != 1 || l.GetStickerPacks() != 1 {
		t.Fatalf("free limits: %v", l)
	}
	code := invite(t, o, wsID)    // owner = 1
	fillSeats(t, wsID, 47)        // 48
	register(t, code)             // 49: registration by an invitation
	createBot(t, o, wsID, "seat") // 50: a bot takes a seat

	// Full: no new link, no email invitation, nobody joins.
	st, e := o.apiErrBody("POST", "/api/workspaces/"+wsID+"/invites", &v1.CreateInviteRequest{})
	wantPlanLimit(t, "invite link", st, e, 50, 50)
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/invites/email", &v1.CreateEmailInviteRequest{Email: uniq("full") + "@example.com"})
	wantPlanLimit(t, "email invite", st, e, 50, 50)
	outsider := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	st, e = outsider.apiErrBody("POST", "/api/invites/"+code+"/join", nil)
	wantPlanLimit(t, "join by code", st, e, 50, 50)
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/members", &v1.AddMemberRequest{UserId: outsider.id})
	wantPlanLimit(t, "add member", st, e, 50, 50)
	anon := &client{t: t, ip: "10.71.0.1"}
	st, e = anon.apiErrBody("POST", "/api/auth/register", &v1.RegisterRequest{
		Email: uniq("late") + "@example.com", Password: "password123", DisplayName: "Late", InviteCode: code, DeviceName: "test",
	})
	wantPlanLimit(t, "register by invite", st, e, 50, 50)
	open := v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_OPEN
	o.must(200, "PATCH", "/api/workspaces/"+wsID, &v1.UpdateWorkspaceRequest{Visibility: &open}, nil)
	st, e = outsider.apiErrBody("POST", "/api/workspaces/"+wsID+"/join", nil)
	wantPlanLimit(t, "join open workspace", st, e, 50, 50)
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/bots", &v1.CreateBotRequest{DisplayName: "b2", Username: strings.ReplaceAll(uniq("b2_"), "-", "_")})
	if st != 409 || e.GetReason() != "PLAN_LIMIT" {
		t.Fatalf("second bot: %d %v", st, e)
	}

	// Guests take no seat: a room link still lets one in; promoting them needs a seat.
	var room v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wsID+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "guests"}, &room)
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+room.GetRoom().GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	var gj v1.JoinRoomInviteResponse
	(&client{t: t, ip: "10.71.0.2"}).must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/members/"+gj.GetMe().GetUser().GetId()+"/promote", nil)
	wantPlanLimit(t, "promote guest", st, e, 50, 50)

	// A seat frees up: joining works again.
	if _, err := testDB.Pool.Exec(context.Background(),
		`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = (SELECT m.user_id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.display_name = 'seat' LIMIT 1)`, wsID); err != nil {
		t.Fatal(err)
	}
	outsider.must(200, "POST", "/api/invites/"+code+"/join", nil, nil)

	// TEAM: members unlimited.
	setPlan(t, wsID, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	fillSeats(t, wsID, 5)
	o.must(201, "POST", "/api/workspaces/"+wsID+"/invites", &v1.CreateInviteRequest{}, nil)
	o.must(200, "POST", "/api/workspaces/"+wsID+"/members/"+gj.GetMe().GetUser().GetId()+"/promote", nil, nil)
}

func TestPlanAudioTier(t *testing.T) {
	withFreeLimits(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wsID := ws.GetId()
	patchWS := func(kbps uint32) (int, *v1.ApiError) {
		return o.apiErrBody("PATCH", "/api/workspaces/"+wsID, &v1.UpdateWorkspaceRequest{DefaultAudioBitrateKbps: &kbps})
	}
	// The stored default (32, before the cap) stays accepted as is; raising is refused.
	if st, e := patchWS(32); st != 200 {
		t.Fatalf("unchanged default: %d %v", st, e)
	}
	st, e := patchWS(64)
	wantPlanLimit(t, "default 64", st, e, 64, 16)
	if st, e := patchWS(16); st != 200 {
		t.Fatalf("default 16: %d %v", st, e)
	}
	st, e = patchWS(32)
	wantPlanLimit(t, "default back to 32", st, e, 32, 16)

	good, normal := uint32(32), uint32(16)
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/rooms", &v1.CreateRoomRequest{
		Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "v", MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &good},
	})
	wantPlanLimit(t, "room 32", st, e, 32, 16)
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wsID+"/rooms", &v1.CreateRoomRequest{
		Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "v", MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &normal},
	}, &cr)
	rid := cr.GetRoom().GetId()
	st, e = o.apiErrBody("PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &good}})
	wantPlanLimit(t, "room patch 32", st, e, 32, 16)

	// A room stored above the cap (before it, or on a lapsed plan) gets min(room, plan) at join.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE rooms SET audio_bitrate_kbps = 64 WHERE id = $1", rid); err != nil {
		t.Fatal(err)
	}
	j := joinPending(t, o, rid)
	if j.GetMedia().GetAudioBitrateKbps() != 16 || j.GetPlanLimits().GetAudioTierMaxKbps() != 16 {
		t.Fatalf("join on free: media %v limits %v", j.GetMedia(), j.GetPlanLimits())
	}

	// TEAM: any tier.
	setPlan(t, wsID, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	best := uint32(64)
	o.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &best}}, nil)
	if st, e := patchWS(64); st != 200 {
		t.Fatalf("team default 64: %d %v", st, e)
	}
	j = joinPending(t, o, rid)
	if j.GetMedia().GetAudioBitrateKbps() != 64 || j.GetPlanLimits().GetAudioTierMaxKbps() != 0 {
		t.Fatalf("join on team: media %v limits %v", j.GetMedia(), j.GetPlanLimits())
	}
}

func TestPlanFreeCounts(t *testing.T) {
	withFreeLimits(t)
	o := owner(t)
	wsID := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	createBot(t, o, wsID, "one")
	st, e := o.apiErrBody("POST", "/api/workspaces/"+wsID+"/bots", &v1.CreateBotRequest{DisplayName: "two", Username: strings.ReplaceAll(uniq("two_"), "-", "_")})
	wantPlanLimit(t, "second bot", st, e, 1, 1)
	createPack(t, o, wsID, "One")
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/sticker-packs", &v1.CreateStickerPackRequest{Name: "Two"})
	wantPlanLimit(t, "second pack", st, e, 1, 1)

	// The superadmin sees the counts against the limits.
	var aw v1.AdminGetWorkspaceResponse
	superadminUser(t).must(200, "GET", "/api/admin/workspaces/"+wsID, nil, &aw)
	if u := aw.GetWorkspace().GetUsage(); u.GetBots() != 1 || u.GetStickerPacks() != 1 || u.GetMembers() != 2 {
		t.Fatalf("admin usage: %v", u)
	}

	// TEAM (20 bots, packs unlimited).
	setPlan(t, wsID, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	createBot(t, o, wsID, "two")
	createPack(t, o, wsID, "Two")
}

// ENTERPRISE (owner, 28.09): every check Free fails passes — members, bots, packs, voice tier.
func TestPlanEnterpriseUnlimited(t *testing.T) {
	withFreeLimits(t)
	o := owner(t)
	wsID := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	createBot(t, o, wsID, "one")
	createPack(t, o, wsID, "One")
	fillSeats(t, wsID, 48) // 50 with the owner and the bot: Free is full
	st, e := o.apiErrBody("POST", "/api/workspaces/"+wsID+"/invites", &v1.CreateInviteRequest{})
	wantPlanLimit(t, "free invite", st, e, 50, 50)

	setPlan(t, wsID, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE, Note: "enterprise"})
	var gw v1.GetWorkspaceResponse
	o.must(200, "GET", "/api/workspaces/"+wsID, nil, &gw)
	if p := gw.GetWorkspace().GetPlan(); p.GetPlan() != v1.Plan_PLAN_ENTERPRISE || p.GetLimits().GetRoomMembers() != 0 ||
		p.GetLimits().GetMembers() != 0 || p.GetLimits().GetBots() != 0 || p.GetLimits().GetStorageMb() != 0 ||
		p.GetLimits().GetStreamMaxPreset() != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED {
		t.Fatalf("enterprise plan: %v", p)
	}
	fillSeats(t, wsID, 5)
	o.must(201, "POST", "/api/workspaces/"+wsID+"/invites", &v1.CreateInviteRequest{}, nil)
	createBot(t, o, wsID, "two")
	createPack(t, o, wsID, "Two")
	best := uint32(64)
	o.must(200, "PATCH", "/api/workspaces/"+wsID, &v1.UpdateWorkspaceRequest{DefaultAudioBitrateKbps: &best}, nil)

	// Setting limits for ENTERPRISE is refused (only CUSTOM stores them).
	st, e = superadminUser(t).apiErrBody("PUT", "/api/admin/workspaces/"+wsID+"/plan",
		&v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE, Limits: &v1.PlanLimits{RoomMembers: 3}})
	if st != 422 {
		t.Fatalf("enterprise with limits: %d %v", st, e)
	}
}
