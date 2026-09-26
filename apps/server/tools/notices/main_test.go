package main

import (
	"bytes"
	"os"
	"testing"
)

// The notices describe the image (linux/amd64) whatever the host: generating them with a
// different host GOOS/GOARCH must reproduce the committed file byte for byte. This also
// fails when a dependency change was not followed by `make third-party-notices`.
func TestNoticesAreHostIndependent(t *testing.T) {
	want, err := os.ReadFile("../../THIRD-PARTY-NOTICES.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, host := range [][2]string{{"darwin", "arm64"}, {"windows", "amd64"}, {"linux", "arm64"}} {
		t.Run(host[0]+"/"+host[1], func(t *testing.T) {
			t.Setenv("GOOS", host[0])
			t.Setenv("GOARCH", host[1])
			var got bytes.Buffer
			if err := generate(&got); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got.Bytes(), want) {
				t.Fatal("THIRD-PARTY-NOTICES.txt differs from the generated notices: run `make third-party-notices` and commit")
			}
		})
	}
}

func TestClassify(t *testing.T) {
	for text, want := range map[string]string{
		"Apache License\nVersion 2.0, January 2004":                              "Apache-2.0",
		"Permission is hereby granted, free of charge, to any person":            "MIT",
		"Redistribution and use in source and binary forms ... Neither the name": "BSD-3-Clause",
		"GNU AFFERO GENERAL PUBLIC LICENSE Version 3":                            "AGPL",
		"Server Side Public License VERSION 1":                                   "SSPL",
		"something else":                                                         "UNKNOWN",
	} {
		if got := classify(text); got != want {
			t.Errorf("%q: %s, want %s", text, got, want)
		}
	}
}
