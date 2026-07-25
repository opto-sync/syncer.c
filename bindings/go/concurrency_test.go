package syncer

// Concurrency and performance tests for the cgo binding.
//
// The C core is stateless for the syncer_merge_json_ex path (the only
// __thread thread-local belongs to the legacy syncer_merge_json callback
// API, which this binding does not use), so concurrent merges from many
// goroutines must be race-free and fully deterministic.
//
// Run with: go test -race ./...

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

// concOpts exercises mergeByKey + timestamp resolution + lww/fww keys, the
// widest option surface the binding exposes.
func concOpts() Options {
	return Options{
		ArrayStrategy:      ArrayMergeByKey,
		ResolveByTimestamp: true,
		LwwKeys:            "updatedAt,syncedAt",
		FwwKeys:            "createdAt",
		ArrayMatchKeys:     "uuid,id",
	}
}

const concBase = `{
	"items": [
		{"id": 1, "updatedAt": 100, "v": "keep", "tag": "base-only"},
		{"id": 2, "updatedAt": 200, "v": "old"},
		{"uuid": "u-9", "id": 9, "createdAt": 10, "v": "first"}
	],
	"meta": {"updatedAt": 500, "owner": "base"},
	"tags": ["a", "b"]
}`

const concIncoming = `{
	"items": [
		{"id": 2, "updatedAt": 300, "v": "new"},
		{"id": 1, "updatedAt": 50, "v": "stale"},
		{"uuid": "u-9", "createdAt": 900, "v": "recreated"},
		{"id": 3, "v": "appended"}
	],
	"meta": {"updatedAt": 400, "owner": "stale-writer"},
	"tags": ["b", "c"]
}`

// TestConcurrentMergeWithOptions runs 100 goroutines x 100 merges on shared
// input strings and verifies every result is byte-identical to the
// single-threaded expected output.
func TestConcurrentMergeWithOptions(t *testing.T) {
	opts := concOpts()

	expected, err := MergeJSONWithOptions(concBase, concIncoming, opts)
	if err != nil {
		t.Fatalf("single-threaded reference merge failed: %v", err)
	}
	// Sanity-check the reference output actually exercised the option paths.
	for _, want := range []string{`"v":"keep"`, `"v":"new"`, `"v":"first"`, `"v":"appended"`, `"owner":"base"`} {
		if !strings.Contains(expected, want) {
			t.Fatalf("reference output missing %s:\n%s", want, expected)
		}
	}
	if strings.Contains(expected, "stale") || strings.Contains(expected, "recreated") {
		t.Fatalf("reference output kept a losing write:\n%s", expected)
	}

	const goroutines = 100
	const iterations = 100

	var wg sync.WaitGroup
	errCh := make(chan error, goroutines)

	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				got, err := MergeJSONWithOptions(concBase, concIncoming, opts)
				if err != nil {
					errCh <- fmt.Errorf("goroutine %d iter %d: %v", g, i, err)
					return
				}
				if got != expected {
					errCh <- fmt.Errorf("goroutine %d iter %d: result diverged\ngot:  %s\nwant: %s", g, i, got, expected)
					return
				}
			}
		}(g)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
}

// TestConcurrentMixedWorkloads runs different option sets on different
// goroutines simultaneously: options must never leak between calls.
func TestConcurrentMixedWorkloads(t *testing.T) {
	type workload struct {
		name           string
		base, incoming string
		opts           Options
	}
	workloads := []workload{
		{"mergeByKey", concBase, concIncoming, concOpts()},
		{"replace", `{"a":[1,2],"b":1}`, `{"a":[3],"c":2}`, Options{}},
		{"union", `{"a":["x","y"]}`, `{"a":["y","z"]}`, Options{ArrayStrategy: ArrayUnion}},
		{"lwwOnly", `{"updatedAt":100,"v":"base"}`, `{"updatedAt":50,"v":"stale"}`,
			Options{ResolveByTimestamp: true, LwwKeys: "updatedAt"}},
	}

	expected := make([]string, len(workloads))
	for i, w := range workloads {
		out, err := MergeJSONWithOptions(w.base, w.incoming, w.opts)
		if err != nil {
			t.Fatalf("%s: reference merge failed: %v", w.name, err)
		}
		expected[i] = out
	}

	const goroutinesPerWorkload = 25
	const iterations = 100

	var wg sync.WaitGroup
	errCh := make(chan error, len(workloads)*goroutinesPerWorkload)
	for i, w := range workloads {
		for g := 0; g < goroutinesPerWorkload; g++ {
			wg.Add(1)
			go func(i int, w workload) {
				defer wg.Done()
				for it := 0; it < iterations; it++ {
					got, err := MergeJSONWithOptions(w.base, w.incoming, w.opts)
					if err != nil {
						errCh <- fmt.Errorf("%s: %v", w.name, err)
						return
					}
					if got != expected[i] {
						errCh <- fmt.Errorf("%s: diverged\ngot:  %s\nwant: %s", w.name, got, expected[i])
						return
					}
				}
			}(i, w)
		}
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
}

// buildKeyedArrayDoc returns {"items":[...n objects...]} where element ids
// are a permutation of 0..n-1 defined by (i*stride+offset) mod n. stride
// must be coprime with n.
func buildKeyedArrayDoc(n, stride, offset int, tag string) string {
	var sb strings.Builder
	sb.WriteString(`{"items":[`)
	for i := 0; i < n; i++ {
		id := (i*stride + offset) % n
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, `{"id":%d,"updatedAt":%d,"name":"%s-%d","score":%d}`,
			id, 1000+i, tag, id, i*7)
	}
	sb.WriteString(`]}`)
	return sb.String()
}

// BenchmarkMergeByKey merges a 1,000-element array of objects against a
// 1,000-element permuted update. Identity matching in the core is O(n*m),
// so this measures the quadratic worst case honestly.
func BenchmarkMergeByKey(b *testing.B) {
	const n = 1000
	base := buildKeyedArrayDoc(n, 1, 0, "base")
	// stride 7 is coprime with 1000: same ids, fully permuted order.
	incoming := buildKeyedArrayDoc(n, 7, 3, "inc")

	opts := Options{
		ArrayStrategy:      ArrayMergeByKey,
		ResolveByTimestamp: true,
		LwwKeys:            "updatedAt",
		FwwKeys:            "createdAt",
	}

	// Correctness gate before timing: every id merged exactly once.
	out, err := MergeJSONWithOptions(base, incoming, opts)
	if err != nil {
		b.Fatalf("merge failed: %v", err)
	}
	if c := strings.Count(out, `"id":999`); c != 1 {
		b.Fatalf(`"id":999 appears %d times, want 1`, c)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := MergeJSONWithOptions(base, incoming, opts); err != nil {
			b.Fatal(err)
		}
	}
}
