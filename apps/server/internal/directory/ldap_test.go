package directory

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	ber "github.com/go-asn1-ber/asn1-ber"
	"github.com/go-ldap/ldap/v3"
)

func TestADGUIDAndEligibility(t *testing.T) {
	raw, _ := hex.DecodeString("33221100554477668899aabbccddeeff")
	id, err := ObjectGUID(raw)
	if err != nil || id.String() != "00112233-4455-6677-8899-aabbccddeeff" {
		t.Fatal("GUID endian mismatch")
	}
	entry := ldap.NewEntry("CN=Alice,DC=example,DC=test", map[string][]string{"objectGUID": {string(raw)}, "userAccountControl": {"514"}, "memberOf": {"cn=Allowed,dc=example,dc=test"}})
	object, err := decode(entry, []string{"CN=Allowed,DC=example,DC=test"})
	if err != nil || !object.Disabled || !object.Eligible {
		t.Fatalf("AD flags: %v %+v", err, object)
	}
	object, err = decode(entry, []string{"CN=Different,DC=example,DC=test"})
	if err != nil || object.Eligible {
		t.Fatal("nested/unknown group accepted")
	}
	if _, err = ObjectGUID(raw[:15]); err == nil {
		t.Fatal("short GUID accepted")
	}
}

type ldapFixture struct {
	listener    net.Listener
	certificate string
	mu          sync.Mutex
	entries     []*ldap.Entry
	failPage    int
	oversized   bool
	connections sync.WaitGroup
}
type fixturePeer struct{ net.Conn }

func (c fixturePeer) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 636}
}

type fixtureDialer struct{ address string }

