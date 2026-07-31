// Integration tests for the GORM opto-sync plugin against a REAL Postgres.
//
// Run with a throwaway Postgres, e.g.:
//
//	docker run -d --name plugintest-pg -p 127.0.0.1:55987:5432 \
//	  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=plugintest \
//	  postgres:16-alpine
//	go test ./... -v
//
// Override the DSN with OPTO_SYNC_TEST_PG. The syncer-go binding compiles the C
// core into its cgo package, so no shared library needs to be installed.
package syncer_gorm

import (
	"encoding/json"
	"os"
	"reflect"
	"sync"
	"testing"

	syncer "github.com/opto-sync/syncer-go"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const defaultDSN = "host=127.0.0.1 port=55987 user=test password=test dbname=plugintest sslmode=disable"

// canonicalOptions is the merge policy used across every opto-sync binding.
//
// There is deliberately NO FwwKeys. FWW in the C core is a node-level VETO, not
// field protection: an incoming node whose FWW key is NEWER is discarded
// WHOLESALE, however new its updatedAt is. With createdAt as a default FWW key,
// any replica that ends up holding a later createdAt for a record could never
// write that record again — silently, behind a 200 OK. See
// docs/MERGE_SEMANTICS.md. FWW remains fully supported as an explicit opt-in;
// see fwwOptions below.
func canonicalOptions() syncer.Options {
	return syncer.Options{
		ArrayStrategy:      syncer.ArrayMergeByKey,
		ArrayMatchKeys:     "id",
		ResolveByTimestamp: true,
		LwwKeys:            "updatedAt,syncedAt",
	}
}

// fwwOptions is canonicalOptions with FWW explicitly opted into, used by the
// tests that assert FWW *behaviour*.
func fwwOptions() syncer.Options {
	opts := canonicalOptions()
	opts.FwwKeys = "createdAt"
	return opts
}

// Doc has a jsonb column held as a raw JSON string, which is the
// zero-deserialization shape the plugin is designed around.
type Doc struct {
	ID    string `gorm:"primaryKey;column:id;type:text"`
	Doc   string `gorm:"column:doc;type:jsonb"`
	Label string `gorm:"column:label;type:text"`
}

func (Doc) TableName() string { return "gorm_docs" }

/* -------------------------------------------------------------------------
 * Fixtures — the same documents the TypeScript plugin tests use, so a
 * divergence between languages shows up as a failing assertion.
 * ------------------------------------------------------------------------- */

const baseDoc = `{
  "profile": {
    "name": "Ada",
    "theme": {"mode": "dark", "accent": "blue"},
    "contact": {"email": "ada@example.com"}
  },
  "items": [
    {"id": "a", "qty": 1, "note": "base-a", "updatedAt": "2026-06-01T00:00:00Z"},
    {"id": "b", "qty": 2, "note": "base-b", "updatedAt": "2026-06-01T00:00:00Z"}
  ],
  "audit": {"createdAt": "2026-01-01T00:00:00Z", "actor": "original-owner"},
  "tags": ["red", "green"]
}`

const incomingDoc = `{
  "profile": {"theme": {"accent": "red"}, "locale": "en-GB"},
  "items": [
    {"id": "a", "qty": 999, "note": "STALE-a", "updatedAt": "2025-01-01T00:00:00Z"},
    {"id": "b", "qty": 42, "note": "fresh-b", "updatedAt": "2026-07-01T00:00:00Z"},
    {"id": "c", "qty": 7, "note": "new-c", "updatedAt": "2026-07-01T00:00:00Z"}
  ],
  "audit": {"createdAt": "2030-01-01T00:00:00Z", "actor": "impostor"},
  "tags": ["blue"]
}`

const expectedMerged = `{
  "profile": {
    "name": "Ada",
    "theme": {"mode": "dark", "accent": "red"},
    "contact": {"email": "ada@example.com"},
    "locale": "en-GB"
  },
  "items": [
    {"id": "a", "qty": 1, "note": "base-a", "updatedAt": "2026-06-01T00:00:00Z"},
    {"id": "b", "qty": 42, "note": "fresh-b", "updatedAt": "2026-07-01T00:00:00Z"},
    {"id": "c", "qty": 7, "note": "new-c", "updatedAt": "2026-07-01T00:00:00Z"}
  ],
  "audit": {"createdAt": "2030-01-01T00:00:00Z", "actor": "impostor"},
  "tags": ["red", "green", "blue"]
}`

// expectedMergedFWW is the same merge under fwwOptions: identical except that
// the audit subtree is vetoed WHOLESALE — both keys, not just createdAt — which
// is exactly why FWW is not a default.
const expectedMergedFWW = `{
  "profile": {
    "name": "Ada",
    "theme": {"mode": "dark", "accent": "red"},
    "contact": {"email": "ada@example.com"},
    "locale": "en-GB"
  },
  "items": [
    {"id": "a", "qty": 1, "note": "base-a", "updatedAt": "2026-06-01T00:00:00Z"},
    {"id": "b", "qty": 42, "note": "fresh-b", "updatedAt": "2026-07-01T00:00:00Z"},
    {"id": "c", "qty": 7, "note": "new-c", "updatedAt": "2026-07-01T00:00:00Z"}
  ],
  "audit": {"createdAt": "2026-01-01T00:00:00Z", "actor": "original-owner"},
  "tags": ["red", "green", "blue"]
}`

/* -------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

func dsn() string {
	if v := os.Getenv("OPTO_SYNC_TEST_PG"); v != "" {
		return v
	}
	return defaultDSN
}

// openDB connects and registers the plugin. It skips (not fails) when no
// Postgres is reachable, so `go test` stays usable without Docker.
func openDB(t *testing.T, opts syncer.Options) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(postgres.Open(dsn()), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Skipf("no Postgres at %q (%v) — start one with docker to run this test", dsn(), err)
	}
	if err := db.Use(&SyncerPlugin{Options: opts}); err != nil {
		t.Fatalf("register plugin: %v", err)
	}
	return db
}

func resetTable(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := db.Exec(`drop table if exists gorm_docs`).Error; err != nil {
		t.Fatalf("drop table: %v", err)
	}
	if err := db.Exec(`create table gorm_docs (
		id text primary key,
		doc jsonb,
		label text
	)`).Error; err != nil {
		t.Fatalf("create table: %v", err)
	}
}

func seed(t *testing.T, db *gorm.DB, id, doc string) {
	t.Helper()
	// Seeded with raw SQL so the plugin's callback is not involved.
	if err := db.Exec(`insert into gorm_docs (id, doc) values (?, ?::jsonb)`, id, doc).Error; err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
}

// readPersisted re-reads the jsonb column as text with a plain SQL query and
// parses it. Persistence is always verified this way, never through the value
// the plugin returned, so an in-memory-only merge cannot make a test pass.
func readPersisted(t *testing.T, db *gorm.DB, id string) map[string]interface{} {
	t.Helper()
	var raw string
	if err := db.Raw(`select doc::text from gorm_docs where id = ?`, id).Scan(&raw).Error; err != nil {
		t.Fatalf("read persisted %s: %v", id, err)
	}
	if raw == "" {
		t.Fatalf("no row persisted for id %q", id)
	}
	var out map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("persisted value for %s is not JSON: %v (%s)", id, err, raw)
	}
	return out
}

func parseJSON(t *testing.T, s string) map[string]interface{} {
	t.Helper()
	var out map[string]interface{}
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		t.Fatalf("bad fixture JSON: %v", err)
	}
	return out
}

// Postgres jsonb reorders object keys and normalizes whitespace, so documents
// are always compared as PARSED values, never as raw text.
func assertJSONEqual(t *testing.T, got, want interface{}, msg string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		g, _ := json.Marshal(got)
		w, _ := json.Marshal(want)
		t.Errorf("%s\n  got:  %s\n  want: %s", msg, g, w)
	}
}

// itemsByID indexes the keyed array under "items" by its identity key.
func itemsByID(t *testing.T, doc map[string]interface{}) map[string]map[string]interface{} {
	t.Helper()
	raw, ok := doc["items"].([]interface{})
	if !ok {
		t.Fatalf("doc has no items array: %#v", doc["items"])
	}
	out := make(map[string]map[string]interface{}, len(raw))
	for _, e := range raw {
		m, ok := e.(map[string]interface{})
		if !ok {
			t.Fatalf("items element is not an object: %#v", e)
		}
		out[m["id"].(string)] = m
	}
	return out
}

/* -------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------- */

func TestPluginRegisters(t *testing.T) {
	db := openDB(t, canonicalOptions())
	p := &SyncerPlugin{}
	if got := p.Name(); got != "opto_sync_syncer" {
		t.Errorf("Name() = %q, want %q", got, "opto_sync_syncer")
	}
	// The Update callback must exist after Use().
	if db.Callback().Update().Get("opto_sync:before_update") == nil {
		t.Error("opto_sync:before_update callback was not registered on the Update processor")
	}
}

// TestMapUpdatesMergeAndPersist is the primary end-to-end case: a map-based
// Updates() against a jsonb column must deep-merge and PERSIST.
func TestMapUpdatesMergeAndPersist(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "m1", baseDoc)

	res := db.Model(&Doc{}).Where("id = ?", "m1").
		Updates(map[string]interface{}{"doc": incomingDoc})
	if res.Error != nil {
		t.Fatalf("Updates: %v", res.Error)
	}
	if res.RowsAffected != 1 {
		t.Fatalf("RowsAffected = %d, want 1", res.RowsAffected)
	}

	got := readPersisted(t, db, "m1")
	assertJSONEqual(t, got, parseJSON(t, expectedMerged), "persisted document does not match canonical merge")
}

