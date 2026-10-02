// Package sso implements inbound corporate authentication within a workspace.
package sso

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitynet"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"golang.org/x/oauth2"
)

// ErrInvalidProof deliberately hides upstream tokens and provider diagnostics.
var ErrInvalidProof = errors.New("SSO proof rejected")

// ErrAuthTimeMissing is the one actionable proof diagnostic: every authorization request
// carries max_age and prompt=login, but those travel in a browser-editable URL, so only the
// signed auth_time bounds proof freshness; iat would only prove a live IdP session. It is
// required from every provider. Entra v2 emits it only as an optional claim: app
// registration → Token configuration → Add optional claim → ID → auth_time.
var ErrAuthTimeMissing = fmt.Errorf("%w: ID token has no auth_time claim (Entra: add the optional ID token claim auth_time)", ErrInvalidProof)

// EndpointPolicy is trusted operator configuration, never a workspace setting.
// It receives the connection's workspace: an operator override may be bound to workspaces.
type EndpointPolicy func(ws uuid.UUID, raw string) (identitynet.Endpoint, error)

// OIDC uses maintained protocol libraries over an exact-endpoint guarded transport.
type OIDC struct {
	Policy EndpointPolicy
	Origin string
	Now    func() time.Time
}
type upstream struct {
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
	client   *http.Client
	// pkceAdvertised: discovery lists S256. Calab always sends an S256 challenge; a generic
	// provider whose discovery omits the list is accepted, but the test records the gap.
	pkceAdvertised bool
}
type metadata struct {
	Issuer        string   `json:"issuer"`
	Authorization string   `json:"authorization_endpoint"`
	Token         string   `json:"token_endpoint"`
	JWKS          string   `json:"jwks_uri"`
	Methods       []string `json:"code_challenge_methods_supported"`
	AuthMethods   []string `json:"token_endpoint_auth_methods_supported"`
}

func (o *OIDC) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}
func validIssuer(c sqlc.WorkspaceIdentityConnection) bool {
	u, err := url.Parse(c.Issuer)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(c.Issuer) > 2048 || c.ClientID == "" {
		return false
	}
	switch c.Provider {
	case "entra":
		tenant, err := uuid.Parse(c.TenantID)
		return err == nil && tenant != uuid.Nil && c.TenantID == tenant.String() && c.Issuer == "https://login.microsoftonline.com/"+tenant.String()+"/v2.0"
	case "adfs", "generic":
		return c.TenantID == ""
	default:
		return false
	}
}

func (o *OIDC) load(ctx context.Context, c sqlc.WorkspaceIdentityConnection, secret string) (*upstream, error) {
	if o == nil || o.Policy == nil || !validIssuer(c) {
		return nil, ErrInvalidProof
	}
	base, e := url.Parse(o.Origin)
	if e != nil || base.Scheme != "https" || base.Host == "" || base.Path != "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, ErrInvalidProof
	}
	discovery := strings.TrimSuffix(c.Issuer, "/") + "/.well-known/openid-configuration"
	ep, err := o.Policy(c.WorkspaceID, discovery)
	if err != nil {
		return nil, ErrInvalidProof
	}
	ep.URL = discovery
	ep.MaxResponseBytes = 1 << 20
	guarded, err := identitynet.NewTransport(identitynet.Config{Endpoints: []identitynet.Endpoint{ep}})
	if err != nil {
		return nil, ErrInvalidProof
	}
	client := &http.Client{Transport: guarded, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, discovery, nil)
	if err != nil {
		return nil, ErrInvalidProof
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, ErrInvalidProof
	}
	var m metadata
	err = json.NewDecoder(resp.Body).Decode(&m)
	_ = resp.Body.Close()
	guarded.CloseIdleConnections()
	if err != nil || resp.StatusCode != 200 || m.Issuer != c.Issuer || m.Authorization == "" || m.Token == "" || m.JWKS == "" || !pkceAcceptable(c.Provider, m.Methods) {
		return nil, ErrInvalidProof
	}
	var endpoints []identitynet.Endpoint
	for _, raw := range []string{discovery, m.Authorization, m.Token, m.JWKS} {
		e, err := o.Policy(c.WorkspaceID, raw)
		if err != nil {
			return nil, ErrInvalidProof
		}
		e.URL = raw
		e.MaxResponseBytes = 1 << 20
		endpoints = append(endpoints, e)
	}
	guarded, err = identitynet.NewTransport(identitynet.Config{Endpoints: endpoints})
	if err != nil {
		return nil, ErrInvalidProof
	}
	client.Transport = guarded
	ctx = oidc.ClientContext(ctx, client)
	config := oidc.Config{ClientID: c.ClientID, SupportedSigningAlgs: []string{"RS256"}, Now: o.now}
	// Keep a single immutable discovery snapshot for browser redirects, exchange and JWKS.
	oauthEndpoint := oauth2.Endpoint{AuthURL: m.Authorization, TokenURL: m.Token}
	// Explicit auth style prevents oauth2's credential-bearing auto-detect retry.
	oauthEndpoint.AuthStyle = oauth2.AuthStyleInHeader
	method := "client_secret_basic"
	if c.Provider == "entra" || c.Provider == "adfs" || secret == "" || (len(m.AuthMethods) > 0 && !slices.Contains(m.AuthMethods, "client_secret_basic") && slices.Contains(m.AuthMethods, "client_secret_post")) {
		oauthEndpoint.AuthStyle = oauth2.AuthStyleInParams
		method = "client_secret_post"
	}
	if secret != "" && len(m.AuthMethods) > 0 && !slices.Contains(m.AuthMethods, method) {
		return nil, ErrInvalidProof
	}
	verifier := oidc.NewVerifier(c.Issuer, oidc.NewRemoteKeySet(ctx, m.JWKS), &config)
	return &upstream{oauth: oauth2.Config{ClientID: c.ClientID, ClientSecret: secret, Endpoint: oauthEndpoint, Scopes: []string{"openid"}, RedirectURL: o.Origin + "/api/auth/sso/callback/" + c.ID.String()}, verifier: verifier, client: client, pkceAdvertised: slices.Contains(m.Methods, "S256")}, nil
}

