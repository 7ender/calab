package bots

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestWebhookURLPolicy(t *testing.T) {
	s := &Service{wh: newWebhookWorker(WebhookOptions{})} // production policy: public addresses
	for _, bad := range []string{
		"http://example.com/hook", // https only
		"https://user:pw@example.com/hook",
		"https://10.0.0.1/hook", "https://127.0.0.1:8443/hook", "https://[::1]/hook", "https://169.254.169.254/latest",
		"https://localhost/hook", "https://api.localhost/hook",
		"ftp://example.com", "example.com/hook", "",
	} {
		if _, err := s.checkWebhookURL(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	for _, ok := range []string{"https://example.com/hook", "https://8.8.8.8/x?y=1", "https://bot.example.org:8443/calab"} {
		if _, err := s.checkWebhookURL(ok); err != nil {
			t.Errorf("rejected %q: %v", ok, err)
		}
	}
}

func TestSign(t *testing.T) {
	body := []byte(`{"id":"1"}`)
	m := hmac.New(sha256.New, []byte("secret-secret-16"))
	m.Write(body)
	if got, want := Sign([]byte("secret-secret-16"), body), "sha256="+hex.EncodeToString(m.Sum(nil)); got != want {
		t.Fatalf("Sign = %s, want %s", got, want)
	}
}

func TestBackoff(t *testing.T) {
	for attempt, want := range map[int32]time.Duration{0: time.Minute, 1: 2 * time.Minute, 5: 32 * time.Minute, 6: time.Hour, 60: time.Hour} {
		if got := Backoff(attempt); got != want {
			t.Errorf("Backoff(%d) = %v, want %v", attempt, got, want)
		}
	}
}

func TestForBot(t *testing.T) {
	ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{MessageCreate: &v1.MessageCreate{
		WorkspaceId: "w", Message: &v1.Message{Id: "m", Content: "/roll 2d6", Command: &v1.MessageCommand{BotUserId: "b1", Name: "roll", Args: "2d6"}},
	}}}
	if ForBot(ev, "b1") != ev {
		t.Fatal("the addressed bot must get the command")
	}
	other := ForBot(ev, "b2")
	if other.GetMessageCreate().GetMessage().GetCommand() != nil || other.GetMessageCreate().GetMessage().GetContent() != "/roll 2d6" ||
		other.GetMessageCreate().GetWorkspaceId() != "w" {
		t.Fatalf("other bots get the plain message: %v", other)
	}
	if ev.GetMessageCreate().GetMessage().GetCommand() == nil {
		t.Fatal("ForBot modified the event")
	}
	plain := &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageDelete{MessageDelete: &v1.MessageDelete{MessageId: "m"}}}
	if ForBot(plain, "b1") != plain {
		t.Fatal("events without a command pass unchanged")
	}
}