func TestDeepMergeOfNestedObjects(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "deep", baseDoc)

	if err := db.Model(&Doc{}).Where("id = ?", "deep").
		Updates(map[string]interface{}{"doc": incomingDoc}).Error; err != nil {
		t.Fatalf("Updates: %v", err)
	}

	got := readPersisted(t, db, "deep")
	profile := got["profile"].(map[string]interface{})
	if profile["name"] != "Ada" {
		t.Errorf("profile.name = %v, want Ada (sibling key must survive deep merge)", profile["name"])
	}
	theme := profile["theme"].(map[string]interface{})
	if theme["mode"] != "dark" {
		t.Errorf("profile.theme.mode = %v, want dark (depth-2 sibling must survive)", theme["mode"])
	}
	if theme["accent"] != "red" {
		t.Errorf("profile.theme.accent = %v, want red (conflicting key takes incoming)", theme["accent"])
	}
	if profile["locale"] != "en-GB" {
		t.Errorf("profile.locale = %v, want en-GB (new nested key added)", profile["locale"])
	}
	contact := profile["contact"].(map[string]interface{})
	if contact["email"] != "ada@example.com" {
		t.Errorf("profile.contact.email = %v, untouched subtree must be preserved", contact["email"])
	}
}

// TestKeyedArrayReconciliation covers the headline behaviour: within ONE array,
// a stale element is rejected while a fresh sibling is applied and a new id is
// appended.
func TestKeyedArrayReconciliation(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "arr", baseDoc)

	if err := db.Model(&Doc{}).Where("id = ?", "arr").
		Updates(map[string]interface{}{"doc": incomingDoc}).Error; err != nil {
		t.Fatalf("Updates: %v", err)
	}

	got := readPersisted(t, db, "arr")
	items := got["items"].([]interface{})
	if len(items) != 3 {
		t.Fatalf("len(items) = %d, want 3", len(items))
	}
	by := itemsByID(t, got)

	// STALE element rejected wholesale
	if by["a"]["qty"].(float64) != 1 {
		t.Errorf("items[id=a].qty = %v, want 1 — STALE element must be REJECTED", by["a"]["qty"])
	}
	if by["a"]["note"] != "base-a" {
		t.Errorf("items[id=a].note = %v, want base-a — STALE element must be REJECTED", by["a"]["note"])
	}
	if by["a"]["updatedAt"] != "2026-06-01T00:00:00Z" {
		t.Errorf("items[id=a].updatedAt = %v, want the newer base timestamp", by["a"]["updatedAt"])
	}
	// FRESH sibling in the SAME array applied
	if by["b"]["qty"].(float64) != 42 {
		t.Errorf("items[id=b].qty = %v, want 42 — FRESH sibling must be APPLIED", by["b"]["qty"])
	}
	if by["b"]["note"] != "fresh-b" {
		t.Errorf("items[id=b].note = %v, want fresh-b", by["b"]["note"])
	}
	// NEW element appended
	if by["c"]["qty"].(float64) != 7 {
		t.Errorf("items[id=c].qty = %v, want 7 — NEW element must be APPENDED", by["c"]["qty"])
	}
	last := items[2].(map[string]interface{})
	if last["id"] != "c" {
		t.Errorf("items[2].id = %v, want c — new element appends at the END", last["id"])
	}
}

