#!/usr/bin/env python3
"""Prove the local IdP fixture, never Calaba's RP implementation; redact tokens."""
import base64
import hashlib
import html.parser
import http.cookiejar
import json
import os
import secrets
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

issuer = os.environ["TEST_OIDC_ISSUER"]
parsed = urllib.parse.urlparse(issuer)
if parsed.scheme != "https" or parsed.hostname != "127.0.0.1":
    sys.exit("Only the HTTPS literal 127.0.0.1 fixture is allowed")
tls = ssl.create_default_context(cafile=os.environ["TEST_OIDC_CA_FILE"])
redirect_uri = os.environ["TEST_OIDC_REDIRECT_URI"]
client_id = os.environ["TEST_OIDC_CLIENT_ID"]
client_secret = os.environ["TEST_OIDC_CLIENT_SECRET"]


class CaptureCallback(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if newurl.startswith(redirect_uri + "?"):
            return None  # Capture the code without opening/listening on the callback port.
        if urllib.parse.urlparse(newurl).netloc != parsed.netloc:
            raise RuntimeError("Fixture attempted an unexpected external redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def opener():
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),  # Local traffic must not enter system/VPN proxies.
        urllib.request.HTTPSHandler(context=tls),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        CaptureCallback(),
    )


client = opener()
deadline = time.monotonic() + 180
while True:
    try:
        with client.open(issuer + "/.well-known/openid-configuration", timeout=5) as response:
            discovery = json.load(response)
        assert discovery["issuer"] == issuer
        for field in ("jwks_uri", "authorization_endpoint", "token_endpoint"):
            endpoint = urllib.parse.urlparse(discovery[field])
            assert endpoint.scheme == "https" and endpoint.netloc == parsed.netloc
        with client.open(discovery["jwks_uri"], timeout=5) as response:
            jwks = json.load(response)
        assert any(k["kty"] == "RSA" and k.get("kid") for k in jwks["keys"])
        break
    except (OSError, urllib.error.URLError):
        if time.monotonic() >= deadline:
            sys.exit("Local IdP discovery did not become ready in 180s")
        time.sleep(2)
print("PASS local TLS trust, exact issuer discovery and RSA JWKS")
if "--ready" in sys.argv:
    sys.exit(0)


class LoginForm(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.action = None

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "form" and values.get("id") == "kc-form-login":
            self.action = values["action"]


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def authorize(username, password):
    agent = opener()
    verifier, state, nonce = secrets.token_urlsafe(48), secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    query = urllib.parse.urlencode(dict(
        client_id=client_id, redirect_uri=redirect_uri, response_type="code", scope="openid email profile",
        state=state, nonce=nonce, code_challenge=b64(hashlib.sha256(verifier.encode()).digest()),
        code_challenge_method="S256",
    ))
    with agent.open(discovery["authorization_endpoint"] + "?" + query, timeout=10) as response:
        form = LoginForm()
        form.feed(response.read().decode())
    assert form.action and urllib.parse.urlparse(form.action).netloc == parsed.netloc
    data = urllib.parse.urlencode(dict(username=username, password=password, credentialId="")).encode()
    try:
        with agent.open(form.action, data=data, timeout=10) as response:
            response.read()
        return None, verifier, nonce
    except urllib.error.HTTPError as error:
        if error.code != 302:
            raise RuntimeError(f"Unexpected login HTTP status {error.code}") from None
        location = error.headers["Location"]
        assert location.startswith(redirect_uri + "?")
        params = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)
        assert params["state"] == [state]
        return params["code"][0], verifier, nonce


def exchange(code, verifier):
    data = urllib.parse.urlencode(dict(
        grant_type="authorization_code", client_id=client_id, client_secret=client_secret,
        code=code, code_verifier=verifier, redirect_uri=redirect_uri,
    )).encode()
    try:
        with client.open(discovery["token_endpoint"], data=data, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


code, verifier, nonce = authorize("alice", "fixture-only-alice-password")
assert code, "Enabled fixture user could not authorize"
status, tokens = exchange(code, verifier)
assert status == 200 and tokens.get("access_token") and tokens.get("id_token")
# Payload checks prove fixture configuration only; signature verification is RP-worker scope.
payload = tokens["id_token"].split(".")[1]
claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
assert claims["iss"] == issuer and claims["aud"] == client_id and claims["nonce"] == nonce
assert claims["email"] == "alice@identity.test" and claims["sub"]
print("PASS authorization code + S256 PKCE + client secret + nonce/issuer/audience fixture claims")
status, error = exchange(code, verifier)
assert status == 400 and error["error"] == "invalid_grant"
print("PASS authorization code replay rejected")
code, _, _ = authorize("alice", "fixture-only-alice-password")
status, error = exchange(code, secrets.token_urlsafe(48))
assert status == 400 and error["error"] == "invalid_grant"
print("PASS incorrect PKCE verifier rejected")
code, _, _ = authorize("disabled", "fixture-only-disabled-password")
assert code is None
print("PASS disabled fixture user received no authorization code")
