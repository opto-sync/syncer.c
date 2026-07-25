package syncer

import (
	"encoding/json"
	"strings"
	"testing"
)

func mustParse(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("result is not valid JSON: %v\n%s", err, s)
	}
	return m
}

func TestVersion(t *testing.T) {
	v := Version()
	if v == "" || strings.Count(v, ".") != 2 {
		t.Fatalf("Version() = %q, want major.minor.patch", v)
	}
}

func TestBasicMerge(t *testing.T) {
	got, err := MergeJSON(
		`{"a": 1, "b": {"c": 2}}`,
		`{"b": {"d": 3}, "e": 4}`,
	)
	if err != nil {
		t.Fatal(err)
	}
	m := mustParse(t, got)
	b := m["b"].(map[string]any)
	if m["a"].(float64) != 1 || b["c"].(float64) != 2 || b["d"].(float64) != 3 || m["e"].(float64) != 4 {
		t.Fatalf("unexpected merge result: %s", got)
	}
}

func TestMergeByKeyReconciliation(t *testing.T) {
	// Matched id=1 deep-merges; id=3 appends; id=2 (base-only) survives.
	got, err := MergeJSONWithOptions(
		`{"items":[{"id":1,"name":"alpha","qty":5},{"id":2,"name":"beta"}]}`,
		`{"items":[{"id":1,"qty":7},{"id":3,"name":"gamma"}]}`,
		Options{ArrayStrategy: ArrayMergeByKey},
	)
	if err != nil {
		t.Fatal(err)
	}
	m := mustParse(t, got)
	items := m["items"].([]any)
	if len(items) != 3 {
		t.Fatalf("want 3 items, got %d: %s", len(items), got)
	}
	byID := map[float64]map[string]any{}
	for _, it := range items {
		o := it.(map[string]any)
		byID[o["id"].(float64)] = o
	}
	if byID[1]["name"] != "alpha" || byID[1]["qty"].(float64) != 7 {
		t.Errorf("id=1 not deep-merged: %v", byID[1])
	}
	if byID[2]["name"] != "beta" {
		t.Errorf("base-only id=2 lost: %s", got)
	}
	if byID[3]["name"] != "gamma" {
		t.Errorf("unmatched id=3 not appended: %s", got)
	}
}

func TestMergeByKeyPerElementLWWReordered(t *testing.T) {
	// Per-element LWW with the incoming array in a DIFFERENT order:
	// stale incoming "a" rejected, fresh incoming "b" accepted.
	got, err := MergeJSONWithOptions(
		`{"rows":[{"id":"a","updatedAt":200,"val":"base-a"},{"id":"b","updatedAt":100,"val":"base-b"}]}`,
		`{"rows":[{"id":"b","updatedAt":150,"val":"new-b"},{"id":"a","updatedAt":100,"val":"stale-a"}]}`,
		Options{
			ArrayStrategy:      ArrayMergeByKey,
			ResolveByTimestamp: true,
			LwwKeys:            "updatedAt,syncedAt",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "base-a") || strings.Contains(got, "stale-a") {
		t.Errorf("stale incoming element should be rejected: %s", got)
	}
	if !strings.Contains(got, "new-b") || strings.Contains(got, "base-b") {
		t.Errorf("fresh incoming element should win: %s", got)
	}
}

func TestMergeByKeyFWWCreatedAt(t *testing.T) {
	// FWW on createdAt: an incoming element claiming a LATER creation for
	// the same identity is rejected.
	got, err := MergeJSONWithOptions(
		`{"rows":[{"id":1,"createdAt":100,"who":"original"}]}`,
		`{"rows":[{"id":1,"createdAt":300,"who":"impostor"}]}`,
		Options{
			ArrayStrategy:      ArrayMergeByKey,
			ResolveByTimestamp: true,
			FwwKeys:            "createdAt",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "original") || strings.Contains(got, "impostor") {
		t.Errorf("FWW should keep the original element: %s", got)
	}
}

func TestMergeByKeyCustomMatchKeys(t *testing.T) {
	// "uuid,id": uuid is the identity when present; elements without uuid
	// fall back to id. Both rows must reconcile (no duplicates).
	got, err := MergeJSONWithOptions(
		`{"rows":[{"uuid":"u-1","v":1},{"id":7,"v":2}]}`,
		`{"rows":[{"uuid":"u-1","v":10},{"id":7,"v":20}]}`,
		Options{
			ArrayStrategy:  ArrayMergeByKey,
			ArrayMatchKeys: "uuid,id",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	m := mustParse(t, got)
	rows := m["rows"].([]any)
	if len(rows) != 2 {
		t.Fatalf("want 2 reconciled rows, got %d: %s", len(rows), got)
	}
	vals := map[float64]bool{}
	for _, r := range rows {
		vals[r.(map[string]any)["v"].(float64)] = true
	}
	if !vals[10] || !vals[20] {
		t.Errorf("incoming values should win for both identities: %s", got)
	}
}

func TestInvalidJSONReturnsError(t *testing.T) {
	if _, err := MergeJSON(`{"a": 1`, `{"b": 2}`); err == nil {
		t.Error("invalid base JSON: want error, got nil")
	}
	if _, err := MergeJSON(`{"a": 1}`, `not json`); err == nil {
		t.Error("invalid incoming JSON: want error, got nil")
	}
	if _, err := MergeJSONWithOptions(`{`, `{}`, Options{ArrayStrategy: ArrayMergeByKey}); err == nil {
		t.Error("invalid JSON with options: want error, got nil")
	}
}

func TestOtherArrayStrategies(t *testing.T) {
	base := `{"tags":["a","b"]}`
	incoming := `{"tags":["b","c"]}`

	got, err := MergeJSONWithOptions(base, incoming, Options{ArrayStrategy: ArrayAppend})
	if err != nil {
		t.Fatal(err)
	}
	if tags := mustParse(t, got)["tags"].([]any); len(tags) != 4 {
		t.Errorf("Append: want 4 tags, got %v", tags)
	}

	got, err = MergeJSONWithOptions(base, incoming, Options{ArrayStrategy: ArrayUnion})
	if err != nil {
		t.Fatal(err)
	}
	if tags := mustParse(t, got)["tags"].([]any); len(tags) != 3 {
		t.Errorf("Union: want 3 tags, got %v", tags)
	}

	got, err = MergeJSON(base, incoming) // default = Replace
	if err != nil {
		t.Fatal(err)
	}
	if tags := mustParse(t, got)["tags"].([]any); len(tags) != 2 || tags[0] != "b" {
		t.Errorf("Replace: want [b c], got %v", tags)
	}
}
