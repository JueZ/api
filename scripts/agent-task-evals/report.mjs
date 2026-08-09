import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_RESULTS_DIRECTORY } from './definitions.mjs';

const args = process.argv.slice(2);
if (args.length > 0) {
  console.error(`Unsupported arguments: ${args.join(' ')}`);
  process.exitCode = 2;
} else {
  const directory = resolve(DEFAULT_RESULTS_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const records = [];
  for (const name of readdirSync(directory)
    .filter((candidate) => candidate.endsWith('.json'))
    .sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue;
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (record?.schemaVersion === 1 && typeof record.taskId === 'string') records.push(record);
    } catch {
      // Malformed local output is ignored and reported through the missing-record summary.
    }
  }
  const grouped = new Map();
  for (const record of records) {
    const key = record.contextVariant;
    const group = grouped.get(key) ?? { total: 0, passed: 0 };
    group.total += 1;
    if (record.passed === true) group.passed += 1;
    grouped.set(key, group);
  }
  const lines = [
    '# Agent-task evaluation report',
    '',
    `Results: ${records.length}`,
    '',
    '| Context | Passed | Total | Rate |',
    '| --- | ---: | ---: | ---: |',
  ];
  for (const [context, group] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const rate = group.total === 0 ? 'n/a' : `${((100 * group.passed) / group.total).toFixed(1)}%`;
    lines.push(`| ${context} | ${group.passed} | ${group.total} | ${rate} |`);
  }
  if (grouped.size === 0) lines.push('| none | 0 | 0 | n/a |');
  lines.push(
    '',
    'A missing, blocked, timed-out, unauthenticated, or adapter-unavailable run is never counted as passing.',
    '',
  );
  const outputPath = join(directory, 'report.md');
  writeFileSync(outputPath, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  console.log(`Wrote ${outputPath}`);
}
