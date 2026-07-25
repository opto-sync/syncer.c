// run_dart.dart — Dart runner for the differential test.
// Usage: dart run run_dart.dart <input.jsonl> <output.jsonl>
//
// Splits each line textually on the unique `,"incoming":` marker (corpus
// generator contract) — never jsonDecode, so int64 text is preserved.
// Output lines are written exactly as returned by the binding.
import 'dart:convert';
import 'dart:io';
import 'package:syncer/syncer.dart';

const marker = ',"incoming":';
const prefix = '{"base":';

void main(List<String> args) {
  if (args.length != 2) {
    stderr.writeln('usage: dart run run_dart.dart <input.jsonl> <output.jsonl>');
    exit(2);
  }
  // Platform-dependent library name; SYNCER_LIB_PATH overrides.
  final libName = Platform.isMacOS
      ? 'libsyncer.dylib'
      : Platform.isWindows
          ? 'syncer.dll'
          : 'libsyncer.so';
  final libPath =
      Platform.environment['SYNCER_LIB_PATH'] ?? '../core/build/$libName';
  final syncer = Syncer(libPath);
  final options = MergeOptions(
    arrayStrategy: ArrayMergeStrategy.mergeByKey, // 4
    resolveByTimestamp: true,
    lwwKeys: 'updatedAt,syncedAt',
    fwwKeys: 'createdAt',
    arrayMatchKeys: 'id',
    maxDepth: 0,
  );

  final lines = File(args[0]).readAsLinesSync();
  final out = StringBuffer();
  var failures = 0;
  var lineno = 0;
  for (final line in lines) {
    lineno++;
    if (line.isEmpty) continue;
    final idx = line.indexOf(marker);
    if (idx < 0 || !line.startsWith(prefix) || !line.endsWith('}')) {
      stderr.writeln('line $lineno: malformed corpus line');
      failures++;
      out.writeln('!MALFORMED');
      continue;
    }
    final base = line.substring(prefix.length, idx);
    final inc = line.substring(idx + marker.length, line.length - 1);
    final merged = syncer.tryMerge(base, inc, options: options);
    if (merged == null) {
      stderr.writeln('line $lineno: merge returned null');
      failures++;
      out.writeln('!NULL');
      continue;
    }
    out.writeln(merged);
  }
  File(args[1]).writeAsStringSync(out.toString(), encoding: utf8);
  if (failures > 0) exit(1);
}
