package signing_test

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/oauthprovider/signing"
	"github.com/golang-jwt/jwt/v5"
)

var testNow = time.Unix(1800000000, 0).UTC()

func rsaKey(t *testing.T, bits int) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		t.Fatal(err)
	}
	return key
}
func privatePEM(k *rsa.PrivateKey) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k)})
}
func publicPEM(k *rsa.PrivateKey) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: x509.MarshalPKCS1PublicKey(&k.PublicKey)})
}
func config(keys ...signing.Key) signing.Config {
	return signing.Config{Issuer: "https://calab.test/oidc/workspaces/workspace-a", ActiveKID: "active", Keys: keys, Now: func() time.Time { return testNow }}
}
func claims() signing.Claims {
	return signing.Claims{Issuer: config().Issuer, Audience: "client-a", Subject: "workspace-opaque-sub", IssuedAt: testNow, ExpiresAt: testNow.Add(5 * time.Minute), Nonce: "bound-nonce"}
}
func ring(t *testing.T, c signing.Config) *signing.Keyring {
	t.Helper()
	r, err := signing.New(c)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// Independent verification reconstructs an RSA public key from the published
// JWKS and checks the signature with crypto/rsa, not Keyring.Verify or jwt.
func TestIndependentSignatureAndPublicJWKS(t *testing.T) {
	active, overlap := rsaKey(t, 2048), rsaKey(t, 2048)
	material := privatePEM(active)
	r := ring(t, config(signing.Key{KID: "active", PEM: material}, signing.Key{KID: "aaa-old", PEM: publicPEM(overlap)}))
	// Mutating the constructor input cannot alter the parsed immutable keyring.
	clear(material)
	c := claims()
	auth := testNow.Add(-time.Minute)
	c.AuthTime = &auth
	yes := true
	c.Name = "Alice"
	c.Email = "alice@example.test"
	c.EmailVerified = &yes
	token, err := r.Sign(c, "client-a")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatal(err)
	}
	var h map[string]string
	if err := json.Unmarshal(header, &h); err != nil {
		t.Fatal(err)
	}
	if h["alg"] != "RS256" || h["kid"] != "active" || h["typ"] != "JWT" || len(h) != 3 {
		t.Fatalf("header: %v", h)
	}
	jwks := r.PublicJWKS()
	if len(jwks.Keys) != 2 || jwks.Keys[0].KID != "aaa-old" {
		t.Fatalf("JWKS: %v", jwks)
	}
	k := jwks.Keys[1]
	n, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		t.Fatal(err)
	}
	e, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		t.Fatal(err)
	}
	pub := &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, hash[:], sig); err != nil {
		t.Fatal(err)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["aud"] != "client-a" || decoded["iss"] != c.Issuer || decoded["sub"] != c.Subject || decoded["auth_time"] != float64(auth.Unix()) {
		t.Fatalf("payload: %v", decoded)
	}
	for _, data := range [][]byte{r.JWKSJSON(), []byte(fmt.Sprintf("%+v %#v", r, r))} {
		for _, forbidden := range []string{"PRIVATE", `"d":`, `"p":`, `"q":`, `"dp":`, `"dq":`, `"qi":`, active.D.String(), overlap.D.String()} {
			if bytes.Contains(data, []byte(forbidden)) {
				t.Fatalf("private key leakage: %s", forbidden)
			}
		}
	}
	var fields struct {
		Keys []map[string]any `json:"keys"`
	}
	if err := json.Unmarshal(r.JWKSJSON(), &fields); err != nil {
		t.Fatal(err)
	}
	for _, key := range fields.Keys {
		if len(key) != 6 {
			t.Fatalf("unexpected public fields: %v", key)
		}
	}
	first := r.JWKSJSON()
	jwks.Keys[0].N = "tampered"
	if !bytes.Equal(first, r.JWKSJSON()) {
		t.Fatal("mutable JWKS")
	}
	got, err := r.Verify(token, "client-a")
	if err != nil || got.Nonce != c.Nonce || got.Name != c.Name {
		t.Fatalf("verify: %+v %v", got, err)
	}
}

