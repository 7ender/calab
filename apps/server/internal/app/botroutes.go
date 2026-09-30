package app

import (
	"net/http"

	"github.com/calaba/calaba/server/internal/auth"
)

// botAccess says whether a bot token (ADR-0031) may call a route.
type botAccess int

const (
	// botPublic: no authentication; a bot is anonymous there. Public handlers that
	// authenticate themselves (logout, room links) refuse bot tokens (auth.Authenticate).
	botPublic botAccess = iota + 1
	// botAllow: bots use the route like people, within the rights of their roles.
	botAllow
	// botDeny: people only — 403 FORBIDDEN, reason BOT_NOT_ALLOWED (auth.NoBots).
	botDeny
)

// botRoutes classifies every route of the server for bots (ADR-0031 §2: bots have no
// password, email, sessions or devices, do not create workspaces, invite, pay or administer
// the product, and change only their name, avatar and description). Every pattern New
// registers must be listed: TestBotRouteTable fails on an unlisted route, so a new route
// needs an explicit decision; an unlisted pattern is denied to bots at run time.
var botRoutes = map[string]botAccess{
	// outside /api and public
	"GET /healthz":                                         botPublic,
	"GET /readyz":                                          botPublic,
	"GET /metrics":                                         botPublic,
	"GET /gateway":                                         botPublic, // IDENTIFY with the bot token
	"GET /api/version":                                     botPublic,
	"/api/":                                                botPublic, // 404 for unknown API paths
	"POST /api/auth/register":                              botPublic,
	"POST /api/auth/login":                                 botPublic,
	"POST /api/auth/refresh":                               botPublic,
	"POST /api/auth/logout":                                botPublic,
	"POST /api/auth/password/forgot":                       botPublic,
	"POST /api/auth/password/reset":                        botPublic,
	"GET /api/invites/{code}":                              botPublic,
	"GET /api/room-invites/{code}":                         botPublic,
	"POST /api/room-invites/{code}/join":                   botPublic, // refuses bot tokens: no guest links for bots
	"POST /api/rtc/webhook":                                botPublic, // LiveKit only (signed)
	"GET /api/me/sessions":                                 botDeny,
	"DELETE /api/me/sessions/{id}":                         botDeny,
	"PATCH /api/me/password":                               botDeny,
	"PATCH /api/me/email":                                  botDeny,
	"POST /api/auth/verify/send":                           botDeny,
	"POST /api/auth/verify":                                botDeny,
	"GET /api/me":                                          botAllow,
	"PATCH /api/me":                                        botAllow, // display name and avatar only (users.update)
	"PATCH /api/me/status":                                 botDeny,
	"POST /api/me/avatar":                                  botAllow,
	"GET /api/users/{id}/note":                             botDeny,
	"PUT /api/users/{id}/note":                             botDeny,
	"DELETE /api/users/{id}/note":                          botDeny,
	"GET /api/me/mentions":                                 botAllow,
	"GET /api/me/blocked-bots":                             botDeny,
	"POST /api/me/blocked-bots/{id}":                       botDeny,
	"DELETE /api/me/blocked-bots/{id}":                     botDeny,
	"POST /api/workspaces":                                 botDeny,
	"GET /api/workspaces":                                  botAllow,
	"GET /api/workspaces/discover":                         botDeny,
	"GET /api/workspaces/{id}":                             botAllow,
	"PATCH /api/workspaces/{id}":                           botAllow, // MANAGE_WORKSPACE, if a role gives it
	"DELETE /api/workspaces/{id}":                          botDeny,  // owner only; a bot is never the owner
	"POST /api/workspaces/{id}/join":                       botDeny,
	"PUT /api/workspaces/{id}/notifications":               botDeny,
	"GET /api/workspaces/{id}/invites":                     botDeny,
	"POST /api/workspaces/{id}/invites":                    botDeny,
	"DELETE /api/workspaces/{id}/invites/{inviteId}":       botDeny,
	"POST /api/invites/{code}/join":                        botDeny,
	"POST /api/workspaces/{id}/invites/lookup":             botDeny,
	"POST /api/workspaces/{id}/members":                    botDeny,
	"POST /api/workspaces/{id}/invites/email":              botDeny,
	"GET /api/workspaces/{id}/invites/email":               botDeny,
	"DELETE /api/workspaces/{id}/invites/email/{inviteId}": botDeny,
	"GET /api/workspaces/{id}/members":                     botAllow,
	"GET /api/workspaces/{id}/birthdays":                   botAllow, // docs/09 #76
	"GET /api/workspaces/{id}/members/birthdays":           botDeny,  // docs/09 #77: bots have no birthday
	"PATCH /api/workspaces/{id}/members/{userId}/birthday": botDeny,
	"GET /api/workspaces/{id}/badges":                      botAllow, // docs/09 #82: the library, read-only
	"POST /api/workspaces/{id}/badges":                     botDeny,
	"PATCH /api/workspaces/{id}/badges/{badgeId}":          botDeny,
	"DELETE /api/workspaces/{id}/badges/{badgeId}":         botDeny,
	"PUT /api/workspaces/{id}/members/{userId}/badge":      botDeny,
	"GET /api/workspaces/{id}/backgrounds":                 botDeny, // ADR-0035: bots have no camera
	"POST /api/workspaces/{id}/backgrounds":                botDeny,
	"PATCH /api/workspaces/{id}/backgrounds/{bgId}":        botDeny,
	"DELETE /api/workspaces/{id}/backgrounds/{bgId}":       botDeny,
	"GET /api/workspaces/{id}/sounds":                      botAllow, // ADR-0036: a bot in a call may play sounds
	"POST /api/workspaces/{id}/sounds":                     botDeny,  // the library is managed by people
	"PATCH /api/workspaces/{id}/sounds/{soundId}":          botDeny,
	"DELETE /api/workspaces/{id}/sounds/{soundId}":         botDeny,
	"PATCH /api/workspaces/{id}/members/{userId}":          botAllow,
	"DELETE /api/workspaces/{id}/members/{userId}":         botAllow,
	"POST /api/workspaces/{id}/members/{userId}/promote":   botAllow,
	"PUT /api/workspaces/{id}/members/{userId}/roles":      botAllow,
	"GET /api/workspaces/{id}/roles":                       botAllow,
	"POST /api/workspaces/{id}/roles":                      botAllow,
	"PATCH /api/workspaces/{id}/roles/{roleId}":            botAllow,
	"DELETE /api/workspaces/{id}/roles/{roleId}":           botAllow,
	"PUT /api/workspaces/{id}/roles/order":                 botAllow,
	"GET /api/workspaces/{id}/bans":                        botAllow,
	"POST /api/workspaces/{id}/bans":                       botAllow,
	"DELETE /api/workspaces/{id}/bans/{userId}":            botAllow,
	"POST /api/workspaces/{id}/rooms":                      botAllow,
	"GET /api/workspaces/{id}/rooms":                       botAllow,
	"POST /api/workspaces/{id}/rooms/temp":                 botAllow, // ADR-0044: CREATE_TEMP_ROOMS; members-only link, no meeting
	"GET /api/rooms/{id}":                                  botAllow,
	"PATCH /api/rooms/{id}":                                botAllow,
	"DELETE /api/rooms/{id}":                               botAllow,
	"PUT /api/rooms/{id}/permissions":                      botAllow,
	"PUT /api/rooms/{id}/notifications":                    botDeny,
	"GET /api/workspaces/{id}/categories":                  botAllow,
	"POST /api/workspaces/{id}/categories":                 botAllow,
	"PATCH /api/categories/{id}":                           botAllow,
	"DELETE /api/categories/{id}":                          botAllow,
	"PUT /api/workspaces/{id}/rooms/order":                 botAllow,
	// messages
	"GET /api/rooms/{id}/messages":                botAllow,
	"GET /api/rooms/{id}/messages/{messageId}":    botAllow,
	"POST /api/rooms/{id}/messages":               botAllow,
	"POST /api/rooms/{id}/messages/{mid}/forward": botAllow, // ADR-0033
	"PATCH /api/messages/{id}":                    botAllow,
	"DELETE /api/messages/{id}":                   botAllow,
	"PUT /api/rooms/{id}/read":                    botAllow,
	"GET /api/workspaces/{id}/messages/search":    botAllow,
	"PUT /api/messages/{id}/reactions/{emoji}":    botAllow,
	"DELETE /api/messages/{id}/reactions/{emoji}": botAllow,
	"PUT /api/messages/{id}/pin":                  botAllow,
	"DELETE /api/messages/{id}/pin":               botAllow,
	"GET /api/rooms/{id}/pins":                    botAllow,
	"PUT /api/messages/{id}/embeds-hidden":        botAllow,
	// DMs: a bot writes to members of shared workspaces (unless blocked)
	"POST /api/dms":             botAllow,
	"GET /api/dms":              botAllow,
	"GET /api/dms/candidates":   botAllow,
	"PATCH /api/dms/{id}/state": botDeny,
	"POST /api/dms/{id}/files":  botAllow,
	// notes shelves (ADR-0039 §3): people only
	"GET /api/notes":         botDeny,
	"POST /api/notes":        botDeny,
	"PATCH /api/notes/{id}":  botDeny,
	"DELETE /api/notes/{id}": botDeny,
	// one-to-one calls (ADR-0034 §7): bots neither call nor answer
	"POST /api/dms/{id}/call":         botDeny,
	"POST /api/calls/{id}/accept":     botDeny,
	"POST /api/calls/{id}/decline":    botDeny,
	"POST /api/calls/{id}/cancel":     botDeny,
	"POST /api/calls/{id}/hangup":     botDeny,
	"POST /api/workspaces/{id}/files": botAllow,
	"GET /api/files/{id}":             botAllow,
	"GET /api/files/{id}/thumbnail":   botAllow,
	// HEIC → JPEG helper for clients without a HEIF decoder (docs/02): not part of the bot API
	"POST /api/files/convert": botDeny,
	// stickers (ADR-0030, ADR-0031 §3): a bot sends stickers, installs packs for itself and,
	// with MANAGE_STICKERS, manages the packs of the workspace (the handlers check the right)
	"GET /api/workspaces/{id}/sticker-packs":     botAllow,
	"POST /api/workspaces/{id}/sticker-packs":    botAllow,
	"GET /api/sticker-packs/{id}":                botAllow,
	"PATCH /api/sticker-packs/{id}":              botAllow,
	"DELETE /api/sticker-packs/{id}":             botAllow,
	"POST /api/sticker-packs/{id}/stickers":      botAllow,
	"PUT /api/sticker-packs/{id}/stickers/{sid}": botAllow, // replace a sticker (MANAGE_STICKERS checked by the handler)
	"PATCH /api/stickers/{id}":                   botAllow,
	"DELETE /api/stickers/{id}":                  botAllow,
	"GET /api/me/sticker-packs":                  botAllow,
	"PUT /api/me/sticker-packs/order":            botAllow,
	"PUT /api/me/sticker-packs/{id}":             botAllow,
	"DELETE /api/me/sticker-packs/{id}":          botAllow,
	// room links for guests: never for bots
	"POST /api/rooms/{id}/invites":              botDeny,
	"GET /api/rooms/{id}/invites":               botDeny,
	"DELETE /api/rooms/{id}/invites/{inviteId}": botDeny,
	"PATCH /api/rooms/{id}/invites/{inviteId}":  botDeny,
	// Guest admission (ADR-0040): bots may read the waiting list, not decide.
	"GET /api/rooms/{id}/admissions":           botAllow,
	"POST /api/rooms/{id}/admissions/{userId}": botDeny,
	"DELETE /api/rooms/{id}/admissions/me":     botDeny,
	// superadmin, link previews, meeting recording
	"GET /api/admin/workspaces":                         botDeny,
	"GET /api/admin/workspaces/{id}":                    botDeny,
	"PUT /api/admin/workspaces/{id}/plan":               botDeny,
	"GET /api/admin/workspaces/{id}/plan/log":           botDeny,
	"PUT /api/admin/workspaces/{id}/suspension":         botDeny,
	"GET /api/admin/users/{id}/storage-quota":           botDeny,
	"PUT /api/admin/users/{id}/storage-quota":           botDeny,
	"GET /api/unfurl":                                   botDeny,
	"GET /api/unfurl/image":                             botDeny,
	"GET /api/workspaces/{id}/integrations/gptunnel":    botDeny,
	"POST /api/workspaces/{id}/integrations/gptunnel":   botDeny,
	"DELETE /api/workspaces/{id}/integrations/gptunnel": botDeny,
	"POST /api/rooms/{id}/recording/start":              botDeny,
	"POST /api/rooms/{id}/recording/stop":               botDeny,
	"POST /api/rooms/{id}/recordings/{rid}/recheck":     botDeny,
	"POST /api/rooms/{id}/recordings/{rid}/reupload":    botDeny,
	"GET /api/rooms/{id}/recordings/{rid}/transcript":   botAllow,
	"DELETE /api/rooms/{id}/recordings/{rid}":           botDeny,
	// voice: a bot joins, listens and speaks through LiveKit like a person (ADR-0031 §5)
	"POST /api/rooms/{id}/join":                        botAllow,
	"POST /api/rooms/{id}/voice/leave":                 botAllow,
	"POST /api/rooms/{id}/stream/request":              botAllow,
	"POST /api/rooms/{id}/camera/request":              botAllow,
	"POST /api/rooms/{id}/camera/stop":                 botAllow,
	"POST /api/rooms/{id}/voice/{userId}/stop-camera":  botAllow,
	"POST /api/rooms/{id}/voice/{userId}/allow-camera": botAllow,
	"PATCH /api/voice/self":                            botAllow,
	"PATCH /api/rooms/{id}/voice-status":               botAllow,
	"POST /api/rooms/{id}/voice/{userId}/mute":         botAllow,
	"POST /api/rooms/{id}/voice/{userId}/unmute":       botAllow,
	"POST /api/rooms/{id}/voice/{userId}/disconnect":   botAllow,
	"POST /api/rooms/{id}/voice/{userId}/stop-stream":  botAllow,
	"POST /api/rooms/{id}/voice/{userId}/move":         botAllow,
	"POST /api/rooms/{id}/sounds/play":                 botAllow, // ADR-0036, a bot in the call
	// bots: management is for people; /api/bots/me is for bots (the handlers check that)
	"POST /api/workspaces/{id}/bots":                  botDeny,
	"GET /api/workspaces/{id}/bots":                   botDeny,
	"POST /api/workspaces/{id}/bots/add":              botDeny,
	"DELETE /api/workspaces/{id}/bots/{botId}":        botDeny,
	"POST /api/workspaces/{id}/bots/{botId}/token":    botDeny,
	"DELETE /api/workspaces/{id}/bots/{botId}/token":  botDeny,
	"POST /api/workspaces/{id}/bots/{botId}/avatar":   botDeny,
	"DELETE /api/workspaces/{id}/bots/{botId}/avatar": botDeny,
	"GET /api/bots/{ref}":                             botDeny,
	"GET /api/bots/me":                                botAllow,
	"PATCH /api/bots/me":                              botAllow,
	"PUT /api/bots/me/commands":                       botAllow,
	"GET /api/bots/me/webhook":                        botAllow,
	"PUT /api/bots/me/webhook":                        botAllow,
	"DELETE /api/bots/me/webhook":                     botAllow,
	"GET /api/rooms/{id}/bot-commands":                botAllow,
	// calendar (ADR-0038): bots read meetings (no external addresses), people change them
	"GET /api/workspaces/{id}/events":            botAllow,
	"POST /api/workspaces/{id}/events":           botDeny,
	"GET /api/events/{id}":                       botAllow,
	"PATCH /api/events/{id}":                     botDeny,
	"DELETE /api/events/{id}":                    botDeny,
	"PUT /api/events/{id}/rsvp":                  botDeny, // bots are never attendees
	"GET /api/me/events/today":                   botDeny,
	"GET /api/workspaces/{id}/freebusy":          botDeny, // ADR-0041 §5: people only
	"POST /api/workspaces/{id}/freebusy/suggest": botDeny,
	"GET /api/me/caldav":                         botDeny,
	"POST /api/me/caldav":                        botDeny,
	"PUT /api/me/caldav":                         botDeny,
	"DELETE /api/me/caldav":                      botDeny,
	"POST /api/me/caldav/sync":                   botDeny,
	"GET /api/event-rsvp":                        botPublic, // signed answer links of external attendees; refuses bot tokens
	"POST /api/event-rsvp":                       botPublic,
	// task boards (ADR-0042 §3): bots work like people within their board bits; access and the
	// final delete (DELETE ?purge=1, refused by the handler) are for people
	"GET /api/workspaces/{id}/boards":          botAllow,
	"POST /api/workspaces/{id}/boards":         botAllow,
	"GET /api/boards/{id}":                     botAllow,
	"PATCH /api/boards/{id}":                   botAllow,
	"DELETE /api/boards/{id}":                  botAllow,
	"POST /api/boards/{id}/restore":            botAllow,
	"PUT /api/boards/{id}/position":            botAllow,
	"GET /api/boards/{id}/permissions":         botAllow,
	"PUT /api/boards/{id}/permissions":         botDeny,
	"POST /api/boards/{id}/statuses":           botAllow,
	"PATCH /api/boards/{id}/statuses/{sid}":    botAllow,
	"DELETE /api/boards/{id}/statuses/{sid}":   botAllow,
	"POST /api/boards/{id}/labels":             botAllow,
	"PATCH /api/boards/{id}/labels/{sid}":      botAllow,
	"DELETE /api/boards/{id}/labels/{sid}":     botAllow,
	"POST /api/boards/{id}/milestones":         botAllow,
	"PATCH /api/boards/{id}/milestones/{sid}":  botAllow,
	"DELETE /api/boards/{id}/milestones/{sid}": botAllow,
	"GET /api/boards/{id}/views":               botAllow,
	"POST /api/boards/{id}/views":              botAllow,
	"PATCH /api/boards/{id}/views/{sid}":       botAllow,
	"DELETE /api/boards/{id}/views/{sid}":      botAllow,
	"POST /api/boards/{id}/files":              botAllow,
	"GET /api/boards/{id}/activity":            botAllow,
	"GET /api/boards/{id}/tasks":               botAllow,
	"POST /api/boards/{id}/tasks":              botAllow,
	"GET /api/tasks/{id}":                      botAllow,
	"PATCH /api/tasks/{id}":                    botAllow,
	"POST /api/tasks/{id}/archive":             botAllow,
	"POST /api/tasks/{id}/restore":             botAllow,
	"PUT /api/tasks/{id}/assignees":            botAllow,
	"PUT /api/tasks/{id}/relations":            botAllow,
	"DELETE /api/tasks/{id}/relations":         botAllow,
	"PUT /api/tasks/{id}/subscription":         botAllow,
	"PUT /api/tasks/{id}/read":                 botAllow,
	"GET /api/tasks/{id}/activity":             botAllow,
	"GET /api/t/{key}":                         botAllow,
	"GET /api/me/tasks":                        botAllow,
	"GET /api/workspaces/{id}/tasks/search":    botAllow,
}

