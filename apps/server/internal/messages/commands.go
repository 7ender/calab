package messages

import (
	"context"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// Bot commands (ADR-0031 §6). A message that starts with "/name" or "/name@username" is a
// command: everyone gets it as a plain message, the addressed bot's MESSAGE_CREATE (gateway
// and webhook) carries Message.command.

const (
	maxCommandName = 32
	minUsername    = 3
	maxUsername    = 32
)

func isWordByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_'
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

// ParseCommand parses "/name[@username][ args]" at the very start of content. name is
// 1..32 of [A-Za-z0-9_], username 3..32 of the same (both returned in lower case); the
// command ends at whitespace or the end of the text; args is the rest, trimmed.
func ParseCommand(content string) (name, username, args string, ok bool) {
	if len(content) < 2 || content[0] != '/' {
		return "", "", "", false
	}
	i := 1
	for i < len(content) && isWordByte(content[i]) {
		i++
	}
	if i == 1 || i-1 > maxCommandName {
		return "", "", "", false
	}
	name = strings.ToLower(content[1:i])
	if i < len(content) && content[i] == '@' {
		j := i + 1
		for j < len(content) && isWordByte(content[j]) {
			j++
		}
		if n := j - i - 1; n < minUsername || n > maxUsername {
			return "", "", "", false
		}
		username = strings.ToLower(content[i+1 : j])
		i = j
	}
	if i < len(content) && !isSpace(content[i]) {
		return "", "", "", false
	}
	return name, username, strings.TrimSpace(content[i:]), true
}

// botCandidate is a bot that may receive a command in a room.
type botCandidate struct {
	id       uuid.UUID
	username string
}

// resolveCommand finds the bot a message addresses (nil = not a command, or no single bot):
// "/name@username" → that bot, if it can view the room; "/name" → the only bot of the room
// (VIEW_ROOM) that registered the command. Commands written by bots are not delivered as
// commands (no bot loops). Errors are logged: the message is sent anyway.
func resolveCommand(ctx context.Context, q *sqlc.Queries, acc perm.RoomAccess, roomID, author uuid.UUID, authorIsBot bool, content string) *v1.MessageCommand {
	if authorIsBot {
		return nil
	}
	name, username, args, ok := ParseCommand(content)
	if !ok {
		return nil
	}
	cands, err := commandCandidates(ctx, q, acc, author)
	if err != nil {
		slog.WarnContext(ctx, "bot command: list bots", "err", err)
		return nil
	}
	if len(cands) == 0 {
		return nil
	}
	var picked []uuid.UUID
	if username != "" {
		for _, c := range cands {
			if c.username == username {
				picked = append(picked, c.id)
			}
		}
	} else {
		ids := make([]uuid.UUID, len(cands))
		for i, c := range cands {
			ids[i] = c.id
		}
		cmds, err := q.ListBotCommands(ctx, ids)
		if err != nil {
			slog.WarnContext(ctx, "bot command: list commands", "err", err)
			return nil
		}
		seen := map[uuid.UUID]bool{}
		for _, c := range cmds {
			if c.Name == name && !seen[c.BotUserID] {
				seen[c.BotUserID] = true
				picked = append(picked, c.BotUserID)
			}
		}
	}
	var target uuid.UUID
	res := perm.NewResolver(q)
	for _, id := range picked {
		if !acc.DM {
			a, err := res.Room(ctx, roomID, id)
			if err != nil || !a.Bits.Has(perm.ViewRoom) {
				continue
			}
		}
		if target != uuid.Nil {
			return nil // ambiguous: "/name@username" picks one
		}
		target = id
	}
	if target == uuid.Nil {
		return nil
	}
	return &v1.MessageCommand{BotUserId: target.String(), Name: name, Args: args}
}

// commandCandidates: the live bots of the room's workspace, or the other participant of a DM
// if it is a bot.
func commandCandidates(ctx context.Context, q *sqlc.Queries, acc perm.RoomAccess, author uuid.UUID) ([]botCandidate, error) {
	if !acc.DM {
		rows, err := q.ListWorkspaceBotIDs(ctx, acc.WorkspaceID)
		if err != nil {
			return nil, err
		}
		out := make([]botCandidate, 0, len(rows))
		for _, r := range rows {
			if r.UserID != author {
				out = append(out, botCandidate{id: r.UserID, username: r.Username})
			}
		}
		return out, nil
	}
	for _, u := range acc.Members {
		if u == author {
			continue
		}
		b, err := q.GetBot(ctx, u)
		if db.IsNotFound(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if b.TokenHash == nil {
			return nil, nil
		}
		return []botCandidate{{id: b.UserID, username: b.Username}}, nil
	}
	return nil, nil
}