func TestConstructorFailsClosed(t *testing.T) {
	k := rsaKey(t, 2048)
	weak := rsaKey(t, 1024)
	priv := privatePEM(k)
	pub := publicPEM(k)
	ecdsaKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ec, err := x509.MarshalPKCS8PrivateKey(ecdsaKey)
	if err != nil {
		t.Fatal(err)
	}
	base := config(signing.Key{KID: "active", PEM: priv})
	cases := map[string]signing.Config{
		"empty": {}, "no-keys": config(), "public-active": config(signing.Key{KID: "active", PEM: pub}),
		"unknown-active": config(signing.Key{KID: "other", PEM: priv}), "malformed": config(signing.Key{KID: "active", PEM: []byte("SECRET-BAD-PEM")}),
		"duplicate-kid":      config(signing.Key{KID: "active", PEM: priv}, signing.Key{KID: "active", PEM: pub}),
		"duplicate-material": config(signing.Key{KID: "active", PEM: priv}, signing.Key{KID: "old", PEM: pub}),
		"weak":               config(signing.Key{KID: "active", PEM: privatePEM(weak)}),
		"ec":                 config(signing.Key{KID: "active", PEM: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: ec})}),
		"trailing":           config(signing.Key{KID: "active", PEM: append(append([]byte(nil), priv...), []byte("secret-garbage")...)}),
		"concatenated":       config(signing.Key{KID: "active", PEM: append(append([]byte(nil), priv...), pub...)}),
		"invalid-kid":        config(signing.Key{KID: "secret\nactive", PEM: priv}),
	}
	for _, issuer := range []string{"http://calab.test", "https://user:password@calab.test", "https://calab.test/#secret", "https://calab.test?secret=1"} {
		c := base
		c.Issuer = issuer
		cases[issuer] = c
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := signing.New(c)
			if !errors.Is(err, signing.ErrConfig) || err.Error() != signing.ErrConfig.Error() {
				t.Fatalf("not safely rejected: %v", err)
			}
		})
	}
	// Both supported alternative PEM encodings parse without a library fallback.
	pkcs8, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		t.Fatal(err)
	}
	ring(t, config(signing.Key{KID: "active", PEM: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})}))
	other := rsaKey(t, 2048)
	pkix, err := x509.MarshalPKIXPublicKey(&other.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	ring(t, config(signing.Key{KID: "active", PEM: priv}, signing.Key{KID: "old", PEM: pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pkix})}))
}

