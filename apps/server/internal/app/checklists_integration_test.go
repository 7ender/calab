//go:build integration

package app_test

import (
	"context"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// Task checklists (ADR-0058 §2).

func newChecklist(t *testing.T, u musty, taskID, title string, want int) *v1.TaskChecklistResponse {
	t.Helper()
	var r v1.TaskChecklistResponse
	u.must(want, "POST", "/api/tasks/"+taskID+"/checklists", &v1.CreateTaskChecklistRequest{Title: title}, &r)
	return &r
}

func newItem(t *testing.T, u musty, clID, text string, want int) *v1.TaskChecklistResponse {
	t.Helper()
	var r v1.TaskChecklistResponse
	u.must(want, "POST", "/api/checklists/"+clID+"/items", &v1.CreateTaskChecklistItemRequest{Text: text}, &r)
	return &r
}

func setBoardFeatures(t *testing.T, boardID string, mask int64) {
	t.Helper()
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE boards SET disabled_features = $2 WHERE id = $1", boardID, mask); err != nil {
		t.Fatal(err)
	}
}

func TestChecklistsCRUD(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Checklists", Key: "CHK"}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "С чек-листами"}, 201)
	tid := task.GetId()

	c1 := newChecklist(t, o, tid, "Подготовка", 201).GetChecklist()
	c2 := newChecklist(t, o, tid, "Релиз", 201).GetChecklist()
	if c1.GetPosition() != 0 || c2.GetPosition() != 1 {
		t.Fatalf("positions %d %d", c1.GetPosition(), c2.GetPosition())
	}
	newChecklist(t, o, tid, "", 422)
	i1 := newItem(t, o, c1.GetId(), "первый", 201)
	if i1.GetChecklistTotal() != 1 || i1.GetChecklistDone() != 0 {
		t.Fatalf("counters %v", i1)
	}
	newItem(t, o, c1.GetId(), "второй", 201)
	newItem(t, o, c1.GetId(), "", 422)
	item := i1.GetChecklist().GetItems()[0]

	// Toggle: counters, done_by, no TASK_UPDATE.
	done := true
	var r v1.TaskChecklistResponse
	o.must(200, "PATCH", "/api/checklist-items/"+item.GetId(), &v1.UpdateTaskChecklistItemRequest{Done: &done}, &r)
	got := r.GetChecklist().GetItems()[0]
	if !got.GetDone() || got.GetDoneBy() != o.id || got.GetDoneAt() == nil || r.GetChecklistTotal() != 2 || r.GetChecklistDone() != 1 {
		t.Fatalf("toggle: %v", &r)
	}
	text := "переименован"
	o.must(200, "PATCH", "/api/checklist-items/"+item.GetId(), &v1.UpdateTaskChecklistItemRequest{Text: &text}, &r)
	if r.GetChecklist().GetItems()[0].GetText() != text || !r.GetChecklist().GetItems()[0].GetDone() {
		t.Fatalf("edit: %v", &r)
	}

	// Rename, reorder (index among the task's checklists).
	title, pos := "Первая", int32(1)
	o.must(200, "PATCH", "/api/checklists/"+c1.GetId(), &v1.UpdateTaskChecklistRequest{Title: &title, Position: &pos}, &r)
	if r.GetChecklist().GetTitle() != title || r.GetChecklist().GetPosition() != 1 {
		t.Fatalf("rename: %v", &r)
	}

	// GET /tasks/{id}: checklists by position, counters on the task and in the list.
	full := getTask(t, o, tid).GetTask()
	if len(full.GetChecklists()) != 2 || full.GetChecklists()[0].GetId() != c2.GetId() || len(full.GetChecklists()[1].GetItems()) != 2 ||
		full.GetChecklistTotal() != 2 || full.GetChecklistDone() != 1 {
		t.Fatalf("task: %v", full)
	}
	for _, x := range listTasks(t, o, b.GetId(), nil) {
		if x.GetId() == tid && (x.GetChecklistTotal() != 2 || x.GetChecklistDone() != 1 || len(x.GetChecklists()) != 0) {
			t.Fatalf("list counters: %v", x)
		}
	}

	// Move an item to another checklist of the task; another task's checklist is 422.
	other := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Другая"}, 201)
	oc := newChecklist(t, o, other.GetId(), "чужой", 201).GetChecklist()
	cl2 := c2.GetId()
	o.must(422, "PATCH", "/api/checklist-items/"+item.GetId(), &v1.UpdateTaskChecklistItemRequest{ChecklistId: &oc.Id}, nil)
	o.must(200, "PATCH", "/api/checklist-items/"+item.GetId(), &v1.UpdateTaskChecklistItemRequest{ChecklistId: &cl2}, &r)
	if r.GetChecklist().GetId() != cl2 || len(r.GetChecklist().GetItems()) != 1 || r.GetChecklistTotal() != 2 || r.GetChecklistDone() != 1 {
		t.Fatalf("move: %v", &r)
	}

	// Delete an item, then a checklist (cascade): counters follow.
	o.must(200, "DELETE", "/api/checklist-items/"+item.GetId(), nil, &r)
	if len(r.GetChecklist().GetItems()) != 0 || r.GetChecklistTotal() != 1 || r.GetChecklistDone() != 0 {
		t.Fatalf("delete item: %v", &r)
	}
	o.must(200, "DELETE", "/api/checklists/"+c1.GetId(), nil, &r)
	if r.GetChecklist() != nil || r.GetChecklistTotal() != 0 {
		t.Fatalf("delete checklist: %v", &r)
	}
	o.must(404, "PATCH", "/api/checklists/"+c1.GetId(), &v1.UpdateTaskChecklistRequest{Title: &title}, nil)

	kinds := activityKinds(t, o, tid)
	n := 0
	for _, k := range kinds {
		if k == "checklist" {
			n++
		}
	}
	if n < 9 {
		t.Fatalf("journal %v", kinds)
	}
}

