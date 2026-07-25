/*
 * syncer.c — Production-grade deep JSON merge engine.
 *
 * Key design decisions:
 *   • Heap-based iterative DFS (no C-stack recursion) so arbitrarily deep
 *     JSON trees never cause a stack overflow.
 *   • Full JSON-path tracking passed to override callbacks
 *     (e.g. "$.users[0].profile.address").
 *   • Circular-reference detection via a visited-pair set.
 *   • Four configurable array merge strategies.
 *   • Backwards-compatible legacy API wrapping the extended API.
 */

#include "syncer.h"
#include "yyjson.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* ========================================================================== */
/*  Path builder                                                              */
/* ========================================================================== */

/* All growable helpers below carry an `oom` flag instead of assuming malloc/
 * realloc succeed. On allocation failure they keep their last valid state,
 * flag oom, and the merge aborts cleanly (caller returns NULL) rather than
 * dereferencing NULL or losing the old buffer. */

typedef struct {
    char*  buf;
    size_t len;
    size_t cap;
    bool   oom;
} path_buf_t;

static void path_init(path_buf_t* p) {
    p->cap = 256;
    p->buf = (char*)malloc(p->cap);
    p->len = 1;
    p->oom = (p->buf == NULL);
    if (p->oom) {
        p->cap = 0;
        p->len = 0;
        return;
    }
    p->buf[0] = '$';
    p->buf[1] = '\0';
}

static void path_free(path_buf_t* p) {
    free(p->buf);
    p->buf = NULL;
    p->len = p->cap = 0;
}

static void path_ensure(path_buf_t* p, size_t extra) {
    if (p->oom) return;
    size_t cap = p->cap;
    while (p->len + extra + 1 > cap) cap *= 2;
    if (cap != p->cap) {
        char* grown = (char*)realloc(p->buf, cap);
        if (!grown) {
            p->oom = true; /* old buf stays valid; freed in path_free */
            return;
        }
        p->buf = grown;
        p->cap = cap;
    }
}

static size_t path_save(const path_buf_t* p) { return p->len; }

static void path_restore(path_buf_t* p, size_t saved) {
    if (p->oom) return;
    p->len = saved;
    p->buf[p->len] = '\0';
}

/* Takes an explicit length: JSON keys may legally contain an escaped NUL, so the
 * key is never treated as a C string. The path handed to override callbacks is
 * a `const char*` and therefore still appears truncated at an embedded NUL —
 * unavoidable given that signature — but the buffer's own length accounting
 * stays correct, so deeper keys appended after such a segment are not lost. */
static void path_push_key(path_buf_t* p, const char* key, size_t klen) {
    path_ensure(p, klen + 1);
    if (p->oom) return;
    p->buf[p->len++] = '.';
    memcpy(p->buf + p->len, key, klen);
    p->len += klen;
    p->buf[p->len] = '\0';
}

static void path_push_index(path_buf_t* p, size_t idx) {
    char tmp[32];
    int n = snprintf(tmp, sizeof(tmp), "[%zu]", idx);
    path_ensure(p, (size_t)n);
    if (p->oom) return;
    memcpy(p->buf + p->len, tmp, (size_t)n);
    p->len += (size_t)n;
    p->buf[p->len] = '\0';
}

/* ========================================================================== */
/*  Visited-pair set for circular reference detection                         */
/* ========================================================================== */

typedef struct {
    uintptr_t a;
    uintptr_t b;
} visited_pair_t;

typedef struct {
    visited_pair_t* items;
    size_t          count;
    size_t          cap;
    bool            oom;
} visited_set_t;

static void visited_init(visited_set_t* v) {
    v->cap   = 64;
    v->count = 0;
    v->items = (visited_pair_t*)malloc(v->cap * sizeof(visited_pair_t));
    v->oom   = (v->items == NULL);
    if (v->oom) v->cap = 0;
}

static void visited_free(visited_set_t* v) {
    free(v->items);
    v->items = NULL;
    v->count = v->cap = 0;
}

static bool visited_contains(const visited_set_t* v, const void* a, const void* b) {
    uintptr_t ua = (uintptr_t)a, ub = (uintptr_t)b;
    for (size_t i = 0; i < v->count; i++) {
        if (v->items[i].a == ua && v->items[i].b == ub) return true;
    }
    return false;
}

static void visited_add(visited_set_t* v, const void* a, const void* b) {
    if (v->oom) return;
    if (v->count == v->cap) {
        size_t cap = v->cap * 2;
        visited_pair_t* grown = (visited_pair_t*)realloc(v->items, cap * sizeof(visited_pair_t));
        if (!grown) {
            v->oom = true;
            return;
        }
        v->items = grown;
        v->cap = cap;
    }
    v->items[v->count].a = (uintptr_t)a;
    v->items[v->count].b = (uintptr_t)b;
    v->count++;
}

/* ========================================================================== */
/*  Explicit merge stack (heap-allocated iterative DFS)                       */
/* ========================================================================== */

typedef enum {
    FRAME_OBJECT,   /* iterating over v2 object keys */
    FRAME_ARRAY     /* iterating over v2 array elements by index */
} frame_kind_t;

