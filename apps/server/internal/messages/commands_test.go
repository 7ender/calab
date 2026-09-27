package messages

import "testing"

func TestParseCommand(t *testing.T) {
	for _, c := range []struct {
		in                   string
		name, username, args string
		ok                   bool
	}{
		{"/start", "start", "", "", true},
		{"/Start@Echo_Bot  hello  world ", "start", "echo_bot", "hello  world", true},
		{"/roll 2d6", "roll", "", "2d6", true},
		{"/roll\nline two", "roll", "", "line two", true},
		{"/a_1@abc", "a_1", "abc", "", true},
		{"/x@ab", "", "", "", false},        // username too short
		{"/x@", "", "", "", false},          // empty username
		{"/", "", "", "", false},            // no name
		{"/ start", "", "", "", false},      // space after slash
		{"hello /start", "", "", "", false}, // not at the start
		{" /start", "", "", "", false},      // leading space
		{"/start,", "", "", "", false},      // must end at whitespace
		{"/path/to/file", "", "", "", false},
		{"/привет", "", "", "", false},
		{"/" + string(make([]byte, 33)), "", "", "", false},
		{"/abcdefghijklmnopqrstuvwxyz0123456", "", "", "", false}, // 33 characters
		{"/abcdefghijklmnopqrstuvwxyz012345 x", "abcdefghijklmnopqrstuvwxyz012345", "", "x", true},
	} {
		name, user, args, ok := ParseCommand(c.in)
		if ok != c.ok || name != c.name || user != c.username || args != c.args {
			t.Errorf("ParseCommand(%q) = %q %q %q %v, want %q %q %q %v", c.in, name, user, args, ok, c.name, c.username, c.args, c.ok)
		}
	}
}
