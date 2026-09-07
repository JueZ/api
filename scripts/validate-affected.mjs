#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertNode22,
  assertStableCandidate,
  collectProvenance,
  createEvidence,
  createValidationPlan,
  executePlan,
  inspectCandidate,
  outputState,
  parseArguments,
  printablePlan,
  readEvidence,
  unavailableTools,
  validateEvidencePath,
  writeEvidence,
} from './lib/affected-validation.mjs';

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log('Usage: node scripts/validate-affected.mjs [--plan] [--base <ref>] [--evidence <path>]');
    console.log('Defaults: --base origin/main --evidence .agent-runtime/affected-validation/latest.json');
    return;
  }

  assertNode22();
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  validateEvidencePath(repositoryRoot, options.evidence);
  const inspection = inspectCandidate(repositoryRoot, options.base);
  inspection.classification.baseSha = inspection.candidate.baseSha;
  const steps = createValidationPlan(inspection.classification, inspection.changedFiles, repositoryRoot);
  const provenance = collectProvenance(repositoryRoot, steps);
  const priorEvidence = readEvidence(repositoryRoot, options.evidence);

  if (options.plan) {
    console.log(JSON.stringify(printablePlan(repositoryRoot, inspection, steps, provenance, priorEvidence), null, 2));
    return;
  }

  const startedAt = new Date().toISOString();
  let results = [];
  let outcome = 'failed';
  let failure;
  let postInspection;
  try {
    const missing = unavailableTools(provenance);
    if (missing.length > 0) throw new Error(`Required validation tools are unavailable: ${missing.join(', ')}.`);
    results = executePlan(repositoryRoot, steps, {
      ...process.env,
      BASE_REF: inspection.candidate.baseSha,
      INCLUDE_WORKTREE: 'true',
    });
    postInspection = inspectCandidate(repositoryRoot, options.base);
    assertStableCandidate(inspection, postInspection);
    results.push({ id: 'candidate-stability', status: 'passed', durationMs: 0 });
    outcome = 'passed';
  } catch (error) {
    results = error.results ?? results;
    if (results.length === 0) results.push({ id: 'preflight', status: 'failed', error: error.message });
    if (!postInspection) {
      try {
        postInspection = inspectCandidate(repositoryRoot, options.base);
      } catch (inspectionError) {
        postInspection = { error: inspectionError.message };
      }
    }
    failure = error;
  } finally {
    const evidence = createEvidence({
      inspection,
      postInspection,
      steps,
      provenance,
      results,
      outputs: outputState(repositoryRoot, steps),
      outcome,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    const evidencePath = writeEvidence(repositoryRoot, evidence, options.evidence);
    console.log(
      JSON.stringify(
        {
          outcome,
          base: evidence.base,
          headSha: evidence.candidate.headSha,
          inputFingerprint: evidence.inputFingerprint,
          evidencePath,
          remoteChecksRequired: true,
        },
        null,
        2,
      ),
    );
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
