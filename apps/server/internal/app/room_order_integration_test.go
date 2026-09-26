//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestRoomOrderFlat (docs/09 P1 #19): a new workspace has no categories; one setOrder batch
// moves a room out of a category to the top level, reorders the rest and the categories; a
// batch with a foreign item changes nothing; members without MANAGE_ROOM get 403.
func TestRoomOrderFlat(t *testing.T) {
	o, bob, ws, voiceRoom := setupTeam(t)
	wid := ws.GetId()
	var lc v1.ListCategoriesResponse
	o.must(200, "GET", "/api/workspaces/"+wid+"/categories", nil, &lc)
	if len(lc.GetCategories()) != 0 {
		t.Fatalf("new workspace has categories: %v", lc.GetCategories())
	}
	var text v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "chat"}, &text)
	if text.GetRoom().GetCategoryId() != "" || text.GetRoom().GetPosition() <= voiceRoom.GetPosition() {
		t.Fatalf("new room not appended at the top level: %v", text.GetRoom())
	}
	var ca, cb v1.CreateCategoryResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/categories", &v1.CreateCategoryRequest{Name: "A"}, &ca)
	o.must(201, "POST", "/api/workspaces/"+wid+"/categories", &v1.CreateCategoryRequest{Name: "B"}, &cb)
	a, bID := ca.GetCategory().GetId(), cb.GetCategory().GetId()
	o.must(200, "PATCH", "/api/rooms/"+voiceRoom.GetId(), &v1.UpdateRoomRequest{CategoryId: &a}, nil)

	g := dialGW(t)
	g.identify(bob.token)
	// One batch: voice room A → top level before «chat», categories swapped.
	var ord v1.SetRoomOrderResponse
	o.must(200, "PUT", "/api/workspaces/"+wid+"/rooms/order", &v1.SetRoomOrderRequest{
		Rooms: []*v1.SetRoomOrderRequest_RoomPosition{
			{RoomId: voiceRoom.GetId(), Position: 0},
			{RoomId: text.GetRoom().GetId(), Position: 1},
		},
		Categories: []*v1.SetRoomOrderRequest_CategoryPosition{{CategoryId: bID, Position: 0}, {CategoryId: a, Position: 1}},
	}, &ord)
	if len(ord.GetRooms()) != 2 || ord.GetRooms()[0].GetCategoryId() != "" || ord.GetRooms()[0].GetPosition() != 0 {
		t.Fatalf("order response: %v", ord.GetRooms())
	}
	// Categories are announced first, then rooms (one pipeline).
	g.wait("CATEGORY_UPDATE position", func(e *v1.DispatchEvent) bool {
		c := e.GetCategoryUpdate().GetCategory()
		return c.GetId() == bID && c.GetPosition() == 0
	})
	g.wait("ROOM_UPDATE to top level", func(e *v1.DispatchEvent) bool {
		r := e.GetRoomUpdate().GetRoom()
		return r.GetId() == voiceRoom.GetId() && r.GetCategoryId() == "" && r.GetPosition() == 0
	})

	// A foreign room in the batch: 422 and nothing applied (one transaction).
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	var foreign v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+other.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "x"}, &foreign)
	o.must(422, "PUT", "/api/workspaces/"+wid+"/rooms/order", &v1.SetRoomOrderRequest{Rooms: []*v1.SetRoomOrderRequest_RoomPosition{
		{RoomId: text.GetRoom().GetId(), Position: 0, CategoryId: bID},
		{RoomId: foreign.GetRoom().GetId(), Position: 1},
	}}, nil)
	var lr v1.ListRoomsResponse
	o.must(200, "GET", "/api/workspaces/"+wid+"/rooms", nil, &lr)
	for _, r := range lr.GetRooms() {
		if r.GetId() == text.GetRoom().GetId() && (r.GetCategoryId() != "" || r.GetPosition() != 1) {
			t.Fatalf("partial batch applied: %v", r)
		}
	}
	// A category of another workspace is rejected as well.
	var oc v1.CreateCategoryResponse
	o.must(201, "POST", "/api/workspaces/"+other.GetId()+"/categories", &v1.CreateCategoryRequest{Name: "f"}, &oc)
	o.must(422, "PUT", "/api/workspaces/"+wid+"/rooms/order", &v1.SetRoomOrderRequest{Rooms: []*v1.SetRoomOrderRequest_RoomPosition{
		{RoomId: text.GetRoom().GetId(), Position: 0, CategoryId: oc.GetCategory().GetId()},
	}}, nil)

	// Members: no reorder, no category management.
	bob.must(403, "PUT", "/api/workspaces/"+wid+"/rooms/order", &v1.SetRoomOrderRequest{Rooms: []*v1.SetRoomOrderRequest_RoomPosition{{RoomId: text.GetRoom().GetId(), Position: 5}}}, nil)
	name := "renamed"
	bob.must(403, "PATCH", "/api/categories/"+a, &v1.UpdateCategoryRequest{Name: &name}, nil)
	bob.must(403, "DELETE", "/api/categories/"+a, nil, nil)

	// Deleting a category: its rooms go to the top level after the rooms already there.
	var inA v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "in-a", CategoryId: a}, &inA)
	o.must(200, "PUT", "/api/workspaces/"+wid+"/rooms/order", &v1.SetRoomOrderRequest{Rooms: []*v1.SetRoomOrderRequest_RoomPosition{
		{RoomId: inA.GetRoom().GetId(), Position: 0, CategoryId: a},
	}}, nil)
	o.must(204, "DELETE", "/api/categories/"+a, nil, nil)
	o.must(200, "GET", "/api/workspaces/"+wid+"/rooms", nil, &lr)
	for _, r := range lr.GetRooms() {
		if r.GetId() == inA.GetRoom().GetId() && (r.GetCategoryId() != "" || r.GetPosition() != 2) {
			t.Fatalf("room of a deleted category: %v, want top level at 2", r)
		}
	}
}
