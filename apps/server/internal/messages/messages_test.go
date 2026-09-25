package messages

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestParsePage(t *testing.T) {
	id := uuid.New()
	p, err := ParsePage(httptest.NewRequest("GET", "/?before="+id.String()+"&limit=10", nil)) //nolint:noctx // test
	if err != nil || p.Before == nil || *p.Before != id || p.After != nil || p.Limit != 10 {
		t.Fatalf("%+v %v", p, err)
	}
	if p, _ := ParsePage(httptest.NewRequest("GET", "/", nil)); p.Limit != DefaultLimit || p.Before != nil { //nolint:noctx // test
		t.Fatalf("defaults: %+v", p)
	}
	for _, q := range []string{"limit=0", "limit=101", "limit=x", "before=nope", "before=" + id.String() + "&after=" + id.String()} {
		if _, err := ParsePage(httptest.NewRequest("GET", "/?"+q, nil)); err == nil { //nolint:noctx // test
			t.Errorf("%s accepted", q)
		}
	}
}

func TestValidateContent(t *testing.T) {
	if ValidateContent("hi", 0) != nil || ValidateContent("", 1) != nil || ValidateContent(strings.Repeat("я", 4000), 0) != nil {
		t.Fatal("valid content rejected")
	}
	if ValidateContent("  \n", 0) == nil || ValidateContent(strings.Repeat("a", 4001), 3) == nil {
		t.Fatal("invalid content accepted")
	}
}

func TestParseAttachments(t *testing.T) {
	a, b := uuid.NewString(), uuid.NewString()
	if ids, err := parseAttachments([]string{a, b}); err != nil || len(ids) != 2 {
		t.Fatal(err)
	}
	if _, err := parseAttachments([]string{a, a}); err == nil {
		t.Fatal("duplicate accepted")
	}
	many := make([]string, 21)
	for i := range many {
		many[i] = uuid.NewString()
	}
	if _, err := parseAttachments(many); err == nil {
		t.Fatal("21 attachments accepted")
	}
}