// TestFirstWriteWinsRejectsRecreation: with FWW explicitly opted into, a newer
// createdAt must not overwrite the original subtree.
func TestFirstWriteWinsRejectsRecreation(t *testing.T) {
	db := openDB(t, fwwOptions())
	resetTable(t, db)
	seed(t, db, "fww", baseDoc)

	if err := db.Model(&Doc{}).Where("id = ?", "fww").
		Updates(map[string]interface{}{"doc": incomingDoc}).Error; err != nil {
		t.Fatalf("Updates: %v", err)
	}

	got := readPersisted(t, db, "fww")
	assertJSONEqual(t, got, parseJSON(t, expectedMergedFWW),
		"explicit FWW vetoes the audit subtree wholesale")

	audit := got["audit"].(map[string]interface{})
	if audit["createdAt"] != "2026-01-01T00:00:00Z" {
		t.Errorf("audit.createdAt = %v, want the ORIGINAL — FWW must reject a re-creation", audit["createdAt"])
	}
	if audit["actor"] != "original-owner" {
		t.Errorf("audit.actor = %v, want original-owner — FWW rejects the whole subtree", audit["actor"])
	}
}

// TestDefaultPolicyDoesNotVetoOnCreatedAt is the regression test for removing
// createdAt from the default policy. FWW is a NODE-LEVEL veto: the incoming node
// below is the newest write in the system by updatedAt, by an enormous margin,
// and FWW still drops it wholesale. A replica holding a later createdAt would
// therefore be permanently, silently unable to write the record — behind a 200.
func TestDefaultPolicyDoesNotVetoOnCreatedAt(t *testing.T) {
	if canonicalOptions().FwwKeys != "" {
		t.Fatalf("the canonical policy must declare no FwwKeys, got %q", canonicalOptions().FwwKeys)
	}

	const base = `{"createdAt":100,"updatedAt":100,"v":"base"}`
	const incoming = `{"createdAt":200,"updatedAt":999999,"v":"NEWEST"}`

	underDefault, err := syncer.MergeJSONWithOptions(base, incoming, canonicalOptions())
	if err != nil {
		t.Fatalf("merge under the default policy: %v", err)
	}
	if got := parseJSON(t, underDefault)["v"]; got != "NEWEST" {
		t.Errorf("v = %v, want NEWEST — the default policy must let the newest write land", got)
	}

	underFWW, err := syncer.MergeJSONWithOptions(base, incoming, fwwOptions())
	if err != nil {
		t.Fatalf("merge under explicit FWW: %v", err)
	}
	fww := parseJSON(t, underFWW)
	if fww["v"] != "base" {
		t.Errorf("v = %v, want base — explicit FWW must still veto the whole node", fww["v"])
	}
	if fww["updatedAt"].(float64) != 100 {
		t.Errorf("updatedAt = %v, want 100 — the newest updatedAt is discarded WITH the node", fww["updatedAt"])
	}
}

