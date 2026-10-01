//go:build integration

package app_test

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/encoding/protojson"
)

// Credentials traverse the production App's authorize/bind/decision/token
// handlers. No principal, grant, token or authentication result is fabricated.
func TestIdentityRealProviderTokenIsolationAcrossRESTGatewayRTC(t *testing.T) {
	f := identitySetup(t, "optional")
	_, base := identityHTTP(t)
	const origin = "https://app.example.com"
	const redirect = "https://isolation-rp.example/callback"
	issuerPath := "/oidc/workspaces/" + f.a.Id
	o := owner(t)
	status, _, _ := identityRequest(t, base, "POST", "/api/auth/local/reauth", o.token, origin, nil, &v1.LocalReauthRequest{CurrentPassword: "password123"})
	if status != 200 {
		t.Fatalf("owner local reauth: HTTP %d", status)
	}
	status, raw, _ := identityRequest(t, base, "POST", "/api/workspaces/"+f.a.Id+"/oauth/clients", o.token, origin, nil, &v1.CreateOAuthClientRequest{Name: "Token isolation RP", Type: v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, RedirectUris: []string{redirect}, Scopes: []string{"openid"}, RefreshEnabled: true})
	var client v1.OAuthClientSecretResponse
	if status != 201 || protojson.Unmarshal(raw, &client) != nil || client.Client == nil {
		t.Fatalf("production client creation: HTTP %d", status)
	}
	verifier := strings.Repeat("v", 43)
	challenge := sha256.Sum256([]byte(verifier))
	args := url.Values{"client_id": {client.Client.ClientId}, "redirect_uri": {redirect}, "response_type": {"code"}, "scope": {"openid"}, "state": {"isolation-state"}, "nonce": {"isolation-nonce"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
	req, err := http.NewRequestWithContext(t.Context(), "GET", base+issuerPath+"/authorize?"+args.Encode(), http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Forwarded-For", "10.96.1.1")
	httpClient := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := httpClient.Do(req)
	if err != nil {
		t.Fatal("production authorize request failed")
	}
	cookies := response.Cookies()
	location, err := url.Parse(response.Header.Get("Location"))
	_ = response.Body.Close()
	if response.StatusCode != http.StatusSeeOther || err != nil || location.Path != "/oauth/consent" {
		t.Fatalf("production authorization consent redirect: HTTP %d", response.StatusCode)
	}
	handle := location.Query().Get("request")
	if handle == "" || len(cookies) == 0 {
		t.Fatal("missing server-generated browser binding")
	}
	status, raw, _ = identityRequest(t, base, "POST", "/api/oauth/requests/"+handle+"/bind", f.local.token, origin, cookies, &v1.BindOAuthRequest{CsrfToken: handle})
	var snapshot v1.OAuthConsentSnapshot
	if status != 200 || protojson.Unmarshal(raw, &snapshot) != nil || snapshot.CsrfToken == "" {
		t.Fatalf("production consent bind: HTTP %d", status)
	}
	status, raw, _ = identityRequest(t, base, "POST", "/api/oauth/requests/"+handle+"/decision", f.local.token, origin, cookies, &v1.DecideOAuthRequest{Allow: true, AllowRefresh: true, CsrfToken: snapshot.CsrfToken})
	var decision v1.OAuthDecisionResponse
	if status != 200 || protojson.Unmarshal(raw, &decision) != nil {
		t.Fatalf("production consent decision: HTTP %d", status)
	}
	callback, err := url.Parse(decision.RedirectUrl)
	if err != nil || callback.Query().Get("code") == "" || callback.Query().Get("state") != "isolation-state" || callback.Query().Get("iss") != origin+issuerPath {
		t.Fatal("authorization response binding failed")
	}
	type credentials struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
		ID      string `json:"id_token"`
	}
	status, _, raw = quotaWire(t, base, "POST", issuerPath+"/token", "10.96.1.2", "", "", "", url.Values{"grant_type": {"authorization_code"}, "client_id": {client.Client.ClientId}, "redirect_uri": {redirect}, "code": {callback.Query().Get("code")}, "code_verifier": {verifier}})
	var issued credentials
	if status != 200 || json.Unmarshal(raw, &issued) != nil || issued.Access == "" || issued.Refresh == "" || issued.ID == "" {
		t.Fatalf("real code exchange with explicit refresh consent: HTTP %d", status)
	}
	checkUserInfo := func(token string, want int) {
		t.Helper()
		for _, method := range []string{"GET", "POST"} {
			status, headers, raw := quotaWire(t, base, method, issuerPath+"/userinfo", "10.96.1.3", token, "", "", nil)
			var problem struct{ Error, Code string }
			if want == 401 {
				if err := json.Unmarshal(raw, &problem); err != nil {
					t.Fatal("UserInfo denial is not JSON")
				}
			}
			if status != want {
				t.Fatalf("UserInfo %s: HTTP %d, want %d; error=%q code=%q", method, status, want, problem.Error, problem.Code)
			}
			if want == 401 && (problem.Error != "invalid_token" || problem.Code != "" || headers.Get("WWW-Authenticate") != `Bearer error="invalid_token"` || headers.Get("Cache-Control") != "no-store" || headers.Get("Referrer-Policy") != "no-referrer") {
				t.Fatalf("UserInfo %s invalid-token protocol headers/body mismatch", method)
			}
		}
	}
	checkUserInfo(issued.Access, 200)
	identityTokenVerifyID(t, base, issuerPath, issued.ID, origin+issuerPath, client.Client.ClientId)
	room, _ := identityVoiceRooms(t, f)
	checkLocal := func() {
		t.Helper()
		status, raw, _ := identityRequest(t, base, "POST", "/api/rooms/"+room+"/join", f.local.token, origin, nil, nil)
		var joined v1.JoinVoiceResponse
		if status != 200 || protojson.Unmarshal(raw, &joined) != nil || joined.Token == "" {
			t.Fatalf("independent local RTC issuance control: HTTP %d", status)
		}
		// Token issuance only: no media session, microphone or audio playback.
		identityTokenGateway(t, base, f.local.token, f.local.id)
	}
	checkLocal()
	for _, credential := range []struct{ name, token string }{{"access", issued.Access}, {"refresh", issued.Refresh}, {"id", issued.ID}} {
		t.Run(credential.name, func(t *testing.T) {
			for _, endpoint := range []struct{ method, path string }{{"GET", "/api/me"}, {"POST", "/api/rooms/" + room + "/join"}} {
				status, _, _ := identityRequest(t, base, endpoint.method, endpoint.path, credential.token, origin, nil, nil)
				if status != 401 {
					t.Fatalf("provider credential at first-party %s: HTTP %d", endpoint.path, status)
				}
			}
			identityTokenGateway(t, base, credential.token, "")
		})
	}
	bot := createBot(t, o, f.a.Id, "isolation")
	status, _, _ = identityRequest(t, base, "GET", "/api/rooms/"+f.roomA, bot.token, origin, nil, nil)
	if status != 200 {
		t.Fatalf("independent bot first-party control: HTTP %d", status)
	}
	status, raw, _ = identityRequest(t, base, "POST", "/api/auth/local/reauth", bot.token, origin, nil, nil)
	var botDenied v1.ApiError
	if status != 403 || protojson.Unmarshal(raw, &botDenied) != nil || botDenied.GetReason() != "BOT_NOT_ALLOWED" {
		t.Fatalf("first-party bot restriction changed: HTTP %d", status)
	}
	status, _, raw = quotaWire(t, base, "POST", issuerPath+"/token", "10.96.1.6", bot.token, "", "", nil)
	var protocolDenied struct{ Error string }
	if status != 403 || json.Unmarshal(raw, &protocolDenied) != nil || protocolDenied.Error != "access_denied" {
		t.Fatalf("non-UserInfo bot restriction changed: HTTP %d", status)
	}
	for _, token := range []string{f.local.token, bot.token, issued.Refresh, issued.ID} {
		checkUserInfo(token, 401)
	}
	// Rejections above must not revoke an otherwise valid provider grant or local
	// session. Refresh rotates only after all checks of the live original tokens.
	checkUserInfo(issued.Access, 200)
	identityTokenVerifyID(t, base, issuerPath, issued.ID, origin+issuerPath, client.Client.ClientId)
	status, _, raw = quotaWire(t, base, "POST", issuerPath+"/token", "10.96.1.4", "", "", "", url.Values{"grant_type": {"refresh_token"}, "client_id": {client.Client.ClientId}, "refresh_token": {issued.Refresh}})
	var rotated credentials
	if status != 200 || json.Unmarshal(raw, &rotated) != nil || rotated.Access == "" || rotated.Refresh == "" || rotated.Refresh == issued.Refresh {
		t.Fatalf("original live provider refresh control: HTTP %d", status)
	}
	checkUserInfo(rotated.Access, 200)
	checkLocal()
}

func identityTokenGateway(t *testing.T, base, token, allowedUser string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/gateway?v=1&encoding=json", nil) //nolint:bodyclose // websocket owns the response
	if err != nil {
		t.Fatal("gateway dial failed")
	}
	defer func() { _ = ws.Close(websocket.StatusNormalClosure, "") }()
	read := func() (*v1.GatewayFrame, error) {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return nil, err
		}
		frame := &v1.GatewayFrame{}
		return frame, protojson.Unmarshal(data, frame)
	}
	hello, err := read()
	if err != nil || hello.GetHello() == nil {
		t.Fatal("gateway HELLO unavailable")
	}
	raw, err := protojson.Marshal(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_IDENTIFY, Payload: &v1.GatewayFrame_Identify{Identify: &v1.Identify{Token: token}}})
	if err != nil || ws.Write(ctx, websocket.MessageText, raw) != nil {
		t.Fatal("gateway IDENTIFY write failed")
	}
	for {
		frame, err := read()
		if err != nil {
			if allowedUser != "" || websocket.CloseStatus(err) != 4004 {
				t.Fatalf("gateway auth close: %d, expected valid local READY or provider denial 4004", websocket.CloseStatus(err))
			}
			return
		}
		if ready := frame.GetDispatch().GetReady(); ready != nil {
			if allowedUser == "" || ready.GetMe().GetUser().GetId() != allowedUser {
				t.Fatal("gateway accepted provider credential or wrong local account")
			}
			return
		}
	}
}

