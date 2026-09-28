package redisx

import "testing"

func TestKeyNamespace(t *testing.T) {
	t.Cleanup(func() { SetKeyPrefix("") })

	// No namespace: the historical names, byte for byte.
	if KeyPrefix() != "" || Key("voice:ws:1") != "voice:ws:1" || Channel("ws:1") != "ws:1" {
		t.Fatalf("default namespace: %q %q %q", KeyPrefix(), Key("voice:ws:1"), Channel("ws:1"))
	}
	if n, ok := ChannelName("gw:ctl:a"); !ok || n != "gw:ctl:a" {
		t.Fatalf("default channel name: %q %v", n, ok)
	}

	SetKeyPrefix("calab:")
	if Key("voice:ws:1") != "calab:voice:ws:1" || Channel("ws:1") != "calab:ws:1" || Channel("*") != "calab:*" {
		t.Fatalf("namespaced: %q %q %q", Key("voice:ws:1"), Channel("ws:1"), Channel("*"))
	}
	for ch, want := range map[string]string{"calab:ws:1": "ws:1", "calab:gw:ctl:a": "gw:ctl:a", "calab:": ""} {
		if n, ok := ChannelName(ch); !ok || n != want {
			t.Errorf("%q: %q %v, want %q", ch, n, ok, want)
		}
	}
	for _, foreign := range []string{"ws:1", "calabash:ws:1", "other:calab:ws:1", ""} {
		if n, ok := ChannelName(foreign); ok {
			t.Errorf("%q accepted as %q", foreign, n)
		}
	}
}
