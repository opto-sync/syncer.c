/**
 * Hand-written JS layer over the emscripten glue.
 *
 * The public surface mirrors @opto-sync/syncer (the Node N-API binding) so the
 * two are drop-in interchangeable — same function names, same camelCase option
 * names, same return values (including `null` on unparseable JSON). The only
 * difference is that wasm has to be instantiated first, hence initSyncer().
 *
 * This file is shared by every artifact flavour (single-file / split) so the
 * marshalling logic can never drift between them.
 */

/** Mirrors the C enum syncer_array_strategy_t. */
export const ArrayStrategy = Object.freeze({
  REPLACE: 0,
  APPEND: 1,
  UNION: 2,
  MERGE_BY_INDEX: 3,
  MERGE_BY_KEY: 4,
});

const NOT_READY =
  'opto-sync wasm: engine not initialized. Call `await initSyncer()` before mergeJson()/version().';

/**
 * @param {(opts?: object) => Promise<any>} moduleFactory
 *   The emscripten MODULARIZE factory (default export of the generated glue).
 */
export function createBinding(moduleFactory) {
  /** Resolved emscripten Module, or null before init. */
  let mod = null;
  /** In-flight init, so concurrent callers share one instantiation. */
  let pending = null;

  /**
   * Instantiate the wasm engine. Idempotent: repeated calls (and concurrent
   * calls) resolve to the same instance and never instantiate twice. A failed
   * init is not cached, so a caller can retry with different options.
   *
   * @param {object} [options]
   * @param {ArrayBuffer|Uint8Array} [options.wasmBinary] Pre-fetched wasm bytes.
   *   Required for the split build outside a browser (Node cannot fetch file:
   *   URLs); ignored by the single-file build, which has the bytes inlined.
   * @param {(path: string, dir: string) => string} [options.locateFile]
   *   Override where the split build looks for syncer-core.wasm.
   */
  function initSyncer(options) {
    if (mod) return Promise.resolve(api);
    if (!pending) {
      const moduleArg = {};
      if (options && options.wasmBinary) moduleArg.wasmBinary = options.wasmBinary;
      if (options && options.locateFile) moduleArg.locateFile = options.locateFile;
      pending = Promise.resolve()
        .then(() => moduleFactory(moduleArg))
        .then((m) => {
          mod = m;
          return api;
        })
        .catch((err) => {
          pending = null;
          throw err;
        });
    }
    return pending;
  }

  /** True once the wasm engine is usable. */
  function isReady() {
    return mod !== null;
  }

  /**
   * Copy a JS string into the wasm heap as NUL-terminated UTF-8.
   * @returns {number} pointer; caller owns it.
   */
  function allocString(str) {
    const bytes = mod.lengthBytesUTF8(str) + 1;
    const ptr = mod._malloc(bytes);
    if (!ptr) throw new Error('opto-sync wasm: out of memory allocating a string');
    mod.stringToUTF8(str, ptr, bytes);
    return ptr;
  }

  /**
   * Allocate only when the option is actually a string.
   *
   * 0 (NULL) and a pointer to "" are NOT interchangeable: the core reads NULL
   * lww_keys as "updatedAt" and NULL array_match_keys as "id", while "" means
   * "no keys". Absent option -> NULL keeps parity with the Node binding, which
   * only writes the field when the JS value is a string.
   */
  function allocOptionalString(value) {
    return typeof value === 'string' ? allocString(value) : 0;
  }

  /**
   * Deep merge two JSON strings.
   *
   * @param {string} baseJson
   * @param {string} incomingJson
   * @param {object|Function} [options] Option bag, or (legacy, as in the Node
   *   binding) the override callback positionally.
   * @param {number}   [options.arrayStrategy]     ArrayStrategy.* (default REPLACE)
   * @param {string}   [options.arrayMatchKeys]    identity keys for MERGE_BY_KEY (default "id")
   * @param {number}   [options.maxDepth]          0 = unlimited
   * @param {boolean}  [options.detectCircularRefs]
   * @param {boolean}  [options.resolveByTimestamp]
   * @param {string}   [options.lwwKeys]
   * @param {string}   [options.fwwKeys]
   * @param {Function} [options.overrideCb] (jsonPath, v1Json, v2Json) => string|undefined
   * @returns {string|null} merged JSON, or null when either input fails to parse.
   */
  function mergeJson(baseJson, incomingJson, options) {
    if (!mod) throw new Error(NOT_READY);
    if (typeof baseJson !== 'string' || typeof incomingJson !== 'string') {
      throw new TypeError('String expected');
    }

    /* Function-before-object dispatch, same ordering trap as the Node binding:
       a function IS an object, so testing IsObject first makes the legacy
       positional-callback form unreachable. */
    let overrideCb = null;
    let opts = {};
    if (typeof options === 'function') {
      overrideCb = options;
    } else if (options !== null && typeof options === 'object') {
      opts = options;
      if (typeof opts.overrideCb === 'function') overrideCb = opts.overrideCb;
    }

    /* Every pointer we allocate lands here and is freed in the finally block,
       so a throw anywhere (including out of the user's override) cannot leak
       the wasm heap. */
    const owned = [];
    let cbPtr = 0;
    let callbackError = null;
    let callbackThrew = false;

    const alloc = (v) => {
      const p = allocOptionalString(v);
      if (p) owned.push(p);
      return p;
    };

    try {
      const pBase = allocString(baseJson);
      owned.push(pBase);
      const pIncoming = allocString(incomingJson);
      owned.push(pIncoming);

      const pLww = alloc(opts.lwwKeys);
      const pFww = alloc(opts.fwwKeys);
      const pMatch = alloc(opts.arrayMatchKeys);

      /* `| 0` / `>>> 0` are exactly ToInt32 / ToUint32 — the same coercion
         node-addon-api's Int32Value()/Uint32Value() apply. */
      const strategy = typeof opts.arrayStrategy === 'number' ? opts.arrayStrategy | 0 : 0;
      const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth >>> 0 : 0;
      const detect = opts.detectCircularRefs === true ? 1 : 0;
      const resolve = opts.resolveByTimestamp === true ? 1 : 0;

      let resultPtr;
      if (overrideCb) {
        /* Mirrors the Node binding's exception semantics: the first throw from
           the override is remembered, the override is not invoked again, the
           core falls back to its default merge for the remaining keys, and the
           error is rethrown once the merge has unwound cleanly. Letting a JS
           exception tear through the wasm frames instead would abandon every
           allocation the core is holding. */
        cbPtr = mod.addFunction((pathPtr, v1Ptr, v2Ptr) => {
          if (callbackThrew) return 0;
          let res;
          try {
            res = overrideCb(
              mod.UTF8ToString(pathPtr),
              mod.UTF8ToString(v1Ptr),
              mod.UTF8ToString(v2Ptr),
            );
          } catch (err) {
            callbackThrew = true;
            callbackError = err;
            return 0;
          }
          if (typeof res !== 'string') return 0;
          /* Ownership transfers to the core, which free()s it. Deliberately
             not pushed onto `owned`. */
          return allocString(res);
        }, 'iiii');

        resultPtr = mod._syncer_merge_flat_cb(
          pBase, pIncoming, strategy, maxDepth, detect, resolve, pLww, pFww, pMatch, cbPtr,
        );
      } else {
        resultPtr = mod._syncer_merge_flat(
          pBase, pIncoming, strategy, maxDepth, detect, resolve, pLww, pFww, pMatch,
        );
      }

      if (callbackError) {
        if (resultPtr) mod._syncer_free(resultPtr);
        throw callbackError;
      }
      if (!resultPtr) return null;

      const out = mod.UTF8ToString(resultPtr);
      mod._syncer_free(resultPtr);
      return out;
    } finally {
      for (const p of owned) mod._free(p);
      /* Without this the function table grows by one slot per merge that used
         an override — a slow leak that no heap check would notice. */
      if (cbPtr) mod.removeFunction(cbPtr);
    }
  }

  /** Version of the underlying syncer.c core, e.g. "0.2.0". Static string. */
  function version() {
    if (!mod) throw new Error(NOT_READY);
    return mod.UTF8ToString(mod._syncer_version());
  }

  /**
   * Bytes currently allocated inside the wasm heap. Test/diagnostic hook for
   * proving the binding does not leak across repeated merges.
   */
  function heapAllocatedBytes() {
    if (!mod) throw new Error(NOT_READY);
    return mod._syncer_wasm_alloc_bytes();
  }

  /** Total size of the wasm linear memory in bytes (never shrinks). */
  function heapTotalBytes() {
    if (!mod) throw new Error(NOT_READY);
    return mod.HEAPU8.length;
  }

  const api = {
    initSyncer,
    isReady,
    mergeJson,
    version,
    ArrayStrategy,
    heapAllocatedBytes,
    heapTotalBytes,
  };
  return api;
}