func (d fixtureDialer) DialContext(ctx context.Context, network, _ string) (net.Conn, error) {
	conn, err := (&net.Dialer{}).DialContext(ctx, network, d.address)
	if err != nil {
		return nil, err
	}
	return fixturePeer{conn}, nil
}
func newLDAPFixture(t *testing.T) (*ldapFixture, *LDAP, sqlc.WorkspaceDirectory) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "LDAP fixture"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, DNSNames: []string{"localhost"}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}})
	if err != nil {
		t.Fatal(err)
	}
	fixture := &ldapFixture{listener: listener, certificate: string(certificate), failPage: -1}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			fixture.connections.Add(1)
			go func() { defer fixture.connections.Done(); fixture.serve(conn) }()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); <-done; fixture.connections.Wait() })
	client := &LDAP{Hosts: map[string]HostPolicy{"127.0.0.1": {Networks: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}, TestLoopback: true}}, Dialer: fixtureDialer{address: listener.Addr().String()}}
	config := sqlc.WorkspaceDirectory{Host: "127.0.0.1", Url: "ldaps://127.0.0.1:636", Port: 636, BaseDn: "DC=example,DC=test", BindDn: "CN=Service,DC=example,DC=test", CaPem: string(certificate), AllowedGroupDns: []string{"CN=Allowed,DC=example,DC=test"}}
	return fixture, client, config
}
func ldapPacket(id int64, operation *ber.Packet, control ldap.Control) *ber.Packet {
	packet := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "LDAPMessage")
	packet.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, id, "messageID"))
	packet.AppendChild(operation)
	if control != nil {
		controls := ber.Encode(ber.ClassContext, ber.TypeConstructed, 0, nil, "controls")
		controls.AppendChild(control.Encode())
		packet.AppendChild(controls)
	}
	return packet
}
func ldapResult(tag ber.Tag, code int64) *ber.Packet {
	response := ber.Encode(ber.ClassApplication, ber.TypeConstructed, tag, nil, "result")
	response.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, code, "resultCode"))
	response.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "matchedDN"))
	response.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "diagnosticMessage"))
	return response
}
func (f *ldapFixture) serve(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	page := 0
	for {
		request, err := ber.ReadPacket(conn)
		if err != nil || len(request.Children) < 2 {
			return
		}
		id, ok := request.Children[0].Value.(int64)
		if !ok {
			return
		}
		operation := request.Children[1]
		switch operation.Tag {
		case ldap.ApplicationBindRequest:
			code := int64(0)
			if len(operation.Children) != 3 || operation.Children[1].Value != "CN=Service,DC=example,DC=test" || operation.Children[2].Data.String() != "fixture-password" {
				code = 49
			}
			if _, err = conn.Write(ldapPacket(id, ldapResult(ldap.ApplicationBindResponse, code), nil).Bytes()); err != nil {
				return
			}
		case ldap.ApplicationSearchRequest:
			f.mu.Lock()
			entries := append([]*ldap.Entry(nil), f.entries...)
			fail := f.failPage
			oversized := f.oversized
			f.mu.Unlock()
			if oversized {
				_, _ = conn.Write([]byte{0x30, 0x84, 0x7f, 0xff, 0xff, 0xff})
				return
			}
			if page == fail {
				_, _ = conn.Write(ldapPacket(id, ldapResult(ldap.ApplicationSearchResultDone, ldap.LDAPResultUnavailable), nil).Bytes())
				return
			}
			if page < len(entries) {
				entry := entries[page]
				response := ber.Encode(ber.ClassApplication, ber.TypeConstructed, ldap.ApplicationSearchResultEntry, nil, "entry")
				response.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, entry.DN, "dn"))
				attrs := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "attributes")
				for _, a := range entry.Attributes {
					attribute := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "attribute")
					attribute.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, a.Name, "type"))
					values := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSet, nil, "values")
					for _, v := range a.ByteValues {
						values.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, string(v), "value"))
					}
					attribute.AppendChild(values)
					attrs.AppendChild(attribute)
				}
				response.AppendChild(attrs)
				if _, err = conn.Write(ldapPacket(id, response, nil).Bytes()); err != nil {
					return
				}
			}
			paging := ldap.NewControlPaging(500)
			if page+1 < len(entries) {
				paging.SetCookie([]byte{byte(page + 1)})
			}
			if _, err = conn.Write(ldapPacket(id, ldapResult(ldap.ApplicationSearchResultDone, 0), paging).Bytes()); err != nil {
				return
			}
			page++
		default:
			return
		}
	}
}
func fixtureEntry(guid string, uac string) *ldap.Entry {
	raw, _ := hex.DecodeString(guid)
	return ldap.NewEntry("CN=Alice,DC=example,DC=test", map[string][]string{"objectGUID": {string(raw)}, "userAccountControl": {uac}, "memberOf": {"CN=Allowed,DC=example,DC=test"}})
}
func TestLDAPSVerifiedPagedAndFailedSnapshot(t *testing.T) {
	f, client, c := newLDAPFixture(t)
	f.entries = []*ldap.Entry{fixtureEntry("33221100554477668899aabbccddeeff", "512"), fixtureEntry("34221100554477668899aabbccddeeff", "514")}
	result, err := client.Scan(context.Background(), c, "fixture-password")
	if err != nil || len(result) != 2 || result[0].Disabled || !result[1].Disabled {
		t.Fatalf("paged scan %v %+v", err, result)
	}
	bad := c
	bad.CaPem = ""
	if _, err = client.Scan(context.Background(), bad, "fixture-password"); err == nil {
		t.Fatal("untrusted CA accepted")
	}
	if _, err = client.Scan(context.Background(), c, ""); err == nil {
		t.Fatal("anonymous bind accepted")
	}
	f.mu.Lock()
	f.failPage = 1
	f.mu.Unlock()
	if partial, err := client.Scan(context.Background(), c, "fixture-password"); err == nil || partial != nil {
		t.Fatal("failed page published")
	}
	f.mu.Lock()
	f.failPage = -1
	f.oversized = true
	f.mu.Unlock()
	if _, err = client.Scan(context.Background(), c, "fixture-password"); err == nil {
		t.Fatal("oversized BER accepted")
	}
}
func TestLDAPHostAndTLSRestrictions(t *testing.T) {
	_, client, c := newLDAPFixture(t)
	for _, raw := range []string{"ldap://127.0.0.1:636", "ldaps://127.0.0.1:389", "ldaps://127.0.0.1:636/?filter=*", "ldaps://user:secret@127.0.0.1:636", "ldaps://127.0.0.1:636/dc=test"} {
		c.Url = raw
		if client.Validate(c) == nil {
			t.Fatal("unsafe endpoint accepted")
		}
	}
	if allowed(HostPolicy{Networks: []netip.Prefix{netip.MustParsePrefix("169.254.0.0/16")}}, netip.MustParseAddr("169.254.169.254")) {
		t.Fatal("metadata IP accepted")
	}
}
