import 'dart:ffi';
import 'dart:io';
import 'package:ffi/ffi.dart';
import '../lib/syncer.dart';

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
    return '{"custom": "merged from Dart!"}'.toNativeUtf8();
  }
  return nullptr;
}

void main() {
  final syncer = Syncer('../../core/build/libsyncer.dylib');

  print('Testing Dart FFI Binding to syncer.c:');

  // Deep merge with an override pinned to a full path.
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
  check(bad.isEmpty, 'invalid JSON yields an empty result');

  if (_failures > 0) {
    print('\n$_failures check(s) failed.');
    exit(1);
  }
  print('\nAll Dart binding checks passed.');
}
