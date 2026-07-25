// Package syncer provides Go bindings for the syncer.c deep JSON merge
// engine (v0.2.0).
//
// The C core is compiled directly into this package via cgo (see
// syncer_core.c / yyjson_core.c), so consumers only need a C toolchain —
// no prebuilt shared library, no LD_LIBRARY_PATH.
//
// Override callbacks (syncer_merge_override_cb / _ex) are intentionally NOT
// exposed yet. Bridging per-key Go callbacks through cgo requires a
// registry + cgo.Handle plumbing and imposes a large per-key overhead; it
// will be added as an explicit opt-in API in a later release. Until then
// all merges use the core's default deterministic merge rules.
package syncer

/*
#cgo CFLAGS: -I${SRCDIR}/../../core/include -I${SRCDIR}/../../core/src
#include <stdlib.h>
#include "syncer.h"
*/
import "C"

import (
	"errors"
	"unsafe"
)

// ArrayStrategy selects how arrays are merged. Values mirror
// syncer_array_strategy_t in syncer.h.
type ArrayStrategy int32

const (
	// ArrayReplace: the incoming array completely replaces the base array (default).
	ArrayReplace ArrayStrategy = 0
	// ArrayAppend: incoming elements are concatenated after the base elements.
	ArrayAppend ArrayStrategy = 1
	// ArrayUnion: append only incoming elements not already present in the base.
	ArrayUnion ArrayStrategy = 2
	// ArrayMergeByIndex: element-wise deep merge (base[i] with incoming[i]).
	ArrayMergeByIndex ArrayStrategy = 3
	// ArrayMergeByKey: match object elements by identity key(s)
	// (Options.ArrayMatchKeys, default "id"), deep-merge matched pairs with
	// per-element timestamp resolution, append unmatched incoming elements,
	// keep base-only elements. Non-object elements behave like ArrayUnion.
	ArrayMergeByKey ArrayStrategy = 4
)

// Options configures MergeJSONWithOptions. The zero value matches the C
// core's syncer_default_options(): replace arrays, unlimited depth, no
// circular-ref detection, no timestamp resolution.
type Options struct {
	// ArrayStrategy selects the array merge strategy.
	ArrayStrategy ArrayStrategy
	// MaxDepth limits merge recursion depth. 0 = unlimited.
	MaxDepth uint32
	// DetectCircularRefs enables circular-reference detection.
	DetectCircularRefs bool
	// ResolveByTimestamp enables CRDT-like timestamp conflict resolution
	// using LwwKeys / FwwKeys.
	ResolveByTimestamp bool
	// LwwKeys is a comma-separated list of Last-Write-Wins timestamp keys,
	// e.g. "updatedAt,syncedAt". Empty = none.
	LwwKeys string
	// FwwKeys is a comma-separated list of First-Write-Wins timestamp keys,
	// e.g. "createdAt". Empty = none.
	FwwKeys string
	// ArrayMatchKeys is a comma-separated list of identity keys for
	// ArrayMergeByKey, e.g. "uuid,id". The first listed key present in an
	// incoming element is its identity. Empty = "id".
	ArrayMatchKeys string
}

// ErrMergeFailed is returned when the C core cannot produce a merge result,
// which happens when either input is not valid JSON (or on internal
// allocation failure).
var ErrMergeFailed = errors.New("syncer: merge failed (invalid JSON input or out of memory)")

// Version returns the C core library version as "major.minor.patch".
func Version() string {
	return C.GoString(C.syncer_version())
}

// MergeJSON deep-merges incoming on top of base using default options
// (equivalent to MergeJSONWithOptions with a zero Options).
func MergeJSON(base, incoming string) (string, error) {
	return MergeJSONWithOptions(base, incoming, Options{})
}

// MergeJSONWithOptions deep-merges incoming on top of base with full
// control over array strategy and timestamp resolution.
func MergeJSONWithOptions(base, incoming string, opts Options) (string, error) {
	cBase := C.CString(base)
	defer C.free(unsafe.Pointer(cBase))
	cIncoming := C.CString(incoming)
	defer C.free(unsafe.Pointer(cIncoming))

	// Fully initialize the options struct — it must never be passed with
	// uninitialized fields (new fields are appended over time; v0.2.0
	// added array_match_keys as the last field).
	cOpts := C.syncer_default_options()
	cOpts.override_cb = nil
	cOpts.array_strategy = C.syncer_array_strategy_t(opts.ArrayStrategy)
	cOpts.max_depth = C.uint32_t(opts.MaxDepth)
	cOpts.detect_circular_refs = C.bool(opts.DetectCircularRefs)
	cOpts.resolve_by_timestamp = C.bool(opts.ResolveByTimestamp)

	if opts.LwwKeys != "" {
		cs := C.CString(opts.LwwKeys)
		defer C.free(unsafe.Pointer(cs))
		cOpts.lww_keys = cs
	}
	if opts.FwwKeys != "" {
		cs := C.CString(opts.FwwKeys)
		defer C.free(unsafe.Pointer(cs))
		cOpts.fww_keys = cs
	}
	if opts.ArrayMatchKeys != "" {
		cs := C.CString(opts.ArrayMatchKeys)
		defer C.free(unsafe.Pointer(cs))
		cOpts.array_match_keys = cs
	}

	resPtr := C.syncer_merge_json_ex(cBase, cIncoming, &cOpts)
	if resPtr == nil {
		return "", ErrMergeFailed
	}
	defer C.syncer_free(unsafe.Pointer(resPtr))
	return C.GoString(resPtr), nil
}