typedef struct {
    frame_kind_t    kind;
    yyjson_mut_val* v1;          /* mutable destination */
    yyjson_val*     v2;          /* immutable source */
    /* Object iteration state */
    yyjson_obj_iter obj_iter;
    /* Array iteration state */
    size_t          arr_idx;
    size_t          arr_len_v2;
    /* Path state */
    size_t          path_saved;
} merge_frame_t;

typedef struct {
    merge_frame_t* frames;
    size_t         count;
    size_t         cap;
    bool           oom;
} merge_stack_t;

static void stack_init(merge_stack_t* s) {
    s->cap = 64;
    s->count = 0;
    s->frames = (merge_frame_t*)malloc(s->cap * sizeof(merge_frame_t));
    s->oom = (s->frames == NULL);
    if (s->oom) s->cap = 0;
}

static void stack_free(merge_stack_t* s) {
    free(s->frames);
    s->frames = NULL;
    s->count = s->cap = 0;
}

/* Returns NULL on allocation failure (s->oom set); callers must abort. */
static merge_frame_t* stack_push(merge_stack_t* s) {
    if (s->oom) return NULL;
    if (s->count == s->cap) {
        size_t cap = s->cap * 2;
        merge_frame_t* grown = (merge_frame_t*)realloc(s->frames, cap * sizeof(merge_frame_t));
        if (!grown) {
            s->oom = true;
            return NULL;
        }
        s->frames = grown;
        s->cap = cap;
    }
    return &s->frames[s->count++];
}

static void stack_pop(merge_stack_t* s) {
    if (s->count > 0) s->count--;
}

static merge_frame_t* stack_top(merge_stack_t* s) {
    return s->count > 0 ? &s->frames[s->count - 1] : NULL;
}

/* ========================================================================== */
/*  JSON value comparison (for UNION strategy)                                */
/* ========================================================================== */


/* Semantic deep equality across the mutable/immutable APIs.
 *
 * Object keys are compared as SETS, not as ordered text. Comparing serialized
 * forms (the obvious shortcut) makes UNION dedup depend on key order, which no
 * caller controls: Postgres `jsonb` renormalizes key order on every write, so
 * a round-tripped {"id":"c","v":3} comes back as {"v":3,"id":"c"} and would
 * never match the element it is a duplicate of — UNION would silently degrade
 * to APPEND and lose idempotency.
 *
 * Iterative with an explicit heap stack, matching the merge engine: element
 * subtrees can be arbitrarily deep and must not consume the C stack. On
 * allocation failure it reports "not equal", which for UNION means an element
 * may be appended twice — degraded, never corrupt.
 */
typedef struct {
    yyjson_mut_val* a;
    yyjson_val*     b;
} eq_pair_t;

typedef struct {
    eq_pair_t* items;
    size_t     count;
    size_t     cap;
    bool       oom;
} eq_stack_t;

static void eq_init(eq_stack_t* s) {
    s->cap = 32;
    s->count = 0;
    s->items = (eq_pair_t*)malloc(s->cap * sizeof(eq_pair_t));
    s->oom = (s->items == NULL);
    if (s->oom) s->cap = 0;
}

static void eq_free(eq_stack_t* s) {
    free(s->items);
    s->items = NULL;
    s->count = s->cap = 0;
}

static bool eq_push(eq_stack_t* s, yyjson_mut_val* a, yyjson_val* b) {
    if (s->oom) return false;
    if (s->count == s->cap) {
        size_t cap = s->cap * 2;
        eq_pair_t* grown = (eq_pair_t*)realloc(s->items, cap * sizeof(eq_pair_t));
        if (!grown) {
            s->oom = true;
            return false;
        }
        s->items = grown;
        s->cap = cap;
    }
    s->items[s->count].a = a;
    s->items[s->count].b = b;
    s->count++;
    return true;
}

/* Integers compare exactly (nanosecond-safe); any pair involving a real
 * compares as double, so 1 and 1.0 are the same element. */
static bool eq_nums(yyjson_mut_val* a, yyjson_val* b) {
    if (yyjson_mut_is_int(a) && yyjson_is_int(b)) {
        return yyjson_mut_get_sint(a) == yyjson_get_sint(b);
    }
    return yyjson_mut_get_num(a) == yyjson_get_num(b);
}

