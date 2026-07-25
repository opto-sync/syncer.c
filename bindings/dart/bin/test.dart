import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:ffi/ffi.dart';
import 'package:syncer/syncer.dart';

int _failures = 0;

void check(bool cond, String name) {
  if (cond) {
    print('  PASS  $name');
  } else {
    _failures++;
    print('  FAIL  $name');
  }
}

Pointer<Utf8> dartOverrideCb(Pointer<Utf8> pathPtr, Pointer<Utf8> v1Ptr, Pointer<Utf8> v2Ptr) {
  // The native engine passes the FULL JSON path (e.g. r'$.override_me'),
  // never the bare key — matching on 'override_me' alone never fires.
  final path = pathPtr.toDartString();
  if (path == r'$.override_me') {
    // Contract: the returned pointer is freed by the C core with free(), so
    // it must come from malloc — toNativeUtf8() satisfies that.
    return '{"custom": "merged from Dart!"}'.toNativeUtf8();
  }
  return nullptr;
}

/// Find the array element (as a map) whose [key] normalizes to [id].
Map<String, dynamic>? byId(List<dynamic> items, Object id, {String key = 'id'}) {
  for (final e in items) {
    if (e is Map<String, dynamic> && '${e[key]}' == '$id') return e;
  }
  return null;
}

