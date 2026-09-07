import assert from 'node:assert/strict';
import test from 'node:test';
import { validateArchiveAttestationVerification } from '../verify-archive-attestation.mjs';

const repository = 'JueZ/api';
const controllerRef = '17a371a5654b4d15d9ee7468a59f85fd9574ab1f';
const runId = 34108410221;
const mainRef = 'refs/heads/main';
const issuer = 'https://token.actions.githubusercontent.com';
const repositoryUri = `https://github.com/${repository}`;
const signerUri = `${repositoryUri}/.github/workflows/deploy-environment.yml@${mainRef}`;
const callerUri = `${repositoryUri}/.github/workflows/delivery-v2.yml@${mainRef}`;
const expected = { repository, controllerRef, runId, attempt: 1 };

test('accepts the verified deploy-environment certificate identity', () => {
  assert.deepEqual(validateArchiveAttestationVerification({ verification: fixture(), expected }), {
    ok: true,
    errors: [],
  });
});

test('rejects the wrong run, attempt, or independently expected identity', () => {
  for (const [certificateChange, expectedChange, error] of [
    [{ runInvocationURI: `${repositoryUri}/actions/runs/999/attempts/1` }, {}, /runInvocationURI/],
    [{ runInvocationURI: `${repositoryUri}/actions/runs/${runId}/attempts/2` }, {}, /runInvocationURI/],
    [{}, { attempt: 2 }, /expected.attempt must be 1/],
    [{}, { repository: 'Other/api' }, /expected.repository must be JueZ\/api/],
    [{}, { controllerRef: 'A'.repeat(40) }, /expected.controllerRef/],
  ]) {
    const result = validateArchiveAttestationVerification({
      verification: fixture(certificateChange),
      expected: { ...expected, ...expectedChange },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), error);
  }
});

test('binds every controller digest to the independently trusted controller SHA', () => {
  for (const field of ['buildSignerDigest', 'sourceRepositoryDigest', 'buildConfigDigest', 'githubWorkflowSHA']) {
    const result = validateArchiveAttestationVerification({
      verification: fixture({ [field]: 'b'.repeat(40) }),
      expected,
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(`verification[0].certificate.${field} does not match`));
  }
});

test('rejects wrong signer, caller, repository identity, refs, issuer, or runner', () => {
  const wrongFields = {
    issuer: 'https://example.test',
    subjectAlternativeName: callerUri,
    buildSignerURI: callerUri,
    sourceRepositoryURI: 'https://github.com/Other/api',
    sourceRepositoryIdentifier: '999',
    sourceRepositoryOwnerIdentifier: '888',
    sourceRepositoryRef: 'refs/heads/release',
    buildConfigURI: signerUri,
    githubWorkflowRepository: 'Other/api',
    githubWorkflowRef: 'refs/heads/release',
    runnerEnvironment: 'self-hosted',
  };
  for (const [field, value] of Object.entries(wrongFields)) {
    const result = validateArchiveAttestationVerification({ verification: fixture({ [field]: value }), expected });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(`verification[0].certificate.${field} does not match`));
  }
});

test('accepts only matching push or workflow_dispatch certificate triggers', () => {
  for (const trigger of ['push', 'workflow_dispatch']) {
    const result = validateArchiveAttestationVerification({
      verification: fixture({ githubWorkflowTrigger: trigger, buildTrigger: trigger }),
      expected,
    });
    assert.equal(result.ok, true);
  }
  for (const certificateChange of [
    { githubWorkflowTrigger: 'pull_request', buildTrigger: 'pull_request' },
    { githubWorkflowTrigger: 'push', buildTrigger: 'workflow_dispatch' },
  ]) {
    const result = validateArchiveAttestationVerification({
      verification: fixture(certificateChange),
      expected,
    });
    assert.equal(result.ok, false);
  }
});

test('ignores deceptive predicate and verifiedIdentity claims when the certificate is wrong', () => {
  const verification = fixture({ buildConfigURI: 'https://github.com/Other/api/.github/workflows/unsafe.yml' });
  verification[0].attestation = {
    predicate: { buildConfigURI: callerUri, sourceRepositoryDigest: controllerRef, accepted: true },
  };
  verification[0].verificationResult.statement = {
    predicate: { buildConfigURI: callerUri, sourceRepositoryDigest: controllerRef, accepted: true },
  };
  verification[0].verificationResult.verifiedIdentity = {
    subjectAlternativeName: signerUri,
    issuer,
  };

  const result = validateArchiveAttestationVerification({ verification, expected });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('verification[0].certificate.buildConfigURI does not match'));
});

test('rejects empty, malformed, or mixed-identity verification result arrays', () => {
  for (const verification of [null, {}, [], [{ verificationResult: { signature: {} } }]]) {
    assert.equal(validateArchiveAttestationVerification({ verification, expected }).ok, false);
  }
  const mixed = [...fixture(), ...fixture({ sourceRepositoryIdentifier: '999' })];
  const result = validateArchiveAttestationVerification({ verification: mixed, expected });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('verification[1].certificate.sourceRepositoryIdentifier does not match'));
});

function fixture(certificateChange = {}) {
  return [
    {
      attestation: {},
      verificationResult: {
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        signature: {
          certificate: {
            issuer: 'https://token.actions.githubusercontent.com',
            subjectAlternativeName: signerUri,
            githubWorkflowTrigger: 'push',
            githubWorkflowSHA: controllerRef,
            githubWorkflowRepository: repository,
            githubWorkflowRef: mainRef,
            buildSignerURI: signerUri,
            buildSignerDigest: controllerRef,
            runnerEnvironment: 'github-hosted',
            sourceRepositoryURI: repositoryUri,
            sourceRepositoryDigest: controllerRef,
            sourceRepositoryRef: mainRef,
            sourceRepositoryIdentifier: '1237855378',
            sourceRepositoryOwnerIdentifier: '3954802',
            buildConfigURI: callerUri,
            buildConfigDigest: controllerRef,
            buildTrigger: 'push',
            runInvocationURI: `${repositoryUri}/actions/runs/${runId}/attempts/1`,
            ...certificateChange,
          },
        },
        verifiedTimestamps: [],
        verifiedIdentity: {},
        statement: {},
      },
    },
  ];
}