// botGate lets bot identities through only on botAllow routes (by the matched pattern).
// It runs inside auth.Require.
func botGate(next http.Handler) http.Handler {
	deny := auth.NoBots(next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if botRoutes[r.Pattern] == botAllow {
			next.ServeHTTP(w, r)
			return
		}
		deny.ServeHTTP(w, r)
	})
}

// routeRecorder records every pattern registered on the mux (App.Routes).
type routeRecorder struct {
	*http.ServeMux
	patterns []string
}

func (m *routeRecorder) Handle(pattern string, h http.Handler) {
	m.patterns = append(m.patterns, pattern)
	m.ServeMux.Handle(pattern, h)
}

func (m *routeRecorder) HandleFunc(pattern string, f func(http.ResponseWriter, *http.Request)) {
	m.patterns = append(m.patterns, pattern)
	m.ServeMux.HandleFunc(pattern, f)
}

// BotRouteAccess reports how bots may use a registered route: "public", "allow", "deny" or ""
// (unlisted — denied at run time; tests fail on it).
func BotRouteAccess(pattern string) string {
	switch botRoutes[pattern] {
	case botPublic:
		return "public"
	case botAllow:
		return "allow"
	case botDeny:
		return "deny"
	}
	return ""
}

// BotRoutePatterns lists the patterns of the table (tests: no stale entries).
func BotRoutePatterns() []string {
	out := make([]string, 0, len(botRoutes))
	for p := range botRoutes {
		out = append(out, p)
	}
	return out
}
