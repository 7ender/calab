package gptunnel_test

import (
	"bytes"
	"context"
	"testing"

	"github.com/calaba/calaba/server/internal/gptunnel"
	"github.com/calaba/calaba/server/internal/gptunnel/gptunneltest"
)

func sp(n int) *int { return &n }

func isCode(err error, code string) bool {
	e, ok := gptunnel.AsError(err)
	return ok && e.Code == code
}

func TestResultAndTranscript(t *testing.T) {
	fake, c, tok := setup(t)
	ctx := context.Background()
	data := blob(1500)
	st, err := c.Upload(ctx, tok, bytes.NewReader(data), req("cid-r", len(data)), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	segs := make([]gptunneltest.Segment, 5)
	for i := range segs {
		segs[i] = gptunneltest.Segment{Speaker: sp(i % 2), Start: float64(i), End: float64(i) + 0.5, Text: "remark"}
	}
	segs[4].Speaker = nil
	fake.Lock()
	fake.Statuses, fake.Summary, fake.Language, fake.Transcript, fake.PageSize = []string{"done"}, "## Темы\n- релиз", "ru", segs, 2
	fake.Unlock()
	// Not done yet: no summary, no transcript (409 not_ready).
	r, err := c.Result(ctx, tok, st.ID)
	if err != nil || r.Summary != nil || r.TranscriptSegments != nil {
		t.Fatalf("result before done: %+v %v", r, err)
	}
	if _, _, err := c.Transcript(ctx, tok, st.ID); !isCode(err, gptunnel.CodeNotReady) {
		t.Fatalf("transcript before done: %v", err)
	}
	if _, err := c.Recording(ctx, tok, st.ID); err != nil { // → done
		t.Fatal(err)
	}
	r, err = c.Result(ctx, tok, st.ID)
	if err != nil || r.Summary == nil || *r.Summary != "## Темы\n- релиз" || r.TranscriptSegments == nil || *r.TranscriptSegments != 5 || *r.Speakers != 2 {
		t.Fatalf("result: %+v %v", r, err)
	}
	lang, got, err := c.Transcript(ctx, tok, st.ID) // 3 pages of 2
	if err != nil || lang != "ru" || len(got) != 5 || got[4].Speaker != nil || *got[3].Speaker != 1 || got[2].Start != 2 {
		t.Fatalf("transcript: %q %+v %v", lang, got, err)
	}
	// An older GPTunneL without the methods: 404 not_found (the recording is fine).
	fake.Lock()
	fake.NoResultAPI = true
	fake.Unlock()
	if _, err := c.Result(ctx, tok, st.ID); !isCode(err, gptunnel.CodeNotFound) {
		t.Fatalf("no result API: %v", err)
	}
	fake.Lock()
	fake.NoResultAPI = false
	fake.Unlock()
	if err := c.DeleteRecording(ctx, tok, st.ID); err != nil || fake.DeleteCalled != 1 {
		t.Fatalf("delete: %v", err)
	}
	if _, err := c.Recording(ctx, tok, st.ID); !isCode(err, gptunnel.CodeNotFound) {
		t.Fatalf("after delete: %v", err)
	}
}

func TestNormalizeWebURL(t *testing.T) {
	for _, tc := range []struct{ in, base, want string }{
		{"https://app.gptunnel.ai/meetings/abc?x=1", "https://gptunnel.ru", "https://gptunnel.ru/meetings/abc?x=1"},
		{"https://gptunnel.ai/meetings/abc", "https://gptunnel.ru/", "https://gptunnel.ru/meetings/abc"},
		{"https://APP.gptunnel.ai/m", "http://gpt.test:8080/base", "http://gpt.test:8080/base/m"},
		{"https://gptunnel.ru/meetings/abc", "https://other.example", "https://gptunnel.ru/meetings/abc"},
		{"https://my.gptunnel.example/m/1", "https://gptunnel.ru", "https://my.gptunnel.example/m/1"},
		{"javascript:alert(1)", "https://gptunnel.ru", ""},
		{"/meetings/abc", "https://gptunnel.ru", ""},
		{"", "https://gptunnel.ru", ""},
		{"https://app.gptunnel.ai/m", "not a url", "https://app.gptunnel.ai/m"},
	} {
		if got := gptunnel.NormalizeWebURL(tc.in, tc.base); got != tc.want {
			t.Errorf("NormalizeWebURL(%q, %q) = %q, want %q", tc.in, tc.base, got, tc.want)
		}
	}
}
