package mail

// Meeting mails (ADR-0038 §4): the same details and answer buttons in all three templates; the
// cancellation has no answers and no guest link. Placeholders: {{.title}}, {{.date}},
// {{.organizer}}; the rows and buttons come from their params (see TemplateEventInvite).
type eventLabels struct {
	When, Room, Repeat, Organizer, Attendees string
	Accept, Decline, Maybe, Guest, Open      string
	InviteSubject, UpdateSubject, CancelSubj string
	InviteLine, UpdateLine, CancelLine       string
	InviteNote, CancelNote                   string
}

func eventTexts(l eventLabels) map[Template]texts {
	details := []detail{{l.When, "when"}, {l.Repeat, "repeat"}, {l.Room, "room"}, {l.Organizer, "organizer"}, {l.Attendees, "attendees"}}
	answers := []action{{l.Accept, "rsvp_accept"}, {l.Maybe, "rsvp_maybe"}, {l.Decline, "rsvp_decline"}, {l.Guest, "guest_url"}}
	return map[Template]texts{
		TemplateEventInvite: {Subject: l.InviteSubject, Title: "{{.title}}", Line: l.InviteLine, Button: l.Open,
			Note: l.InviteNote, Details: details, Actions: answers},
		TemplateEventUpdate: {Subject: l.UpdateSubject, Title: "{{.title}}", Line: l.UpdateLine, Button: l.Open,
			Note: l.InviteNote, Details: details, Actions: answers},
		TemplateEventCancel: {Subject: l.CancelSubj, Title: "{{.title}}", Line: l.CancelLine, Button: l.Open,
			Note: l.CancelNote, Details: details},
	}
}

var eventDict = map[string]eventLabels{
	LocaleEN: {
		When: "When", Room: "Room", Repeat: "Repeats", Organizer: "Organizer", Attendees: "Attendees",
		Accept: "Accept", Decline: "Decline", Maybe: "Maybe", Guest: "Join as a guest", Open: "Open the meeting",
		InviteSubject: "Meeting: {{.title}} — {{.date}}", UpdateSubject: "Meeting changed: {{.title}} — {{.date}}",
		CancelSubj: "Meeting cancelled: {{.title}} — {{.date}}",
		InviteLine: "{{.organizer}} invites you to a meeting in Calab.", UpdateLine: "{{.organizer}} changed the meeting.",
		CancelLine: "{{.organizer}} cancelled the meeting.",
		InviteNote: "The attached invite.ics adds the meeting to your calendar. Answers are only informative.",
		CancelNote: "The attached invite.ics removes the meeting from your calendar.",
	},
	LocaleRU: {
		When: "Когда", Room: "Комната", Repeat: "Повтор", Organizer: "Организатор", Attendees: "Участники",
		Accept: "Приму", Decline: "Отклоню", Maybe: "Может быть", Guest: "Войти гостем", Open: "Открыть встречу",
		InviteSubject: "Встреча: {{.title}} — {{.date}}", UpdateSubject: "Встреча изменена: {{.title}} — {{.date}}",
		CancelSubj: "Встреча отменена: {{.title}} — {{.date}}",
		InviteLine: "{{.organizer}} приглашает вас на встречу в Calab.", UpdateLine: "{{.organizer}} изменил(а) встречу.",
		CancelLine: "{{.organizer}} отменил(а) встречу.",
		InviteNote: "Вложение invite.ics добавит встречу в ваш календарь. Ответ — информативный.",
		CancelNote: "Вложение invite.ics уберёт встречу из вашего календаря.",
	},
	LocaleES: {
		When: "Cuándo", Room: "Sala", Repeat: "Se repite", Organizer: "Organizador", Attendees: "Participantes",
		Accept: "Aceptar", Decline: "Rechazar", Maybe: "Quizás", Guest: "Entrar como invitado", Open: "Abrir la reunión",
		InviteSubject: "Reunión: {{.title}} — {{.date}}", UpdateSubject: "Reunión modificada: {{.title}} — {{.date}}",
		CancelSubj: "Reunión cancelada: {{.title}} — {{.date}}",
		InviteLine: "{{.organizer}} te invita a una reunión en Calab.", UpdateLine: "{{.organizer}} modificó la reunión.",
		CancelLine: "{{.organizer}} canceló la reunión.",
		InviteNote: "El archivo invite.ics adjunto añade la reunión a tu calendario. La respuesta es solo informativa.",
		CancelNote: "El archivo invite.ics adjunto quita la reunión de tu calendario.",
	},
	LocaleZhCN: {
		When: "时间", Room: "房间", Repeat: "重复", Organizer: "组织者", Attendees: "参与者",
		Accept: "接受", Decline: "拒绝", Maybe: "待定", Guest: "以访客身份加入", Open: "打开会议",
		InviteSubject: "会议：{{.title}} — {{.date}}", UpdateSubject: "会议已更改：{{.title}} — {{.date}}",
		CancelSubj: "会议已取消：{{.title}} — {{.date}}",
		InviteLine: "{{.organizer}} 邀请你参加 Calab 中的会议。", UpdateLine: "{{.organizer}} 更改了会议。",
		CancelLine: "{{.organizer}} 取消了会议。",
		InviteNote: "附件 invite.ics 可将会议添加到你的日历。答复仅供参考。",
		CancelNote: "附件 invite.ics 会从你的日历中移除该会议。",
	},
}

func init() {
	for loc, l := range eventDict {
		for t, tx := range eventTexts(l) {
			dict[loc][t] = tx
		}
	}
}
