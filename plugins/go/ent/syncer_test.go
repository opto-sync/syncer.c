package syncer_ent

import (
	"context"
	"encoding/json"
	"testing"

	syncer "github.com/opto-sync/syncer-go"
)

func TestReconcileUsesGeneratedClientClosures(t *testing.T) {
	stored := json.RawMessage(`{"profile":{"name":"Ada"},"items":[{"id":1,"v":"a"}]}`)
	r := Reconciler{Options: syncer.Options{
		ArrayStrategy: syncer.ArrayMergeByKey, ArrayMatchKeys: "id",
	}}
	merged, err := r.Reconcile(
		context.Background(),
		func(context.Context) (json.RawMessage, error) { return stored, nil },
		func(_ context.Context, value json.RawMessage) error {
			stored = append(stored[:0], value...)
			return nil
		},
		map[string]any{
			"profile": map[string]any{"city": "London"},
			"items":   []any{map[string]any{"id": 2, "v": "b"}},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(merged, &value); err != nil {
		t.Fatal(err)
	}
	profile := value["profile"].(map[string]any)
	if profile["name"] != "Ada" || profile["city"] != "London" {
		t.Fatalf("unexpected merge: %s", merged)
	}
	if string(stored) != string(merged) {
		t.Fatalf("save closure did not receive result")
	}
}

func TestInvalidStoredJSONFailsBeforeSave(t *testing.T) {
	saved := false
	_, err := (Reconciler{}).Reconcile(
		context.Background(),
		func(context.Context) (json.RawMessage, error) { return json.RawMessage(`{bad`), nil },
		func(context.Context, json.RawMessage) error { saved = true; return nil },
		map[string]any{"x": 1},
	)
	if err == nil || saved {
		t.Fatalf("expected failure without save: err=%v saved=%v", err, saved)
	}
}
