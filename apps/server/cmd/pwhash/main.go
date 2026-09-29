// Command pwhash reads one password line from stdin and prints its PHC argon2id hash with the
// server's parameters (auth.HashPassword). Used by infra/docker/tools/rotate-accounts.sh; the
// password never appears in argv or output.
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/calaba/calaba/server/internal/auth"
)

func main() {
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	pw := strings.TrimRight(line, "\r\n")
	if pw == "" {
		fmt.Fprintln(os.Stderr, "pwhash: empty password on stdin", err)
		os.Exit(2)
	}
	h, err := auth.HashPassword(context.Background(), pw)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pwhash:", err)
		os.Exit(1)
	}
	fmt.Println(h)
}
