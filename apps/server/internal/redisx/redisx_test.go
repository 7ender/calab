package redisx

import "testing"

func TestVersion(t *testing.T) {
	info := "# Server\r\nredis_version:7.4.11\r\nredis_mode:standalone\r\n"
	if v := serverVersion(info); v != "7.4.11" {
		t.Fatalf("parsed %q", v)
	}
	for v, want := range map[string]bool{"7.4.0": true, "7.4.11": true, "8.0.1": true, "7.2.7": false, "6.2": false, "": false, "x.y": false} {
		if atLeast(v, 7, 4) != want {
			t.Errorf("%q: want %v", v, want)
		}
	}
}