static bool vals_deep_equal(yyjson_mut_val* root_a, yyjson_val* root_b) {
    eq_stack_t st;
    eq_init(&st);
    bool equal = eq_push(&st, root_a, root_b);

    while (equal && st.count > 0) {
        eq_pair_t p = st.items[--st.count];
        yyjson_mut_val* a = p.a;
        yyjson_val*     b = p.b;

        if (yyjson_mut_is_obj(a) && yyjson_is_obj(b)) {
            if (yyjson_mut_obj_size(a) != yyjson_obj_size(b)) {
                equal = false;
                break;
            }
            yyjson_obj_iter it;
            yyjson_obj_iter_init(b, &it);
            yyjson_val* k;
            while ((k = yyjson_obj_iter_next(&it))) {
                yyjson_mut_val* va =
                    yyjson_mut_obj_getn(a, yyjson_get_str(k), yyjson_get_len(k));
                if (!va || !eq_push(&st, va, yyjson_obj_iter_get_val(k))) {
                    equal = false;
                    break;
                }
            }
        } else if (yyjson_mut_is_arr(a) && yyjson_is_arr(b)) {
            /* Arrays stay ORDER-SENSITIVE: element order is meaningful. */
            size_t n = yyjson_mut_arr_size(a);
            if (n != yyjson_arr_size(b)) {
                equal = false;
                break;
            }
            for (size_t i = 0; i < n; i++) {
                if (!eq_push(&st, yyjson_mut_arr_get(a, i), yyjson_arr_get(b, i))) {
                    equal = false;
                    break;
                }
            }
        } else if (yyjson_mut_is_str(a) && yyjson_is_str(b)) {
            if (strcmp(yyjson_mut_get_str(a), yyjson_get_str(b)) != 0) equal = false;
        } else if (yyjson_mut_is_num(a) && yyjson_is_num(b)) {
            if (!eq_nums(a, b)) equal = false;
        } else if (yyjson_mut_is_bool(a) && yyjson_is_bool(b)) {
            if (yyjson_mut_get_bool(a) != yyjson_get_bool(b)) equal = false;
        } else if (yyjson_mut_is_null(a) && yyjson_is_null(b)) {
            /* both null: equal */
        } else {
            equal = false;
        }
    }

    eq_free(&st);
    return equal;
}

static bool array_contains(yyjson_mut_val* arr, yyjson_val* needle) {
    yyjson_mut_arr_iter iter;
    yyjson_mut_arr_iter_init(arr, &iter);
    yyjson_mut_val* elem;
    while ((elem = yyjson_mut_arr_iter_next(&iter))) {
        if (vals_deep_equal(elem, needle)) return true;
    }
    return false;
}

/* ========================================================================== */
/*  Identity matching for SYNCER_ARRAY_MERGE_BY_KEY                           */
/* ========================================================================== */

/* Equality of two identity values across the mutable/immutable APIs.
 * int-vs-string pairs are normalized (id 42 matches id "42") so a writer
 * that switches the column type between number and string still reconciles
 * against existing rows instead of duplicating them. Other type combinations
 * fall back to serialize-and-compare. */
static bool ident_values_equal(yyjson_mut_val* a, yyjson_val* b) {
    if (yyjson_mut_is_int(a) && yyjson_is_int(b)) {
        return yyjson_mut_get_sint(a) == yyjson_get_sint(b);
    }
    if (yyjson_mut_is_str(a) && yyjson_is_str(b)) {
        return strcmp(yyjson_mut_get_str(a), yyjson_get_str(b)) == 0;
    }
    char ibuf[24];
    const char* sa = yyjson_mut_get_str(a);
    const char* sb = yyjson_get_str(b);
    if (sa && yyjson_is_int(b)) {
        snprintf(ibuf, sizeof(ibuf), "%lld", (long long)yyjson_get_sint(b));
        return strcmp(sa, ibuf) == 0;
    }
    if (sb && yyjson_mut_is_int(a)) {
        snprintf(ibuf, sizeof(ibuf), "%lld", (long long)yyjson_mut_get_sint(a));
        return strcmp(sb, ibuf) == 0;
    }
    char* wa = yyjson_mut_val_write(a, 0, NULL);
    char* wb = yyjson_val_write(b, 0, NULL);
    bool eq = (wa && wb && strcmp(wa, wb) == 0);
    free(wa);
    free(wb);
    return eq;
}

/* Determine the identity key for an incoming object element: the FIRST key in
 * the comma-separated `match_keys` list that the element actually carries.
 * Using only the first present key keeps matching deterministic — a later,
 * weaker key (e.g. "name") can never override a missing match on a stronger
 * one (e.g. "uuid"). Returns the identity value, or NULL if the element
 * carries none of the keys. key_out/keylen_out receive the winning key. */
static yyjson_val* ident_key_of(yyjson_val* elem, const char* match_keys,
                                const char** key_out, size_t* keylen_out) {
    if (!yyjson_is_obj(elem)) return NULL;
    const char* seg = match_keys;
    for (;;) {
        const char* end = strchr(seg, ',');
        size_t len = end ? (size_t)(end - seg) : strlen(seg);
        while (len > 0 && *seg == ' ') { seg++; len--; }
        while (len > 0 && seg[len - 1] == ' ') len--;
        if (len > 0) {
            yyjson_val* v = yyjson_obj_getn(elem, seg, len);
            if (v) {
                *key_out = seg;
                *keylen_out = len;
                return v;
            }
        }
        if (!end) break;
        seg = end + 1;
    }
    return NULL;
}

/* Find the element of `arr1` whose value at key[0..keylen) equals `ident`.
 * Returns its index in *idx_out. First match wins on duplicate identities. */
static yyjson_mut_val* find_by_ident(yyjson_mut_val* arr1, const char* key,
                                     size_t keylen, yyjson_val* ident,
                                     size_t* idx_out) {
    size_t i = 0;
    yyjson_mut_arr_iter iter;
    yyjson_mut_arr_iter_init(arr1, &iter);
    yyjson_mut_val* elem;
    while ((elem = yyjson_mut_arr_iter_next(&iter))) {
        if (yyjson_mut_is_obj(elem)) {
            yyjson_mut_val* v = yyjson_mut_obj_getn(elem, key, keylen);
            if (v && ident_values_equal(v, ident)) {
                *idx_out = i;
                return elem;
            }
        }
        i++;
    }
    return NULL;
}

