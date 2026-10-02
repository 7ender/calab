// Package identitynet provides bounded HTTPS access to exact identity endpoints.
// Build Config from operator-owned policy, never from discovery or admin URLs alone.
// Each Endpoint pins its complete URL (including any query), host, port, CA, and
// optional CIDRs. PrivateCIDRs only permit RFC1918/ULA addresses at that endpoint;
// TestLoopbackCIDRs are a separate, literal-address-only test exception. Neither
// permits metadata, link-local, multicast, or unspecified destinations. TLS chain
// and hostname verification always apply, including to test and on-prem endpoints.
//
// NewClient exposes Do with redacted errors. NewTransport supports OIDC libraries,
// but a caller wrapping it in net/http.Client must redact that client's url.Error
// before logging (net/http itself adds the request URL to Do errors). Callers must
// close response bodies. Limits cover decompressed response bytes and the entire
// request, including body reading; redirects are rejected even by the transport.
package identitynet
