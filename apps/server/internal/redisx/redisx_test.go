package redisx

import (
	"testing"

	"github.com/redis/rueidis"
)

func TestVersion(t *testing.T) {
	info := "# Server\r\nredis_version:7.4.11\r\nredis_mode:standalone\r\n"
	if v := infoField(info, "redis_version"); v != "7.4.11" {
		t.Fatalf("parsed %q", v)
	}
	valkey := "# Server\r\nredis_version:7.2.4\r\nserver_name:valkey\r\nvalkey_version:9.1.2\r\n"
	for info, ok := range map[string]bool{
		info:   true, // Redis 7.4
		valkey: true, // Valkey 9 (its redis_version 7.2.4 must not decide)
		"# Server\r\nredis_version:7.2.4\r\nvalkey_version:8.1.1\r\n": false, // Valkey 8: no HEXPIRE
		"# Server\r\nredis_version:7.2.7\r\n":                         false,
	} {
		if err := checkVersion(info); (err == nil) != ok {
			t.Errorf("%q: err %v", info, err)
		}
	}
	if got := redactURL("redis://:s3cret@127.0.0.1:6379/0"); got != "redis://:xxxxx@127.0.0.1:6379/0" {
		t.Errorf("redacted: %s", got)
	}
	for v, want := range map[string]bool{"7.4.0": true, "7.4.11": true, "8.0.1": true, "7.2.7": false, "6.2": false, "": false, "x.y": false} {
		if atLeast(v, 7, 4) != want {
			t.Errorf("%q: want %v", v, want)
		}
	}
}

func TestParseURLWithPassword(t *testing.T) {
	for raw, want := range map[string][3]string{
		"redis://:s3cr%40t@127.0.0.1:6379/0": {"", "s3cr@t", "127.0.0.1:6379"},
		"redis://calaba:pw@127.0.0.1:6379/2": {"calaba", "pw", "127.0.0.1:6379"},
		"redis://127.0.0.1:6379":             {"", "", "127.0.0.1:6379"},
	} {
		opt, err := rueidis.ParseURL(raw)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if opt.Username != want[0] || opt.Password != want[1] || len(opt.InitAddress) != 1 || opt.InitAddress[0] != want[2] {
			t.Errorf("%s: user=%q pass=%q addr=%v", raw, opt.Username, opt.Password, opt.InitAddress)
		}
	}
}
