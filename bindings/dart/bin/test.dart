import 'dart:ffi';
import 'package:ffi/ffi.dart';
import '../lib/syncer.dart';

Pointer<Utf8> dartOverrideCb(Pointer<Utf8> keyPtr, Pointer<Utf8> v1Ptr, Pointer<Utf8> v2Ptr) {
  final key = keyPtr.toDartString();
  if (key == 'override_me') {
    return '{"custom": "merged from Dart!"}'.toNativeUtf8();
  }
  return nullptr;
}

void main() {
  final syncer = Syncer('../../core/build/libsyncer.dylib');

  final j1 = '{"a": 1, "b": {"c": 2}, "override_me": "no"}';
  final j2 = '{"b": {"d": 3}, "e": 4, "override_me": "yes"}';

  final cb = Pointer.fromFunction<MergeOverrideCbC>(dartOverrideCb);

  print('Testing Dart FFI Binding to syncer.c:');
  final res = syncer.merge(j1, j2, options: MergeOptions(overrideCb: cb));
  print('Merged: $res');
}
