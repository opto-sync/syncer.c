import 'dart:convert';
import 'dart:io';

import 'package:opto_sync_floor/syncer_floor.dart';
import 'package:syncer/syncer.dart';
import 'package:test/test.dart';

String corePath() {
  final configured = Platform.environment['SYNCER_LIB_PATH'];
  if (configured != null && configured.isNotEmpty) return configured;
  var directory = Directory.current.absolute;
  for (var i = 0; i < 10; i++) {
    final path = Platform.isMacOS
        ? '${directory.path}/core/build/libsyncer.dylib'
        : '${directory.path}/core/build/libsyncer.so';
    if (File(path).existsSync()) return path;
    directory = directory.parent;
  }
  throw StateError('build core or set SYNCER_LIB_PATH');
}

void main() {
  test('generated DAO closures load, reconcile, and save', () async {
    var stored = '{"profile":{"name":"Ada"}}';
    final helper = FloorSyncer(Syncer(corePath()));
    final merged = await helper.reconcile(
      load: () async => stored,
      save: (value) async => stored = value,
      incomingJson: '{"profile":{"city":"London"}}',
    );
    expect(jsonDecode(merged)['profile'], {'name': 'Ada', 'city': 'London'});
    expect(stored, merged);
  });

  test('malformed incoming JSON never reaches save', () async {
    var saved = false;
    final helper = FloorSyncer(Syncer(corePath()));
    await expectLater(
      helper.reconcile(
        load: () async => '{}',
        save: (_) async => saved = true,
        incomingJson: '{bad',
      ),
      throwsA(isA<FloorSyncerMergeException>()),
    );
    expect(saved, isFalse);
  });
}
