import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReleaseRetentionPolicy,
  mayDeleteBlob,
  validateRetentionTransition,
} from '../release-retention-policy.mjs';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-07T12:00:00.000Z');
const candidateDigest = `aa${'1'.repeat(62)}`;
const rollbackDigest = `bb${'2'.repeat(62)}`;
const nextDigest = `cc${'3'.repeat(62)}`;
const candidateRef = `aa${'1'.repeat(38)}`;
const rollbackRef = `bb${'2'.repeat(38)}`;
const nextRef = `cc${'3'.repeat(38)}`;

test('policy excludes only the candidate and current accepted rollback buckets across all 256 buckets', () => {
  const policy = buildReleaseRetentionPolicy({
    functionDigests: [candidateDigest, rollbackDigest],
    controllerRefs: [candidateRef, rollbackRef],
  });

  assert.ok(policy.rules.length <= 52);
  assert.equal(policy.rules.length, 52);
  const prefixes = policy.rules.flatMap((rule) => rule.definition.filters.prefixMatch);
  assert.equal(prefixes.length, 2 * 254);
  assert.ok(policy.rules.every((rule) => rule.definition.filters.prefixMatch.length <= 10));
  assert.ok(prefixes.every((prefix) => /^function-releases\/(?:functionapp-|accepted\/)[0-9a-f]{2}$/.test(prefix)));
  assert.ok(
    prefixes.every((prefix) => !['function-releases/functionapp-', 'function-releases/accepted/'].includes(prefix)),
  );
  assert.ok(
    policy.rules.every(
      (rule) =>
        rule.definition.actions.baseBlob.delete.daysAfterModificationGreaterThan === 180 &&
        rule.definition.actions.version.delete.daysAfterCreationGreaterThan === 30,
    ),
  );

  for (let bucket = 0; bucket < 256; bucket += 1) {
    const hex = bucket.toString(16).padStart(2, '0');
    assert.equal(
      mayDeleteBlob(policy, `function-releases/functionapp-${hex}${'0'.repeat(62)}.zip`),
      !['aa', 'bb'].includes(hex),
    );
    assert.equal(
      mayDeleteBlob(policy, `function-releases/accepted/${hex}${'0'.repeat(38)}/101/1/promotion/functionapp.zip`),
      !['aa', 'bb'].includes(hex),
    );
  }
});

test('same-bucket digest and controller collisions preserve the complete shared bucket conservatively', () => {
  const policy = buildReleaseRetentionPolicy({
    functionDigests: [`ab${'1'.repeat(62)}`, `ab${'2'.repeat(62)}`],
    controllerRefs: [`ab${'1'.repeat(38)}`, `ab${'2'.repeat(38)}`],
  });

  assert.equal(policy.rules.length, 52);
  assert.equal(mayDeleteBlob(policy, `function-releases/functionapp-ab${'f'.repeat(62)}.zip`), false);
  assert.equal(
    mayDeleteBlob(policy, `function-releases/accepted/ab${'f'.repeat(38)}/101/1/promotion/functionapp.zip`),
    false,
  );
  assert.equal(mayDeleteBlob(policy, `function-releases/functionapp-ac${'f'.repeat(62)}.zip`), true);
  assert.equal(
    mayDeleteBlob(policy, `function-releases/accepted/ac${'f'.repeat(38)}/101/1/promotion/functionapp.zip`),
    true,
  );
});

test('candidate rotation retires an old bucket only after it stops being the actual rollback target', () => {
  const initial = policyFor(candidateDigest, rollbackDigest, candidateRef, rollbackRef);
  const nextCandidate = policyFor(nextDigest, rollbackDigest, nextRef, rollbackRef);
  const nextAcceptedTarget = policyFor(nextDigest, candidateDigest, nextRef, candidateRef);

  assert.equal(mayDeleteBlob(initial, functionPath(candidateDigest)), false);
  assert.equal(mayDeleteBlob(initial, functionPath(rollbackDigest)), false);
  assert.equal(mayDeleteBlob(nextCandidate, functionPath(candidateDigest)), true);
  assert.equal(mayDeleteBlob(nextCandidate, functionPath(rollbackDigest)), false);
  assert.equal(mayDeleteBlob(nextAcceptedTarget, functionPath(candidateDigest)), false);
  assert.equal(mayDeleteBlob(nextAcceptedTarget, functionPath(rollbackDigest)), true);
  assert.equal(mayDeleteBlob(nextAcceptedTarget, functionPath(nextDigest)), false);
});

