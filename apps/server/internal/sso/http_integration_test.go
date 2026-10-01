//go:build integration

package sso

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestSSOHTTPBrowserBindingsAndDependencyFailure(t *testing.T) {
	f := newServiceFixture(t)
	f.activate(t)
	h := &HTTP{Service: f.s, Deps: HTTPDeps{
		Principal: func(_ *http.Request, optional bool) (identitypolicy.Principal, error) {
			if optional {
				return identitypolicy.Principal{}, nil
			}
			return f.p, nil
		},
		RateLimit: func(context.Context, string, int) (time.Duration, error) { return 0, nil },
		WriteResult: func(w http.ResponseWriter, _ *http.Request, r Result) {
			writeProto(w, &pb.SSOCompleteResponse{Tokens: r.Tokens, Assurance: r.Assurance, Tested: r.Tested})
		},
	}}
	mux := http.NewServeMux()
	h.Routes(mux)
	request := func(method, path, origin string, body proto.Message, cookie *http.Cookie) *httptest.ResponseRecorder {
		var raw []byte
		if body != nil {
			var err error
			raw, err = protojson.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequestWithContext(context.Background(), method, path, strings.NewReader(string(raw)))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	path := "/api/auth/sso/workspaces/" + f.ws.String() + "/begin"
	beginReq := &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB}
	if w := request("POST", path, "https://attacker.test", beginReq, nil); w.Code < 400 {
		t.Fatal("cross-origin initiation accepted")
	}
	w := request("POST", path, f.s.Protocol.Origin, beginReq, nil)
	if w.Code != 200 {
		t.Fatalf("begin %d %s", w.Code, w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Path != "/" {
		t.Fatal("unsafe transaction cookie")
	}
	var begin pb.SSOBeginResponse
	if err := protojson.Unmarshal(w.Body.Bytes(), &begin); err != nil {
		t.Fatal(err)
	}
	code, state := f.idp.code(t, begin.AuthorizationUrl, "owner-subject", nil)
	callback := "/api/auth/sso/callback/" + f.connection.String() + "?code=" + url.QueryEscape(code) + "&state=" + url.QueryEscape(state)
	if w = request("GET", callback, "", nil, nil); w.Code < 400 {
		t.Fatal("missing browser binding accepted")
	}
	w = request("GET", callback, "", nil, cookies[0])
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/sso/complete" || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("unsafe completion redirect")
	}
	finish := &pb.SSOFinishRequest{FlowId: begin.FlowId}
	if w = request("POST", "/api/auth/sso/finish", "https://attacker.test", finish, cookies[0]); w.Code < 400 {
		t.Fatal("cross-origin finish accepted")
	}
	if w = request("POST", "/api/auth/sso/finish", f.s.Protocol.Origin, finish, nil); w.Code < 400 {
		t.Fatal("unbound finish accepted")
	}
	w = request("POST", "/api/auth/sso/finish", f.s.Protocol.Origin, finish, cookies[0])
	if w.Code != 200 {
		t.Fatalf("finish %d %s", w.Code, w.Body.String())
	}
	var out pb.SSOCompleteResponse
	if err := protojson.Unmarshal(w.Body.Bytes(), &out); err != nil || out.Tokens == nil || out.Assurance == nil || out.Tested {
		t.Fatal("completion contract lost authority/proof")
	}
	if w = request("POST", "/api/auth/sso/finish", f.s.Protocol.Origin, finish, cookies[0]); w.Code < 400 {
		t.Fatal("HTTP replay accepted")
	}
	h.Deps.RateLimit = func(context.Context, string, int) (time.Duration, error) { return 0, ErrDenied }
	if w = request("POST", path, f.s.Protocol.Origin, beginReq, nil); w.Code < 400 {
		t.Fatal("quota dependency failure permitted issuance")
	}
}
