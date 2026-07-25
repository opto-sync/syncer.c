import 'dart:ffi';
import 'dart:io';
import 'package:ffi/ffi.dart';

/// Array merge strategies. Values mirror `syncer_array_strategy_t` in syncer.h.
enum ArrayMergeStrategy {
  /// Incoming array completely replaces the base array (default).
  replace(0),

  /// Concatenate incoming elements after the base elements.
  append(1),

  /// Append only incoming elements not already present in the base (idempotent).
  union(2),

  /// Merge element-wise: base[i] deep-merged with incoming[i].
  mergeByIndex(3),

  /// Match object elements by identity key(s) (see
  /// [MergeOptions.arrayMatchKeys]); matched pairs deep-merge (honoring
  /// timestamp resolution per element), unmatched incoming elements append,
  /// base-only elements are kept. Non-object elements behave like [union].
  /// Identity values are normalized, so `"id": 42` matches `"id": "42"`.
  mergeByKey(4);

  final int value;
  const ArrayMergeStrategy(this.value);
}

/// Alias so callers can refer to the strategy enum by the C-style short name.
typedef ArrayStrategy = ArrayMergeStrategy;

/// Override callback signature (`syncer_merge_override_cb_ex`).
///
/// The first argument is the FULL JSON path of the conflicting node
/// (e.g. `$.users[0].profile`), never the bare key name.
///
/// ALLOCATION CONTRACT: a non-null returned `Pointer<Utf8>` is consumed and
/// freed BY THE C CORE with `free()`. It must therefore come from the C
/// allocator — `malloc` from package:ffi, which is what
/// `String.toNativeUtf8()` uses by default. Never return a pointer obtained
/// from `calloc`-incompatible allocators, a cached/static pointer, or one you
/// also free yourself (double free). Return [nullptr] to fall back to the
/// core's default merge for that node.
typedef MergeOverrideCbC = Pointer<Utf8> Function(
    Pointer<Utf8> jsonPath, Pointer<Utf8> v1, Pointer<Utf8> v2);
typedef MergeOverrideCbDart = Pointer<Utf8> Function(
    Pointer<Utf8> jsonPath, Pointer<Utf8> v1, Pointer<Utf8> v2);

/// Native mirror of `syncer_merge_options_t`.
///
/// Field order MUST match the C struct exactly. In particular
/// `array_match_keys` was added in core v0.2.0 as the LAST field: since this
/// struct is heap-allocated and passed by pointer, omitting it would make the
/// C core read past the allocation.
final class SyncerMergeOptionsC extends Struct {
  external Pointer<NativeFunction<MergeOverrideCbC>> override_cb;
  @Int32()
  external int array_strategy;
  @Uint32()
  external int max_depth;
  @Bool()
  external bool detect_circular_refs;
  @Bool()
  external bool resolve_by_timestamp;
  external Pointer<Utf8> lww_keys;
  external Pointer<Utf8> fww_keys;

  /// Comma-separated identity keys for [ArrayMergeStrategy.mergeByKey]
  /// (core v0.2.0+). nullptr = "id". MUST remain the last field.
  external Pointer<Utf8> array_match_keys;
}

typedef SyncerMergeJsonExC = Pointer<Utf8> Function(
    Pointer<Utf8> j1, Pointer<Utf8> j2, Pointer<SyncerMergeOptionsC> opts);
typedef SyncerMergeJsonExDart = Pointer<Utf8> Function(
    Pointer<Utf8> j1, Pointer<Utf8> j2, Pointer<SyncerMergeOptionsC> opts);

typedef SyncerFreeC = Void Function(Pointer<Void> ptr);
typedef SyncerFreeDart = void Function(Pointer<Void> ptr);

typedef SyncerVersionC = Pointer<Utf8> Function();
typedef SyncerVersionDart = Pointer<Utf8> Function();

/// Environment variable that, when set, overrides library path resolution
/// in [resolveSyncerLibraryPath].
const String syncerLibPathEnvVar = 'SYNCER_LIB_PATH';

/// Resolve a platform-appropriate path to the syncer shared library.
///
/// Resolution order:
/// 1. The `SYNCER_LIB_PATH` environment variable, if set and non-empty.
/// 2. `libsyncer.dylib` / `libsyncer.so` / `syncer.dll` (plus `libsyncer.dll`
///    on Windows) inside [directory], trying the current platform's
///    convention first and falling back to the others if that file does not
///    exist. If none of the candidates exist on disk, the platform-preferred
///    path is returned anyway so that `DynamicLibrary.open` reports the
///    canonical missing location.
String resolveSyncerLibraryPath({String directory = '.'}) {
  final env = Platform.environment[syncerLibPathEnvVar];
  if (env != null && env.isNotEmpty) return env;

  final preferred = Platform.isMacOS
      ? 'libsyncer.dylib'
      : Platform.isWindows
          ? 'syncer.dll'
          : 'libsyncer.so';
  final candidates = <String>[
    preferred,
    'libsyncer.dylib',
    'libsyncer.so',
    'syncer.dll',
    'libsyncer.dll',
  ];

  final sep = Platform.pathSeparator;
  final base = directory.endsWith(sep) || directory.endsWith('/')
      ? directory
      : '$directory$sep';
  for (final name in candidates) {
    final path = '$base$name';
    if (File(path).existsSync()) return path;
  }
  return '$base$preferred';
}