test('policy accepts at most a candidate and one verified rollback target and rejects malformed identities', () => {
  const validDigest = 'd'.repeat(64);
  const validRef = 'e'.repeat(40);
  for (const input of [
    { functionDigests: [], controllerRefs: [validRef] },
    { functionDigests: [validDigest], controllerRefs: [] },
    { functionDigests: [validDigest, validDigest, validDigest], controllerRefs: [validRef] },
    { functionDigests: [validDigest], controllerRefs: [validRef, validRef, validRef] },
    { functionDigests: ['A'.repeat(64)], controllerRefs: [validRef] },
    { functionDigests: [validDigest], controllerRefs: ['not-a-controller-ref'] },
  ]) {
    assert.throws(
      () => buildReleaseRetentionPolicy(input),
      /candidate and at most one verified accepted rollback target/,
    );
  }
});

test('old protected base and immutable versions require an established ARM policy exclusion', () => {
  const policy = policyFor(candidateDigest, rollbackDigest, candidateRef, rollbackRef);
  const protectedVersions = [
    version(`functionapp-${candidateDigest}.zip`, 29),
    version(`accepted/${rollbackRef}/101/1/promotion/functionapp.zip`, 31),
  ];
  const currentPolicy = armPolicy(policy, 2);

  assert.deepEqual(validateRetentionTransition({ currentPolicy, protectedVersions, now }), []);
  assert.match(
    validateRetentionTransition({ currentPolicy: armPolicy(policy, 1), protectedVersions, now }).join('\n'),
    /established retention exclusion/,
  );
  assert.match(
    validateRetentionTransition({
      currentPolicy: armPolicy(policyFor(nextDigest, rollbackDigest, nextRef, rollbackRef), 3),
      protectedVersions,
      now,
    }).join('\n'),
    /functionapp-/,
  );
  assert.match(
    validateRetentionTransition({ currentPolicy: { policy, lastModifiedTime: ago(3) }, protectedVersions, now }).join(
      '\n',
    ),
    /established retention exclusion/,
  );
});

test('fresh immutable versions have retention headroom while malformed or future control-plane timestamps fail', () => {
  const fresh = [version(`functionapp-${candidateDigest}.zip`, 27)];
  assert.deepEqual(validateRetentionTransition({ currentPolicy: undefined, protectedVersions: fresh, now }), []);

  for (const [currentPolicy, protectedVersions] of [
    [
      armPolicy(policyFor(candidateDigest, rollbackDigest, candidateRef, rollbackRef), 3),
      [{ ...version(`functionapp-${candidateDigest}.zip`, 29), versionId: 'not-a-version' }],
    ],
    [
      armPolicy(policyFor(candidateDigest, rollbackDigest, candidateRef, rollbackRef), 3),
      [{ ...version(`functionapp-${candidateDigest}.zip`, 29), versionId: new Date(now + DAY).toISOString() }],
    ],
    [
      armPolicy(policyFor(candidateDigest, rollbackDigest, candidateRef, rollbackRef), 3, 'not-a-timestamp'),
      [version(`functionapp-${candidateDigest}.zip`, 29)],
    ],
    [
      armPolicy(
        policyFor(candidateDigest, rollbackDigest, candidateRef, rollbackRef),
        3,
        new Date(now + DAY).toISOString(),
      ),
      [version(`functionapp-${candidateDigest}.zip`, 29)],
    ],
  ]) {
    assert.match(
      validateRetentionTransition({ currentPolicy, protectedVersions, now }).join('\n'),
      /control-plane verified immutable version timestamp|established retention exclusion/,
    );
  }
});

function policyFor(functionDigest, rollbackTargetDigest, controllerRef, rollbackTargetRef) {
  return buildReleaseRetentionPolicy({
    functionDigests: [functionDigest, rollbackTargetDigest],
    controllerRefs: [controllerRef, rollbackTargetRef],
  });
}

function armPolicy(policy, daysOld, lastModifiedTime = ago(daysOld)) {
  return { properties: { policy, lastModifiedTime } };
}

function version(blobName, daysOld) {
  return { blobName, versionId: ago(daysOld) };
}

function functionPath(digest) {
  return `function-releases/functionapp-${digest}.zip`;
}

function ago(days) {
  return new Date(now - days * DAY).toISOString();
}