/* ========================================================================== */
/*  CRDT Timestamp Resolution                                                 */
/* ========================================================================== */

/* True if s[0..len) is a non-empty run of ASCII digits. */
static bool ts_all_digits(const char* s, size_t len) {
    if (len == 0) return false;
    for (size_t i = 0; i < len; i++) {
        if (s[i] < '0' || s[i] > '9') return false;
    }
    return true;
}

/* Compare two timestamp strings. Pure-digit strings (epoch seconds/ms/ns)
 * compare by numeric magnitude even when their lengths differ — plain strcmp
 * would rank "9" above "10". Everything else (e.g. fixed-width ISO-8601)
 * falls back to lexicographic order, which matches chronological order for
 * such formats. */
static int ts_compare(const char* s1, const char* s2) {
    size_t l1 = strlen(s1), l2 = strlen(s2);
    if (ts_all_digits(s1, l1) && ts_all_digits(s2, l2)) {
        while (l1 > 1 && *s1 == '0') { s1++; l1--; }
        while (l2 > 1 && *s2 == '0') { s2++; l2--; }
        if (l1 != l2) return l1 < l2 ? -1 : 1;
        return strncmp(s1, s2, l1);
    }
    return strcmp(s1, s2);
}

static bool check_crdt_keys(yyjson_mut_val* v1, yyjson_val* v2, const char* keys_str, bool is_fww) {
    if (!keys_str || !v1 || !v2) return false;

    /* Walk the comma-separated key list in place — no fixed-size copy (a list
       longer than an internal buffer must not silently stop resolving). */
    const char* seg = keys_str;
    for (;;) {
        const char* end = strchr(seg, ',');
        size_t len = end ? (size_t)(end - seg) : strlen(seg);

        /* Trim surrounding spaces so "updatedAt, syncedAt" works. */
        while (len > 0 && *seg == ' ') { seg++; len--; }
        while (len > 0 && seg[len - 1] == ' ') len--;

        if (len > 0) {
            yyjson_mut_val* t1 = yyjson_mut_obj_getn(v1, seg, len);
            yyjson_val*     t2 = yyjson_obj_getn(v2, seg, len);
            if (t1 && t2) {
                int  cmp = 0;
                bool comparable = false;
                if (yyjson_mut_is_int(t1) && yyjson_is_int(t2)) {
                    int64_t i1 = yyjson_mut_get_sint(t1);
                    int64_t i2 = yyjson_get_sint(t2);
                    cmp = (i1 > i2) - (i1 < i2);
                    comparable = true;
                } else if (yyjson_mut_is_num(t1) && yyjson_is_num(t2)) {
                    /* At least one side is a real (e.g. epoch seconds with a
                       fractional part from time.time()). Compare as doubles so
                       float timestamps cannot silently bypass resolution.
                       Exact int64 comparison above still covers the int-int
                       case, so nanosecond-precision integers stay lossless. */
                    double d1 = yyjson_mut_get_num(t1);
                    double d2 = yyjson_get_num(t2);
                    cmp = (d1 > d2) - (d1 < d2);
                    comparable = true;
                } else {
                    /* Normalize int-vs-string pairs so a writer switching the
                       field between number and string cannot bypass
                       resolution. */
                    char b1[24], b2[24];
                    const char* s1 = yyjson_mut_get_str(t1);
                    const char* s2 = yyjson_get_str(t2);
                    if (!s1 && yyjson_mut_is_int(t1)) {
                        snprintf(b1, sizeof(b1), "%lld", (long long)yyjson_mut_get_sint(t1));
                        s1 = b1;
                    }
                    if (!s2 && yyjson_is_int(t2)) {
                        snprintf(b2, sizeof(b2), "%lld", (long long)yyjson_get_sint(t2));
                        s2 = b2;
                    }
                    if (s1 && s2) {
                        cmp = ts_compare(s1, s2);
                        comparable = true;
                    }
                }
                /* FWW: reject when incoming is newer. LWW: reject when existing is newer. */
                if (comparable && (is_fww ? (cmp < 0) : (cmp > 0))) return true;
            }
        }
        if (!end) break;
        seg = end + 1;
    }
    return false;
}

static bool should_reject_by_crdt_rules(yyjson_mut_val* v1, yyjson_val* v2, const char* lww_keys, const char* fww_keys) {
    if (!v1 || !v2 || !yyjson_mut_is_obj(v1) || !yyjson_is_obj(v2)) return false;

    /* If FWW condition is met (incoming is newer), we reject it */
    if (check_crdt_keys(v1, v2, fww_keys, true)) return true;
    
    /* If LWW condition is met (existing is newer), we reject it */
    if (check_crdt_keys(v1, v2, lww_keys, false)) return true;

    return false;
}

/* ========================================================================== */
/*  Core iterative merge engine                                               */
/* ========================================================================== */

