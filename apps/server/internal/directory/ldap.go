// Package directory synchronizes workspace eligibility from a read-only AD directory.
package directory

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitynet"
	"github.com/calaba/calaba/server/internal/unfurl"
	"github.com/go-ldap/ldap/v3"
	"github.com/google/uuid"
)

// ErrDirectory hides LDAP server diagnostics and credentials.
var ErrDirectory = errors.New("directory dependency unavailable")

// HostPolicy is supplied by the operator, independently of workspace configuration.
type HostPolicy struct {
	Networks     []netip.Prefix
	TestLoopback bool
	// Workspaces binds the host to exact workspaces (IDENTITY_DIRECTORY_HOSTS workspace_ids);
	// empty = every workspace, which config allows only for the on-prem enterprise edition.
	Workspaces map[uuid.UUID]bool
}

// LDAP scans only exact operator-approved hosts, with checked literal TCP peers.
type LDAP struct {
	Hosts    map[string]HostPolicy
	Resolver identitynet.Resolver
	Dialer   identitynet.Dialer
}

// Object is one full-snapshot record, keyed by stable AD objectGUID.
type Object struct {
	GUID               uuid.UUID
	DN                 string
	Eligible, Disabled bool
}

// ObjectGUID decodes AD's mixed-endian binary GUID without using DN or email identity.
func ObjectGUID(raw []byte) (uuid.UUID, error) {
	if len(raw) != 16 {
		return uuid.Nil, ErrDirectory
	}
	b := append([]byte(nil), raw...)
	b[0], b[1], b[2], b[3] = raw[3], raw[2], raw[1], raw[0]
	b[4], b[5] = raw[5], raw[4]
	b[6], b[7] = raw[7], raw[6]
	id, err := uuid.FromBytes(b)
	if err != nil || id == uuid.Nil {
		return uuid.Nil, ErrDirectory
	}
	return id, nil
}

// Validate rejects unapproved hosts, plain LDAP, filters, referrals and anonymous binds.
func (l *LDAP) Validate(c sqlc.WorkspaceDirectory) error {
	u, err := url.Parse(c.Url)
	if l == nil || err != nil || u.Scheme != "ldaps" || u.User != nil || u.Hostname() != c.Host || u.Port() != "636" && u.Port() != "" || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || c.Port != 636 || c.Host != strings.ToLower(c.Host) || strings.HasSuffix(c.Host, ".") || c.BaseDn == "" || c.BindDn == "" {
		return ErrDirectory
	}
	policy, ok := l.Hosts[c.Host]
	if !ok || len(policy.Networks) == 0 || len(policy.Workspaces) > 0 && !policy.Workspaces[c.WorkspaceID] {
		return ErrDirectory
	}
	if _, err = ldap.ParseDN(c.BaseDn); err != nil {
		return ErrDirectory
	}
	if _, err = ldap.ParseDN(c.BindDn); err != nil {
		return ErrDirectory
	}
	if len(c.AllowedGroupDns) > 100 {
		return ErrDirectory
	}
	for _, dn := range c.AllowedGroupDns {
		if _, err = ldap.ParseDN(dn); err != nil {
			return ErrDirectory
		}
	}
	if c.CaPem != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(c.CaPem)) {
			return ErrDirectory
		}
	}
	return nil
}
func allowed(p HostPolicy, a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || a.Zone() != "" || (!a.IsPrivate() && !unfurl.PublicAddr(a) && (!a.IsLoopback() || !p.TestLoopback)) || a == netip.MustParseAddr("168.63.129.16") || a == netip.MustParseAddr("fd00:ec2::254") || a == netip.MustParseAddr("fd20:ce::254") {
		return false
	}
	for _, n := range p.Networks {
		if n.IsValid() && n.Contains(a) {
			return true
		}
	}
	return false
}
func (l *LDAP) connect(ctx context.Context, c sqlc.WorkspaceDirectory) (*ldap.Conn, func(), error) {
	if l.Validate(c) != nil {
		return nil, nil, ErrDirectory
	}
	resolver := l.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	dialer := l.Dialer
	if dialer == nil {
		dialer = &net.Dialer{Timeout: 3 * time.Second}
	}
	addresses, err := resolver.LookupNetIP(ctx, "ip", c.Host)
	if err != nil || len(addresses) == 0 || len(addresses) > 32 {
		return nil, nil, ErrDirectory
	}
	policy := l.Hosts[c.Host]
	for _, a := range addresses {
		if !allowed(policy, a) {
			return nil, nil, ErrDirectory
		}
	}
	var raw net.Conn
	for _, a := range addresses {
		raw, err = dialer.DialContext(ctx, "tcp", net.JoinHostPort(a.String(), "636"))
		if err != nil {
			continue
		}
		peer, ok := raw.RemoteAddr().(*net.TCPAddr)
		if !ok || peer.Port != 636 || peer.AddrPort().Addr().Unmap() != a.Unmap() || !allowed(policy, peer.AddrPort().Addr()) {
			_ = raw.Close()
			return nil, nil, ErrDirectory
		}
		break
	}
	if raw == nil || err != nil {
		return nil, nil, ErrDirectory
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		_ = raw.Close()
		return nil, nil, ErrDirectory
	}
	if c.CaPem != "" && !roots.AppendCertsFromPEM([]byte(c.CaPem)) {
		_ = raw.Close()
		return nil, nil, ErrDirectory
	}
	secure := tls.Client(raw, &tls.Config{MinVersion: tls.VersionTLS12, ServerName: c.Host, RootCAs: roots})
	if err = secure.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, nil, ErrDirectory
	}
	deadline, _ := ctx.Deadline()
	_ = secure.SetDeadline(deadline)
	conn := ldap.NewConn(&boundedLDAPConn{Conn: secure, budget: 128 << 20}, true)
	conn.SetTimeout(10 * time.Second)
	conn.Start()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	return conn, func() { stop(); _ = conn.Close() }, nil
}