/// Merge options for [Syncer.merge] / [Syncer.tryMerge].
class MergeOptions {
  ArrayMergeStrategy arrayStrategy;
  int maxDepth;
  bool detectCircularRefs;
  bool resolveByTimestamp;

  /// Comma-separated Last-Write-Wins timestamp keys (e.g. "updatedAt,syncedAt").
  String? lwwKeys;

  /// Comma-separated First-Write-Wins timestamp keys (e.g. "createdAt").
  String? fwwKeys;

  /// Comma-separated identity keys for [ArrayMergeStrategy.mergeByKey]
  /// (e.g. "uuid,id"). The first listed key present in an incoming element is
  /// that element's identity. null = "id". Requires core v0.2.0+.
  String? arrayMatchKeys;

  /// Optional conflict-override callback. See [MergeOverrideCbC] for the
  /// allocation contract: any non-null `Pointer<Utf8>` the callback returns
  /// is freed by the C core with `free()`, so it must be freshly allocated
  /// with malloc — `'...'.toNativeUtf8()` is the idiomatic way. Return
  /// [nullptr] to use the default merge for a node.
  Pointer<NativeFunction<MergeOverrideCbC>>? overrideCb;

  MergeOptions({
    this.arrayStrategy = ArrayMergeStrategy.replace,
    this.maxDepth = 0,
    this.detectCircularRefs = false,
    this.resolveByTimestamp = false,
    this.lwwKeys,
    this.fwwKeys,
    this.arrayMatchKeys,
    this.overrideCb,
  });
}

class Syncer {
  late DynamicLibrary _lib;
  late SyncerMergeJsonExDart _mergeJsonEx;
  late SyncerFreeDart _free;
  late SyncerVersionDart _version;

  Syncer(String libPath) {
    _lib = DynamicLibrary.open(libPath);
    _mergeJsonEx = _lib.lookupFunction<SyncerMergeJsonExC, SyncerMergeJsonExDart>(
        'syncer_merge_json_ex');
    _free = _lib.lookupFunction<SyncerFreeC, SyncerFreeDart>('syncer_free');
    _version =
        _lib.lookupFunction<SyncerVersionC, SyncerVersionDart>('syncer_version');
  }

  /// Library version as "major.minor.patch". The native string is static and
  /// must not be freed, so it is only copied here.
  String get version => _version().toDartString();

  /// Deep-merge [j2] on top of [j1].
  ///
  /// Returns null when the core fails (e.g. either input is not valid JSON).
  String? tryMerge(String j1, String j2, {MergeOptions? options}) {
    final opts = options ?? MergeOptions();
    final cj1 = j1.toNativeUtf8();
    final cj2 = j2.toNativeUtf8();

    final cOpts = calloc<SyncerMergeOptionsC>();
    cOpts.ref.override_cb = opts.overrideCb ?? nullptr;
    cOpts.ref.array_strategy = opts.arrayStrategy.value;
    cOpts.ref.max_depth = opts.maxDepth;
    cOpts.ref.detect_circular_refs = opts.detectCircularRefs;
    cOpts.ref.resolve_by_timestamp = opts.resolveByTimestamp;

    final cLwwKeys =
        opts.lwwKeys == null ? nullptr : opts.lwwKeys!.toNativeUtf8();
    final cFwwKeys =
        opts.fwwKeys == null ? nullptr : opts.fwwKeys!.toNativeUtf8();
    final cArrayMatchKeys = opts.arrayMatchKeys == null
        ? nullptr
        : opts.arrayMatchKeys!.toNativeUtf8();

    cOpts.ref.lww_keys = cLwwKeys;
    cOpts.ref.fww_keys = cFwwKeys;
    cOpts.ref.array_match_keys = cArrayMatchKeys;

    final resultPtr = _mergeJsonEx(cj1, cj2, cOpts);

    if (cLwwKeys != nullptr) malloc.free(cLwwKeys);
    if (cFwwKeys != nullptr) malloc.free(cFwwKeys);
    if (cArrayMatchKeys != nullptr) malloc.free(cArrayMatchKeys);
    calloc.free(cOpts);
    malloc.free(cj1);
    malloc.free(cj2);

    if (resultPtr == nullptr) return null;

    final result = resultPtr.toDartString();
    _free(resultPtr.cast<Void>());
    return result;
  }

  /// Deep-merge [j2] on top of [j1].
  ///
  /// Kept for backwards compatibility: returns '' on core failure, which is
  /// ambiguous — prefer [tryMerge], which returns null instead.
  String merge(String j1, String j2, {MergeOptions? options}) =>
      tryMerge(j1, j2, options: options) ?? '';
}