static yyjson_mut_val* merge_leaf(
    yyjson_mut_doc*              doc,
    path_buf_t*                  path,
    yyjson_mut_val*              v1,
    yyjson_val*                  v2,
    const syncer_merge_options_t* opts)
{
    /* Try override callback first */
    if (opts && opts->override_cb) {
        char* s1 = yyjson_mut_val_write(v1, 0, NULL);
        char* s2 = yyjson_val_write(v2, 0, NULL);
        /* Never hand the callback NULL serializations. */
        char* res = (s1 && s2) ? opts->override_cb(path->buf, s1, s2) : NULL;
        free(s1);
        free(s2);
        if (res) {
            yyjson_doc* pd = yyjson_read(res, strlen(res), 0);
            if (pd) {
                yyjson_mut_val* mv = yyjson_val_mut_copy(doc, yyjson_doc_get_root(pd));
                yyjson_doc_free(pd);
                free(res);
                return mv;
            }
            free(res);
        }
    }
    /* Default: v2 overwrites v1 */
    return yyjson_val_mut_copy(doc, v2);
}

/* Consult the override callback for a CONTAINER node where both sides are
 * present, returning the replacement value or NULL to fall through to the
 * default merge (no callback, the callback declined, or it returned
 * unparseable JSON — the last case must not drop v2's subtree).
 *
 * Used for objects AND for arrays under every non-REPLACE strategy. Arrays
 * used to skip this entirely, so an override registered for an array path was
 * silently ignored whenever a strategy other than REPLACE was in effect —
 * which is the default policy across opto-sync. That made overrides
 * unpredictable: the same callback fired for `$.profile` but not for
 * `$.profile.tags`. */
static yyjson_mut_val* try_override_node(yyjson_mut_doc*               doc,
                                         const syncer_merge_options_t* opts,
                                         path_buf_t*                   path,
                                         yyjson_mut_val*               v1,
                                         yyjson_val*                   v2)
{
    if (!opts || !opts->override_cb) return NULL;
    char* s1 = yyjson_mut_val_write(v1, 0, NULL);
    char* s2 = yyjson_val_write(v2, 0, NULL);
    /* Never hand the callback NULL serializations. */
    char* res = (s1 && s2) ? opts->override_cb(path->buf, s1, s2) : NULL;
    free(s1);
    free(s2);
    if (!res) return NULL;
    yyjson_doc* pd = yyjson_read(res, strlen(res), 0);
    free(res);
    if (!pd) return NULL;
    yyjson_mut_val* mv = yyjson_val_mut_copy(doc, yyjson_doc_get_root(pd));
    yyjson_doc_free(pd);
    return mv;
}

/* Returns false when the merge had to abort (allocation failure); the caller
 * must then discard the partially merged doc and report an error. */