func TestTypedClaimsAndTemporalValidation(t *testing.T) {
	r := ring(t, config(signing.Key{KID: "active", PEM: privatePEM(rsaKey(t, 2048))}))
	mutations := map[string]func(*signing.Claims){
		"issuer": func(c *signing.Claims) { c.Issuer += "/" }, "audience": func(c *signing.Claims) { c.Audience = "client-b" }, "subject": func(c *signing.Claims) { c.Subject = " " },
		"zero-iat": func(c *signing.Claims) { c.IssuedAt = time.Time{} }, "zero-exp": func(c *signing.Claims) { c.ExpiresAt = time.Time{} },
		"expired":    func(c *signing.Claims) { c.IssuedAt = testNow.Add(-5 * time.Minute); c.ExpiresAt = testNow },
		"future-iat": func(c *signing.Claims) { c.IssuedAt = testNow.Add(time.Second) }, "long-ttl": func(c *signing.Claims) { c.ExpiresAt = testNow.Add(5*time.Minute + time.Second) },
		"exp-before-iat":         func(c *signing.Claims) { c.ExpiresAt = testNow.Add(-time.Second) },
		"nbf-future":             func(c *signing.Claims) { v := testNow.Add(time.Second); c.NotBefore = &v },
		"auth-future":            func(c *signing.Claims) { v := testNow.Add(time.Second); c.AuthTime = &v },
		"verified-without-email": func(c *signing.Claims) { yes := true; c.EmailVerified = &yes },
		"oversized":              func(c *signing.Claims) { c.Nonce = strings.Repeat("secret", 200) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			c := claims()
			mutate(&c)
			token, err := r.Sign(c, "client-a")
			if token != "" || !errors.Is(err, signing.ErrClaims) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
	c := claims()
	c.IssuedAt = testNow.Add(900 * time.Millisecond)
	c.ExpiresAt = testNow.Add(300 * time.Millisecond)
	if _, err := r.Sign(c, "client-a"); !errors.Is(err, signing.ErrClaims) {
		t.Fatal("accepted subsecond empty lifetime")
	}
	token, err := r.Sign(claims(), "client-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Verify(token, "client-b"); !errors.Is(err, signing.ErrToken) {
		t.Fatal("cross-client acceptance")
	}
	if _, err := r.Sign(claims(), ""); !errors.Is(err, signing.ErrClaims) {
		t.Fatal("empty expected audience")
	}
}

func TestAlgorithmKIDAndClaimConfusion(t *testing.T) {
	k := rsaKey(t, 2048)
	r := ring(t, config(signing.Key{KID: "active", PEM: privatePEM(k)}))
	base := jwt.MapClaims{"iss": claims().Issuer, "aud": "client-a", "sub": "opaque", "iat": testNow.Unix(), "exp": testNow.Add(time.Minute).Unix()}
	for _, method := range []jwt.SigningMethod{jwt.SigningMethodHS256, jwt.SigningMethodRS384, jwt.SigningMethodRS512, jwt.SigningMethodNone} {
		t.Run(method.Alg(), func(t *testing.T) {
			tok := jwt.NewWithClaims(method, base)
			tok.Header["kid"] = "active"
			var key any = k
			if method == jwt.SigningMethodHS256 {
				key = publicPEM(k)
			}
			if method == jwt.SigningMethodNone {
				key = jwt.UnsafeAllowNoneSignatureType
			}
			raw, err := tok.SignedString(key)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := r.Verify(raw, "client-a"); !errors.Is(err, signing.ErrToken) {
				t.Fatal("wrong algorithm accepted")
			}
		})
	}
	for _, kid := range []any{"unknown", "", nil, 42} {
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, base)
		tok.Header["kid"] = kid
		raw, err := tok.SignedString(k)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := r.Verify(raw, "client-a"); !errors.Is(err, signing.ErrToken) {
			t.Fatal("wrong kid accepted")
		}
	}
	for name, change := range map[string]func(jwt.MapClaims){"wrong-iss": func(c jwt.MapClaims) { c["iss"] = "https://other.test" }, "extra-claim": func(c jwt.MapClaims) { c["roles"] = []string{"admin"} }, "compound-claim": func(c jwt.MapClaims) { c["iss sub"] = "malicious" }, "missing-sub": func(c jwt.MapClaims) { delete(c, "sub") }, "missing-iat": func(c jwt.MapClaims) { delete(c, "iat") }, "missing-exp": func(c jwt.MapClaims) { delete(c, "exp") }, "multi-aud": func(c jwt.MapClaims) { c["aud"] = []string{"client-a", "client-b"} }, "fractional": func(c jwt.MapClaims) { c["exp"] = float64(testNow.Unix()) + 5.5 }} {
		t.Run(name, func(t *testing.T) {
			c := jwt.MapClaims{}
			for k, v := range base {
				c[k] = v
			}
			change(c)
			tok := jwt.NewWithClaims(jwt.SigningMethodRS256, c)
			tok.Header["kid"] = "active"
			raw, err := tok.SignedString(k)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := r.Verify(raw, "client-a"); !errors.Is(err, signing.ErrToken) {
				t.Fatal("bad claims accepted")
			}
		})
	}
	// Even correctly signed duplicate/reserved claims are rejected.
	for _, payload := range []string{fmt.Sprintf(`{"iss":%q,"aud":"client-a","sub":"a","sub":"b","iat":%d,"exp":%d}`, claims().Issuer, testNow.Unix(), testNow.Add(time.Minute).Unix()), `{"iss":"a"} {"iss":"b"}`} {
		raw := signRaw(t, k, `{"alg":"RS256","kid":"active","typ":"JWT"}`, payload)
		if _, err := r.Verify(raw, "client-a"); !errors.Is(err, signing.ErrToken) {
			t.Fatal("ambiguous JSON accepted")
		}
	}
	goodJSON, _ := json.Marshal(base)
	for _, header := range []string{`{"alg":"RS256","alg":"RS256","kid":"active","typ":"JWT"}`, `{"alg":"RS256","kid":"active","typ":"JWT","jku":"https://attacker.test"}`} {
		if _, err := r.Verify(signRaw(t, k, header, string(goodJSON)), "client-a"); !errors.Is(err, signing.ErrToken) {
			t.Fatal("ambiguous header accepted")
		}
	}
}

func signRaw(t *testing.T, k *rsa.PrivateKey, header, payload string) string {
	t.Helper()
	input := base64.RawURLEncoding.EncodeToString([]byte(header)) + "." + base64.RawURLEncoding.EncodeToString([]byte(payload))
	hash := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, k, crypto.SHA256, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func TestImmutableRotationOverlapAndExpiry(t *testing.T) {
	old, newKey := rsaKey(t, 2048), rsaKey(t, 2048)
	before := ring(t, config(signing.Key{KID: "active", PEM: privatePEM(old)}))
	oldToken, err := before.Sign(claims(), "client-a")
	if err != nil {
		t.Fatal(err)
	}
	staged := ring(t, config(signing.Key{KID: "active", PEM: privatePEM(old)}, signing.Key{KID: "next", PEM: publicPEM(newKey)}))
	if len(staged.PublicJWKS().Keys) != 2 {
		t.Fatal("new key was not prepublished")
	}
	cfg := config(signing.Key{KID: "active", PEM: publicPEM(old)}, signing.Key{KID: "next", PEM: privatePEM(newKey)})
	cfg.ActiveKID = "next"
	activated := ring(t, cfg)
	if _, err := activated.Verify(oldToken, "client-a"); err != nil {
		t.Fatal("lost overlap", err)
	}
	newToken, err := activated.Sign(claims(), "client-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := staged.Verify(newToken, "client-a"); err != nil {
		t.Fatal("prepublished key cannot verify", err)
	}
	cfg.Keys = []signing.Key{{KID: "next", PEM: privatePEM(newKey)}}
	retired := ring(t, cfg)
	if _, err := retired.Verify(oldToken, "client-a"); !errors.Is(err, signing.ErrToken) {
		t.Fatal("retired key accepted")
	}
	if _, err := before.Verify(newToken, "client-a"); !errors.Is(err, signing.ErrToken) {
		t.Fatal("unknown new key accepted")
	}
	cfg.Keys = append(cfg.Keys, signing.Key{KID: "active", PEM: publicPEM(old)})
	cfg.Now = func() time.Time { return testNow.Add(5 * time.Minute) }
	expired := ring(t, cfg)
	if _, err := expired.Verify(oldToken, "client-a"); !errors.Is(err, signing.ErrToken) {
		t.Fatal("expiry boundary accepted")
	}
	cfg.ClockSkew = time.Minute
	skew := ring(t, cfg)
	if _, err := skew.Verify(oldToken, "client-a"); err != nil {
		t.Fatal("approved verification skew ignored", err)
	}
	c := claims()
	if _, err := skew.Sign(c, "client-a"); !errors.Is(err, signing.ErrClaims) {
		t.Fatal("signer issued already expired token using skew")
	}
}

func TestConcurrentSignVerify(t *testing.T) {
	r := ring(t, config(signing.Key{KID: "active", PEM: privatePEM(rsaKey(t, 2048))}))
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 8 {
				raw, err := r.Sign(claims(), "client-a")
				if err != nil {
					t.Error(err)
					return
				}
				if _, err := r.Verify(raw, "client-a"); err != nil {
					t.Error(err)
					return
				}
				_ = r.PublicJWKS()
				_ = r.JWKSJSON()
			}
		})
	}
	wg.Wait()
}

