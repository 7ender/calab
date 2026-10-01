package oauthprovider

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestFirstPartyIdentityErrorCodes(t *testing.T) {
	cases := []struct {
		reason   identitypolicy.Reason
		recovery bool
		code     v1.ErrorCode
	}{
		{identitypolicy.SSORequired, false, v1.ErrorCode_ERROR_CODE_SSO_REQUIRED},
		{identitypolicy.RecentAuthRequired, false, v1.ErrorCode_ERROR_CODE_RECENT_AUTH_REQUIRED},
		{identitypolicy.DirectoryStale, false, v1.ErrorCode_ERROR_CODE_DIRECTORY_ACCESS_DENIED},
		{identitypolicy.MembershipSuspended, false, v1.ErrorCode_ERROR_CODE_DIRECTORY_ACCESS_DENIED},
		{identitypolicy.ScopeDenied, false, v1.ErrorCode_ERROR_CODE_IDENTITY_SCOPE_DENIED},
		{identitypolicy.ScopeDenied, true, v1.ErrorCode_ERROR_CODE_RECOVERY_ONLY},
	}
	for _, tc := range cases {
		t.Run(tc.code.String()+string(tc.reason), func(t *testing.T) {
			st := identitypolicy.State{}
			if tc.recovery {
				st.Principal.Authority = identitypolicy.Recovery
			}
			w := httptest.NewRecorder()
			writeAPIError(w, apiIdentityError(st, identitypolicy.Decision{Reason: tc.reason}, identitypolicy.ErrDenied))
			got := &v1.ApiError{}
			if err := protojson.Unmarshal(w.Body.Bytes(), got); err != nil {
				t.Fatal(err)
			}
			if w.Code != http.StatusForbidden || got.Code != tc.code {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
		})
	}
	w := httptest.NewRecorder()
	writeError(w, errors.New("internal database error"))
	if w.Code != 503 || w.Body.String() != "{\"error\":\"server_error\"}\n" {
		t.Fatalf("external error format changed: %d %s", w.Code, w.Body.String())
	}
}
