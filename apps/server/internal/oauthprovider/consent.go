package oauthprovider

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func cookieName(handle string) string {
	return "__Host-calab_oauth_" + base64.RawURLEncoding.EncodeToString(hash(handle)[:12])
}
func requestCookie(r *http.Request, handle string) string {
	c, err := r.Cookie(cookieName(handle))
	if err != nil || !tokenShape(c.Value, "calab_ob_") {
		return ""
	}
	return c.Value
}
func redirectURL(raw, state, issuer, code, errCode string) string {
	u, _ := url.Parse(raw)
	f := u.Query()
	f.Set("state", state)
	f.Set("iss", issuer)
	if code != "" {
		f.Set("code", code)
	}
	if errCode != "" {
		f.Set("error", errCode)
	}
	u.RawQuery = f.Encode()
	return u.String()
}

func (s *Service) clientRedirect(ctx context.Context, q *sqlc.Queries, c sqlc.OauthClient, raw string) bool {
	redirects, err := q.ListOAuthClientRedirects(ctx, sqlc.ListOAuthClientRedirectsParams{WorkspaceID: c.WorkspaceID, ClientID: c.ID})
	if err != nil {
		return false
	}
	for _, registered := range redirects {
		if redirectMatches(raw, registered.RedirectUri, c.ClientType) {
			return true
		}
	}
	return false
}

func (s *Service) entitlement(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) error {
	w, err := q.GetWorkspace(ctx, ws)
	if err != nil {
		return err
	}
	if w.SuspendedAt != nil {
		return oauthError("access_denied")
	}
	g, err := q.GetIdentityGrant(ctx, sqlc.GetIdentityGrantParams{WorkspaceID: ws, Feature: string(identitypolicy.OAuthProvider)})
	if err != nil {
		return oauthError("access_denied")
	}
	plan, err := q.GetWorkspacePlan(ctx, ws)
	business := err == nil && plan.Plan == "enterprise" && (plan.ValidUntil == nil || s.c.Now().Before(*plan.ValidUntil))
	grant := identitypolicy.Grant{WorkspaceID: ws, Feature: identitypolicy.OAuthProvider, Source: g.Source, Enabled: g.Enabled, Revoked: g.RevokedAt != nil, Version: g.Version, PlanEligible: s.c.Entitlements.Eligible(ws, g.Source, business)}
	if g.ValidUntil != nil {
		grant.ValidUntil = *g.ValidUntil
	}
	if !identitypolicy.RequireEntitlement(s.c.Now(), ws, grant, identitypolicy.OAuthProvider).Allowed {
		return oauthError("access_denied")
	}
	return nil
}

func parseAuthorize(f url.Values, c sqlc.OauthClient) (sqlc.CreateOAuthRequestParams, error) {
	for _, v := range f {
		if len(v) != 1 {
			return sqlc.CreateOAuthRequestParams{}, oauthError("invalid_request")
		}
	}
	for _, k := range []string{"request", "request_uri", "claims", "acr_values", "resource", "audience"} {
		if f.Has(k) {
			return sqlc.CreateOAuthRequestParams{}, oauthError("invalid_request")
		}
	}
	if f.Get("response_type") != "code" {
		return sqlc.CreateOAuthRequestParams{}, oauthError("unsupported_response_type")
	}
	if f.Has("response_mode") && f.Get("response_mode") != "query" {
		return sqlc.CreateOAuthRequestParams{}, oauthError("invalid_request")
	}
	if len(f.Get("state")) < 1 || len(f.Get("state")) > 512 || len(f.Get("nonce")) < 1 || len(f.Get("nonce")) > 512 || f.Get("code_challenge_method") != "S256" || !validChallenge(f.Get("code_challenge")) {
		return sqlc.CreateOAuthRequestParams{}, oauthError("invalid_request")
	}
	scopes, ok := scopeSet(f.Get("scope"))
	if !ok || !subset(scopes, c.Scopes) {
		return sqlc.CreateOAuthRequestParams{}, oauthError("invalid_scope")
	}
	prompt := strings.Join(strings.Fields(f.Get("prompt")), " ")
	seen := map[string]bool{}
	for _, p := range strings.Fields(prompt) {
		if !subset([]string{p}, []string{"none", "login", "consent"}) || seen[p] {
			return sqlc.CreateOAuthRequestParams{}, oauthError("invalid_request")
		}
		seen[p] = true
	}
	if seen["none"] && len(seen) > 1 {
		return sqlc.CreateOAuthRequestParams{}, oauthError("invalid_request")
	}
	var maxAge *int32
	if f.Has("max_age") {
		n, err := strconv.ParseInt(f.Get("max_age"), 10, 32)
		if err != nil || n < 0 {
			return sqlc.CreateOAuthRequestParams{}, oauthError("invalid_request")
		}
		v := int32(n)
		maxAge = &v
	}
	return sqlc.CreateOAuthRequestParams{WorkspaceID: c.WorkspaceID, ClientID: c.ID, ClientVersion: c.Version, RedirectUri: f.Get("redirect_uri"), Scopes: scopes, State: f.Get("state"), Nonce: f.Get("nonce"), PkceChallenge: f.Get("code_challenge"), Prompt: prompt, MaxAgeSeconds: maxAge}, nil
}

