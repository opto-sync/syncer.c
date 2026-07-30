// Package syncer_ent provides transaction-safe building blocks for Ent hooks.
package syncer_ent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	syncer "github.com/opto-sync/syncer-go"
)

var ErrInvalidJSONValue = errors.New("opto-sync ent: value is not JSON-serializable")

// Load and Save deliberately match small closures over generated Ent clients.
// Ent generates schema-specific types, so a reusable package cannot name one
// concrete mutation or field without code generation of its own.
type Load func(context.Context) (json.RawMessage, error)
type Save func(context.Context, json.RawMessage) error

type Reconciler struct {
	Options syncer.Options
}

// Merge accepts the decoded values used by Ent json fields.
func (r Reconciler) Merge(base, incoming any) (json.RawMessage, error) {
	baseJSON, err := json.Marshal(base)
	if err != nil {
		return nil, fmt.Errorf("%w: base: %v", ErrInvalidJSONValue, err)
	}
	incomingJSON, err := json.Marshal(incoming)
	if err != nil {
		return nil, fmt.Errorf("%w: incoming: %v", ErrInvalidJSONValue, err)
	}
	merged, err := syncer.MergeJSONWithOptions(string(baseJSON), string(incomingJSON), r.Options)
	if err != nil {
		return nil, fmt.Errorf("opto-sync ent: merge: %w", err)
	}
	return json.RawMessage(merged), nil
}

// Reconcile loads, merges, and saves through caller-supplied Ent closures.
// Call it with a transactional Ent client so the read and write share the same
// transaction. Returning the persisted bytes makes silent no-op saves visible.
func (r Reconciler) Reconcile(
	ctx context.Context,
	load Load,
	save Save,
	incoming any,
) (json.RawMessage, error) {
	base, err := load(ctx)
	if err != nil {
		return nil, fmt.Errorf("opto-sync ent: load: %w", err)
	}
	var decoded any
	if len(base) == 0 || string(base) == "null" {
		decoded = map[string]any{}
	} else if err := json.Unmarshal(base, &decoded); err != nil {
		return nil, fmt.Errorf("opto-sync ent: stored value: %w", err)
	}
	merged, err := r.Merge(decoded, incoming)
	if err != nil {
		return nil, err
	}
	if err := save(ctx, merged); err != nil {
		return nil, fmt.Errorf("opto-sync ent: save: %w", err)
	}
	return merged, nil
}
