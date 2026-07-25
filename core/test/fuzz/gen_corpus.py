#!/usr/bin/env python3
"""
gen_corpus.py — regenerate the seed corpora for all four libFuzzer harnesses.

Seeds are worth more than dictionary entries here: the merge engine only reaches
its interesting branches when the SAME key names line up on both sides of the
input (identity keys for MERGE_BY_KEY, LWW/FWW keys for timestamp resolution).
Random mutation practically never invents that alignment, so every seed below is
a document PAIR that already lines up, drawn from shapes a real sync client
produces.

Each harness consumes a different fixed-length control prefix, so the same pair
list is emitted once per harness with the right prefix bytes prepended:

    corpus_merge/       0 control bytes
    corpus_strategies/  3 (strategy, max_depth, flags)
    corpus_callback/    2 (callback behaviour, flags)
    corpus_idempotent/  1 (strategy)

Run:  python3 gen_corpus.py        (idempotent; safe to re-run)
"""

import hashlib
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SEP = b"\x1e"

# ---------------------------------------------------------------------------
# Document pairs. (name, json1, json2)
# ---------------------------------------------------------------------------
PAIRS = [
    # --- flat objects --------------------------------------------------------
    ("flat", '{"a":1,"b":2}', '{"b":3,"c":4}'),
    ("empty_both", "{}", "{}"),
    ("empty_base", "{}", '{"a":{"b":[1,2,3]}}'),
    ("type_change", '{"a":{"b":1}}', '{"a":[1,2]}'),

    # --- nested objects ------------------------------------------------------
    ("nested3", '{"u":{"p":{"addr":{"city":"NY","zip":"10001"}}}}',
                '{"u":{"p":{"addr":{"city":"SF"},"bio":"hi"}}}'),
    ("deep10", '{"l1":{"l2":{"l3":{"l4":{"l5":{"l6":{"l7":{"l8":{"l9":{"l10":{"v":1}}}}}}}}}}}',
               '{"l1":{"l2":{"l3":{"l4":{"l5":{"l6":{"l7":{"l8":{"l9":{"l10":{"v":2,"n":true}}}}}}}}}}}'),

    # --- keyed arrays: the MERGE_BY_KEY shape --------------------------------
    ("rows_int_ts",
     '{"items":[{"id":1,"name":"a","createdAt":100,"updatedAt":200,"syncedAt":150},'
     '{"id":2,"name":"b","createdAt":110,"updatedAt":210}]}',
     '{"items":[{"id":1,"name":"A","createdAt":100,"updatedAt":300,"syncedAt":260},'
     '{"id":3,"name":"c","createdAt":120,"updatedAt":220}]}'),
    ("rows_stale_incoming",
     '{"items":[{"id":1,"v":"new","updatedAt":900}]}',
     '{"items":[{"id":1,"v":"old","updatedAt":100}]}'),
    ("rows_fww_createdat",
     '{"items":[{"id":1,"v":"first","createdAt":100}]}',
     '{"items":[{"id":1,"v":"later","createdAt":500}]}'),
    ("rows_nested_payload",
     '{"items":[{"id":"u1","updatedAt":1,"profile":{"tags":[{"id":9,"w":1}]}}]}',
     '{"items":[{"id":"u1","updatedAt":2,"profile":{"tags":[{"id":9,"w":2},{"id":10}]}}]}'),
    ("rows_id_type_mismatch",
     '{"items":[{"id":42,"v":1}]}', '{"items":[{"id":"42","v":2}]}'),
    ("rows_alt_match_keys",
     '{"items":[{"uuid":"aaa","key":"k1","v":1}]}',
     '{"items":[{"uuid":"aaa","key":"k1","v":2}]}'),
    ("rows_missing_ids",
     '{"items":[{"id":1,"v":1},{"noid":true},7,"s"]}',
     '{"items":[{"id":1,"v":2},{"noid":true},7,"t"]}'),
    ("root_array_rows",
     '[{"id":1,"updatedAt":1}]', '[{"id":1,"updatedAt":2},{"id":2}]'),

    # --- OUT OF CONTRACT (documented in syncer.h): must not crash ------------
    ("oob_duplicate_keys", '{"a":1,"a":2}', '{"a":3,"a":4}'),
    ("oob_duplicate_keys_nested", '{"o":{"k":1,"k":2}}', '{"o":{"k":3,"k":4}}'),
    ("oob_duplicate_identity",
     '{"items":[{"id":1,"v":1},{"id":1,"v":2}]}',
     '{"items":[{"id":1,"v":3},{"id":1,"v":4}]}'),
    ("oob_duplicate_identity_norm",
     '{"items":[{"id":1,"v":1},{"id":"1","v":2}]}',
     '{"items":[{"id":1,"v":3}]}'),

    # --- timestamp formats ---------------------------------------------------
    ("ts_digit_strings",
     '{"id":1,"updatedAt":"1700000000000"}', '{"id":1,"updatedAt":"999"}'),
    ("ts_digit_leading_zeros",
     '{"id":1,"updatedAt":"007"}', '{"id":1,"updatedAt":"7"}'),
    ("ts_int64_extremes",
     '{"id":1,"updatedAt":9223372036854775807}',
     '{"id":1,"updatedAt":-9223372036854775808}'),
    ("ts_int64_nanos",
     '{"id":1,"updatedAt":1700000000000000001}',
     '{"id":1,"updatedAt":1700000000000000002}'),
    ("ts_float",
     '{"id":1,"updatedAt":1700000000.25}', '{"id":1,"updatedAt":1700000000.75}'),
    ("ts_int_vs_string",
     '{"id":1,"updatedAt":1700000000}', '{"id":1,"updatedAt":"1700000000"}'),
    ("ts_iso8601",
     '{"id":1,"updatedAt":"2024-01-15T10:30:00Z","createdAt":"2024-01-01T00:00:00Z"}',
     '{"id":1,"updatedAt":"2024-06-15T10:30:00Z","createdAt":"2024-01-01T00:00:00Z"}'),
    ("ts_equal", '{"id":1,"updatedAt":5,"v":1}', '{"id":1,"updatedAt":5,"v":2}'),
    ("ts_nonscalar", '{"id":1,"updatedAt":{"o":1}}', '{"id":1,"updatedAt":[1]}'),
    ("ts_missing_one_side", '{"id":1,"updatedAt":9}', '{"id":1,"v":2}'),

    # --- unicode / escapes ---------------------------------------------------
    ("unicode_keys",
     '{"héllo":{"wörld":1},"a.b":{"c":1},"q\\"k":1}',
     '{"héllo":{"wörld":2,"日本":3},"a.b":{"d":4},"q\\"k":9}'),
    ("unicode_ids",
     '{"items":[{"id":"ключ","v":1}]}',
     '{"items":[{"id":"ключ","v":2}]}'),
    ("emoji", '{"e":"\U0001f600"}', '{"e":"\U0001f4a9","f":"\U0001f680"}'),
    ("escaped_nul_key", '{"a\\u0000b":1}', '{"a\\u0000c":2,"a":3}'),
    ("escaped_nul_value", '{"k":"x\\u0000y"}', '{"k":"x\\u0000z"}'),
    ("lone_surrogate_escape", '{"s":"\\ud83d"}', '{"s":"\\ude00"}'),

    # --- scalar arrays / strategy differentiators ---------------------------
    ("scalar_arrays", '{"a":[1,2,3]}', '{"a":[3,4,5]}'),
    ("scalar_arrays_dupes", '{"a":[1,1,2]}', '{"a":[1,2,2,3]}'),
    ("arrays_uneven", '{"a":[{"x":1},{"y":2},{"z":3}]}', '{"a":[{"x":9}]}'),
    ("arrays_of_arrays", '{"a":[[1,2],[3]]}', '{"a":[[1,2,9],[4,5]]}'),
    ("num_equivalence", '{"a":[1,2.0]}', '{"a":[1.0,2]}'),
    ("key_order_swapped", '{"a":[{"id":"c","v":3}]}', '{"a":[{"v":3,"id":"c"}]}'),

    # --- root-level non-objects ---------------------------------------------
    ("root_scalars", "1", '"two"'),
    ("root_null_true", "null", "true"),
    ("root_arr_vs_obj", "[1,2]", '{"a":1}'),

    # --- self-merge / no separator case (fz_split2 duplicates the buffer) ----
    ("selfmerge_nosep", '{"items":[{"id":1,"updatedAt":5,"v":{"n":[1,2]}}]}', None),

    # --- malformed: must return NULL, never crash ---------------------------
    ("bad_truncated", '{"a":1', '{"b":2}'),
    ("bad_trailing_comma", '{"a":1,}', '{"a":2,}'),
    ("bad_unclosed_string", '{"a":"x', '{"a":"y"}'),
    ("bad_bare", "not json at all", '{"a":1}'),
    ("bad_deep_unclosed", "[" * 200, "]" * 200),
    ("bad_empty", "", ""),
    ("bad_lone_sep", None, None),

    # --- pathological but well-formed --------------------------------------
    ("wide_object",
     "{" + ",".join('"k%d":%d' % (i, i) for i in range(64)) + "}",
     "{" + ",".join('"k%d":%d' % (i, i * 2) for i in range(0, 64, 3)) + "}"),
    ("long_array_rows",
     '{"items":[' + ",".join('{"id":%d,"updatedAt":%d}' % (i, i) for i in range(32)) + "]}",
     '{"items":[' + ",".join('{"id":%d,"updatedAt":%d}' % (i, 100 - i) for i in range(32)) + "]}"),
    ("long_key", '{"' + "k" * 400 + '":1}', '{"' + "k" * 400 + '":2}'),
]

