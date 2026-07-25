# Goal: Create `syncer.c` Repository and Library

The goal is to create a new repository `opto-sync/syncer.c` containing a C library that performs deep merging of JSON objects (specifically targeting JSONB fields from ORMs like Drizzle, SeaORM, Prisma, Ecto, GORM, etc.), while allowing custom merge strategies and overrides defined in higher-level languages.

This library will centralize the complex deep-merge logic into a fast, portable C core, preventing logic duplication across your multi-language stack.

## User Review Required

> [!IMPORTANT]
> Please review the expanded architecture that now includes **Golang** and the **BEAM Ecosystem (Erlang, Elixir, Gleam)**.

## Open Questions

> [!WARNING]
> 1. **Typescript Bindings:** Should we use **Node-API (N-API)** for native Node.js addons, or compile the C code to **WebAssembly (WASM)** so it can run seamlessly in browsers, Deno, and Bun as well? (WASM is highly recommended for edge environments).
> 2. **BEAM Bindings:** For Erlang/Elixir/Gleam, Native Implemented Functions (NIFs) can block the BEAM scheduler if they run too long. Since JSON merging is usually very fast, standard NIFs should be fine, but do you foresee extremely large JSON documents that might require Dirty NIFs to avoid scheduler blocking?

## Proposed Architecture

The system will consist of a C core (`libsyncer`), multiple binding layers, and an ORM/Validation plugin layer.

### 1. C Core (`libsyncer`)
- **JSON Representation:** Parse incoming JSON strings into an in-memory AST using `yyjson` (Implemented).
- **Merge Engine:** A recursive deep-merge algorithm that merges two JSON ASTs (Implemented).
- **Override Callbacks:** The C API will accept C function pointers to yield merging decisions to the host language.

### 2. Language Bindings (Expanded)
- **Rust (`syncer-rs`):** Uses the `cc` crate and `bindgen`. (Implemented Prototype).
- **TypeScript (`@opto-sync/syncer`):** Will provide both **Node-API (N-API)** (for native high-performance server logic) and **WASM** builds (for edge environments).
- **Dart (`syncer_dart`):** Uses `dart:ffi` and `ffigen`.
- **Golang (`syncer-go`):** Uses `cgo` to link against the C library. 
- **BEAM Ecosystem (`syncer_nif`):** A shared Native Implemented Function (NIF) for Erlang/Elixir/Gleam.

### 3. Zero-Deserialization ORM Strategy (Performance)
To maximize FFI/WASM boundary performance, the ORM plugins will be designed to intercept the raw JSON strings coming from the SQL driver **before** they are deserialized into host-language objects (POJOs, Rust structs, etc.). 
- The raw JSON strings will be passed directly into the C core.
- The C core merges them rapidly in memory.
- The C core returns a single raw JSON string.
- The host language then deserializes this final merged string *only once* into the host object.
This prevents redundant encode/decode cycles and keeps performance extremely high.

### 3. ORM Plugins & Enforced Override Classes
To guarantee data integrity and strict behavior, the ORM plugins will **force** the developer to implement a class or struct with manual merging overrides for complex fields.

- **TypeScript / Drizzle:** Extend abstract `BaseMergeStrategy<T>`.
- **Rust / SeaORM:** Implement `MergeOverride` trait.
- **Golang / GORM:** Implement a `MergeStrategy` interface with methods for specific struct fields.
- **Elixir / Ecto:** Implement an Ecto Custom Type behavior (`Ecto.Type`) where the `cast` and `dump` functions utilize the NIF, and enforce a specific protocol for merging.

### 4. Validation & Constraints Layer
To ensure merged data is safe to persist back to the database:
- **TypeScript:** Parse merged result through Zod.
- **Rust:** Serialize into Serde models and validate.
- **Golang:** Use struct tags (e.g., `go-playground/validator`) on the unmarshaled merged result.
- **SQL Constraints Check:** The ORM plugins will rely on the type-safe ORM schema to catch errors pre-insertion, while surfacing DB-level errors cleanly.

## Repository Structure

```
syncer.c/
├── core/                  # C library source code (Done)
├── bindings/
│   ├── rust/              # Rust crate (syncer-rs) (Done)
│   ├── typescript/        # NPM package (@opto-sync/syncer)
│   ├── dart/              # Dart/Flutter package (syncer_dart)
│   ├── go/                # Golang module (syncer-go)
│   └── beam/              # Erlang/Elixir/Gleam NIFs (syncer_nif)
└── plugins/               
    ├── seaorm/            # SeaORM integration
    ├── drizzle/           # Drizzle integration
    ├── gorm/              # Golang GORM integration
    └── ecto/              # Elixir Ecto integration
```

## Verification Plan

1. **Repository Setup:** Scaffold the local directory structure. (Done)
2. **Core Prototype:** Write a basic C implementation. (Done)
3. **Binding Tests:** Write tests in Rust (Done), TS, Dart, Go, and Elixir that call the C library.
4. **Enforced Class Tests:** Write tests to show that the respective compilers/type-checkers throw errors if the required merge overrides are missing.

---

## Status update (2026-07-24)

Core `libsyncer` is at **v0.2.0** (`syncer_version()`):

- Iterative (heap-stack) deep merge — no C-stack recursion; tested to 1000 levels.
- Array strategies: `REPLACE`, `APPEND`, `UNION`, `MERGE_BY_INDEX`, and new
  **`MERGE_BY_KEY`** — reconciles objects-in-arrays by identity keys
  (`array_match_keys`, default `"id"`), deep-merging matched pairs with
  per-element CRDT timestamp resolution (`lww_keys` e.g. `updatedAt,syncedAt`;
  `fww_keys` e.g. `createdAt`), appending unmatched incoming elements, keeping
  existing-only elements, and treating scalars as a union so repeated syncs
  are idempotent.
- Test suites: `make` runs 34 unit tests plus randomized property tests
  (idempotency, always-valid output, corruption robustness); `make sanitize`
  runs both under ASan+UBSan.
- Documented out-of-contract inputs: duplicate object keys; duplicate identity
  values within a single array.

Client libraries moved to the sibling repo `../opto-sync-clients`
(`clients/{dart,ts,rust}`) — external projects import those; they consume this
repo's bindings and never reimplement merge logic. The former `clients/wasm`
was a misnomer (Node-API TS client) and now lives at `clients/ts`; a true WASM
build remains an open item, as does the BEAM NIF (design doc only).