func TestChecklistsLimits(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Limits", Key: "CLM"}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Лимиты"}, 201)
	var first string
	for i := range MaxChecklistsForTest {
		c := newChecklist(t, o, task.GetId(), "c", 201).GetChecklist()
		if i == 0 {
			first = c.GetId()
		}
	}
	newChecklist(t, o, task.GetId(), "лишний", 409)
	if reason, _ := errReason(o.client); reason != "CHECKLIST_LIMIT" {
		t.Fatalf("reason %q", reason)
	}
	// 100 items: seeded directly, the 101st through the API.
	if _, err := testDB.Pool.Exec(context.Background(), `INSERT INTO task_checklist_items (checklist_id, task_id, text, position)
		SELECT $1, $2, 'x', g FROM generate_series(1, 100) g`, first, task.GetId()); err != nil {
		t.Fatal(err)
	}
	newItem(t, o, first, "101", 409)
	if reason, _ := errReason(o.client); reason != "CHECKLIST_ITEM_LIMIT" {
		t.Fatalf("reason %q", reason)
	}
	// Moving into a full checklist is limited too.
	var cs []string
	for _, c := range getTask(t, o, task.GetId()).GetTask().GetChecklists() {
		cs = append(cs, c.GetId())
	}
	it := newItem(t, o, cs[1], "перенос", 201).GetChecklist().GetItems()[0]
	o.must(409, "PATCH", "/api/checklist-items/"+it.GetId(), &v1.UpdateTaskChecklistItemRequest{ChecklistId: &first}, nil)
}

const MaxChecklistsForTest = 10

func TestChecklistsPermissions(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Perms", Key: "CPM"}, 201)
	ownerTask := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Задача владельца"}, 201)
	bobTask := createTask(t, bob, b.GetId(), &v1.CreateTaskRequest{Title: "Задача Боба"}, 201)
	oc := newChecklist(t, o, ownerTask.GetId(), "владельца", 201).GetChecklist()
	oi := newItem(t, o, oc.GetId(), "пункт", 201).GetChecklist().GetItems()[0]

	// CREATE_TASKS: own tasks yes, someone else's no (read stays).
	newChecklist(t, bob, bobTask.GetId(), "своя", 201)
	newChecklist(t, bob, ownerTask.GetId(), "чужая", 403)
	newItem(t, bob, oc.GetId(), "чужой", 403)
	done := true
	bob.must(403, "PATCH", "/api/checklist-items/"+oi.GetId(), &v1.UpdateTaskChecklistItemRequest{Done: &done}, nil)
	bob.must(403, "DELETE", "/api/checklists/"+oc.GetId(), nil, nil)
	if len(getTask(t, bob, ownerTask.GetId()).GetTask().GetChecklists()) != 1 {
		t.Fatal("a viewer cannot read checklists")
	}
	// Assigned: the right extends.
	o.must(200, "PUT", "/api/tasks/"+ownerTask.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
	bob.must(200, "PATCH", "/api/checklist-items/"+oi.GetId(), &v1.UpdateTaskChecklistItemRequest{Done: &done}, nil)
	// EDIT_TASKS edits any task.
	setBoardPerms(o, b.GetId(), 200, userOv(carol.id, perm.EditTasks, 0))
	newChecklist(t, carol, bobTask.GetId(), "редактор", 201)

	// View-only user (CREATE_TASKS denied): read yes, every write 403.
	setBoardPerms(o, b.GetId(), 200, userOv(carol.id, perm.EditTasks, 0), userOv(bob.id, 0, perm.CreateTasks))
	bob.must(403, "POST", "/api/tasks/"+bobTask.GetId()+"/checklists", &v1.CreateTaskChecklistRequest{Title: "x"}, nil)
	bob.must(403, "PATCH", "/api/checklist-items/"+oi.GetId(), &v1.UpdateTaskChecklistItemRequest{Done: &done}, nil)
	getTask(t, bob, ownerTask.GetId())

	// A hidden board: 404.
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Closed", Key: "CPR", IsPrivate: true}, 201)
	pt := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "тайна"}, 201)
	pc := newChecklist(t, o, pt.GetId(), "тайный", 201).GetChecklist()
	newChecklist(t, bob, pt.GetId(), "x", 404)
	newItem(t, bob, pc.GetId(), "x", 404)

	// A bot: by the same bits.
	bt := createBot(t, o, wid, "Checklister")
	giveBot(t, o, wid, bt, "tasks", perm.ViewBoard|perm.CreateTasks)
	newChecklist(t, bt, bobTask.GetId(), "бот чужая", 403)
	own := createTask(t, bt, b.GetId(), &v1.CreateTaskRequest{Title: "Задача бота"}, 201)
	bc := newChecklist(t, bt, own.GetId(), "бот", 201).GetChecklist()
	newItem(t, bt, bc.GetId(), "пункт", 201)
	giveBot(t, o, wid, bt, "edit", perm.EditTasks)
	newChecklist(t, bt, bobTask.GetId(), "бот с EDIT_TASKS", 201)

	// Convert creates a task: EDIT_TASKS without CREATE_TASKS may not.
	setBoardPerms(o, b.GetId(), 200, userOv(carol.id, perm.EditTasks, perm.CreateTasks))
	carol.must(403, "POST", "/api/checklist-items/"+oi.GetId()+"/convert", nil, nil)
	if len(getTask(t, o, ownerTask.GetId()).GetTask().GetChecklists()[0].GetItems()) != 1 {
		t.Fatal("the item was converted")
	}
}