func TestConfiguredLifetimeCannotExpandProviderProfile(t *testing.T) {
	cfg := config(signing.Key{KID: "active", PEM: privatePEM(rsaKey(t, 2048))})
	for _, lifetime := range []time.Duration{5*time.Minute + time.Nanosecond, 24 * time.Hour, -time.Second} {
		cfg.MaxLifetime = lifetime
		if _, err := signing.New(cfg); !errors.Is(err, signing.ErrConfig) {
			t.Fatalf("expanded lifetime accepted: %s", lifetime)
		}
	}
	cfg.MaxLifetime = 5 * time.Minute
	r := ring(t, cfg)
	if _, err := r.Sign(claims(), "client-a"); err != nil {
		t.Fatal("5-minute boundary refused", err)
	}
	c := claims()
	c.ExpiresAt = c.ExpiresAt.Add(time.Second)
	if _, err := r.Sign(c, "client-a"); !errors.Is(err, signing.ErrClaims) {
		t.Fatal("over-5-minute token issued")
	}
	cfg.MaxLifetime = time.Minute
	narrowed := ring(t, cfg)
	if _, err := narrowed.Sign(claims(), "client-a"); !errors.Is(err, signing.ErrClaims) {
		t.Fatal("narrower lifetime ignored")
	}
	c.ExpiresAt = testNow.Add(time.Minute)
	if _, err := narrowed.Sign(c, "client-a"); err != nil {
		t.Fatal("narrowed boundary refused", err)
	}
}
