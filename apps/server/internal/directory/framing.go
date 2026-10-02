package directory

import (
	"encoding/binary"
	"io"
	"net"
)

// boundedLDAPConn validates the definite outer LDAPMessage length before go-ldap's
// BER decoder sees a header and allocates a payload. No process-global parser knob
// is changed, so independent/concurrent directory sessions retain their own budgets.
type boundedLDAPConn struct {
	net.Conn
	header    []byte
	remaining int64
	budget    int64
}

func (c *boundedLDAPConn) Read(dst []byte) (int, error) {
	if len(dst) == 0 {
		return 0, nil
	}
	if len(c.header) == 0 && c.remaining == 0 {
		var first [2]byte
		if _, err := io.ReadFull(c.Conn, first[:]); err != nil {
			return 0, err
		}
		if first[0] != 0x30 {
			return 0, ErrDirectory
		}
		header := append([]byte(nil), first[:]...)
		length := uint32(first[1])
		if first[1]&0x80 != 0 {
			count := int(first[1] & 0x7f)
			if count < 1 || count > 4 {
				return 0, ErrDirectory
			}
			var raw [4]byte
			if _, err := io.ReadFull(c.Conn, raw[4-count:]); err != nil {
				return 0, err
			}
			length = binary.BigEndian.Uint32(raw[:])
			header = append(header, raw[4-count:]...)
		}
		if length == 0 || length > 1<<20 || int64(length)+int64(len(header)) > c.budget {
			return 0, ErrDirectory
		}
		c.budget -= int64(length) + int64(len(header))
		c.remaining = int64(length)
		c.header = header
	}
	if len(c.header) > 0 {
		n := copy(dst, c.header)
		c.header = c.header[n:]
		return n, nil
	}
	if int64(len(dst)) > c.remaining {
		dst = dst[:c.remaining]
	}
	n, err := c.Conn.Read(dst)
	c.remaining -= int64(n)
	return n, err
}
