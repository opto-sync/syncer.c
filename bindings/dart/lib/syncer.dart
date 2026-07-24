import 'dart:ffi';
import 'package:ffi/ffi.dart';

enum ArrayMergeStrategy {
  replace(0),
  append(1),
  union(2),
  mergeByIndex(3);

  final int value;
  const ArrayMergeStrategy(this.value);
}

typedef MergeOverrideCbC = Pointer<Utf8> Function(Pointer<Utf8> jsonPath, Pointer<Utf8> v1, Pointer<Utf8> v2);
typedef MergeOverrideCbDart = Pointer<Utf8> Function(Pointer<Utf8> jsonPath, Pointer<Utf8> v1, Pointer<Utf8> v2);

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
}

typedef SyncerMergeJsonExC = Pointer<Utf8> Function(Pointer<Utf8> j1, Pointer<Utf8> j2, Pointer<SyncerMergeOptionsC> opts);
typedef SyncerMergeJsonExDart = Pointer<Utf8> Function(Pointer<Utf8> j1, Pointer<Utf8> j2, Pointer<SyncerMergeOptionsC> opts);

typedef SyncerFreeC = Void Function(Pointer<Void> ptr);
typedef SyncerFreeDart = void Function(Pointer<Void> ptr);

class MergeOptions {
  ArrayMergeStrategy arrayStrategy;
  int maxDepth;
  bool detectCircularRefs;
  bool resolveByTimestamp;
  String? lwwKeys;
  String? fwwKeys;
  Pointer<NativeFunction<MergeOverrideCbC>>? overrideCb;

  MergeOptions({
    this.arrayStrategy = ArrayMergeStrategy.replace,
    this.maxDepth = 0,
    this.detectCircularRefs = false,
    this.resolveByTimestamp = false,
    this.lwwKeys,
    this.fwwKeys,
    this.overrideCb,
  });
}

class Syncer {
  late DynamicLibrary _lib;
  late SyncerMergeJsonExDart _mergeJsonEx;
  late SyncerFreeDart _free;

  Syncer(String libPath) {
    _lib = DynamicLibrary.open(libPath);
    _mergeJsonEx = _lib.lookupFunction<SyncerMergeJsonExC, SyncerMergeJsonExDart>('syncer_merge_json_ex');
    _free = _lib.lookupFunction<SyncerFreeC, SyncerFreeDart>('syncer_free');
  }

  String merge(String j1, String j2, {MergeOptions? options}) {
    final opts = options ?? MergeOptions();
    final cj1 = j1.toNativeUtf8();
    final cj2 = j2.toNativeUtf8();
    
    final cOpts = calloc<SyncerMergeOptionsC>();
    cOpts.ref.override_cb = opts.overrideCb ?? nullptr;
    cOpts.ref.array_strategy = opts.arrayStrategy.value;
    cOpts.ref.max_depth = opts.maxDepth;
    cOpts.ref.detect_circular_refs = opts.detectCircularRefs;
    cOpts.ref.resolve_by_timestamp = opts.resolveByTimestamp;
    
    Pointer<Utf8> cLwwKeys = nullptr;
    Pointer<Utf8> cFwwKeys = nullptr;

    if (opts.lwwKeys != null) {
      cLwwKeys = opts.lwwKeys!.toNativeUtf8();
      cOpts.ref.lww_keys = cLwwKeys;
    } else {
      cOpts.ref.lww_keys = nullptr;
    }

    if (opts.fwwKeys != null) {
      cFwwKeys = opts.fwwKeys!.toNativeUtf8();
      cOpts.ref.fww_keys = cFwwKeys;
    } else {
      cOpts.ref.fww_keys = nullptr;
    }

    final resultPtr = _mergeJsonEx(cj1, cj2, cOpts);

    if (cLwwKeys != nullptr) malloc.free(cLwwKeys);
    if (cFwwKeys != nullptr) malloc.free(cFwwKeys);
    malloc.free(cOpts);
    malloc.free(cj1);
    malloc.free(cj2);

    if (resultPtr == nullptr) return '';

    final result = resultPtr.toDartString();
    _free(resultPtr.cast<Void>());

    return result;
  }
}
