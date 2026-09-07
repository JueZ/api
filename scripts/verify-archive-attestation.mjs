const repository = 'JueZ/api';
const repositoryId = '1237855378';
const repositoryOwnerId = '3954802';
const issuer = 'https://token.actions.githubusercontent.com';
const mainRef = 'refs/heads/main';
const signerWorkflow = '.github/workflows/deploy-environment.yml';
const callerWorkflow = '.github/workflows/delivery-v2.yml';
const shaPattern = /^[0-9a-f]{40}$/;

/**
 * Validates only certificate identity in an already cryptographically verified
 * `gh attestation verify --format json` result array.
 *
 * Input shape:
 *   { verification, expected: { repository, controllerRef, runId, attempt: 1 } }
 * Return shape:
 *   { ok: boolean, errors: string[] }
 *
 * The caller must run `gh attestation verify` against the local archive manifest
 * with repository, signer workflow, certificate identity, source ref/digest,
 * signer digest, and hosted-runner restrictions. This helper does not verify a
 * signature and never uses attestation predicate or statement claims as proof.
 */
export function validateArchiveAttestationVerification({ verification, expected }) {
  const errors = [];
  const expectedRunId = positiveInteger(expected?.runId);
  const expectedAttempt = positiveInteger(expected?.attempt);

  if (expected?.repository !== repository) errors.push(`expected.repository must be ${repository}`);
  if (!shaPattern.test(expected?.controllerRef ?? '')) {
    errors.push('expected.controllerRef must be a lowercase 40-character SHA');
  }
  if (expectedRunId === null) errors.push('expected.runId must be a positive integer');
  if (expectedAttempt !== 1) errors.push('expected.attempt must be 1');
  if (!Array.isArray(verification) || verification.length === 0) {
    errors.push('verification must be a non-empty gh attestation verification result array');
    return { ok: false, errors };
  }

  const repositoryUri = `https://github.com/${repository}`;
  const signerUri = `${repositoryUri}/${signerWorkflow}@${mainRef}`;
  const callerUri = `${repositoryUri}/${callerWorkflow}@${mainRef}`;
  const runInvocationUri =
    expectedRunId === null ? '' : `${repositoryUri}/actions/runs/${expectedRunId}/attempts/${expectedAttempt ?? ''}`;
  const controllerRef = expected?.controllerRef;

  for (const [index, result] of verification.entries()) {
    const certificate = result?.verificationResult?.signature?.certificate;
    if (!isRecord(certificate)) {
      errors.push(`verification[${index}] is missing signature.certificate`);
      continue;
    }
    for (const [field, value] of Object.entries({
      issuer,
      subjectAlternativeName: signerUri,
      buildSignerURI: signerUri,
      buildSignerDigest: controllerRef,
      sourceRepositoryURI: repositoryUri,
      sourceRepositoryIdentifier: repositoryId,
      sourceRepositoryOwnerIdentifier: repositoryOwnerId,
      sourceRepositoryRef: mainRef,
      sourceRepositoryDigest: controllerRef,
      buildConfigURI: callerUri,
      buildConfigDigest: controllerRef,
      githubWorkflowSHA: controllerRef,
      githubWorkflowRepository: repository,
      githubWorkflowRef: mainRef,
      runnerEnvironment: 'github-hosted',
      runInvocationURI: runInvocationUri,
    })) {
      if (certificate[field] !== value) errors.push(`verification[${index}].certificate.${field} does not match`);
    }
    for (const field of ['githubWorkflowTrigger', 'buildTrigger']) {
      if (!['push', 'workflow_dispatch'].includes(certificate[field])) {
        errors.push(`verification[${index}].certificate.${field} must be push or workflow_dispatch`);
      }
    }
    if (certificate.githubWorkflowTrigger !== certificate.buildTrigger) {
      errors.push(`verification[${index}].certificate trigger fields do not match`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function positiveInteger(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