func TestChecklistsPlanAndFeature(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Gates", Key: "CGT"}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Ворота"}, 201)
	cl := newChecklist(t, o, task.GetId(), "есть", 201).GetChecklist()
	it := newItem(t, o, cl.GetId(), "пункт", 201).GetChecklist().GetItems()[0]
	done := true

	// Feature CHECKLISTS off (bit 10): create / edit / toggle / convert are 409 FEATURE_DISABLED,
	// delete and reading stay.
	setBoardFeatures(t, b.GetId(), 1<<uint(v1.BoardFeature_BOARD_FEATURE_CHECKLISTS))
	reason := func(want string) {
		t.Helper()
		if r, code := errReason(o.client); r != want || code != v1.ErrorCode_ERROR_CODE_CONFLICT {
			t.Fatalf("reason %q code %v, want %s", r, code, want)
		}
	}
	newChecklist(t, o, task.GetId(), "x", 409)
	reason("FEATURE_DISABLED")
	newItem(t, o, cl.GetId(), "x", 409)
	o.must(409, "PATCH", "/api/checklist-items/"+it.GetId(), &v1.UpdateTaskChecklistItemRequest{Done: &done}, nil)
	reason("FEATURE_DISABLED")
	o.must(409, "PATCH", "/api/checklists/"+cl.GetId(), &v1.UpdateTaskChecklistRequest{Title: &cl.Title}, nil)
	o.must(409, "POST", "/api/checklist-items/"+it.GetId()+"/convert", nil, nil)
	if len(getTask(t, o, task.GetId()).GetTask().GetChecklists()) != 1 {
		t.Fatal("data hidden")
	}
	o.must(200, "DELETE", "/api/checklist-items/"+it.GetId(), nil, nil)
	o.must(200, "DELETE", "/api/checklists/"+cl.GetId(), nil, nil)
	setBoardFeatures(t, b.GetId(), 0)

	// Free plan: reads stay, every write (delete too) is PLAN_LIMIT.
	cl = newChecklist(t, o, task.GetId(), "до понижения", 201).GetChecklist()
	it = newItem(t, o, cl.GetId(), "пункт", 201).GetChecklist().GetItems()[0]
	withFreeLimits(t)
	if len(getTask(t, o, task.GetId()).GetTask().GetChecklists()) != 1 {
		t.Fatal("read-only data is gone")
	}
	newChecklist(t, o, task.GetId(), "x", 409)
	reason("PLAN_LIMIT")
	newItem(t, o, cl.GetId(), "x", 409)
	o.must(409, "PATCH", "/api/checklist-items/"+it.GetId(), &v1.UpdateTaskChecklistItemRequest{Done: &done}, nil)
	reason("PLAN_LIMIT")
	o.must(409, "POST", "/api/checklist-items/"+it.GetId()+"/convert", nil, nil)
	o.must(409, "DELETE", "/api/checklists/"+cl.GetId(), nil, nil)
	reason("PLAN_LIMIT")
}

