//go:build integration

package app_test

import "net/netip"

type netipPrefix = netip.Prefix

func parsePrefixes(ss []string) []netip.Prefix {
	out := make([]netip.Prefix, len(ss))
	for i, s := range ss {
		out[i] = netip.MustParsePrefix(s)
	}
	return out
}