static bool do_merge(
    yyjson_mut_doc*              doc,
    yyjson_mut_val*              root1,
    yyjson_val*                  root2,
    const syncer_merge_options_t* opts)
{
    merge_stack_t stack;
    stack_init(&stack);

    path_buf_t path;
    path_init(&path);

    visited_set_t visited = {0};
    if (opts && opts->detect_circular_refs) visited_init(&visited);

    syncer_array_strategy_t arr_strat = opts ? opts->array_strategy : SYNCER_ARRAY_REPLACE;
    uint32_t max_depth = opts ? opts->max_depth : 0;
    bool resolve_ts = opts ? opts->resolve_by_timestamp : false;
    const char* lww_keys = (opts && opts->lww_keys) ? opts->lww_keys : "updatedAt";
    const char* fww_keys = (opts && opts->fww_keys) ? opts->fww_keys : NULL;
    const char* match_keys = (opts && opts->array_match_keys) ? opts->array_match_keys : "id";

    bool ok = !stack.oom && !path.oom && !visited.oom;

    /* Seed: if both roots are objects, push a frame; otherwise leaf-merge at root */
    if (ok && yyjson_mut_is_obj(root1) && yyjson_is_obj(root2)) {
        if (resolve_ts && should_reject_by_crdt_rules(root1, root2, lww_keys, fww_keys)) {
            /* Root v1 is newer; keep v1 entirely (not an error) — fall through
               to the shared cleanup with an empty stack. */
        } else {
            if (opts && opts->detect_circular_refs) {
                visited_add(&visited, root1, root2);
            }
            merge_frame_t* f = stack_push(&stack);
            if (!f) {
                ok = false;
            } else {
                f->kind = FRAME_OBJECT;
                f->v1 = root1;
                f->v2 = root2;
                yyjson_obj_iter_init(root2, &f->obj_iter);
                f->path_saved = path_save(&path);
            }
        }
    } else if (ok && yyjson_mut_is_arr(root1) && yyjson_is_arr(root2)
               && arr_strat != SYNCER_ARRAY_REPLACE) {
        /* A root-level array is still a node the host may override ("$"). */
        yyjson_mut_val* ov = try_override_node(doc, opts, &path, root1, root2);
        if (ov) {
            yyjson_mut_doc_set_root(doc, ov);
            stack_free(&stack);
            path_free(&path);
            if (opts && opts->detect_circular_refs) visited_free(&visited);
            return true;
        }
        merge_frame_t* f = stack_push(&stack);
        if (!f) {
            ok = false;
        } else {
            f->kind = FRAME_ARRAY;
            f->v1 = root1;
            f->v2 = root2;
            f->arr_idx = 0;
            f->arr_len_v2 = yyjson_arr_size(root2);
            f->path_saved = path_save(&path);
        }
    }
    /* else: handled after this loop — root itself is a leaf merge */

    while (ok && stack.count > 0) {
        if (path.oom || visited.oom) {
            ok = false;
            break;
        }
        merge_frame_t* top = stack_top(&stack);

        if (top->kind == FRAME_OBJECT) {
            yyjson_val* k2 = yyjson_obj_iter_next(&top->obj_iter);
            if (!k2) {
                /* Done with this object frame */
                path_restore(&path, top->path_saved);
                stack_pop(&stack);
                continue;
            }
            yyjson_val* val2 = yyjson_obj_iter_get_val(k2);
            const char* key_str = yyjson_get_str(k2);
            /* Length-explicit throughout: a JSON key may legally contain an
               escaped NUL (RFC 8259 permits the escape sequence backslash-
               u-0-0-0-0 inside a string), and strlen-based lookup or key
               creation truncates there. That silently aliases an incoming
               key onto an unrelated shorter existing key, overwriting it AND
               dropping the real key. Values were always length-correct via
               yyjson_val_mut_copy; keys have to match that. */
            size_t key_len = yyjson_get_len(k2);
            yyjson_mut_val* val1 = yyjson_mut_obj_getn(top->v1, key_str, key_len);

            if (!val1) {
                /* Key only in v2: copy it */
                yyjson_mut_val* cp = yyjson_val_mut_copy(doc, val2);
                yyjson_mut_obj_add(top->v1, yyjson_mut_strn(doc, key_str, key_len), cp);
                continue;
            }

            /* Build path for this key */
            size_t saved = path_save(&path);
            path_restore(&path, top->path_saved);
            path_push_key(&path, key_str, key_len);

            /* Check depth */
            if (max_depth > 0 && stack.count >= max_depth) {
                /* At max depth, do a leaf merge (overwrite or callback) */
                yyjson_mut_val* merged = merge_leaf(doc, &path, val1, val2, opts);
                yyjson_mut_obj_put(top->v1, yyjson_mut_strn(doc, key_str, key_len), merged);
                path_restore(&path, saved);
                continue;
            }

            /* Circular ref check */
            if (opts && opts->detect_circular_refs) {
                if (visited_contains(&visited, val1, val2)) {
                    /* Circular: skip this subtree */
                    path_restore(&path, saved);
                    continue;
                }
                visited_add(&visited, val1, val2);
            }

            /* Both objects: push a new frame */
            if (yyjson_mut_is_obj(val1) && yyjson_is_obj(val2)) {
                if (resolve_ts && should_reject_by_crdt_rules(val1, val2, lww_keys, fww_keys)) {
                    /* v1 is newer -> keep v1, don't descend or overwrite */
                    path_restore(&path, saved);
                    continue;
                }

                /* Try the callback first; an unparseable result falls back to
                   the default deep merge rather than dropping v2's subtree. */
                {
                    yyjson_mut_val* mv = try_override_node(doc, opts, &path, val1, val2);
                    if (mv) {
                        yyjson_mut_obj_put(top->v1, yyjson_mut_strn(doc, key_str, key_len), mv);
                        path_restore(&path, saved);
                        continue;
                    }
                }
                merge_frame_t* f = stack_push(&stack);
                if (!f) {
                    ok = false;
                    break;
                }
                f->kind = FRAME_OBJECT;
                f->v1 = val1;
                f->v2 = val2;
                yyjson_obj_iter_init(val2, &f->obj_iter);
                f->path_saved = path_save(&path);
                continue;
            }

            /* Both arrays with non-replace strategy: push array frame */
            if (yyjson_mut_is_arr(val1) && yyjson_is_arr(val2)
                && arr_strat != SYNCER_ARRAY_REPLACE) {
                /* Same contract as objects: the host gets to decide this node
                   before the strategy descends into it. */
                yyjson_mut_val* ov = try_override_node(doc, opts, &path, val1, val2);
                if (ov) {
                    yyjson_mut_obj_put(top->v1, yyjson_mut_strn(doc, key_str, key_len), ov);
                    path_restore(&path, saved);
                    continue;
                }
                merge_frame_t* f = stack_push(&stack);
                if (!f) {
                    ok = false;
                    break;
                }
                f->kind = FRAME_ARRAY;
                f->v1 = val1;
                f->v2 = val2;
                f->arr_idx = 0;
                f->arr_len_v2 = yyjson_arr_size(val2);
                f->path_saved = path_save(&path);
                continue;
            }

            /* Leaf merge (type mismatch, primitives, or array replace) */
            yyjson_mut_val* merged = merge_leaf(doc, &path, val1, val2, opts);
            yyjson_mut_obj_put(top->v1, yyjson_mut_strn(doc, key_str, key_len), merged);
            path_restore(&path, saved);

        } else if (top->kind == FRAME_ARRAY) {
            /* Array frame processing */
            yyjson_mut_val* arr1 = top->v1;
            yyjson_val*     arr2 = top->v2;

            if (arr_strat == SYNCER_ARRAY_APPEND) {
                yyjson_arr_iter it2;
                yyjson_arr_iter_init(arr2, &it2);
                yyjson_val* elem;
                while ((elem = yyjson_arr_iter_next(&it2))) {
                    yyjson_mut_val* cp = yyjson_val_mut_copy(doc, elem);
                    yyjson_mut_arr_append(arr1, cp);
                }
                path_restore(&path, top->path_saved);
                stack_pop(&stack);
                continue;
            }

            if (arr_strat == SYNCER_ARRAY_UNION) {
                yyjson_arr_iter it2;
                yyjson_arr_iter_init(arr2, &it2);
                yyjson_val* elem;
                while ((elem = yyjson_arr_iter_next(&it2))) {
                    if (!array_contains(arr1, elem)) {
                        yyjson_mut_val* cp = yyjson_val_mut_copy(doc, elem);
                        yyjson_mut_arr_append(arr1, cp);
                    }
                }
                path_restore(&path, top->path_saved);
                stack_pop(&stack);
                continue;
            }

            if (arr_strat == SYNCER_ARRAY_MERGE_BY_KEY) {
                /* Process one v2 element per outer-loop iteration so matched
                   pairs can descend as normal object frames. */
                size_t i = top->arr_idx;
                if (i >= top->arr_len_v2) {
                    path_restore(&path, top->path_saved);
                    stack_pop(&stack);
                    continue;
                }
                top->arr_idx = i + 1;

                yyjson_val* e2 = yyjson_arr_get(arr2, i);
                const char* ikey = NULL;
                size_t ikeylen = 0;
                yyjson_val* ident = ident_key_of(e2, match_keys, &ikey, &ikeylen);

                if (!ident) {
                    /* Non-object, or object without any identity key: UNION
                       semantics so repeated syncs of the same payload stay
                       idempotent instead of duplicating elements. */
                    if (!array_contains(arr1, e2)) {
                        yyjson_mut_val* cp = yyjson_val_mut_copy(doc, e2);
                        yyjson_mut_arr_append(arr1, cp);
                    }
                    continue;
                }

                size_t idx1 = 0;
                yyjson_mut_val* e1 = find_by_ident(arr1, ikey, ikeylen, ident, &idx1);
                if (!e1) {
                    /* New identity: append */
                    yyjson_mut_val* cp = yyjson_val_mut_copy(doc, e2);
                    yyjson_mut_arr_append(arr1, cp);
                    continue;
                }

                /* Matched pair: per-element timestamp resolution, then deep
                   merge by pushing an object frame. */
                if (resolve_ts && should_reject_by_crdt_rules(e1, e2, lww_keys, fww_keys)) {
                    continue; /* existing element is newer — keep it */
                }
                path_restore(&path, top->path_saved);
                path_push_index(&path, idx1);
                merge_frame_t* f = stack_push(&stack);
                if (!f) {
                    ok = false;
                    break;
                }
                f->kind = FRAME_OBJECT;
                f->v1 = e1;
                f->v2 = e2;
                yyjson_obj_iter_init(e2, &f->obj_iter);
                f->path_saved = path_save(&path);
                continue;
            }

            if (arr_strat == SYNCER_ARRAY_MERGE_BY_INDEX) {
                /* Process one element per outer-loop iteration */
                size_t i = top->arr_idx;
                size_t len1 = yyjson_mut_arr_size(arr1);
                size_t len2 = top->arr_len_v2;
                size_t max_len = len1 > len2 ? len1 : len2;

                if (i >= max_len) {
                    /* All indices processed — pop this frame */
                    path_restore(&path, top->path_saved);
                    stack_pop(&stack);
                    continue;
                }

                /* Advance index for next iteration */
                top->arr_idx = i + 1;

                yyjson_mut_val* e1 = (i < len1) ? yyjson_mut_arr_get(arr1, i) : NULL;
                yyjson_val*     e2 = (i < len2) ? yyjson_arr_get(arr2, i) : NULL;

                if (e1 && e2) {
                    size_t path_before = path_save(&path);
                    path_restore(&path, top->path_saved);
                    path_push_index(&path, i);

                    if (yyjson_mut_is_obj(e1) && yyjson_is_obj(e2)) {
                        if (resolve_ts && should_reject_by_crdt_rules(e1, e2, lww_keys, fww_keys)) {
                            /* v1 is newer -> keep v1 as-is */
                        } else {
                            /* Push a child object frame — the outer while loop
                               will process it, and when it pops, we'll come back
                               here with arr_idx already advanced. */
                            merge_frame_t* f = stack_push(&stack);
                            if (!f) {
                                ok = false;
                                break;
                            }
                            f->kind = FRAME_OBJECT;
                            f->v1 = e1;
                            f->v2 = e2;
                            yyjson_obj_iter_init(e2, &f->obj_iter);
                            f->path_saved = path_save(&path);
                        }
                    } else {
                        /* Leaf merge for this index */
                        yyjson_mut_val* merged = merge_leaf(doc, &path, e1, e2, opts);
                        yyjson_mut_arr_replace(arr1, i, merged);
                    }
                    /* Don't restore path here — child frame will do it,
                       or the next iteration will restore via path_saved */
                    (void)path_before;
                } else if (!e1 && e2) {
                    /* v1 shorter: append from v2 */
                    yyjson_mut_val* cp = yyjson_val_mut_copy(doc, e2);
                    yyjson_mut_arr_append(arr1, cp);
                }
                /* else e1 && !e2: v2 shorter, keep v1 element as-is */
                continue;
            }

            /* Fallthrough: SYNCER_ARRAY_REPLACE (shouldn't reach here) */
            path_restore(&path, top->path_saved);
            stack_pop(&stack);
        }
    }

    if (path.oom || stack.oom || visited.oom) ok = false;

    stack_free(&stack);
    path_free(&path);
    if (opts && opts->detect_circular_refs) visited_free(&visited);
    return ok;
}

