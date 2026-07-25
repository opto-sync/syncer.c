# Cross-language differential test

Proves that every opto-sync language binding (C reference, TypeScript, Dart,
Rust, Go) produces **byte-identical** merge output from the shared C core.

## How it works

1. `gen_corpus.js` — seeded PRNG (mulberry32, fixed seed, no `Date.now` /
   unseeded `Math.random`) emits `corpus.jsonl`: ~305 lines of
   `{"base":<obj>,"incoming":<obj>}`. Lines are built by **string
   concatenation**, never `JSON.stringify` of JS numbers, so int64
   timestamps like `1689940800123456789` survive verbatim. The corpus
   exercises nested objects (to 5 deep), keyed arrays of objects with
   `id` + `updatedAt`/`createdAt`/`syncedAt` (int, string-digit, float and
   int64-nanosecond timestamps), scalar arrays, unicode keys/values,
   int/string ids, nulls, and empty objects/arrays.
2. Runners (`run_c.c`, `run_ts.js`, `run_dart.dart`, `rust-runner/`,
   `go-runner/`) read the corpus and write `results-<lang>.jsonl` — one
   merged JSON string per line, exactly as returned by the binding, no
   re-serialization. All use identical options:
   `arrayStrategy=MERGE_BY_KEY(4)`, `resolveByTimestamp=true`,
   `lwwKeys="updatedAt,syncedAt"`, `fwwKeys="createdAt"`,
   `arrayMatchKeys="id"`, `maxDepth=0`, no callback.
3. `compare.js` asserts all five results files are byte-identical
   line-by-line; on mismatch it prints the line number, the inputs, and
   each language's output.
4. Pass 2 (idempotency): `build_pass2.js` re-pairs each language's own
   pass-1 output with the original incoming doc; re-merging must reproduce
   the pass-1 output byte-for-byte, per language and across languages.

## Corpus line contract

Runners split each line textually on the first `,"incoming":` — never with
a JSON parser (which would corrupt int64 text in JS/Dart). The generator
guarantees no key or string value contains the substring `incoming`, so the
marker is unique per line. Keep that invariant if you extend the pools.

## Run

```sh
./run_all.sh
```

Requires: cc, node (with the TypeScript addon buildable via node-gyp),
dart, cargo, go. The Dart runner loads `../core/build/libsyncer.dylib`
(override with `SYNCER_LIB_PATH`); C/Rust/Go compile the core sources in.