// TestIdempotentReapply: applying the same payload repeatedly must converge.
func TestIdempotentReapply(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "idem", baseDoc)

	apply := func() {
		if err := db.Model(&Doc{}).Where("id = ?", "idem").
			Updates(map[string]interface{}{"doc": incomingDoc}).Error; err != nil {
			t.Fatalf("Updates: %v", err)
		}
	}

	apply()
	first := readPersisted(t, db, "idem")
	apply()
	second := readPersisted(t, db, "idem")
	apply()
	third := readPersisted(t, db, "idem")

	assertJSONEqual(t, second, first, "apply #2 must be a semantic no-op")
	assertJSONEqual(t, third, first, "apply #3 must be a semantic no-op")
	assertJSONEqual(t, first, parseJSON(t, expectedMerged), "converged document")

	if items := third["items"].([]interface{}); len(items) != 3 {
		t.Errorf("len(items) = %d after 3 applies, want 3 — keyed array must not grow", len(items))
	}
	if tags := third["tags"].([]interface{}); len(tags) != 3 {
		t.Errorf("len(tags) = %d after 3 applies, want 3 — union array must not grow", len(tags))
	}
}

// TestScopedByPrimaryKeyOnModel: db.Model(&Doc{ID: ...}) with no WHERE clause is
// still scoped, via the model's primary key.
func TestScopedByPrimaryKeyOnModel(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "pk", baseDoc)

	if err := db.Model(&Doc{ID: "pk"}).
		Updates(map[string]interface{}{"doc": incomingDoc}).Error; err != nil {
		t.Fatalf("Updates: %v", err)
	}

	got := readPersisted(t, db, "pk")
	assertJSONEqual(t, got, parseJSON(t, expectedMerged),
		"primary key on the model must scope the merge")
}

