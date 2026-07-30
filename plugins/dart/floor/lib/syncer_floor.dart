import 'package:syncer/syncer.dart';

typedef LoadFloorJson = Future<String?> Function();
typedef SaveFloorJson = Future<void> Function(String mergedJson);

class FloorSyncerMergeException implements Exception {
  final String message;
  const FloorSyncerMergeException(this.message);
  @override
  String toString() => 'opto-sync Floor: $message';
}

/// Hook building blocks for generated Floor DAOs.
///
/// Floor generates application-specific DAO types, so this adapter accepts
/// load/save closures rather than reflecting over generated classes. Invoke
/// [reconcile] inside one sqflite/Floor transaction.
class FloorSyncer {
  final Syncer syncer;
  final MergeOptions options;

  FloorSyncer(this.syncer, {MergeOptions? options})
      : options = options ??
            MergeOptions(
              arrayStrategy: ArrayMergeStrategy.mergeByKey,
              resolveByTimestamp: true,
              lwwKeys: 'updatedAt,syncedAt',
            );

  String merge(String baseJson, String incomingJson) {
    final result = syncer.tryMerge(baseJson, incomingJson, options: options);
    if (result == null) {
      throw const FloorSyncerMergeException('native merge failed');
    }
    return result;
  }

  Future<String> reconcile({
    required LoadFloorJson load,
    required SaveFloorJson save,
    required String incomingJson,
  }) async {
    final stored = await load();
    final merged =
        merge(stored == null || stored.isEmpty ? '{}' : stored, incomingJson);
    await save(merged);
    return merged;
  }
}
