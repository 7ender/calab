package redisx

import (
	"strings"
	"sync/atomic"
)

// The key namespace (REDIS_KEY_PREFIX, docs/06 «Общий Valkey»). Every key the API reads or
// writes is built by Key and every pub/sub channel it uses by Channel — including the KEYS of
// Lua scripts, which never build key names themselves — so one Valkey can be shared with
// other applications under an ACL user limited to ~<prefix>* and &<prefix>*. A key or channel
// name written without these helpers is a bug: it escapes the namespace.
var keyPrefix atomic.Pointer[string]

// SetKeyPrefix sets the namespace. It is process-wide configuration (every instance of a
// deployment must use the same one), set once at startup (app.New) before the first name is
// built. p is validated by config (REDIS_KEY_PREFIX): letters, digits, '.', '_', '-', ':' and
// a final ':', so it is never a glob pattern. "" (the default) keeps the historical names.
func SetKeyPrefix(p string) { keyPrefix.Store(&p) }

// KeyPrefix returns the namespace ("" = none).
func KeyPrefix() string {
	if p := keyPrefix.Load(); p != nil {
		return *p
	}
	return ""
}

// Key is the full name of a Valkey key.
func Key(name string) string { return KeyPrefix() + name }

// Channel is the full name of a pub/sub channel (or of a PSUBSCRIBE pattern).
func Channel(name string) string { return KeyPrefix() + name }

// ChannelName returns the name of the channel a message arrived on without the namespace;
// ok=false for a channel outside it.
func ChannelName(channel string) (name string, ok bool) {
	return strings.CutPrefix(channel, KeyPrefix())
}
