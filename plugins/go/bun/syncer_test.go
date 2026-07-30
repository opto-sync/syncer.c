package syncer_bun

import (
	"testing"

	syncer "github.com/opto-sync/syncer-go"
)

func TestBeforeUpdateMutatesBunJSONField(t *testing.T) {
	r := Reconciler{Options: syncer.Options{
		ArrayStrategy: syncer.ArrayMergeByKey, ArrayMatchKeys: "id",
	}}
	stored := map[string]any{"nested": map[string]any{"keep": true}}
	var incoming any = map[string]any{"nested": map[string]any{"x": 1}}
	if err := r.BeforeUpdate(stored, &incoming); err != nil {
		t.Fatal(err)
	}
	nested := incoming.(map[string]any)["nested"].(map[string]any)
	if nested["keep"] != true || nested["x"] != float64(1) {
		t.Fatalf("unexpected merge: %#v", incoming)
	}
}

func TestBeforeUpdateRejectsNilTarget(t *testing.T) {
	if err := (Reconciler{}).BeforeUpdate(map[string]any{}, nil); err == nil {
		t.Fatal("expected nil target to fail")
	}
}