// TestMergeDoesNotTouchOtherRows guards against the plugin fetching the wrong
// row when several exist.
func TestMergeDoesNotTouchOtherRows(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "target", baseDoc)
	seed(t, db, "bystander", `{"untouched": true}`)

	if err := db.Model(&Doc{}).Where("id = ?", "target").
		Updates(map[string]interface{}{"doc": incomingDoc}).Error; err != nil {
		t.Fatalf("Updates: %v", err)
	}

	assertJSONEqual(t, readPersisted(t, db, "target"), parseJSON(t, expectedMerged), "target merged")
	assertJSONEqual(t, readPersisted(t, db, "bystander"),
		map[string]interface{}{"untouched": true}, "bystander row must be untouched")
}

/* ---- guard rails the plugin documents ---- */

// TestUnscopedUpdateIsNotMerged asserts the documented guard rail: with no WHERE
// clause and no primary key the plugin REFUSES to merge rather than merging
// against an arbitrary row.
//
// Note the residual risk this pins down: the UPDATE itself still proceeds and
// overwrites every row with the incoming document as-is. The guard rail
// prevents merging the WRONG row; it does not turn an unscoped update into an
// error. Callers must scope their updates.
func TestUnscopedUpdateIsNotMerged(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "r1", baseDoc)
	seed(t, db, "r2", baseDoc)

	// AllowGlobalUpdate is required because GORM itself blocks a WHERE-less
	// update; that is the only way to reach the plugin's unscoped path.
	err := db.Session(&gorm.Session{AllowGlobalUpdate: true}).
		Model(&Doc{}).
		Updates(map[string]interface{}{"doc": incomingDoc}).Error
	if err != nil {
		t.Fatalf("unscoped Updates: %v", err)
	}

	incoming := parseJSON(t, incomingDoc)
	for _, id := range []string{"r1", "r2"} {
		got := readPersisted(t, db, id)
		// NOT merged: the stale element survived, proving no merge ran.
		assertJSONEqual(t, got, incoming,
			"unscoped update must write the incoming document as-is (no merge) for "+id)
		by := itemsByID(t, got)
		if by["a"]["qty"].(float64) != 999 {
			t.Errorf("row %s: items[id=a].qty = %v; an unscoped update must NOT have merged", id, by["a"]["qty"])
		}
		if len(got["items"].([]interface{})) != 3 {
			t.Errorf("row %s: unscoped write should contain exactly the incoming array", id)
		}
	}
}