# ---------------------------------------------------------------------------
# Control-byte prefixes per harness.
# ---------------------------------------------------------------------------
# fuzz_strategies: (strategy 0..4, max_depth, flag byte)
STRATEGY_PREFIXES = [
    bytes([0, 0, 0x00]),  # REPLACE, unlimited depth, no flags
    bytes([1, 0, 0x02]),  # APPEND, resolve_by_timestamp
    bytes([2, 0, 0x0A]),  # UNION, resolve + lww "updatedAt,syncedAt"
    bytes([3, 0, 0x0A]),  # MERGE_BY_INDEX, resolve
    bytes([4, 0, 0x1A]),  # MERGE_BY_KEY, resolve + lww + fww "createdAt"
    bytes([4, 0, 0x5A]),  # MERGE_BY_KEY, + match keys "uuid,id"
    bytes([4, 0, 0xFF]),  # MERGE_BY_KEY, all keysets at their spacey variants
    bytes([4, 2, 0x1A]),  # MERGE_BY_KEY with max_depth=2
    bytes([0, 1, 0x01]),  # REPLACE, max_depth=1, detect_circular_refs
]

# fuzz_callback: (behaviour 0..7, flags: bit0 legacy+depth, bit1 resolve, bits2+ strategy)
CALLBACK_PREFIXES = [
    bytes([0, 0x00]),  # decline -> default merge, REPLACE
    bytes([1, 0x13]),  # echo incoming, MERGE_BY_INDEX-ish, legacy on, resolve
    bytes([2, 0x12]),  # keep existing
    bytes([3, 0x10]),  # unparseable -> fallback path
    bytes([4, 0x11]),  # empty string -> parse failure, legacy on
    bytes([5, 0x12]),  # path echo
    bytes([6, 0x13]),  # alternating decline/echo
    bytes([7, 0x10]),  # container result
]