/* ========================================================================== */
/*  Public API                                                                */
/* ========================================================================== */

char* syncer_merge_json_ex(const char* json1,
                            const char* json2,
                            const syncer_merge_options_t* opts)
{
    if (!json1 && !json2) return NULL;

    /* One-sided merge: still parse the present side, so invalid JSON returns
       NULL (per the API contract) instead of being echoed back verbatim. */
    if (!json1 || !json2) {
        const char* only = json1 ? json1 : json2;
        yyjson_doc* d = yyjson_read(only, strlen(only), 0);
        if (!d) return NULL;
        char* out = yyjson_write(d, 0, NULL);
        yyjson_doc_free(d);
        return out;
    }

    yyjson_doc* doc1 = yyjson_read(json1, strlen(json1), 0);
    yyjson_doc* doc2 = yyjson_read(json2, strlen(json2), 0);

    if (!doc1 || !doc2) {
        if (doc1) yyjson_doc_free(doc1);
        if (doc2) yyjson_doc_free(doc2);
        return NULL;
    }

    yyjson_mut_doc* mut_doc = yyjson_doc_mut_copy(doc1, NULL);
    if (!mut_doc) {
        yyjson_doc_free(doc1);
        yyjson_doc_free(doc2);
        return NULL;
    }
    yyjson_mut_val* root1 = yyjson_mut_doc_get_root(mut_doc);
    yyjson_val*     root2 = yyjson_doc_get_root(doc2);

    /* If both roots are containers, use the iterative engine */
    bool both_obj = yyjson_mut_is_obj(root1) && yyjson_is_obj(root2);
    bool both_arr = yyjson_mut_is_arr(root1) && yyjson_is_arr(root2);
    syncer_array_strategy_t strat = opts ? opts->array_strategy : SYNCER_ARRAY_REPLACE;

    bool merged_ok = true;
    if (both_obj || (both_arr && strat != SYNCER_ARRAY_REPLACE)) {
        merged_ok = do_merge(mut_doc, root1, root2, opts);
    } else {
        /* Root-level leaf merge or array-replace at root */
        path_buf_t p;
        path_init(&p);
        if (p.oom) {
            merged_ok = false;
        } else {
            yyjson_mut_val* merged = merge_leaf(mut_doc, &p, root1, root2, opts);
            if (merged) yyjson_mut_doc_set_root(mut_doc, merged);
            else merged_ok = false;
        }
        path_free(&p);
    }

    char* result = merged_ok ? yyjson_mut_write(mut_doc, 0, NULL) : NULL;

    yyjson_mut_doc_free(mut_doc);
    yyjson_doc_free(doc1);
    yyjson_doc_free(doc2);

    return result;
}