// TestStructUpdatesPassThrough asserts the documented behaviour that
// struct-based updates are NOT merged (GORM only carries non-zero fields there,
// so "unset" and "overwrite" are indistinguishable).
func TestStructUpdatesPassThrough(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "s1", baseDoc)

	if err := db.Model(&Doc{}).Where("id = ?", "s1").
		Updates(&Doc{Doc: incomingDoc}).Error; err != nil {
		t.Fatalf("struct Updates: %v", err)
	}

	got := readPersisted(t, db, "s1")
	assertJSONEqual(t, got, parseJSON(t, incomingDoc),
		"struct-based update must pass through unmerged (documented behaviour)")
	by := itemsByID(t, got)
	if by["a"]["qty"].(float64) != 999 {
		t.Errorf("items[id=a].qty = %v, want 999 — struct updates must not be merged", by["a"]["qty"])
	}
}

// TestNoRowMatchedWritesNothing: when the WHERE matches nothing there is no
// stored document to merge, and nothing should be written.
func TestNoRowMatchedWritesNothing(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "present", baseDoc)

	res := db.Model(&Doc{}).Where("id = ?", "absent").
		Updates(map[string]interface{}{"doc": incomingDoc})
	if res.Error != nil {
		t.Fatalf("Updates: %v", res.Error)
	}
	if res.RowsAffected != 0 {
		t.Errorf("RowsAffected = %d, want 0", res.RowsAffected)
	}
	assertJSONEqual(t, readPersisted(t, db, "present"), parseJSON(t, baseDoc),
		"the existing row must be untouched")
}

/* ---- column selection and option plumbing ---- */

// TestOptionsAreForwarded proves the plugin's Options actually reach the C core:
// the zero-value plugin (plain deep merge, REPLACE arrays, no timestamp
// resolution) must produce a DIFFERENT result from the canonical policy.
func TestOptionsAreForwarded(t *testing.T) {
	// Zero options: no timestamp resolution, arrays replaced.
	db := openDB(t, syncer.Options{})
	resetTable(t, db)
	seed(t, db, "zero", baseDoc)

	if err := db.Model(&Doc{}).Where("id = ?", "zero").
		Updates(map[string]interface{}{"doc": incomingDoc}).Error; err != nil {
		t.Fatalf("Updates: %v", err)
	}
	got := readPersisted(t, db, "zero")

	by := itemsByID(t, got)
	if by["a"]["qty"].(float64) != 999 {
		t.Errorf("without ResolveByTimestamp the STALE element should WIN, got qty=%v", by["a"]["qty"])
	}
	audit := got["audit"].(map[string]interface{})
	if audit["createdAt"] != "2030-01-01T00:00:00Z" {
		t.Errorf("without FwwKeys, createdAt should be overwritten, got %v", audit["createdAt"])
	}
	// but it still DEEP merged (that is the point of the plugin)
	profile := got["profile"].(map[string]interface{})
	if profile["name"] != "Ada" {
		t.Errorf("zero options must still deep-merge; profile.name = %v", profile["name"])
	}
}

