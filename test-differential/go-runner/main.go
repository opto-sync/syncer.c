// run_go — Go runner for the differential test.
// Usage: run_go <input.jsonl> <output.jsonl>
//
// Splits each line textually on the unique `,"incoming":` marker (corpus
// generator contract) — no JSON parsing, int64 text preserved. Output lines
// are written exactly as returned by the binding.
package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	syncer "github.com/opto-sync/syncer-go"
)

const (
	marker = `,"incoming":`
	prefix = `{"base":`
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: run_go <input.jsonl> <output.jsonl>")
		os.Exit(2)
	}
	opts := syncer.Options{
		ArrayStrategy:      syncer.ArrayMergeByKey, // 4
		MaxDepth:           0,
		DetectCircularRefs: false,
		ResolveByTimestamp: true,
		LwwKeys:            "updatedAt,syncedAt",
		FwwKeys:            "createdAt",
		ArrayMatchKeys:     "id",
	}

	in, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	defer in.Close()
	out, err := os.Create(os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	defer out.Close()
	w := bufio.NewWriter(out)
	defer w.Flush()

	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	failures := 0
	lineno := 0
	for sc.Scan() {
		lineno++
		line := sc.Text()
		if line == "" {
			continue
		}
		idx := strings.Index(line, marker)
		if idx < 0 || !strings.HasPrefix(line, prefix) || !strings.HasSuffix(line, "}") {
			fmt.Fprintf(os.Stderr, "line %d: malformed corpus line\n", lineno)
			failures++
			fmt.Fprintln(w, "!MALFORMED")
			continue
		}
		base := line[len(prefix):idx]
		inc := line[idx+len(marker) : len(line)-1]
		merged, err := syncer.MergeJSONWithOptions(base, inc, opts)
		if err != nil {
			fmt.Fprintf(os.Stderr, "line %d: merge failed: %v\n", lineno, err)
			failures++
			fmt.Fprintln(w, "!NULL")
			continue
		}
		fmt.Fprintln(w, merged)
	}
	if err := sc.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if failures > 0 {
		os.Exit(1)
	}
}