func freshAuthentication(now, created, at time.Time, prompt string, maxAge *int32) bool {
	if at.IsZero() || at.After(now) {
		return false
	}
	if subset([]string{"login"}, strings.Fields(prompt)) && at.Before(created) {
		return false
	}
	if maxAge != nil {
		if *maxAge == 0 {
			return !at.Before(created)
		}
		if now.Sub(at) > time.Duration(*maxAge)*time.Second {
			return false
		}
	}
	return true
}

func (s *Service) authorize(w http.ResponseWriter, r *http.Request) {
	headers(w)
	if len(r.URL.RawQuery)>16<<10{writeError(w,oauthError("invalid_request"));return}
	ws, err := pathWorkspace(r)
	if err != nil {
		writeError(w, err)
		return
	}
	f, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeError(w, oauthError("invalid_request"))
		return
	}
	if len(f["client_id"]) != 1 || len(f["redirect_uri"]) != 1 {
		writeError(w, oauthError("invalid_request"))
		return
	}
	c, err := s.c.DB.Q.FindOAuthClient(r.Context(), sqlc.FindOAuthClientParams{WorkspaceID: ws, ClientID: f.Get("client_id")})
	if err != nil || c.DisabledAt != nil || !s.clientRedirect(r.Context(), s.c.DB.Q, c, f.Get("redirect_uri")) {
		writeError(w, oauthError("invalid_request"))
		return
	}
	redirectError := func(e error) {
		var pe *protocolError
		if !errors.As(e, &pe) {
			pe = &protocolError{code: "server_error"}
		}
		// #nosec G710 -- The complete redirect was matched to this client's registered URI before this closure.
		http.Redirect(w, r, redirectURL(f.Get("redirect_uri"), f.Get("state"), s.issuer(ws), "", pe.code), http.StatusSeeOther)
	}
	request, err := parseAuthorize(f, c)
	if err != nil {
		redirectError(err)
		return
	}
	request.Issuer = s.issuer(ws)
	if err = s.entitlement(r.Context(), s.c.DB.Q, ws); err != nil {
		redirectError(err)
		return
	}
	if request.Prompt == "none" {
		p, err := s.c.ResolveSession(r.Context(), r)
		if err != nil {
			redirectError(oauthError("login_required"))
			return
		}
		code := ""
		err = s.c.DB.Tx(r.Context(), func(q *sqlc.Queries) error {
			if err := s.lockWorkspace(r.Context(), q, ws); err != nil {
				return err
			}
			locked, err := q.GetOAuthClientForUpdate(r.Context(), sqlc.GetOAuthClientForUpdateParams{WorkspaceID: ws, ID: c.ID})
			if err != nil {
				return err
			}
			if locked.DisabledAt != nil || locked.Version != c.Version {
				return oauthError("interaction_required")
			}
			st, d, err := s.state(r.Context(), q, p, ws, identitypolicy.OAuthAuthorize)
			if err != nil {
				return oauthError("interaction_required")
			}
			if !freshAuthentication(s.c.Now(), s.c.Now(), authTime(st), "", request.MaxAgeSeconds) {
				return oauthError("login_required")
			}
			consent, err := q.FindOAuthConsent(r.Context(), sqlc.FindOAuthConsentParams{WorkspaceID: ws, UserID: p.UserID, ClientID: c.ID})
			if err != nil || consent.RevokedAt != nil || !subset(request.Scopes, consent.Scopes) {
				return oauthError("consent_required")
			}
			code, err = s.createCode(r.Context(), q, request, st, d, consent)
			return err
		})
		if err != nil {
			redirectError(err)
			return
		}
		http.Redirect(w, r, redirectURL(request.RedirectUri, request.State, request.Issuer, code, ""), http.StatusSeeOther)
		return
	}
	handle, browser := opaque("calab_oh_"), opaque("calab_ob_")
	request.HandleHash = hash(handle)
	request.BrowserHash = hash(browser)
	request.ExpiresAt = s.c.Now().Add(10 * time.Minute)
	err = s.c.DB.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := s.lockWorkspace(r.Context(), q, ws); err != nil {
			return err
		}
		locked, err := q.GetOAuthClientForUpdate(r.Context(), sqlc.GetOAuthClientForUpdateParams{WorkspaceID: ws, ID: c.ID})
		if err != nil {
			return err
		}
		if locked.DisabledAt != nil || locked.Version != c.Version {
			return oauthError("invalid_request")
		}
		if err = s.entitlement(r.Context(), q, ws); err != nil {
			return err
		}
		_, err = q.CreateOAuthRequest(r.Context(), request)
		return err
	})
	if err != nil {
		redirectError(err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName(handle), Value: browser, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 600})
	http.Redirect(w, r, s.c.PublicOrigin+"/oauth/consent?request="+url.QueryEscape(handle), http.StatusSeeOther)
}