// TestArrayMatchKeysForwarded checks a non-default identity key.
func TestArrayMatchKeysForwarded(t *testing.T) {
	opts := canonicalOptions()
	opts.ArrayMatchKeys = "sku"
	db := openDB(t, opts)
	resetTable(t, db)
	seed(t, db, "mk", `{"rows":[{"sku":"x","v":1},{"sku":"y","v":1}]}`)

	if err := db.Model(&Doc{}).Where("id = ?", "mk").
		Updates(map[string]interface{}{"doc": `{"rows":[{"sku":"x","v":2},{"sku":"z","v":9}]}`}).Error; err != nil {
		t.Fatalf("Updates: %v", err)
	}
	rows := readPersisted(t, db, "mk")["rows"].([]interface{})
	if len(rows) != 3 {
		t.Fatalf("len(rows) = %d, want 3 (x merged, y kept, z appended)", len(rows))
	}
	for _, r := range rows {
		m := r.(map[string]interface{})
		if m["sku"] == "x" && m["v"].(float64) != 2 {
			t.Errorf("rows[sku=x].v = %v, want 2 — matched on sku, not id", m["v"])
		}
	}
}

// TestColumnsRestrictionSkipsUnlistedColumns checks the Columns allow-list.
func TestColumnsRestrictionSkipsUnlistedColumns(t *testing.T) {
	db, err := gorm.Open(postgres.Open(dsn()), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Skipf("no Postgres at %q (%v)", dsn(), err)
	}
	// Restrict merging to a column that is NOT "doc".
	if err := db.Use(&SyncerPlugin{Options: canonicalOptions(), Columns: []string{"other"}}); err != nil {
		t.Fatalf("register plugin: %v", err)
	}
	resetTable(t, db)
	seed(t, db, "col", baseDoc)

	if err := db.Model(&Doc{}).Where("id = ?", "col").
		Updates(map[string]interface{}{"doc": incomingDoc}).Error; err != nil {
		t.Fatalf("Updates: %v", err)
	}
	assertJSONEqual(t, readPersisted(t, db, "col"), parseJSON(t, incomingDoc),
		"a column outside Columns must NOT be merged")
}

// TestNonStringJSONValueIsMarshalled: the plugin accepts []byte,
// json.RawMessage and arbitrary Go values, not just strings.
func TestNonStringJSONValueIsMarshalled(t *testing.T) {
	db := openDB(t, canonicalOptions())

	cases := []struct {
		name  string
		value interface{}
	}{
		{"string", incomingDoc},
		{"bytes", []byte(incomingDoc)},
		{"rawmessage", json.RawMessage(incomingDoc)},
		{"map", parseJSONAny(t, incomingDoc)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetTable(t, db)
			seed(t, db, "v", baseDoc)
			if err := db.Model(&Doc{}).Where("id = ?", "v").
				Updates(map[string]interface{}{"doc": tc.value}).Error; err != nil {
				t.Fatalf("Updates: %v", err)
			}
			assertJSONEqual(t, readPersisted(t, db, "v"), parseJSON(t, expectedMerged),
				"incoming value of type "+tc.name+" must merge identically")
		})
	}
}

func parseJSONAny(t *testing.T, s string) map[string]interface{} {
	t.Helper()
	return parseJSON(t, s)
}

// TestInvalidIncomingJSONSurfacesError: garbage must not be silently written.
func TestInvalidIncomingJSONSurfacesError(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "bad", baseDoc)

	err := db.Model(&Doc{}).Where("id = ?", "bad").
		Updates(map[string]interface{}{"doc": `{ not json`}).Error
	if err == nil {
		t.Fatal("expected an error for invalid incoming JSON, got nil")
	}
	assertJSONEqual(t, readPersisted(t, db, "bad"), parseJSON(t, baseDoc),
		"row must be untouched after a failed merge")
}

