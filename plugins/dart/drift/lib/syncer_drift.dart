import 'package:drift/drift.dart';
import 'package:syncer/syncer.dart';

final RegExp _safeIdentifier = RegExp(r'^[A-Za-z_][A-Za-z0-9_]*$');

/// A requested Drift row did not exist, so no merge was persisted.
class SyncerRowNotFoundException implements Exception {
  final String table;
  final String idColumn;
  final Object id;

  const SyncerRowNotFoundException(this.table, this.idColumn, this.id);

  @override
  String toString() => 'opto-sync: no row in "$table" where "$idColumn" = $id';
}

/// The native engine refused malformed JSON or could not allocate a result.
class SyncerDriftMergeException implements Exception {
  final String message;

  const SyncerDriftMergeException(this.message);

  @override
  String toString() => 'opto-sync: $message';
}

/// Drift/SQLite reconciliation through the shared C engine.
///
/// The default policy matches the opto-sync clients and SQL extensions:
/// keyed-array merge on `id`, LWW on `updatedAt,syncedAt`, and no FWW key.
class DriftSyncer {
  final Syncer syncer;
  final MergeOptions options;

  DriftSyncer(
    this.syncer, {
    MergeOptions? options,
  }) : options = options ??
            MergeOptions(
              arrayStrategy: ArrayMergeStrategy.mergeByKey,
              resolveByTimestamp: true,
              lwwKeys: 'updatedAt,syncedAt',
            );

  /// Reconcile two in-memory JSON texts without touching a database.
  String merge(String baseJson, String incomingJson, {MergeOptions? options}) {
    final merged = syncer.tryMerge(baseJson, incomingJson,
        options: options ?? this.options);
    if (merged == null) {
      throw const SyncerDriftMergeException(
        'merge failed: an input was invalid JSON or the native engine ran out of memory',
      );
    }
    return merged;
  }

  Variable _idVariable(Object id) {
    if (id is String) return Variable.withString(id);
    if (id is int) return Variable.withInt(id);
    if (id is BigInt) return Variable.withBigInt(id);
    if (id is double) return Variable.withReal(id);
    throw ArgumentError.value(
      id,
      'id',
      'must be a String, int, BigInt, or double',
    );
  }

  /// Atomically read, reconcile, and update one JSON column.
  ///
  /// A transaction is opened through [database]; concurrent writers therefore
  /// serialize or receive SQLite's busy/locked error instead of silently
  /// overwriting a merge computed from stale state.
  ///
  /// Table and column identifiers cannot be bound parameters, so all three are
  /// restricted to plain SQL identifiers before any statement is built.
  Future<String> reconcileJsonColumn({
    required GeneratedDatabase database,
    required String table,
    required String idColumn,
    required Object id,
    required String jsonColumn,
    required String incomingJson,
    MergeOptions? options,
  }) async {
    for (final entry in {
      'table': table,
      'idColumn': idColumn,
      'jsonColumn': jsonColumn,
    }.entries) {
      if (!_safeIdentifier.hasMatch(entry.value)) {
        throw ArgumentError.value(
          entry.value,
          entry.key,
          'must be a plain SQL identifier',
        );
      }
    }

    final idVariable = _idVariable(id);
    return database.transaction(() async {
      final rows = await database.customSelect(
        'SELECT CAST("$jsonColumn" AS TEXT) AS raw_json '
        'FROM "$table" WHERE "$idColumn" = ? LIMIT 1',
        variables: [idVariable],
      ).get();
      if (rows.isEmpty) {
        throw SyncerRowNotFoundException(table, idColumn, id);
      }

      final current = rows.single.data['raw_json'];
      final baseJson = current == null ? '{}' : current.toString();
      final merged = merge(baseJson, incomingJson, options: options);

      final affected = await database.customUpdate(
        'UPDATE "$table" SET "$jsonColumn" = ? WHERE "$idColumn" = ?',
        variables: [Variable.withString(merged), idVariable],
      );
      if (affected != 1) {
        throw SyncerRowNotFoundException(table, idColumn, id);
      }
      return merged;
    });
  }
}
