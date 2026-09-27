package auth

import (
	"bytes"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestBotTokenFormat(t *testing.T) {
	id := uuid.MustParse("01890000-0000-7000-8000-000000000001")
	tok, hash, prefix, err := NewBotToken(id)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(tok, "calab_bot_"+id.String()+"_") || len(tok) != len("calab_bot_")+36+1+43 {
		t.Fatalf("token form: %q", tok)
	}
	if !IsBotToken(tok) || IsBotToken("eyJhbGciOi") {
		t.Fatal("IsBotToken")
	}
	gotID, secret, ok := ParseBotToken(tok)
	if !ok || gotID != id || !bytes.Equal(HashRefreshSecret(secret), hash) || !strings.HasPrefix(secret, prefix) || len(prefix) != 6 {
		t.Fatalf("parse: %v %v %q", ok, gotID, prefix)
	}
	tok2, hash2, _, _ := NewBotToken(id)
	if tok2 == tok || bytes.Equal(hash, hash2) {
		t.Fatal("tokens are not random")
	}
	for _, bad := range []string{
		"",
		"calab_bot_",
		tok[:len(tok)-1],                  // short secret
		tok + "A",                         // long secret
		strings.Replace(tok, "_", "-", 2), // separator
		"calab_bot_not-a-uuid-not-a-uuid-not-a-uu_" + secret,
		"calab_bot_" + id.String() + "_" + strings.Repeat("!", 43), // not base64url
		"Calab_bot_" + id.String() + "_" + secret,
	} {
		if _, _, ok := ParseBotToken(bad); ok {
			t.Errorf("accepted malformed token %q", bad)
		}
	}
}

func TestBotAuthCacheEncoding(t *testing.T) {
	a := botAuth{tokenID: uuid.New(), hash: HashRefreshSecret("x")}
	got, ok := decodeBotAuth(a.encode())
	if !ok || got.tokenID != a.tokenID || !bytes.Equal(got.hash, a.hash) {
		t.Fatalf("round trip: %v %v", ok, got)
	}
	none, ok := decodeBotAuth(botAuth{}.encode())
	if !ok || none.hash != nil {
		t.Fatal("no token must round-trip as none")
	}
	for _, bad := range []string{"", "x", "x:y", uuid.NewString() + ":abcd"} {
		if _, ok := decodeBotAuth(bad); ok {
			t.Errorf("decoded %q", bad)
		}
	}
}
