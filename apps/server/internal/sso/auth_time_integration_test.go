//go:build integration

package sso

import (
	"context"
	"errors"
	"testing"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
)

// A connection test against an IdP that omits auth_time fails with the actionable error and
// leaves an auth_time_missing audit record for the owner.
func TestSSOConnectionTestReportsMissingAuthTime(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	begin, callback := f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LINK, "owner-subject")
	if _, err := f.s.Finish(ctx, callback.FlowID, begin.Browser); err != nil {
		t.Fatal(err)
	}
	test, err := f.s.Begin(ctx, f.p, f.ws, &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_TEST, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_WEB})
	if err != nil {
		t.Fatal(err)
	}
	code, state := f.idp.code(t, test.Response.AuthorizationUrl, "owner-subject", map[string]any{"auth_time": nil})
	if _, err = f.s.Callback(ctx, f.connection, state, test.Browser, code); !errors.Is(err, ErrAuthTimeMissing) {
		t.Fatalf("test without auth_time: %v", err)
	}
	var n int
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM workspace_identity_audit WHERE workspace_id=$1 AND action='auth_time_missing' AND outcome='denied' AND target_id=$2`, f.ws, f.connection).Scan(&n); err != nil || n != 1 {
		t.Fatalf("auth_time_missing audit: %d %v", n, err)
	}
}
