package files

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestLimitHash(t *testing.T) {
	data := strings.Repeat("abc", 1000)
	l := &limitHash{r: strings.NewReader(data), h: sha256.New(), limit: int64(len(data))}
	if _, err := io.Copy(io.Discard, l); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(data))
	if l.n != int64(len(data)) || hex.EncodeToString(l.h.Sum(nil)) != hex.EncodeToString(sum[:]) {
		t.Fatal("count or hash mismatch")
	}
	l = &limitHash{r: strings.NewReader(data), h: sha256.New(), limit: int64(len(data)) - 1}
	if _, err := io.Copy(io.Discard, l); !errors.Is(err, errTooLarge) {
		t.Fatalf("over limit: %v", err)
	}
}

func TestDetectMime(t *testing.T) {
	png := "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
	for _, c := range []struct{ head, declared, want string }{
		{png, "text/plain", "image/png"},                         // sniffing wins
		{"hello world", "text/csv", "text/csv"},                  // inconclusive sniff: declared kept
		{"hello world", "image/png", "text/plain"},               // cannot claim an image
		{"hello world", "text/html", "text/plain"},               // no active content
		{"<svg xmlns='x'></svg>", "image/svg+xml", "text/plain"}, // svg is never an image
		{"\x00\x01\x02", "application/zip", "application/zip"},
		{"\x00\x01\x02", "", "application/octet-stream"},
	} {
		if got := DetectMime([]byte(c.head), c.declared); got != c.want {
			t.Errorf("%q/%q: got %q want %q", c.head, c.declared, got, c.want)
		}
	}
}

func TestSanitizeName(t *testing.T) {
	for in, want := range map[string]string{
		"a.txt": "a.txt", "../../etc/passwd": "passwd", `C:\\Users\\x\\doc.pdf`: "doc.pdf",
		"": "file", "bad\x00name\n.txt": "badname.txt", " spaced ": "spaced",
	} {
		if got := SanitizeName(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
	if n := SanitizeName(strings.Repeat("я", 300)); len(n) > 255 || !strings.HasPrefix(n, "я") {
		t.Errorf("long name: %d bytes", len(n))
	}
}
