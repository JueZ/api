import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectQualityBaseline } from './lib/quality-evidence.mjs';
import { evaluateQuality, loadQualityInputs, renderQualityMarkdown } from './lib/quality-gates.mjs';

const options = parseArguments(process.argv.slice(2));
const root = process.cwd();

if (options.collectBaseline) {
  const baseline = collectQualityBaseline({
    root,
    sourceRef: options.sourceRef ?? 'unknown',
    runChecks: !options.noRunChecks,
  });
  writeJson(resolve(root, options.collectBaseline), baseline);
  console.log(`Quality baseline written to ${options.collectBaseline}.`);
  process.exitCode = 0;
} else {
  const { gates, waivers } = loadQualityInputs({
    root,
    gatesPath: options.gatesPath ?? 'docs/quality/quality-gates.yml',
    waiversPath: options.waiversPath ?? 'docs/quality/waivers.yml',
  });
  const report = evaluateQuality({ root, gates, waivers });
  const outputDirectory = resolve(root, options.outputDirectory ?? '.quality-report');
  mkdirSync(outputDirectory, { recursive: true });
  writeJson(resolve(outputDirectory, 'quality-report.json'), report, false);
  writeFileSync(resolve(outputDirectory, 'quality-report.md'), renderQualityMarkdown(report));
  console.log(
    `Quality gates: ${report.summary.requiredGatesPassed}/${report.summary.requiredGateCount} mandatory gates passed; ${report.summary.categoriesEligibleForTen}/${report.summary.categoryCount} categories eligible for 10/10.`,
  );
  process.exitCode = report.result === 'passed' ? 0 : 1;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--no-run-checks') {
      options.noRunChecks = true;
      continue;
    }
    const key = {
      '--collect-baseline': 'collectBaseline',
      '--source-ref': 'sourceRef',
      '--output-dir': 'outputDirectory',
      '--gates': 'gatesPath',
      '--waivers': 'waiversPath',
    }[argument];
    if (!key || !arguments_[index + 1]) throw new Error(`Unknown or incomplete argument: ${argument}`);
    options[key] = arguments_[index + 1];
    index += 1;
  }
  return options;
}

function writeJson(path, value, pretty = true) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}
