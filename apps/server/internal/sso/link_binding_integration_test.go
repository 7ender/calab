//go:build integration

package sso

import (
	"context"
	"testing"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/identitycrypto"
)

// Account-link CSRF: the native link flow's start URL, minted by the initiator and opened in
// someone else's browser, must not bind that browser's IdP subject to the initiator. The
// identity exists only after the initiating client finishes with its ticket and verifier.
func TestSSOLinkBindsOnlyAfterInitiatorFinishes(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	identities := func() int {
		var n int
		if err := f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM workspace_external_identities WHERE workspace_id=$1 AND subject='victim-subject'`, f.ws).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	verifier, _ := identitycrypto.Secret()
	challenge, _ := identitycrypto.S256(verifier)
	begin, err := f.s.Begin(ctx, f.p, f.ws, &pb.SSOBeginRequest{Purpose: pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LINK, ClientKind: pb.SSOClientKind_SSO_CLIENT_KIND_DESKTOP, DesktopChallenge: challenge})
	if err != nil {
		t.Fatal(err)
	}
	// The victim's browser opens the start URL and signs in at the IdP.
	flow, browser, auth, err := f.s.BrowserStart(ctx, mustURL(begin.Response.BrowserStartUrl).Query().Get("handle"))
	if err != nil {
		t.Fatal(err)
	}
	code, state := f.idp.code(t, auth, "victim-subject", nil)
	cb, err := f.s.Callback(ctx, f.connection, state, browser, code)
	if err != nil || !cb.Native {
		t.Fatalf("callback: %v", err)
	}
	if identities() != 0 {
		t.Fatal("callback linked the browser's subject before the initiator finished")
	}
	// Neither the initiator without the ticket nor the victim's app without the verifier binds it.
	other, _ := identitycrypto.Secret()
	if _, err = f.s.Exchange(ctx, flow, cb.Ticket, other); err == nil {
		t.Fatal("exchange without the initiator's verifier")
	}
	if _, err = f.s.Exchange(ctx, flow, other, verifier); err == nil {
		t.Fatal("exchange without the ticket")
	}
	if identities() != 0 {
		t.Fatal("failed exchange linked the subject")
	}
	// The initiating client with both: linked to the initiator.
	if _, err = f.s.Exchange(ctx, flow, cb.Ticket, verifier); err != nil {
		t.Fatalf("initiator exchange: %v", err)
	}
	var owner string
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT user_id::text FROM workspace_external_identities WHERE workspace_id=$1 AND subject='victim-subject'`, f.ws).Scan(&owner); err != nil || owner != f.user.String() {
		t.Fatalf("link after finish: %v %s", err, owner)
	}

	// Web: the callback alone (correct flow cookie) creates nothing; finish does.
	f = newServiceFixture(t)
	webBegin, webCB := f.web(t, pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LINK, "web-subject")
	var n int
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM workspace_external_identities WHERE workspace_id=$1 AND subject='web-subject'`, f.ws).Scan(&n); err != nil || n != 0 {
		t.Fatalf("web callback linked: %v %d", err, n)
	}
	if _, err = f.s.Finish(ctx, webCB.FlowID, "wrong-browser"); err == nil {
		t.Fatal("finish from another browser")
	}
	if _, err = f.s.Finish(ctx, webCB.FlowID, webBegin.Browser); err != nil {
		t.Fatal(err)
	}
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM workspace_external_identities WHERE workspace_id=$1 AND subject='web-subject'`, f.ws).Scan(&n); err != nil || n != 1 {
		t.Fatalf("web link after finish: %v %d", err, n)
	}
}