// Scan returns a bounded complete snapshot; a failed page returns no usable records.
func (l *LDAP) Scan(ctx context.Context, c sqlc.WorkspaceDirectory, password string) ([]Object, error) {
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	if password == "" {
		return nil, ErrDirectory
	}
	conn, closeConn, err := l.connect(ctx, c)
	if err != nil {
		return nil, err
	}
	defer closeConn()
	if err = conn.Bind(c.BindDn, password); err != nil {
		return nil, ErrDirectory
	}
	paging := ldap.NewControlPaging(500)
	objects := make([]Object, 0)
	seen := map[uuid.UUID]bool{}
	cookies := map[string]bool{}
	for {
		if ctx.Err() != nil {
			return nil, ErrDirectory
		}
		request := ldap.NewSearchRequest(c.BaseDn, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 10, false, "(&(objectCategory=person)(objectClass=user))", []string{"objectGUID", "userAccountControl", "memberOf"}, []ldap.Control{paging})
		result, err := conn.Search(request)
		if err != nil || len(result.Referrals) > 0 {
			return nil, ErrDirectory
		}
		for _, entry := range result.Entries {
			object, err := decode(entry, c.AllowedGroupDns)
			if err != nil || seen[object.GUID] || len(objects) >= 100000 {
				return nil, ErrDirectory
			}
			seen[object.GUID] = true
			objects = append(objects, object)
		}
		control := ldap.FindControl(result.Controls, ldap.ControlTypePaging)
		next, ok := control.(*ldap.ControlPaging)
		if !ok {
			return nil, ErrDirectory
		}
		if len(next.Cookie) == 0 {
			break
		}
		if len(next.Cookie) > 4096 {
			return nil, ErrDirectory
		}
		if cookies[string(next.Cookie)] {
			return nil, ErrDirectory
		}
		cookies[string(next.Cookie)] = true
		paging.SetCookie(next.Cookie)
	}
	return objects, nil
}
func decode(entry *ldap.Entry, groups []string) (Object, error) {
	if len(entry.DN) > 4096 || len(entry.GetAttributeValues("memberOf")) > 1000 {
		return Object{}, ErrDirectory
	}
	guid, err := ObjectGUID(entry.GetRawAttributeValue("objectGUID"))
	if err != nil {
		return Object{}, err
	}
	uac, err := strconv.ParseUint(entry.GetAttributeValue("userAccountControl"), 10, 32)
	if err != nil {
		return Object{}, ErrDirectory
	}
	if _, err = ldap.ParseDN(entry.DN); err != nil {
		return Object{}, ErrDirectory
	}
	eligible := len(groups) == 0
	for _, raw := range entry.GetAttributeValues("memberOf") {
		if len(raw) > 4096 {
			return Object{}, ErrDirectory
		}
		member, err := ldap.ParseDN(raw)
		if err != nil {
			return Object{}, ErrDirectory
		}
		for _, wanted := range groups {
			dn, err := ldap.ParseDN(wanted)
			if err != nil {
				return Object{}, ErrDirectory
			}
			if member.EqualFold(dn) {
				eligible = true
			}
		}
	}
	return Object{GUID: guid, DN: entry.DN, Eligible: eligible, Disabled: uac&2 != 0}, nil
}