# fuzz_idempotent: strategy index into kIdempotent[4]
IDEMPOTENT_PREFIXES = [bytes([0]), bytes([1]), bytes([2]), bytes([3])]


def body(j1, j2):
    """Build the <json1> SEP <json2> payload for a pair."""
    if j1 is None and j2 is None:
        return SEP  # lone separator: two empty documents
    if j2 is None:
        return j1.encode()  # no separator: harness self-merges the buffer
    return j1.encode() + SEP + j2.encode()


def write(dirname, name, data):
    d = os.path.join(HERE, dirname)
    os.makedirs(d, exist_ok=True)
    # Hash suffix keeps names unique and stable across reruns.
    h = hashlib.sha1(data).hexdigest()[:8]
    with open(os.path.join(d, "%s_%s" % (name, h)), "wb") as f:
        f.write(data)


def main():
    counts = {}
    for name, j1, j2 in PAIRS:
        payload = body(j1, j2)

        write("corpus_merge", name, payload)

        for i, pre in enumerate(STRATEGY_PREFIXES):
            write("corpus_strategies", "%s_s%d" % (name, i), pre + payload)

        for i, pre in enumerate(CALLBACK_PREFIXES):
            write("corpus_callback", "%s_c%d" % (name, i), pre + payload)

        for i, pre in enumerate(IDEMPOTENT_PREFIXES):
            write("corpus_idempotent", "%s_i%d" % (name, i), pre + payload)

    for d in ("corpus_merge", "corpus_strategies", "corpus_callback",
              "corpus_idempotent"):
        counts[d] = len(os.listdir(os.path.join(HERE, d)))
    for d, n in sorted(counts.items()):
        print("%-20s %4d seeds" % (d, n))


if __name__ == "__main__":
    main()
