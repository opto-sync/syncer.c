// Package syncer_gorm provides a GORM plugin that transparently deep-merges
// JSONB column updates through the syncer.c core (via the syncer-go cgo
// binding) instead of letting a plain UPDATE overwrite the stored document.
package syncer_gorm

import (
	"encoding/json"
	"fmt"

	syncer "github.com/opto-sync/syncer-go"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/schema"
)

// SyncerPlugin is a GORM plugin that hooks into the Update pipeline.
//
// For every update issued as a map (db.Model(...).Updates(map[string]any{...}))
// it detects JSON/JSONB columns, fetches the currently stored document,
// deep-merges the incoming document on top of it with the syncer.c engine,
// and replaces the update value with the merged result.
type SyncerPlugin struct {
	// Options passed to every merge. Zero value = plain deep merge with
	// array replacement. Typical sync setup:
	//
	//	Options: syncer.Options{
	//		ArrayStrategy:      syncer.ArrayMergeByKey,
	//		ResolveByTimestamp: true,
	//		LwwKeys:            "updatedAt,syncedAt",
	//		FwwKeys:            "createdAt",
	//	}
	Options syncer.Options

	// Columns optionally restricts merging to these column names.
	// Empty = every field whose GORM DataType contains "json".
	Columns []string
}

// Name implements gorm.Plugin.
func (p *SyncerPlugin) Name() string {
	return "opto_sync_syncer"
}

// Initialize implements gorm.Plugin.
func (p *SyncerPlugin) Initialize(db *gorm.DB) error {
	return db.Callback().Update().
		Before("gorm:update").
		Register("opto_sync:before_update", p.beforeUpdate)
}

// beforeUpdate must have the signature func(*gorm.DB) — that is what
// gorm's callback processor Register accepts.
func (p *SyncerPlugin) beforeUpdate(db *gorm.DB) {
	stmt := db.Statement
	if stmt == nil || stmt.Schema == nil {
		return
	}
	updates, ok := stmt.Dest.(map[string]interface{})
	if !ok {
		// Struct-based updates are passed through untouched: GORM only
		// includes non-zero fields there and we cannot distinguish
		// "unset" from "overwrite" reliably.
		return
	}

	for _, field := range stmt.Schema.Fields {
		if !p.isJSONField(field) {
			continue
		}
		incoming, present := lookupUpdate(updates, field)
		if !present {
			continue
		}
		incomingJSON, err := toJSONString(incoming)
		if err != nil {
			_ = db.AddError(fmt.Errorf("opto_sync: column %q: %w", field.DBName, err))
			return
		}

		current, found, err := p.fetchCurrent(db, field.DBName)
		if err != nil {
			_ = db.AddError(fmt.Errorf("opto_sync: fetch current %q: %w", field.DBName, err))
			return
		}
		if !found || current == "" {
			continue // nothing stored yet — let the update write as-is
		}

		merged, err := syncer.MergeJSONWithOptions(current, incomingJSON, p.Options)
		if err != nil {
			_ = db.AddError(fmt.Errorf("opto_sync: merge %q: %w", field.DBName, err))
			return
		}
		setUpdate(updates, field, merged)
	}
}

// isJSONField reports whether a schema field should be merged.
func (p *SyncerPlugin) isJSONField(field *schema.Field) bool {
	if len(p.Columns) > 0 {
		for _, c := range p.Columns {
			if c == field.DBName || c == field.Name {
				return true
			}
		}
		return false
	}
	// Auto-detect: `gorm:"type:jsonb"` etc.
	switch {
	case field.DataType == "json", field.DataType == "jsonb",
		field.DataType == "JSON", field.DataType == "JSONB":
		return true
	}
	return false
}

// fetchCurrent reads the currently stored raw JSON text for one column,
// scoped by the statement's WHERE conditions (and the model's primary key
// when set). Returns found=false when no row matches.
func (p *SyncerPlugin) fetchCurrent(db *gorm.DB, column string) (string, bool, error) {
	stmt := db.Statement

	tx := db.Session(&gorm.Session{NewDB: true}).
		Table(stmt.Table).
		Select(column).
		Limit(1)

	scoped := false
	if c, ok := stmt.Clauses["WHERE"]; ok {
		if where, ok := c.Expression.(clause.Where); ok && len(where.Exprs) > 0 {
			tx = tx.Clauses(clause.Where{Exprs: where.Exprs})
			scoped = true
		}
	}
	// Primary key from the model (db.Model(&Doc{ID: ...}).Updates(...)).
	if stmt.Model != nil {
		if pk := stmt.Schema.PrioritizedPrimaryField; pk != nil {
			modelValue := stmt.ReflectValue
			if modelValue.IsValid() {
				if v, zero := pk.ValueOf(stmt.Context, modelValue); !zero {
					tx = tx.Where(map[string]interface{}{pk.DBName: v})
					scoped = true
				}
			}
		}
	}
	if !scoped {
		// Refuse to merge against an arbitrary row.
		return "", false, nil
	}

	var raw []byte
	row := tx.Row()
	if row == nil {
		return "", false, tx.Error
	}
	if err := row.Scan(&raw); err != nil {
		if err.Error() == "sql: no rows in result set" {
			return "", false, nil
		}
		return "", false, err
	}
	return string(raw), true, nil
}

// lookupUpdate finds the incoming value for a field under either its DB
// column name or its Go struct name.
func lookupUpdate(updates map[string]interface{}, field *schema.Field) (interface{}, bool) {
	if v, ok := updates[field.DBName]; ok {
		return v, true
	}
	if v, ok := updates[field.Name]; ok {
		return v, true
	}
	return nil, false
}

// setUpdate writes the merged JSON back under whichever key the caller used.
func setUpdate(updates map[string]interface{}, field *schema.Field, merged string) {
	if _, ok := updates[field.DBName]; ok {
		updates[field.DBName] = merged
		return
	}
	updates[field.Name] = merged
}

// toJSONString normalizes the incoming update value to a raw JSON string.
func toJSONString(v interface{}) (string, error) {
	switch t := v.(type) {
	case string:
		return t, nil
	case []byte:
		return string(t), nil
	case json.RawMessage:
		return string(t), nil
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return "", fmt.Errorf("value is not JSON-serializable: %w", err)
		}
		return string(b), nil
	}
}
