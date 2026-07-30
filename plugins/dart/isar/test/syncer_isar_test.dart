import 'dart:io';

import 'package:opto_sync_isar/syncer_isar.dart';
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
  test('Isar collection closures reconcile embedded object fields', () async {
    Map<String, dynamic>? stored = {
      'profile': {'name': 'Ada'},
      'items': [
        {'id': 1, 'v': 'a'}
      ],
    };
    final helper = IsarSyncer(Syncer(corePath()));
    final merged = await helper.reconcile(
      load: () async => stored,
      save: (value) async => stored = value,
      incoming: {
        'profile': {'city': 'London'},
        'items': [
          {'id': 2, 'v': 'b'}
        ],
      },
    );
    expect(merged['profile'], {'name': 'Ada', 'city': 'London'});
    expect(merged['items'], hasLength(2));
    expect(stored, merged);
  });

  test('stale timestamped object loses', () {
    final helper = IsarSyncer(Syncer(corePath()));
    final merged = helper.mergeMaps(
      {'updatedAt': 200, 'v': 'base'},
      {'updatedAt': 100, 'v': 'stale'},
    );
    expect(merged['v'], 'base');
  });
}
