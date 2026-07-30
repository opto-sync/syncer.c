import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:opto_sync_drift/syncer_drift.dart';
import 'package:syncer/syncer.dart';
import 'package:test/test.dart';

String locateCoreLibrary() {
  final configured = Platform.environment['SYNCER_LIB_PATH'];
  if (configured != null && configured.isNotEmpty) return configured;
  var directory = Directory.current.absolute;
  for (var i = 0; i < 10; i++) {
    final candidate = Platform.isMacOS
        ? '${directory.path}/core/build/libsyncer.dylib'
        : '${directory.path}/core/build/libsyncer.so';
    if (File(candidate).existsSync()) return candidate;
    if (directory.parent.path == directory.path) break;
    directory = directory.parent;
  }
  throw StateError('Build core/build/libsyncer or set SYNCER_LIB_PATH');
}

class _TestDatabase extends GeneratedDatabase {
  _TestDatabase(super.executor);

  @override
  int get schemaVersion => 1;

  @override
  Iterable<TableInfo<Table, Object?>> get allTables => const [];
}

void main() {
  late _TestDatabase database;
  late DriftSyncer reconciler;

  setUp(() async {
    database = _TestDatabase(NativeDatabase.memory());
    await database.customStatement(
      'CREATE TABLE documents (id TEXT PRIMARY KEY, data TEXT)',
    );
    reconciler = DriftSyncer(Syncer(locateCoreLibrary()));
  });

  tearDown(() => database.close());

  test('reconcileJsonColumn merges and persists in one transaction', () async {
    await database.customInsert(
      'INSERT INTO documents(id, data) VALUES (?, ?)',
      variables: [
        const Variable('d1'),
        const Variable('{"profile":{"name":"Ada"},"items":[{"id":1,"qty":1}]}'),
      ],
    );

    final merged = await reconciler.reconcileJsonColumn(
      database: database,
      table: 'documents',
      idColumn: 'id',
      id: 'd1',
      jsonColumn: 'data',
      incomingJson:
          '{"profile":{"city":"London"},"items":[{"id":1,"qty":2},{"id":2,"qty":1}]}',
    );
    final value = jsonDecode(merged) as Map<String, dynamic>;
    expect(value['profile'], {'name': 'Ada', 'city': 'London'});
    expect(value['items'], hasLength(2));

    final stored = await database.customSelect(
      'SELECT data FROM documents WHERE id = ?',
      variables: [const Variable('d1')],
    ).get();
    expect(jsonDecode(stored.single.data['data']! as String), value);
  });

  test('stale nested JSON-Pointer timestamp is rejected in memory', () {
    final nested = DriftSyncer(
      Syncer(locateCoreLibrary()),
      options: MergeOptions(
        arrayStrategy: ArrayMergeStrategy.mergeByKey,
        resolveByTimestamp: true,
        lwwKeys: '#/_sync/updatedAt',
      ),
    );
    final merged = nested.merge(
      '{"_sync":{"updatedAt":200},"v":"base"}',
      '{"_sync":{"updatedAt":100},"v":"stale"}',
    );
    expect(jsonDecode(merged)['v'], 'base');
  });

  test('unsafe identifiers and missing rows fail loudly', () async {
    await expectLater(
      reconciler.reconcileJsonColumn(
        database: database,
        table: 'documents; DROP TABLE documents',
        idColumn: 'id',
        id: 'd1',
        jsonColumn: 'data',
        incomingJson: '{}',
      ),
      throwsArgumentError,
    );
    await expectLater(
      reconciler.reconcileJsonColumn(
        database: database,
        table: 'documents',
        idColumn: 'id',
        id: 'missing',
        jsonColumn: 'data',
        incomingJson: '{}',
      ),
      throwsA(isA<SyncerRowNotFoundException>()),
    );
  });
}