void main() {
  final libPath = resolveSyncerLibraryPath(directory: '../../core/build');
  final syncer = Syncer(libPath);

  print('Testing Dart FFI Binding to syncer.c:');
  print('  (library: $libPath)');

  // --- version -------------------------------------------------------------
  final version = syncer.version;
  check(RegExp(r'^\d+\.\d+\.\d+$').hasMatch(version),
      'version is major.minor.patch (got "$version")');

  // --- legacy behavior still intact ---------------------------------------
  final j1 = '{"a": 1, "b": {"c": 2}, "override_me": "no"}';
  final j2 = '{"b": {"d": 3}, "e": 4, "override_me": "yes"}';
  final cb = Pointer.fromFunction<MergeOverrideCbC>(dartOverrideCb);
  final res = syncer.merge(j1, j2, options: MergeOptions(overrideCb: cb));
  check(res.contains('"custom":"merged from Dart!"'), 'override fires on full path');
  check(res.contains('"a":1'), 'base-only sibling preserved');
  check(res.contains('"c":2') && res.contains('"d":3'), 'nested objects deep-merge');
  check(res.contains('"e":4'), 'incoming-only key copied');

  // CRDT: numeric-string timestamps compare by magnitude, not strcmp.
  final crdt = syncer.merge(
    '{"updatedAt":"10","val":"base"}',
    '{"updatedAt":"9","val":"stale"}',
    options: MergeOptions(resolveByTimestamp: true, lwwKeys: 'updatedAt'),
  );
  check(crdt.contains('"val":"base"'), 'CRDT rejects the older numeric-string stamp');

  // Invalid JSON surfaces as an empty result (NULL from the core).
  final bad = syncer.merge('{oops', '{}');
  check(bad.isEmpty, 'merge(): invalid JSON yields an empty result (compat)');

  // --- tryMerge ------------------------------------------------------------
  check(syncer.tryMerge('{oops', '{}') == null,
      'tryMerge returns null on invalid base JSON');
  check(syncer.tryMerge('{}', 'not json') == null,
      'tryMerge returns null on invalid incoming JSON');
  check(syncer.tryMerge('{"x":1}', '{"y":2}') != null,
      'tryMerge returns a result on valid JSON');

  // --- mergeByKey: matched pair deep-merge + append + keep -----------------
  {
    final out = syncer.tryMerge(
      '{"items":[{"id":1,"name":"one","qty":1},{"id":2,"name":"two"}]}',
      '{"items":[{"id":1,"qty":5},{"id":3,"name":"three"}]}',
      options: MergeOptions(arrayStrategy: ArrayMergeStrategy.mergeByKey),
    );
    check(out != null, 'mergeByKey produces a result');
    final items = (jsonDecode(out!) as Map<String, dynamic>)['items'] as List;
    check(items.length == 3, 'mergeByKey yields 3 elements (got ${items.length})');
    final e1 = byId(items, 1);
    check(e1 != null && e1['name'] == 'one' && e1['qty'] == 5,
        'matched pair deep-merges (name kept, qty updated)');
    final e2 = byId(items, 2);
    check(e2 != null && e2['name'] == 'two', 'base-only element kept');
    final e3 = byId(items, 3);
    check(e3 != null && e3['name'] == 'three', 'unmatched incoming element appended');
  }

  // --- arrayMatchKeys "uuid,id" -------------------------------------------
  {
    final out = syncer.tryMerge(
      '{"rows":[{"uuid":"a","v":1},{"id":7,"v":2}]}',
      '{"rows":[{"uuid":"a","w":9},{"id":7,"w":8}]}',
      options: MergeOptions(
        arrayStrategy: ArrayMergeStrategy.mergeByKey,
        arrayMatchKeys: 'uuid,id',
      ),
    );
    check(out != null, 'arrayMatchKeys merge produces a result');
    final rows = (jsonDecode(out!) as Map<String, dynamic>)['rows'] as List;
    check(rows.length == 2, 'uuid,id keys: no duplicates (got ${rows.length})');
    final byUuid = byId(rows, 'a', key: 'uuid');
    check(byUuid != null && byUuid['v'] == 1 && byUuid['w'] == 9,
        'element matched on uuid deep-merged');
    final byIdKey = byId(rows, 7);
    check(byIdKey != null && byIdKey['v'] == 2 && byIdKey['w'] == 8,
        'element without uuid falls back to id key');
  }

  // --- per-element LWW with reordered arrays -------------------------------
  {
    final out = syncer.tryMerge(
      '{"items":[{"id":1,"updatedAt":"10","val":"base1"},{"id":2,"updatedAt":"5","val":"base2"}]}',
      // Incoming array intentionally reordered relative to the base.
      '{"items":[{"id":2,"updatedAt":"6","val":"new2"},{"id":1,"updatedAt":"9","val":"stale1"}]}',
      options: MergeOptions(
        arrayStrategy: ArrayMergeStrategy.mergeByKey,
        resolveByTimestamp: true,
        lwwKeys: 'updatedAt,syncedAt',
        fwwKeys: 'createdAt',
      ),
    );
    check(out != null, 'per-element LWW merge produces a result');
    final items = (jsonDecode(out!) as Map<String, dynamic>)['items'] as List;
    check(items.length == 2, 'reordered arrays still pair up (got ${items.length})');
    final e1 = byId(items, 1);
    check(e1 != null && e1['val'] == 'base1',
        'stale incoming element loses per-element LWW despite reorder');
    final e2 = byId(items, 2);
    check(e2 != null && e2['val'] == 'new2',
        'fresh incoming element wins per-element LWW despite reorder');
  }

  // --- fwwKeys createdAt ---------------------------------------------------
  {
    final out = syncer.tryMerge(
      '{"createdAt":"100","owner":"original"}',
      '{"createdAt":"200","owner":"impostor"}',
      options: MergeOptions(resolveByTimestamp: true, fwwKeys: 'createdAt'),
    );
    check(out != null, 'FWW merge produces a result');
    final obj = jsonDecode(out!) as Map<String, dynamic>;
    check(obj['owner'] == 'original',
        'createdAt FWW: earlier write wins, impostor rejected');
    check('${obj['createdAt']}' == '100', 'createdAt FWW keeps the earlier stamp');
  }

  // --- id int-vs-string normalization --------------------------------------
  {
    final out = syncer.tryMerge(
      '{"items":[{"id":42,"v":"a"}]}',
      '{"items":[{"id":"42","w":"b"}]}',
      options: MergeOptions(arrayStrategy: ArrayMergeStrategy.mergeByKey),
    );
    check(out != null, 'int-vs-string id merge produces a result');
    final items = (jsonDecode(out!) as Map<String, dynamic>)['items'] as List;
    check(items.length == 1,
        'id 42 matches "42" — single merged element (got ${items.length})');
    final e = items.first as Map<String, dynamic>;
    check(e['v'] == 'a' && e['w'] == 'b', 'normalized-id pair deep-merged');
  }

  if (_failures > 0) {
    print('\n$_failures check(s) failed.');
    exit(1);
  }
  print('\nAll Dart binding checks passed.');
}