func TestChecklistConvert(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Convert", Key: "CNV"}, 201)
	parent := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Родитель"}, 201)
	cl := newChecklist(t, o, parent.GetId(), "список", 201).GetChecklist()
	newItem(t, o, cl.GetId(), "оставить", 201)
	it := newItem(t, o, cl.GetId(), "сделать подзадачей", 201).GetChecklist().GetItems()[1]

	var r v1.ConvertChecklistItemResponse
	o.must(201, "POST", "/api/checklist-items/"+it.GetId()+"/convert", nil, &r)
	sub := r.GetTask()
	if sub.GetTitle() != "сделать подзадачей" || sub.GetParentId() != parent.GetId() || len(r.GetChecklist().GetItems()) != 1 || r.GetChecklistTotal() != 1 {
		t.Fatalf("convert: %v", &r)
	}
	if got := getTask(t, o, parent.GetId()); got.GetTask().GetSubtaskCount() != 1 || len(got.GetSubtasks()) != 1 {
		t.Fatalf("parent: %v", got)
	}
	o.must(404, "DELETE", "/api/checklist-items/"+it.GetId(), nil, nil)

	// A subtask cannot get subtasks: 422; with SUBTASKS off: 409 FEATURE_DISABLED (parentId).
	sc := newChecklist(t, o, sub.GetId(), "у подзадачи", 201).GetChecklist()
	si := newItem(t, o, sc.GetId(), "ещё", 201).GetChecklist().GetItems()[0]
	o.must(422, "POST", "/api/checklist-items/"+si.GetId()+"/convert", nil, nil)
	setBoardFeatures(t, b.GetId(), 1<<uint(v1.BoardFeature_BOARD_FEATURE_SUBTASKS))
	left := getTask(t, o, parent.GetId()).GetTask().GetChecklists()[0].GetItems()[0]
	o.must(409, "POST", "/api/checklist-items/"+left.GetId()+"/convert", nil, nil)
	if reason, _ := errReason(o.client); reason != "FEATURE_DISABLED" {
		t.Fatalf("reason %q", reason)
	}
}

func TestChecklistEvents(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Events", Key: "CEV"}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "События"}, 201)
	// Carol does not see the board.
	setBoardPerms(o, b.GetId(), 200, userOv(carol.id, 0, perm.ViewBoard))

	gb, gc := dialGW(t), dialGW(t)
	gb.identify(bob.token)
	gc.identify(carol.token)

	cl := newChecklist(t, o, task.GetId(), "события", 201).GetChecklist()
	ev := gb.wait("TASK_CHECKLIST_UPDATE", func(e *v1.DispatchEvent) bool { return e.GetTaskChecklistUpdate() != nil })
	if u := ev.GetTaskChecklistUpdate(); u.GetTaskId() != task.GetId() || u.GetBoardId() != b.GetId() || u.GetChecklist().GetId() != cl.GetId() {
		t.Fatalf("create event: %v", u)
	}
	gb.wait("TASK_ACTIVITY", func(e *v1.DispatchEvent) bool { return e.GetTaskActivity().GetActivity().GetKind() == "checklist" })

	it := newItem(t, o, cl.GetId(), "пункт", 201).GetChecklist().GetItems()[0]
	gb.wait("item added", func(e *v1.DispatchEvent) bool { return len(e.GetTaskChecklistUpdate().GetChecklist().GetItems()) == 1 })
	done := true
	o.must(200, "PATCH", "/api/checklist-items/"+it.GetId(), &v1.UpdateTaskChecklistItemRequest{Done: &done}, nil)
	ev = gb.wait("toggle", func(e *v1.DispatchEvent) bool { return e.GetTaskChecklistUpdate().GetChecklistDone() == 1 })
	if u := ev.GetTaskChecklistUpdate(); u.GetChecklistTotal() != 1 || !u.GetChecklist().GetItems()[0].GetDone() {
		t.Fatalf("toggle event: %v", u)
	}
	// A toggle sends no TASK_UPDATE.
	gb.quiet("TASK_UPDATE on a toggle", 400*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetTaskUpdate() != nil })

	o.must(200, "DELETE", "/api/checklists/"+cl.GetId(), nil, nil)
	ev = gb.wait("TASK_CHECKLIST_DELETE", func(e *v1.DispatchEvent) bool { return e.GetTaskChecklistDelete() != nil })
	if d := ev.GetTaskChecklistDelete(); d.GetChecklistId() != cl.GetId() || d.GetChecklistTotal() != 0 || d.GetTaskId() != task.GetId() {
		t.Fatalf("delete event: %v", d)
	}
	// The one who cannot see the board gets none of it.
	gc.quiet("checklist events for a user without the board", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetTaskChecklistUpdate() != nil || e.GetTaskChecklistDelete() != nil
	})
}