// TestJSONContentWithSQLMetacharacters: merged JSON travels as a bound
// parameter, so quotes and semicolons in the DATA must round-trip verbatim.
func TestJSONContentWithSQLMetacharacters(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "q", `{"note":"base"}`)

	nasty := `he said "hi"; drop table gorm_docs; -- ' \ 100%`
	payload, err := json.Marshal(map[string]interface{}{
		"note":   nasty,
		"nested": map[string]string{"s": "O'Brien"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&Doc{}).Where("id = ?", "q").
		Updates(map[string]interface{}{"doc": string(payload)}).Error; err != nil {
		t.Fatalf("Updates: %v", err)
	}

	got := readPersisted(t, db, "q")
	if got["note"] != nasty {
		t.Errorf("note = %q, want %q — JSON content must round-trip verbatim", got["note"], nasty)
	}
	nested := got["nested"].(map[string]interface{})
	if nested["s"] != "O'Brien" {
		t.Errorf("nested.s = %v, want O'Brien", nested["s"])
	}
	// the table must still exist
	var n int64
	if err := db.Raw(`select count(*) from information_schema.tables where table_name = 'gorm_docs'`).
		Scan(&n).Error; err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Error("gorm_docs no longer exists — SQL injection via JSON content")
	}
}

// TestConcurrentUpdatesLoseWrites documents a REAL limitation rather than
// asserting safety: the plugin's read-merge-write is NOT atomic, so concurrent
// map updates to the same row can lose merges. It is recorded as a test so the
// behaviour is visible and any future fix has a place to land.
//
// The assertion is deliberately weak (at least one writer survives) because the
// interleaving is timing-dependent; the diagnostic log shows how many were lost.
func TestConcurrentUpdatesLoseWrites(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "race", `{"items":[]}`)

	const n = 8
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			doc, _ := json.Marshal(map[string]interface{}{
				"items": []map[string]interface{}{{"id": string(rune('a' + i)), "v": i}},
			})
			_ = db.Model(&Doc{}).Where("id = ?", "race").
				Updates(map[string]interface{}{"doc": string(doc)}).Error
		}(i)
	}
	wg.Wait()

	got := readPersisted(t, db, "race")
	items := got["items"].([]interface{})
	if len(items) == 0 {
		t.Error("no writer survived at all, which should be impossible")
	}
	if len(items) < n {
		t.Logf("KNOWN LIMITATION: %d/%d concurrent merges survived. Outside a "+
			"transaction each statement is its own implicit transaction, so the "+
			"plugin's FOR UPDATE lock is released before the UPDATE runs and "+
			"read-merge-write is not atomic. Wrap the update in a transaction "+
			"(see TestConcurrentUpdatesInTransactionAreSafe).", len(items), n)
	}
}

// TestConcurrentUpdatesInTransactionAreSafe is the counterpart to the test
// above: when the caller wraps the update in a transaction, the plugin's
// `SELECT ... FOR UPDATE` spans the whole read-merge-write, so concurrent syncs
// of the same row serialize and NO merge is lost.
func TestConcurrentUpdatesInTransactionAreSafe(t *testing.T) {
	db := openDB(t, canonicalOptions())
	resetTable(t, db)
	seed(t, db, "race-tx", `{"items":[]}`)

	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			doc, _ := json.Marshal(map[string]interface{}{
				"items": []map[string]interface{}{{"id": string(rune('a' + i)), "v": i}},
			})
			errs[i] = db.Transaction(func(tx *gorm.DB) error {
				return tx.Model(&Doc{}).Where("id = ?", "race-tx").
					Updates(map[string]interface{}{"doc": string(doc)}).Error
			})
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("writer %d failed: %v", i, err)
		}
	}

	got := readPersisted(t, db, "race-tx")
	items := got["items"].([]interface{})
	if len(items) != n {
		t.Errorf("len(items) = %d, want %d — a transaction-wrapped merge must not lose writes", len(items), n)
	}
	seen := map[string]bool{}
	for _, e := range items {
		seen[e.(map[string]interface{})["id"].(string)] = true
	}
	for i := 0; i < n; i++ {
		if id := string(rune('a' + i)); !seen[id] {
			t.Errorf("writer element id=%q was lost", id)
		}
	}
}
