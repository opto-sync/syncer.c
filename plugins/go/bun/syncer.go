// Package syncer_bun provides a JSON-field hook usable from Bun model hooks
// and RunInTx callbacks without forcing a particular model shape.
package syncer_bun

import (
	"encoding/json"
	"errors"
	"fmt"

	syncer "github.com/opto-sync/syncer-go"
)

var ErrInvalidJSONValue = errors.New("opto-sync bun: invalid JSON value")

type Reconciler struct {
	Options syncer.Options
}

// MergeValues reconciles the decoded map/slice values Bun maps JSON columns to.
func (r Reconciler) MergeValues(base, incoming any) (any, error) {
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
		return nil, fmt.Errorf("opto-sync bun: merge: %w", err)
	}
	var value any
	if err := json.Unmarshal([]byte(merged), &value); err != nil {
		return nil, fmt.Errorf("opto-sync bun: decode result: %w", err)
	}
	return value, nil
}

// BeforeUpdate is a model-hook-friendly form: assign its result to the Bun
// model's JSON field before issuing Update. The caller must load the row with
// FOR UPDATE inside db.RunInTx to prevent a lost read-modify-write.
func (r Reconciler) BeforeUpdate(stored any, incoming *any) error {
	if incoming == nil {
		return errors.New("opto-sync bun: incoming pointer is nil")
	}
	merged, err := r.MergeValues(stored, *incoming)
	if err != nil {
		return err
	}
	*incoming = merged
	return nil
}