func (s *Service) findRequest(ctx context.Context, q *sqlc.Queries, r *http.Request) (sqlc.OauthAuthorizationRequest, error) {
	handle := r.PathValue("request")
	cookie := requestCookie(r, handle)
	if !tokenShape(handle, "calab_oh_") || cookie == "" || !s.sameOrigin(r) {
		return sqlc.OauthAuthorizationRequest{}, oauthError("invalid_request")
	}
	req, err := q.FindOAuthRequest(ctx, sqlc.FindOAuthRequestParams{HandleHash: hash(handle), BrowserHash: hash(cookie)})
	if err != nil || req.ConsumedAt != nil || !s.c.Now().Before(req.ExpiresAt) || req.Issuer != s.issuer(req.WorkspaceID) {
		return req, oauthError("invalid_request")
	}
	return req, nil
}

func (s *Service) bind(w http.ResponseWriter, r *http.Request) {
	input := &v1.BindOAuthRequest{}
	if err := readProto(w, r, input); err != nil {
		writeAPIError(w, err)
		return
	}
	if input.CsrfToken != r.PathValue("request") {
		writeAPIError(w, oauthError("invalid_request"))
		return
	}
	p, err := s.resolveBearer(r)
	if err != nil {
		writeAPIError(w, &protocolError{code: "invalid_token", status: http.StatusUnauthorized})
		return
	}
	var snapshot *v1.OAuthConsentSnapshot
	err = s.c.DB.Tx(r.Context(), func(q *sqlc.Queries) error {
		req, err := s.findRequest(r.Context(), q, r)
		if err != nil {
			return err
		}
		if err := s.lockWorkspace(r.Context(), q, req.WorkspaceID); err != nil {
			return err
		}
		c, err := q.GetOAuthClientForUpdate(r.Context(), sqlc.GetOAuthClientForUpdateParams{WorkspaceID: req.WorkspaceID, ID: req.ClientID})
		if err != nil {
			return err
		}
		if c.DisabledAt != nil || c.Version != req.ClientVersion {
			return oauthError("invalid_request")
		}
		st, _, err := s.state(r.Context(), q, p, req.WorkspaceID, identitypolicy.OAuthAuthorize)
		if err != nil {
			return oauthError("interaction_required")
		}
		if !freshAuthentication(s.c.Now(), req.CreatedAt, authTime(st), req.Prompt, req.MaxAgeSeconds) {
			return oauthError("login_required")
		}
		csrf := opaque("calab_cs_")
		_, err = q.BindOAuthRequest(r.Context(), sqlc.BindOAuthRequestParams{ID: req.ID, BrowserHash: req.BrowserHash, SessionID: &p.SessionID, UserID: &p.UserID, CsrfHash: hash(csrf)})
		if err != nil {
			return oauthError("invalid_request")
		}
		workspace, err := q.GetWorkspace(r.Context(), req.WorkspaceID)
		if err != nil {
			return err
		}
		user, err := q.GetUser(r.Context(), p.UserID)
		if err != nil {
			return err
		}
		snapshot = &v1.OAuthConsentSnapshot{RequestId: r.PathValue("request"), WorkspaceId: req.WorkspaceID.String(), WorkspaceName: workspace.Name, ClientName: c.Name, RedirectUri: req.RedirectUri, DisplayName: user.DisplayName, Scopes: req.Scopes, RefreshRequested: c.RefreshEnabled, CsrfToken: csrf, ExpiresAt: timestamppb.New(req.ExpiresAt)}
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	protoResponse(w, http.StatusOK, snapshot)
}

func (s *Service) decide(w http.ResponseWriter, r *http.Request) {
	input := &v1.DecideOAuthRequest{}
	if err := readProto(w, r, input); err != nil {
		writeAPIError(w, err)
		return
	}
	if !tokenShape(input.CsrfToken, "calab_cs_") {
		writeAPIError(w, oauthError("invalid_request"))
		return
	}
	p, err := s.resolveBearer(r)
	if err != nil {
		writeAPIError(w, &protocolError{code: "invalid_token", status: http.StatusUnauthorized})
		return
	}
	redirect := ""
	err = s.c.DB.Tx(r.Context(), func(q *sqlc.Queries) error {
		req, err := s.findRequest(r.Context(), q, r)
		if err != nil {
			return err
		}
		if err := s.lockWorkspace(r.Context(), q, req.WorkspaceID); err != nil {
			return err
		}
		c, err := q.GetOAuthClientForUpdate(r.Context(), sqlc.GetOAuthClientForUpdateParams{WorkspaceID: req.WorkspaceID, ID: req.ClientID})
		if err != nil {
			return err
		}
		if c.DisabledAt != nil || c.Version != req.ClientVersion {
			return oauthError("invalid_request")
		}
		st, d, err := s.state(r.Context(), q, p, req.WorkspaceID, identitypolicy.OAuthAuthorize)
		if err != nil {
			return oauthError("interaction_required")
		}
		if !freshAuthentication(s.c.Now(), req.CreatedAt, authTime(st), req.Prompt, req.MaxAgeSeconds) {
			return oauthError("login_required")
		}
		req, err = q.ConsumeOAuthRequest(r.Context(), sqlc.ConsumeOAuthRequestParams{ID: req.ID, BrowserHash: req.BrowserHash, CsrfHash: hash(input.CsrfToken), SessionID: &p.SessionID, UserID: &p.UserID})
		if err != nil {
			return oauthError("invalid_request")
		}
		if !input.Allow {
			redirect = redirectURL(req.RedirectUri, req.State, req.Issuer, "", "access_denied")
			return s.audit(r.Context(), q, req.WorkspaceID, p.UserID, req.ID, "oauth_consent_denied")
		}
		if input.AllowRefresh && !c.RefreshEnabled {
			return oauthError("invalid_request")
		}
		consent, err := q.UpsertOAuthConsent(r.Context(), sqlc.UpsertOAuthConsentParams{WorkspaceID: req.WorkspaceID, UserID: p.UserID, ClientID: c.ID, Scopes: req.Scopes, RefreshAllowed: input.AllowRefresh})
		if err != nil {
			return err
		}
		// Re-consenting increments the consent version: existing families cannot
		// silently retain a wider scope or an old refresh permission.
		reason := "consent_replaced"
		if _, err = q.RevokeWorkspaceOAuthGrants(r.Context(), sqlc.RevokeWorkspaceOAuthGrantsParams{WorkspaceID: req.WorkspaceID, UserID: &p.UserID, ClientID: &c.ID, Reason: &reason}); err != nil {
			return err
		}
		code, err := s.createCode(r.Context(), q, sqlc.CreateOAuthRequestParams{WorkspaceID: req.WorkspaceID, ClientID: req.ClientID, ClientVersion: req.ClientVersion, Issuer: req.Issuer, RedirectUri: req.RedirectUri, Scopes: req.Scopes, State: req.State, Nonce: req.Nonce, PkceChallenge: req.PkceChallenge}, st, d, consent)
		if err != nil {
			return err
		}
		redirect = redirectURL(req.RedirectUri, req.State, req.Issuer, code, "")
		return s.audit(r.Context(), q, req.WorkspaceID, p.UserID, consent.ID, "oauth_consent_granted")
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName(r.PathValue("request")), Value: "", Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	protoResponse(w, http.StatusOK, &v1.OAuthDecisionResponse{RedirectUrl: redirect})
}

func (s *Service) createCode(ctx context.Context, q *sqlc.Queries, req sqlc.CreateOAuthRequestParams, st identitypolicy.State, d identitypolicy.Decision, consent sqlc.OauthConsent) (string, error) {
	now := s.c.Now()
	if authTime(st).IsZero() {
		return "", oauthError("login_required")
	}
	_, err := q.UpsertOAuthSubject(ctx, sqlc.UpsertOAuthSubjectParams{WorkspaceID: req.WorkspaceID, UserID: st.Principal.UserID, Subject: opaque("")})
	if err != nil {
		return "", err
	}
	var proofDeadline *time.Time
	if st.Assurance != nil && (st.Policy.Mode == identitypolicy.Enforced || st.Principal.Authority == identitypolicy.WorkspaceSSO) {
		t := d.ValidUntil
		proofDeadline = &t
	}
	dbNow, err := q.IdentityDatabaseNow(ctx)
	if err != nil {
		return "", err
	}
	expires := minimum(minimum(now.Add(identitypolicy.RefreshAbsoluteTTL), dbNow.Add(identitypolicy.RefreshAbsoluteTTL)), st.Principal.ExpiresAt)
	if !expires.After(now) || !expires.After(dbNow) || !d.ValidUntil.After(now) || !d.ValidUntil.After(dbNow) {
		return "", oauthError("interaction_required")
	}
	g, err := q.CreateOAuthGrant(ctx, sqlc.CreateOAuthGrantParams{WorkspaceID: req.WorkspaceID, UserID: st.Principal.UserID, ClientID: req.ClientID, ConsentID: consent.ID, SessionID: st.Principal.SessionID, Scopes: req.Scopes, ClientVersion: req.ClientVersion, ConsentVersion: consent.Version, PolicyVersion: d.Versions.Policy, AccessVersion: d.Versions.Access, EntitlementVersion: d.Versions.Entitlement, SessionVersion: d.Versions.Session, AuthenticatedAt: authTime(st), AssuranceExpiresAt: proofDeadline, ExpiresAt: expires, IdleExpiresAt: minimum(expires, minimum(now.Add(identitypolicy.RefreshIdleTTL), dbNow.Add(identitypolicy.RefreshIdleTTL))), Issuer: req.Issuer})
	if err != nil {
		return "", err
	}
	code := opaque("calab_oc_")
	_, err = q.CreateOAuthCode(ctx, sqlc.CreateOAuthCodeParams{WorkspaceID: req.WorkspaceID, GrantID: g.ID, UserID: g.UserID, ClientID: req.ClientID, CodeHash: hash(code), RedirectUri: req.RedirectUri, PkceChallenge: req.PkceChallenge, Nonce: req.Nonce, ExpiresAt: minimum(minimum(now.Add(identitypolicy.AuthorizationCodeTTL), dbNow.Add(identitypolicy.AuthorizationCodeTTL)), d.ValidUntil)})
	return code, err
}