// Independent standard-library verification proves the ID token is live and
// valid for its intended RP while first-party authentication still rejects it.
func identityTokenVerifyID(t *testing.T, base, path, token, issuer, audience string) {
	t.Helper()
	status, _, raw := quotaWire(t, base, "GET", path+"/jwks", "10.96.1.5", "", "", "", nil)
	var jwks struct {
		Keys []struct{ Kid, Kty, Alg, N, E, D string }
	}
	if status != 200 || json.Unmarshal(raw, &jwks) != nil {
		t.Fatal("public JWKS unavailable")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatal("malformed production ID token")
	}
	decode := func(raw string, out any) {
		t.Helper()
		data, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || json.Unmarshal(data, out) != nil {
			t.Fatal("ID token encoding failed")
		}
	}
	var header struct{ Kid, Alg string }
	var claims struct {
		Iss, Aud, Nonce string
		Exp             int64
	}
	decode(parts[0], &header)
	decode(parts[1], &claims)
	if header.Alg != "RS256" || claims.Iss != issuer || claims.Aud != audience || claims.Nonce != "isolation-nonce" || claims.Exp <= time.Now().Unix() {
		t.Fatal("production ID token RP binding or lifetime invalid")
	}
	for _, key := range jwks.Keys {
		if key.Kid != header.Kid {
			continue
		}
		n, errN := base64.RawURLEncoding.DecodeString(key.N)
		e, errE := base64.RawURLEncoding.DecodeString(key.E)
		signature, errS := base64.RawURLEncoding.DecodeString(parts[2])
		if key.Kty != "RSA" || key.Alg != "RS256" || key.D != "" || errN != nil || errE != nil || errS != nil {
			t.Fatal("invalid public verification key")
		}
		digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		public := &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
		if rsa.VerifyPKCS1v15(public, crypto.SHA256, digest[:], signature) != nil {
			t.Fatal("independent RS256 verification failed")
		}
		return
	}
	t.Fatal("ID token signing key absent from JWKS")
}