// pkceAcceptable applies the per-provider PKCE rule to discovery's
// code_challenge_methods_supported. A listed set must contain S256 for every provider.
// AD FS must list it (ADR-0054: AD FS 2019+ with verified S256); Entra supports S256 by
// documentation and its fixed tenant issuer; a generic provider may omit the list
// (S256 is still sent, the connection test records "connection_tested_pkce_unadvertised").
func pkceAcceptable(provider string, methods []string) bool {
	if len(methods) > 0 {
		return slices.Contains(methods, "S256")
	}
	return provider != "adfs"
}

// Authorization always uses code/S256, a fresh nonce and bounded authentication age.
func (o *OIDC) Authorization(ctx context.Context, c sqlc.WorkspaceIdentityConnection, state, nonce, verifier string) (string, error) {
	p, err := o.load(ctx, c, "")
	if err != nil {
		return "", err
	}
	challenge, err := identitycrypto.S256(verifier)
	if err != nil {
		return "", ErrInvalidProof
	}
	return p.oauth.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("code_challenge", challenge), oauth2.SetAuthURLParam("max_age", "3600"), oauth2.SetAuthURLParam("prompt", "login")), nil
}

// Proof contains only the validated immutable subject and authentication time.
// PKCEAdvertised reports whether discovery listed S256 (connection test diagnostics only).
type Proof struct {
	Issuer, Subject string
	AuthenticatedAt time.Time
	PKCEAdvertised  bool
}

// Exchange validates signatures and the stricter Calaba claim profile after code exchange.
func (o *OIDC) Exchange(ctx context.Context, c sqlc.WorkspaceIdentityConnection, secret, code, verifier string, nonceHash []byte) (Proof, error) {
	p, err := o.load(ctx, c, secret)
	if err != nil {
		return Proof{}, err
	}
	token, err := p.oauth.Exchange(oidc.ClientContext(ctx, p.client), code, oauth2.VerifierOption(verifier))
	if err != nil {
		return Proof{}, ErrInvalidProof
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok {
		return Proof{}, ErrInvalidProof
	}
	id, err := p.verifier.Verify(oidc.ClientContext(ctx, p.client), raw)
	if err != nil {
		return Proof{}, ErrInvalidProof
	}
	var claims struct {
		AZP      string `json:"azp"`
		Tenant   string `json:"tid"`
		AuthTime int64  `json:"auth_time"`
		NBF      int64  `json:"nbf"`
	}
	now := o.now()
	if id.Claims(&claims) != nil || id.Issuer != c.Issuer || id.Subject == "" || len(id.Subject) > 512 || !identitycrypto.EqualHash(id.Nonce, nonceHash) || (len(id.Audience) > 1 && claims.AZP != c.ClientID) || (claims.AZP != "" && claims.AZP != c.ClientID) || id.IssuedAt.IsZero() || id.IssuedAt.After(now.Add(time.Minute)) || !id.Expiry.After(now) || id.Expiry.Before(id.IssuedAt) || claims.NBF > now.Add(time.Minute).Unix() || claims.AuthTime < 0 || (c.Provider == "entra" && claims.Tenant != c.TenantID) {
		return Proof{}, ErrInvalidProof
	}
	if claims.AuthTime == 0 {
		return Proof{}, ErrAuthTimeMissing
	}
	auth := time.Unix(claims.AuthTime, 0)
	// Skew may validate the token, but never extends internal proof deadlines.
	if auth.After(now.Add(time.Minute)) || !now.Before(auth.Add(time.Hour)) {
		return Proof{}, ErrInvalidProof
	}
	if auth.After(now) {
		auth = now
	}
	return Proof{Issuer: id.Issuer, Subject: id.Subject, AuthenticatedAt: auth, PKCEAdvertised: p.pkceAdvertised}, nil
}