/* --------------------------------------------------------------------------
 * Legacy wrapper: adapts the old (key-only) callback to the new (path) API.
 * -------------------------------------------------------------------------- */

/* Thread-local storage for the legacy callback wrapper */
static __thread syncer_merge_override_cb s_legacy_cb;

static char* legacy_cb_adapter(const char* json_path,
                                const char* val1,
                                const char* val2)
{
    if (!s_legacy_cb) return NULL;
    /* Extract the last key segment from the path for backwards compat */
    const char* last_dot = strrchr(json_path, '.');
    const char* last_bracket = strrchr(json_path, '[');
    const char* key = json_path;
    if (last_dot && (!last_bracket || last_dot > last_bracket)) {
        key = last_dot + 1;
    } else if (last_bracket) {
        key = last_bracket;
    }
    return s_legacy_cb(key, val1, val2);
}

char* syncer_merge_json(const char* json1,
                         const char* json2,
                         syncer_merge_override_cb cb)
{
    if (cb) {
        s_legacy_cb = cb;
        syncer_merge_options_t opts = syncer_default_options();
        opts.override_cb = legacy_cb_adapter;
        char* out = syncer_merge_json_ex(json1, json2, &opts);
        s_legacy_cb = NULL; /* never leave a stale cb visible to later calls */
        return out;
    }
    return syncer_merge_json_ex(json1, json2, NULL);
}

void syncer_free(void* ptr) {
    if (ptr) free(ptr);
}

const char* syncer_version(void) {
    return "0.2.0";
}
