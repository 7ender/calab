// Command notices writes THIRD-PARTY-NOTICES.txt: the license texts of every Go module
// linked into the server binary (go list -deps ./cmd/server, as built in the Dockerfile).
// It fails on copyleft (GPL / LGPL / AGPL), unknown licenses and modules without a
// license file, so a new dependency with such terms cannot slip in unnoticed.
//
//	go run ./tools/notices > THIRD-PARTY-NOTICES.txt   (make third-party-notices)
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type module struct {
	Path, Version, Dir string
	Replace            *module
}

type pkg struct {
	Standard bool
	Module   *module
}

// License and NOTICE files (Apache-2.0 requires reproducing NOTICE), e.g. LICENSE,
// LICENSE.md, NOTICE, lib/LICENSE.libwebp (C code transpiled into Go by the module).
var licenseFile = regexp.MustCompile(`(?i)^(licen[cs]e|copying|notice)(\.(md|txt|rst)|[._-][a-z0-9]+)?$`)

// classify maps a license text to an SPDX id by its characteristic wording.
func classify(text string) string {
	t := strings.Join(strings.Fields(text), " ")
	switch {
	case strings.Contains(t, "GNU AFFERO GENERAL PUBLIC LICENSE"):
		return "AGPL"
	case strings.Contains(t, "GNU LESSER GENERAL PUBLIC LICENSE"):
		return "LGPL"
	case strings.Contains(t, "GNU GENERAL PUBLIC LICENSE"):
		return "GPL"
	case strings.Contains(t, "Apache License") && strings.Contains(t, "Version 2.0"):
		return "Apache-2.0"
	case strings.Contains(t, "Mozilla Public License"):
		return "MPL-2.0"
	case strings.Contains(t, "Permission is hereby granted, free of charge"):
		return "MIT"
	case strings.Contains(t, "Permission to use, copy, modify, and/or distribute"),
		strings.Contains(t, "Permission to use, copy, modify, and distribute this software for any purpose with or without fee"):
		return "ISC"
	case strings.Contains(t, "Redistribution and use in source and binary forms"):
		if strings.Contains(t, "Neither the name") || strings.Contains(t, "names of its contributors") {
			return "BSD-3-Clause"
		}
		return "BSD-2-Clause"
	}
	return "UNKNOWN"
}

var forbidden = map[string]bool{"GPL": true, "LGPL": true, "AGPL": true, "UNKNOWN": true}

func modules() ([]module, error) {
	cmd := exec.CommandContext(context.Background(), "go", "list", "-deps", "-tags", "nodynamic", "-json=Standard,Module", "./cmd/server")
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	seen := map[string]module{}
	dec := json.NewDecoder(bytes.NewReader(out))
	for {
		var p pkg
		if err := dec.Decode(&p); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return nil, err
		}
		if p.Standard || p.Module == nil || p.Module.Version == "" { // stdlib, main module
			continue
		}
		m := *p.Module
		if m.Replace != nil {
			m.Dir = m.Replace.Dir
		}
		seen[m.Path] = m
	}
	list := make([]module, 0, len(seen))
	for _, m := range seen {
		list = append(list, m)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Path < list[j].Path })
	return list, nil
}

// licenseText collects license / NOTICE files from the module root and its direct
// subdirectories (bundled third-party code keeps its license there).
func licenseText(dir string) (license, all string, err error) {
	var lic, parts []string
	var walk func(d, rel string, depth int) error
	walk = func(d, rel string, depth int) error {
		entries, err := os.ReadDir(d)
		if err != nil {
			return err
		}
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() {
				if depth == 0 && name != "testdata" && name != "vendor" && !strings.HasPrefix(name, ".") {
					if err := walk(filepath.Join(d, name), name+"/", 1); err != nil {
						return err
					}
				}
				continue
			}
			if !licenseFile.MatchString(name) {
				continue
			}
			b, err := os.ReadFile(filepath.Join(d, name)) //nolint:gosec // module cache path
			if err != nil {
				return err
			}
			text := strings.TrimSpace(string(b))
			if !strings.HasPrefix(strings.ToLower(name), "notice") {
				lic = append(lic, text)
			}
			parts = append(parts, "--- "+rel+name+" ---\n"+text)
		}
		return nil
	}
	if err := walk(dir, "", 0); err != nil {
		return "", "", err
	}
	return strings.Join(lic, "\n\n"), strings.Join(parts, "\n\n"), nil
}

func run() error {
	mods, err := modules()
	if err != nil {
		return err
	}
	var body strings.Builder
	var problems []string
	summary := map[string][]string{}
	for _, m := range mods {
		lic, text, err := licenseText(m.Dir)
		if err != nil {
			return fmt.Errorf("%s: %w", m.Path, err)
		}
		id := "UNKNOWN"
		if lic != "" {
			id = classify(lic)
		}
		summary[id] = append(summary[id], m.Path)
		if forbidden[id] {
			problems = append(problems, fmt.Sprintf("%s %s: %s", m.Path, m.Version, id))
		}
		fmt.Fprintf(&body, "\n%s\n%s %s — %s\n%s\n\n%s\n", strings.Repeat("=", 80), m.Path, m.Version, id, strings.Repeat("=", 80), text)
	}
	fmt.Println("Calaba server — third-party notices")
	fmt.Println()
	fmt.Println("The server binary includes the following Go modules. Their license texts follow.")
	fmt.Println("Generated by `make third-party-notices` (apps/server/tools/notices); do not edit.")
	fmt.Println()
	ids := make([]string, 0, len(summary))
	for id := range summary {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		fmt.Printf("%s (%d): %s\n", id, len(summary[id]), strings.Join(summary[id], ", "))
	}
	fmt.Print(body.String())
	if len(problems) > 0 {
		return fmt.Errorf("licenses that need review:\n  %s", strings.Join(problems, "\n  "))
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "notices:", err)
		os.Exit(1)
	}
}
