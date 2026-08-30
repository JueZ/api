import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildFailureFingerprint,
  buildPublicRepairState,
  buildStrategyFingerprint,
  classifyFailure,
  CODEX_CALLBACK,
  containsSensitiveText,
  decideRepairAttempt,
  isAcceptedDeliverySummary,
  LEARNING_RECURRENCE_THRESHOLD,
  learningDecision,
  planRepairIssue,
  REPAIR_BOUNDS,
  repairFingerprintMarker,
  repairIncidentMarker,
  runRepairQueue,
  sanitizeDeliveryRecovery,
  sanitizeJobName,
  selectFailedJob,
  validateSourceRun,
} from '../triage-repair-issues.mjs';

const REPOSITORY = 'JueZ/api';
const HEAD_SHA = 'a'.repeat(40);
const NEXT_SHA = 'b'.repeat(40);
const THIRD_SHA = 'c'.repeat(40);
const WORKFLOW = '.github/workflows/pr-gate.yml';

function run(overrides = {}) {
  return {
    id: 101,
    path: WORKFLOW,
    event: 'pull_request',
    conclusion: 'failure',
    head_sha: HEAD_SHA,
    head_branch: 'codex/fix-gate',
    repository: { full_name: REPOSITORY },
    pull_requests: [{ number: 42 }],
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 42,
    state: 'open',
    base: { ref: 'main' },
    head: { ref: 'codex/fix-gate', sha: HEAD_SHA, repo: { full_name: REPOSITORY } },
    ...overrides,
  };
}

function incident(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    fingerprint: 'pr-gate.candidate-code.backend-and-contracts',
    classification: 'candidate-code',
    severity: 'medium',
    affectedArea: 'pull-request.backend-and-contracts',
    workflowPath: WORKFLOW,
    workflowRunId: 101,
    workflowRunUrl: `https://github.com/${REPOSITORY}/actions/runs/101`,
    failedJob: 'backend and contracts',
    failedJobId: 202,
    headSha: HEAD_SHA,
    pullRequest: 42,
    observableFailure: 'PR Gate concluded failure at backend and contracts.',
    learningTriggers: [],
    recovery: {
      state: 'not-reported',
      rollback: 'not-reported',
      terminalOutcome: 'incomplete',
      supersededBy: null,
      rollbackOccurred: 'unknown',
      candidateInProduction: 'unknown',
    },
    ...overrides,
  };
}

function strategy(overrides = {}) {
  return {
    failureClass: 'deterministic-test-or-policy',
    failingGate: 'pr-gate.workflow-validation',
    rootCauseHypothesis: 'candidate-bypasses-fixed-command',
    affectedSurface: 'github-workflows',
    repairMechanism: 'invoke-fixed-validator',
    ...overrides,
  };
}

function deliverySummary(overrides = {}) {
  return {
    schemaVersion: 2,
    sha: HEAD_SHA,
    mode: 'full',
    deploymentRequired: true,
    terminalOutcome: 'superseded',
    test: 'passed',
    production: 'not_applicable',
    rawJobs: { test: 'success', production: 'skipped' },
    superseded: true,
    supersededBy: NEXT_SHA,
    recovery: 'not-required',
    rollback: 'skipped',
    ...overrides,
  };
}

function markedRepairState(state) {
  return `${repairIncidentMarker(state.trigger.headSha, state.failureFingerprint)}\n\`\`\`json\n${JSON.stringify(
    state,
    null,
    2,
  )}\n\`\`\``;
}

function markedProgressState(state) {
  return `${repairIncidentMarker(state.trigger.headSha, state.failureFingerprint)}
Sanitized advisory repair-progress snapshot for \`${state.failureFingerprint}\`.

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\``;
}

function repairStateFromBody(body) {
  const match = String(body).match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, 'expected a marked public repair-state JSON block');
  return JSON.parse(match[1]);
}

test('repair bounds and callback limitation are explicit and finite', () => {
  assert.deepEqual(REPAIR_BOUNDS, {
    maxAttemptsPerStrategy: 2,
    maxAttemptsPerRepairGeneration: 3,
    externalRerunsPerFailure: 1,
  });
  assert.equal(LEARNING_RECURRENCE_THRESHOLD, 2);
  assert.equal(CODEX_CALLBACK.supported, false);
  assert.equal(CODEX_CALLBACK.requested, false);
});

test('exact-head binding accepts only open same-repository codex pull requests', () => {
  assert.equal(validateSourceRun({ run: run(), pullRequest: pullRequest() }).accepted, true);
  assert.equal(
    validateSourceRun({ run: run(), pullRequest: pullRequest({ head: { ...pullRequest().head, sha: NEXT_SHA } }) })
      .reason,
    'stale-pull-request-head',
  );
  assert.equal(
    validateSourceRun({
      run: run(),
      pullRequest: pullRequest({ head: { ref: 'codex/fork', sha: HEAD_SHA, repo: { full_name: 'fork/api' } } }),
    }).reason,
    'pull-request-fork-denied',
  );
  assert.equal(
    validateSourceRun({
      run: run(),
      pullRequest: pullRequest({ head: { ref: 'feature/human', sha: HEAD_SHA, repo: { full_name: REPOSITORY } } }),
    }).reason,
    'pull-request-branch-not-codex',
  );
});

test('protected-main failures require an allowlisted workflow and main identity', () => {
  const delivery = run({
    path: '.github/workflows/delivery-v2.yml',
    event: 'push',
    head_branch: 'main',
    pull_requests: [],
  });
  assert.equal(validateSourceRun({ run: delivery }).scope, 'protected-main');
  assert.equal(
    validateSourceRun({ run: { ...delivery, head_branch: 'feature' } }).reason,
    'trusted-workflow-not-on-main',
  );
  assert.equal(
    validateSourceRun({ run: { ...delivery, path: '.github/workflows/untrusted.yml' } }).reason,
    'workflow-not-allowlisted',
  );
});

test('only an accepted successful Delivery v2 supersession enters active continuation', () => {
  const successfulDelivery = run({
    path: '.github/workflows/delivery-v2.yml',
    event: 'push',
    conclusion: 'success',
    head_branch: 'main',
    pull_requests: [],
  });
  assert.equal(
    validateSourceRun({ run: successfulDelivery, deliverySummary: deliverySummary() }).scope,
    'protected-main',
  );
  assert.equal(validateSourceRun({ run: successfulDelivery }).reason, 'workflow-did-not-fail-or-supersede');
  assert.equal(
    validateSourceRun({
      run: successfulDelivery,
      deliverySummary: deliverySummary({
        terminalOutcome: 'verified',
        production: 'passed',
        rawJobs: { test: 'success', production: 'success' },
        superseded: false,
        supersededBy: null,
      }),
    }).reason,
    'workflow-did-not-fail-or-supersede',
  );
  const shadowBlocker = deliverySummary({
    mode: 'shadow',
    terminalOutcome: 'incomplete',
    test: 'skipped',
    production: 'skipped',
    rawJobs: { test: 'skipped', production: 'skipped' },
    superseded: false,
    supersededBy: null,
  });
  assert.equal(validateSourceRun({ run: successfulDelivery, deliverySummary: shadowBlocker }).scope, 'protected-main');
  assert.equal(
    validateSourceRun({
      run: { ...successfulDelivery, event: 'workflow_dispatch' },
      deliverySummary: shadowBlocker,
    }).reason,
    'workflow-did-not-fail-or-supersede',
  );
  assert.equal(
    validateSourceRun({
      run: successfulDelivery,
      deliverySummary: { ...shadowBlocker, mode: 'dry-run' },
    }).reason,
    'workflow-did-not-fail-or-supersede',
  );
});

test('causal failed job selection does not treat the aggregate as the root failure', () => {
  const selected = selectFailedJob(
    [
      { id: 1, name: 'PR Gate', conclusion: 'failure' },
      { id: 2, name: 'backend and contracts', conclusion: 'failure' },
    ],
    WORKFLOW,
  );
  assert.deepEqual(selected, {
    id: 2,
    name: 'backend and contracts',
    conclusion: 'failure',
    workflowPath: WORKFLOW,
  });
  const classification = classifyFailure(WORKFLOW, selected.name);
  assert.equal(classification.classification, 'candidate-code');
  assert.equal(
    buildFailureFingerprint(WORKFLOW, classification.classification, selected.name),
    'pr-gate.candidate-code.backend-and-contracts',
  );
});

test('strategy fingerprints use causal keys rather than cosmetic descriptions', () => {
  const first = buildStrategyFingerprint({ ...strategy(), description: 'Call the fixed validator directly.' });
  const restated = buildStrategyFingerprint({ ...strategy(), description: 'Directly call the fixed validator.' });
  const different = buildStrategyFingerprint(strategy({ repairMechanism: 'pin-reviewed-package-command' }));
  assert.equal(first, restated);
  assert.notEqual(first, different);
  assert.match(first, /^strategy-v1\.[0-9a-f]{64}$/);
});

test('two ineffective identical strategies prevent a third repetition and mandate re-diagnosis', () => {
  const strategyFingerprint = buildStrategyFingerprint(strategy());
  const proseOnlyInitialDiagnosis = decideRepairAttempt({
    attempts: [],
    proposedStrategy: strategy(),
    rediagnosis: {
      version: 1,
      strategyFingerprint,
      failureClassification: strategy().failureClass,
      rootCauseHypothesis: 'The candidate bypasses the fixed validation command.',
      discriminatingAction: 'run the fixed validator directly',
    },
  });
  assert.equal(proseOnlyInitialDiagnosis.allowed, false);
  assert.deepEqual(proseOnlyInitialDiagnosis.missingRediagnosis, ['rootCauseHypothesisKey']);

  const boundInitialDiagnosis = decideRepairAttempt({
    attempts: [],
    proposedStrategy: strategy(),
    rediagnosis: {
      version: 1,
      strategyFingerprint,
      failureClassification: strategy().failureClass,
      rootCauseHypothesisKey: strategy().rootCauseHypothesis,
      rootCauseHypothesis: 'The candidate bypasses the fixed validation command.',
      discriminatingAction: 'run the fixed validator directly',
    },
  });
  assert.equal(boundInitialDiagnosis.allowed, true);
  assert.equal(boundInitialDiagnosis.action, 'attempt');

  const attempts = [
    { strategyFingerprint, outcome: 'ineffective' },
    { strategyFingerprint, outcome: 'ineffective' },
  ];
  const repeated = decideRepairAttempt({ attempts, proposedStrategy: strategy() });
  assert.equal(repeated.allowed, false);
  assert.equal(repeated.action, 'strategy-exhausted');
  assert.equal(repeated.taskStatus, 'active');
  assert.equal(repeated.continuationRequired, true);
  assert.deepEqual(repeated.missingRediagnosis, [
    'version',
    'strategyFingerprint',
    'failureClassification',
    'rootCauseHypothesisKey',
    'discriminatingAction',
  ]);

  const differentStrategy = strategy({
    rootCauseHypothesis: 'candidate-controlled-command-resolution',
    repairMechanism: 'pin-reviewed-package-command',
  });
  const premature = decideRepairAttempt({ attempts, proposedStrategy: differentStrategy });
  assert.equal(premature.allowed, false);
  assert.equal(premature.action, 'rediagnose');

  const mechanismOnlyStrategy = strategy({ repairMechanism: 'pin-reviewed-package-command' });
  const staleHypothesis = decideRepairAttempt({
    attempts,
    proposedStrategy: mechanismOnlyStrategy,
    priorRediagnosisVersion: 1,
    priorRediagnosisStrategyFingerprint: strategyFingerprint,
    priorRootCauseHypothesisKey: strategy().rootCauseHypothesis,
    rediagnosis: {
      version: 2,
      strategyFingerprint: buildStrategyFingerprint(mechanismOnlyStrategy),
      failureClassification: mechanismOnlyStrategy.failureClass,
      rootCauseHypothesisKey: mechanismOnlyStrategy.rootCauseHypothesis,
      rootCauseHypothesis: 'The original strategy hypothesis is unchanged despite a new mechanism.',
      discriminatingAction: 'run the fixed validator against a no-op package script fixture',
    },
  });
  assert.equal(staleHypothesis.allowed, false);
  assert.equal(staleHypothesis.action, 'rediagnose');
  assert.ok(staleHypothesis.missingRediagnosis.includes('rootCauseHypothesisKey'));

  const rediagnosed = decideRepairAttempt({
    attempts,
    proposedStrategy: differentStrategy,
    priorRediagnosisVersion: 1,
    priorRediagnosisStrategyFingerprint: strategyFingerprint,
    priorRootCauseHypothesisKey: strategy().rootCauseHypothesis,
    rediagnosis: {
      version: 2,
      strategyFingerprint: buildStrategyFingerprint(differentStrategy),
      failureClassification: differentStrategy.failureClass,
      rootCauseHypothesisKey: differentStrategy.rootCauseHypothesis,
      discriminatingAction: 'run the fixed validator against a no-op package script fixture',
    },
  });
  assert.equal(rediagnosed.allowed, true);
  assert.equal(rediagnosed.action, 'attempt-different-strategy');
  assert.equal(rediagnosed.taskStatus, 'active');
});

test('retired strategy history survives a new generation while a different re-diagnosed strategy remains allowed', () => {
  const retiredStrategyFingerprint = buildStrategyFingerprint(strategy());
  const sameStrategy = decideRepairAttempt({
    attempts: [],
    exhaustedStrategyFingerprints: [retiredStrategyFingerprint],
    proposedStrategy: strategy(),
  });
  assert.equal(sameStrategy.allowed, false);
  assert.equal(sameStrategy.action, 'strategy-exhausted');
  assert.equal(sameStrategy.generationStatus, 'active');

  const differentStrategy = strategy({
    rootCauseHypothesis: 'candidate-controlled-command-resolution',
    repairMechanism: 'pin-reviewed-package-command',
  });
  const allowed = decideRepairAttempt({
    attempts: [],
    exhaustedStrategyFingerprints: [retiredStrategyFingerprint],
    proposedStrategy: differentStrategy,
    priorRediagnosisVersion: 1,
    priorRediagnosisStrategyFingerprint: retiredStrategyFingerprint,
    priorRootCauseHypothesisKey: strategy().rootCauseHypothesis,
    rediagnosis: {
      version: 2,
      strategyFingerprint: buildStrategyFingerprint(differentStrategy),
      failureClassification: differentStrategy.failureClass,
      rootCauseHypothesisKey: differentStrategy.rootCauseHypothesis,
      discriminatingAction: 'invoke the fixed validator without the package indirection',
    },
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.action, 'attempt-different-strategy');
  assert.equal(allowed.strategyFingerprint, buildStrategyFingerprint(differentStrategy));
});

test('a freshly bound different strategy gets both bounded attempts without reusing an exhausted third attempt', () => {
  const firstStrategy = strategy();
  const firstStrategyFingerprint = buildStrategyFingerprint(firstStrategy);
  const secondStrategy = strategy({
    rootCauseHypothesis: 'candidate-controlled-command-resolution',
    repairMechanism: 'pin-reviewed-package-command',
  });
  const secondStrategyFingerprint = buildStrategyFingerprint(secondStrategy);
  const secondDiagnosis = {
    version: 2,
    strategyFingerprint: secondStrategyFingerprint,
    failureClassification: secondStrategy.failureClass,
    rootCauseHypothesisKey: secondStrategy.rootCauseHypothesis,
    discriminatingAction: 'invoke the fixed validator without the candidate-controlled command resolution',
  };
  const firstAttempt = decideRepairAttempt({
    attempts: [],
    exhaustedStrategyFingerprints: [firstStrategyFingerprint],
    proposedStrategy: secondStrategy,
    rediagnosis: secondDiagnosis,
    priorRediagnosisVersion: 1,
    priorRediagnosisStrategyFingerprint: firstStrategyFingerprint,
    priorRootCauseHypothesisKey: firstStrategy.rootCauseHypothesis,
  });
  assert.equal(firstAttempt.allowed, true);
  assert.equal(firstAttempt.requiredRediagnosisVersion, 2);

  const oneIneffectiveAttempt = [{ strategyFingerprint: secondStrategyFingerprint, outcome: 'ineffective' }];
  const secondAttempt = decideRepairAttempt({
    attempts: oneIneffectiveAttempt,
    exhaustedStrategyFingerprints: [firstStrategyFingerprint],
    proposedStrategy: secondStrategy,
    rediagnosis: secondDiagnosis,
    priorRediagnosisVersion: 2,
    priorRediagnosisStrategyFingerprint: secondStrategyFingerprint,
    priorRootCauseHypothesisKey: secondStrategy.rootCauseHypothesis,
  });
  assert.equal(secondAttempt.allowed, true);
  assert.equal(secondAttempt.requiredRediagnosisVersion, 2);

  const thirdAttempt = decideRepairAttempt({
    attempts: [...oneIneffectiveAttempt, ...oneIneffectiveAttempt],
    exhaustedStrategyFingerprints: [firstStrategyFingerprint],
    proposedStrategy: secondStrategy,
    rediagnosis: secondDiagnosis,
    priorRediagnosisVersion: 2,
    priorRediagnosisStrategyFingerprint: secondStrategyFingerprint,
    priorRootCauseHypothesisKey: secondStrategy.rootCauseHypothesis,
  });
  assert.equal(thirdAttempt.allowed, false);
  assert.equal(thirdAttempt.action, 'strategy-exhausted');
});

test('an interleaved exhausted causal hypothesis cannot return under a third strategy fingerprint', () => {
  const firstStrategy = strategy({ rootCauseHypothesis: 'root-a' });
  const secondStrategy = strategy({ rootCauseHypothesis: 'root-b', repairMechanism: 'repair-b' });
  const thirdStrategy = strategy({ rootCauseHypothesis: 'root-a', repairMechanism: 'repair-c' });
  const firstStrategyFingerprint = buildStrategyFingerprint(firstStrategy);
  const secondStrategyFingerprint = buildStrategyFingerprint(secondStrategy);
  const thirdStrategyFingerprint = buildStrategyFingerprint(thirdStrategy);
  const decision = decideRepairAttempt({
    attempts: [
      {
        strategyFingerprint: firstStrategyFingerprint,
        rootCauseHypothesisKey: firstStrategy.rootCauseHypothesis,
        outcome: 'ineffective',
      },
      {
        strategyFingerprint: secondStrategyFingerprint,
        rootCauseHypothesisKey: secondStrategy.rootCauseHypothesis,
        outcome: 'ineffective',
      },
      {
        strategyFingerprint: firstStrategyFingerprint,
        rootCauseHypothesisKey: firstStrategy.rootCauseHypothesis,
        outcome: 'ineffective',
      },
    ],
    currentGenerationAttemptCount: 0,
    proposedStrategy: thirdStrategy,
    priorRediagnosisVersion: 2,
    priorRediagnosisStrategyFingerprint: secondStrategyFingerprint,
    priorRootCauseHypothesisKey: secondStrategy.rootCauseHypothesis,
    rediagnosis: {
      version: 3,
      strategyFingerprint: thirdStrategyFingerprint,
      failureClassification: thirdStrategy.failureClass,
      rootCauseHypothesisKey: thirdStrategy.rootCauseHypothesis,
      discriminatingAction: 'try a third mechanism without changing the retired causal hypothesis',
    },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.action, 'causal-hypothesis-exhausted');
  assert.deepEqual(decision.exhaustedRootCauseHypothesisKeys, ['root-a']);
});

test('repair generation exhaustion requires durable continuation instead of task completion', () => {
  const attempts = ['one', 'two', 'three'].map((rootCauseHypothesis) => ({
    strategyFingerprint: buildStrategyFingerprint(strategy({ rootCauseHypothesis })),
    outcome: 'ineffective',
  }));
  const decision = decideRepairAttempt({
    attempts,
    proposedStrategy: strategy({ rootCauseHypothesis: 'four' }),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.action, 'continue-next-generation');
  assert.equal(decision.generationStatus, 'exhausted');
  assert.equal(decision.taskStatus, 'active');
  assert.equal(decision.continuationRequired, true);
  assert.deepEqual(decision.missingRediagnosis, [
    'version',
    'strategyFingerprint',
    'failureClassification',
    'rootCauseHypothesisKey',
    'discriminatingAction',
  ]);
  assert.notEqual(decision.taskStatus, 'complete');
});

test('untrusted job names are sanitized and secret-shaped content is never copied', () => {
  const secret = ['github_pat_', 'synthetic123456789'].join('');
  assert.equal(containsSensitiveText(`Authorization=${secret}`), true);
  assert.equal(sanitizeJobName(`backend ${secret}`), 'redacted-job');
  const plan = planRepairIssue({ incident: incident({ failedJob: sanitizeJobName(secret) }) });
  assert.equal(plan.action, 'create');
  assert.doesNotMatch(plan.body, new RegExp(secret));
  assert.doesNotMatch(plan.body, /raw stack|environment dump|prompt text/i);
  assert.match(plan.body, /sanitized workflow-trigger metadata and advisory continuation state/i);
  assert.match(plan.body, /cannot authorize a repair or mark the task complete/i);
});

test('repair issue schema v2 persists an active safe continuation target and runtime state', () => {
  const plan = planRepairIssue({ incident: incident() });
  const strategyFingerprint = buildStrategyFingerprint(strategy());
  const state = buildPublicRepairState({
    ...plan.state,
    diagnosis: {
      version: 1,
      strategyFingerprint,
      failureClassification: 'workflow-policy',
      rootCauseHypothesisKey: strategy().rootCauseHypothesis,
      rootCauseHypothesis: 'The fixed validation command was bypassed.',
      evidence: [
        {
          kind: 'discriminating-observation',
          summary: 'The fixed validator fails before the mutable package indirection.',
          sourceRef: `https://github.com/${REPOSITORY}/actions/runs/101`,
        },
      ],
      discriminatingAction: 'Run the fixed validator directly against the candidate.',
    },
    repair: {
      generation: 2,
      status: 'generation-exhausted',
      attempts: [{ number: 1, strategyFingerprint, outcome: 'ineffective', candidateSha: HEAD_SHA }],
      exhaustedStrategyFingerprints: [strategyFingerprint],
    },
    continuation: {
      status: 'next-generation',
      triggers: ['new-candidate-head', 'permission-restored'],
      blocker: 'Waiting for repository write permission.',
    },
  });
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.failureFingerprint, incident().fingerprint);
  assert.deepEqual(state.task, {
    status: 'active',
    targetRequirementRef: `https://github.com/${REPOSITORY}/pull/42`,
    candidateSha: HEAD_SHA,
    completionStatus: 'unverified',
  });
  assert.equal(state.diagnosis.failureClassification, 'workflow-policy');
  assert.equal(state.diagnosis.version, 1);
  assert.equal(state.diagnosis.strategyFingerprint, strategyFingerprint);
  assert.equal(state.diagnosis.rootCauseHypothesisKey, strategy().rootCauseHypothesis);
  assert.equal(state.diagnosis.rootCauseHypothesis, 'The fixed validation command was bypassed.');
  assert.deepEqual(state.diagnosis.evidence, [
    {
      kind: 'discriminating-observation',
      summary: 'The fixed validator fails before the mutable package indirection.',
      sourceRef: `https://github.com/${REPOSITORY}/actions/runs/101`,
    },
  ]);
  assert.equal(state.diagnosis.discriminatingAction, 'Run the fixed validator directly against the candidate.');
  assert.equal(state.repair.generation, 2);
  assert.equal(state.repair.status, 'active');
  assert.deepEqual(state.repair.attempts, [
    { number: 1, generation: 2, strategyFingerprint, outcome: 'ineffective', candidateSha: HEAD_SHA },
  ]);
  assert.deepEqual(state.repair.strategyFingerprints, [strategyFingerprint]);
  assert.deepEqual(state.repair.exhaustedStrategyFingerprints, [strategyFingerprint]);
  assert.equal(state.repair.policyDecision.action, 'await-materially-different-strategy');
  assert.equal(state.repair.policyDecision.attemptsInGeneration, 1);
  assert.deepEqual(state.repair.policyDecision.missingRediagnosis, []);
  assert.equal(state.continuation.required, true);
  assert.equal(state.continuation.status, 'blocked');
  assert.ok(state.continuation.triggers.includes('new-candidate-head'));
  assert.ok(state.continuation.triggers.includes('permission-restored'));
  assert.equal(state.continuation.blocker, 'Waiting for repository write permission.');
  assert.equal(state.recovery.rollbackOccurred, 'unknown');
  assert.equal(state.recovery.candidateInProduction, 'unknown');
  assert.equal(state.callback.supported, false);
  assert.deepEqual(state.persistence, {
    authority: 'advisory',
    revalidationRequired: true,
    repairAuthorization: 'none',
  });
  assert.doesNotMatch(JSON.stringify(state), /raw stack|environment dump|prompt text/i);
  assert.match(plan.body, /"schemaVersion": 2/);
  assert.match(plan.body, /keeps this task active/i);
});

test('delivery summary v2 is accepted only with bounded terminal and supersession identity', () => {
  const base = deliverySummary();
  assert.equal(isAcceptedDeliverySummary({ schemaVersion: 1, sha: HEAD_SHA }, HEAD_SHA), true);
  assert.equal(isAcceptedDeliverySummary(base, HEAD_SHA), true);
  assert.equal(
    isAcceptedDeliverySummary(
      {
        ...base,
        terminalOutcome: 'verified',
        test: 'passed',
        production: 'passed',
        rawJobs: { test: 'success', production: 'success' },
        superseded: false,
        supersededBy: null,
      },
      HEAD_SHA,
    ),
    true,
  );
  assert.equal(
    isAcceptedDeliverySummary(
      {
        ...base,
        terminalOutcome: 'not_applicable',
        deploymentRequired: false,
        test: 'not_applicable',
        production: 'not_applicable',
        rawJobs: { test: 'skipped', production: 'skipped' },
        superseded: false,
        supersededBy: null,
      },
      HEAD_SHA,
    ),
    true,
  );
  assert.equal(
    isAcceptedDeliverySummary(
      {
        ...base,
        terminalOutcome: 'not_applicable',
        deploymentRequired: false,
        test: 'passed',
        production: 'not_applicable',
        rawJobs: { test: 'success', production: 'skipped' },
        superseded: false,
        supersededBy: null,
      },
      HEAD_SHA,
    ),
    true,
  );
  assert.equal(
    isAcceptedDeliverySummary(
      {
        ...base,
        terminalOutcome: 'incomplete',
        test: 'failure',
        production: 'skipped',
        rawJobs: { test: 'failure', production: 'skipped' },
        superseded: false,
        supersededBy: null,
      },
      HEAD_SHA,
    ),
    true,
  );
  assert.equal(
    isAcceptedDeliverySummary(
      {
        ...base,
        terminalOutcome: 'incomplete',
        deploymentRequired: false,
        test: 'failure',
        production: 'not_applicable',
        rawJobs: { test: 'failure', production: 'skipped' },
        superseded: false,
        supersededBy: null,
      },
      HEAD_SHA,
    ),
    true,
  );
  assert.equal(isAcceptedDeliverySummary({ ...base, deploymentRequired: false }, HEAD_SHA), false);
  const missingDeploymentRequired = { ...base };
  delete missingDeploymentRequired.deploymentRequired;
  assert.equal(isAcceptedDeliverySummary(missingDeploymentRequired, HEAD_SHA), false);
  assert.equal(isAcceptedDeliverySummary({ ...base, supersededBy: 'not-a-sha' }, HEAD_SHA), false);
  assert.equal(isAcceptedDeliverySummary({ ...base, superseded: false }, HEAD_SHA), false);
  assert.equal(
    isAcceptedDeliverySummary({ ...base, terminalOutcome: 'verified', supersededBy: NEXT_SHA }, HEAD_SHA),
    false,
  );
  assert.equal(isAcceptedDeliverySummary({ ...base, sha: NEXT_SHA }, HEAD_SHA), false);
  assert.equal(
    isAcceptedDeliverySummary({ ...base, rawJobs: { test: 'failure', production: 'skipped' } }, HEAD_SHA),
    false,
  );

  assert.deepEqual(
    sanitizeDeliveryRecovery({
      ...base,
      recovery: 'not-required',
      rollback: 'skipped',
    }),
    {
      state: 'not-required',
      rollback: 'skipped',
      terminalOutcome: 'superseded',
      supersededBy: NEXT_SHA,
      rollbackOccurred: 'no',
      candidateInProduction: 'unknown',
    },
  );
});

test('same exact head and fingerprint deduplicates without another callback or issue', () => {
  const value = incident();
  const issue = {
    number: 9,
    state: 'OPEN',
    author: { login: 'github-actions[bot]' },
    body: `${repairFingerprintMarker(value.fingerprint)}\n${repairIncidentMarker(value.headSha, value.fingerprint)}`,
  };
  const plan = planRepairIssue({ incident: value, issues: [issue] });
  assert.equal(plan.action, 'deduplicated');
  assert.equal(plan.reason, 'exact-head-and-fingerprint-already-recorded');
  assert.equal(plan.issueNumber, 9);
});

test('latest sanitized advisory v2 snapshot carries repair history into a newly bound recurrence', () => {
  const initialPlan = planRepairIssue({ incident: incident() });
  const olderState = buildPublicRepairState(initialPlan.state);
  const firstStrategyFingerprint = buildStrategyFingerprint(strategy());
  const secondStrategyFingerprint = buildStrategyFingerprint(
    strategy({ repairMechanism: 'pin-reviewed-package-command' }),
  );
  const latestState = buildPublicRepairState({
    ...initialPlan.state,
    headSha: NEXT_SHA,
    workflowRunId: 202,
    workflowRunUrl: `https://github.com/${REPOSITORY}/actions/runs/202`,
    failedJobId: 303,
    task: { ...olderState.task, candidateSha: NEXT_SHA },
    diagnosis: {
      failureClassification: 'workflow-policy',
      rootCauseHypothesis: 'The mutable package indirection bypasses the fixed validator.',
      evidence: [
        {
          kind: 'discriminating-observation',
          summary: 'The fixed validator fails while the candidate package indirection passes.',
          sourceRef: `https://github.com/${REPOSITORY}/actions/runs/202`,
        },
      ],
      discriminatingAction: 'Run the fixed validator directly on the next candidate.',
    },
    repair: {
      generation: 2,
      status: 'active',
      attempts: [
        {
          number: 1,
          generation: 2,
          strategyFingerprint: firstStrategyFingerprint,
          outcome: 'ineffective',
          candidateSha: NEXT_SHA,
        },
        {
          number: 2,
          generation: 2,
          strategyFingerprint: firstStrategyFingerprint,
          outcome: 'ineffective',
          candidateSha: NEXT_SHA,
        },
        {
          number: 3,
          generation: 2,
          strategyFingerprint: secondStrategyFingerprint,
          outcome: 'ineffective',
          candidateSha: NEXT_SHA,
        },
      ],
    },
    continuation: {
      status: 'blocked',
      triggers: ['permission-restored', 'next-repository-task'],
      blocker: 'Repository write permission must be restored.',
    },
  });
  const issue = {
    number: 9,
    state: 'OPEN',
    author: { login: 'github-actions[bot]' },
    body: `${repairFingerprintMarker(initialPlan.state.fingerprint)}\n${markedRepairState(olderState)}`,
  };
  const comments = [
    {
      user: { login: 'github-actions[bot]' },
      created_at: '2026-08-30T20:00:00Z',
      updated_at: '2026-08-30T20:00:00Z',
      body: markedRepairState(latestState),
    },
    {
      user: { login: 'github-actions[bot]' },
      created_at: '2026-08-30T20:01:00Z',
      updated_at: '2026-08-30T20:02:00Z',
      body: markedRepairState({
        ...latestState,
        diagnosis: {
          ...latestState.diagnosis,
          rootCauseHypothesis: 'An edited bot comment must not replace the preserved snapshot.',
        },
        repair: { ...latestState.repair, generation: 99, attempts: [] },
      }),
    },
  ];
  const nextIncident = incident({
    headSha: THIRD_SHA,
    workflowRunId: 303,
    workflowRunUrl: `https://github.com/${REPOSITORY}/actions/runs/303`,
    failedJobId: 404,
  });
  const plan = planRepairIssue({ incident: nextIncident, issues: [issue], comments });

  assert.equal(plan.action, 'append');
  assert.equal(plan.state.task.candidateSha, THIRD_SHA);
  assert.equal(plan.state.task.targetRequirementRef, `https://github.com/${REPOSITORY}/pull/42`);
  assert.equal(plan.state.diagnosis.failureClassification, 'workflow-policy');
  assert.equal(
    plan.state.diagnosis.rootCauseHypothesis,
    'The mutable package indirection bypasses the fixed validator.',
  );
  assert.equal(plan.state.diagnosis.discriminatingAction, 'Run the fixed validator directly on the next candidate.');
  assert.equal(plan.state.diagnosis.evidence.length, 2);
  assert.equal(plan.state.diagnosis.evidence.at(-1).sourceRef, nextIncident.workflowRunUrl);
  assert.equal(plan.state.repair.generation, 2);
  assert.equal(plan.state.repair.attempts.length, 3);
  assert.deepEqual(plan.state.repair.strategyFingerprints, [firstStrategyFingerprint, secondStrategyFingerprint]);
  assert.deepEqual(plan.state.repair.exhaustedStrategyFingerprints, [firstStrategyFingerprint]);
  assert.equal(plan.state.repair.status, 'generation-exhausted');
  assert.equal(plan.state.repair.policyDecision.action, 'continue-next-generation');
  assert.equal(plan.state.repair.policyDecision.authorization, 'none');
  assert.equal(plan.state.repair.policyDecision.attemptsInGeneration, 3);
  assert.deepEqual(plan.state.continuation.triggers, ['permission-restored', 'next-repository-task']);
  assert.equal(plan.state.continuation.status, 'blocked');
  assert.equal(plan.state.continuation.blocker, 'Repository write permission must be restored.');
  assert.deepEqual(plan.state.continuation.nextGeneration, {
    pending: true,
    fromGeneration: 2,
    targetGeneration: 3,
    automatic: false,
  });
  assert.match(plan.comment, new RegExp(repairIncidentMarker(THIRD_SHA, nextIncident.fingerprint)));
  assert.match(plan.comment, /"action": "continue-next-generation"/);
  assert.doesNotMatch(plan.comment, /edited bot comment/);
});

test('same causal PR failure on a different PR resets the active target and repair generation', () => {
  const initialPlan = planRepairIssue({ incident: incident() });
  const strategyFingerprint = buildStrategyFingerprint(strategy());
  const persistedState = buildPublicRepairState({
    ...initialPlan.state,
    diagnosis: {
      failureClassification: 'workflow-policy',
      rootCauseHypothesis: 'The first pull request used the wrong validation mechanism.',
      discriminatingAction: 'Run the fixed validator against the first pull request.',
    },
    repair: {
      generation: 4,
      attempts: [
        {
          number: 1,
          generation: 4,
          strategyFingerprint,
          outcome: 'ineffective',
          candidateSha: HEAD_SHA,
        },
      ],
    },
    continuation: {
      status: 'blocked',
      triggers: ['permission-restored'],
      blocker: 'The first pull request is blocked.',
    },
  });
  const issue = {
    number: 9,
    state: 'OPEN',
    author: { login: 'github-actions[bot]' },
    body: `${repairFingerprintMarker(initialPlan.state.fingerprint)}\n${markedRepairState(persistedState)}`,
  };
  const plan = planRepairIssue({
    incident: incident({
      headSha: NEXT_SHA,
      pullRequest: 99,
      workflowRunId: 303,
      workflowRunUrl: `https://github.com/${REPOSITORY}/actions/runs/303`,
    }),
    issues: [issue],
  });

  assert.equal(plan.action, 'append');
  assert.equal(plan.state.task.targetRequirementRef, `https://github.com/${REPOSITORY}/pull/99`);
  assert.equal(plan.state.task.candidateSha, NEXT_SHA);
  assert.equal(plan.state.repair.generation, 1);
  assert.deepEqual(plan.state.repair.attempts, []);
  assert.deepEqual(plan.state.repair.exhaustedStrategyFingerprints, []);
  assert.equal(plan.state.diagnosis.failureClassification, 'candidate-code');
  assert.equal(plan.state.diagnosis.rootCauseHypothesis, null);
  assert.equal(plan.state.diagnosis.discriminatingAction, null);
  assert.equal(plan.state.continuation.blocker, null);
});

test('human, unmarked, malformed, and secret-shaped persisted state cannot influence recurrence', () => {
  const initialPlan = planRepairIssue({ incident: incident() });
  const strategyFingerprint = buildStrategyFingerprint(strategy());
  const validState = buildPublicRepairState({
    ...initialPlan.state,
    diagnosis: {
      failureClassification: 'workflow-policy',
      rootCauseHypothesis: 'This untrusted hypothesis must not survive.',
      discriminatingAction: 'This untrusted action must not survive.',
    },
    repair: {
      generation: 4,
      attempts: [{ strategyFingerprint, outcome: 'ineffective', candidateSha: HEAD_SHA }],
    },
  });
  const secret = ['github_pat_', 'synthetic123456789'].join('');
  const secretState = {
    ...validState,
    diagnosis: { ...validState.diagnosis, rootCauseHypothesis: `Authorization=${secret}` },
  };
  const issue = {
    number: 9,
    state: 'OPEN',
    author: { login: 'github-actions[bot]' },
    body: `${repairFingerprintMarker(initialPlan.state.fingerprint)}\n${repairIncidentMarker(
      HEAD_SHA,
      initialPlan.state.fingerprint,
    )}`,
  };
  const comments = [
    { user: { login: 'martin' }, body: markedRepairState(validState) },
    { user: { login: 'github-actions[bot]' }, body: `\`\`\`json\n${JSON.stringify(validState)}\n\`\`\`` },
    {
      user: { login: 'github-actions[bot]' },
      body: `${repairIncidentMarker(HEAD_SHA, initialPlan.state.fingerprint)}\n\`\`\`json\n{"schemaVersion":\n\`\`\``,
    },
    { user: { login: 'github-actions[bot]' }, body: markedRepairState(secretState) },
  ];
  const plan = planRepairIssue({
    incident: incident({ headSha: NEXT_SHA }),
    issues: [issue],
    comments,
  });

  assert.equal(plan.action, 'append');
  assert.equal(plan.state.diagnosis.failureClassification, 'candidate-code');
  assert.equal(plan.state.diagnosis.rootCauseHypothesis, null);
  assert.equal(plan.state.diagnosis.discriminatingAction, null);
  assert.equal(plan.state.repair.generation, 1);
  assert.deepEqual(plan.state.repair.attempts, []);
  assert.deepEqual(plan.state.repair.exhaustedStrategyFingerprints, []);
  assert.doesNotMatch(plan.comment, new RegExp(secret));
  assert.doesNotMatch(plan.comment, /This untrusted hypothesis|This untrusted action/);
});

test('new exact head increments recurrence and objectively requires learning promotion', () => {
  const value = incident({ headSha: NEXT_SHA });
  const issue = {
    number: 9,
    state: 'CLOSED',
    author: { login: 'github-actions[bot]' },
    body: `${repairFingerprintMarker(value.fingerprint)}\n${repairIncidentMarker(HEAD_SHA, value.fingerprint)}`,
  };
  const plan = planRepairIssue({ incident: value, issues: [issue] });
  assert.equal(plan.action, 'append');
  assert.equal(plan.reopen, true);
  assert.equal(plan.state.recurrenceCount, 2);
  assert.equal(plan.state.learning.status, 'promotion-required');
  assert.ok(plan.labels.includes('learning-promotion-required'));
});

test('production rollback requires promotion on its first occurrence', () => {
  assert.deepEqual(
    learningDecision({
      classification: 'production-regression',
      severity: 'critical',
      recurrenceCount: 1,
      learningTriggers: ['production-rollback'],
    }),
    {
      status: 'promotion-required',
      severity: 'critical',
      triggers: ['production-rollback'],
      recurrenceCount: 1,
    },
  );
});

test('duplicate repair issues fail closed instead of multiplying queue mutations', () => {
  const value = incident();
  const marker = repairFingerprintMarker(value.fingerprint);
  const plan = planRepairIssue({
    incident: value,
    issues: [
      { number: 7, author: { login: 'github-actions[bot]' }, body: marker },
      { number: 8, author: { login: 'github-actions[bot]' }, body: marker },
    ],
  });
  assert.equal(plan.action, 'blocked');
  assert.deepEqual(plan.issueNumbers, [7, 8]);
});

test('queue runtime reports exact bounded duplicate identities and progress fails closed with the same numbers', async () => {
  const value = incident();
  const marker = repairFingerprintMarker(value.fingerprint);
  const issues = [
    { number: 8, state: 'OPEN', author: { login: 'github-actions[bot]' }, body: marker },
    { number: 7, state: 'OPEN', author: { login: 'github-actions[bot]' }, body: marker },
  ];
  const api = {
    async getRun() {
      return run();
    },
    async getPullRequest() {
      return pullRequest();
    },
    async getJobs() {
      return [{ id: 202, name: 'backend and contracts', conclusion: 'failure' }];
    },
    async listRepairIssues() {
      return issues;
    },
    async listIssueComments() {
      return [];
    },
  };
  const baseEnv = { GITHUB_REPOSITORY: REPOSITORY, SOURCE_RUN_ID: '101', DRY_RUN: 'false' };
  const blocked = await runRepairQueue({ api, env: baseEnv, logger: { log() {} } });
  assert.equal(blocked.action, 'blocked');
  assert.equal(blocked.reason, 'duplicate-repair-issues');
  assert.equal(blocked.issueNumber, 0);
  assert.deepEqual(blocked.issueNumbers, [7, 8]);

  await assert.rejects(
    runRepairQueue({
      api,
      env: {
        ...baseEnv,
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        REPAIR_PROGRESS_JSON: JSON.stringify({
          schemaVersion: 1,
          repository: REPOSITORY,
          issueNumber: 7,
          sourceRunId: 101,
          candidateSha: HEAD_SHA,
          failureFingerprint: value.fingerprint,
          diagnosis: {},
          repair: {},
          continuation: {},
        }),
      },
      logger: { log() {} },
    }),
    /found: 7, 8/,
  );
});

test('human-authored repair marker and label spoof cannot become the active repair issue', () => {
  const value = incident();
  const marker = repairFingerprintMarker(value.fingerprint);
  const humanIssue = {
    number: 1,
    author: { login: 'maintainer' },
    labels: [{ name: 'codex-repair' }],
    body: marker,
  };
  const botIssue = {
    number: 10,
    state: 'OPEN',
    author: { login: 'github-actions[bot]' },
    labels: [{ name: 'codex-repair' }],
    body: marker,
  };
  const planned = planRepairIssue({ incident: value, issues: [humanIssue, botIssue] });
  assert.equal(planned.action, 'append');
  assert.equal(planned.issueNumber, 10);
  assert.equal(planRepairIssue({ incident: value, issues: [humanIssue] }).action, 'create');
});

test('serialized same-fingerprint writer creates once and appends the next exact run', async () => {
  const issues = [];
  const comments = new Map();
  let currentRun = run();
  let currentPullRequest = pullRequest();
  const api = {
    async getRun() {
      return currentRun;
    },
    async getPullRequest() {
      return currentPullRequest;
    },
    async getJobs() {
      return [{ id: 202, name: 'backend and contracts', conclusion: 'failure' }];
    },
    async listRepairIssues() {
      return issues;
    },
    async listIssueComments(_repository, number) {
      return comments.get(number) || [];
    },
    async ensureLabels() {},
    async createIssue(_repository, title, body, labels) {
      issues.push({
        number: 10,
        title,
        body,
        labels,
        state: 'OPEN',
        author: { login: 'github-actions[bot]' },
      });
      comments.set(10, []);
      return 10;
    },
    async addLabels() {},
    async reopenIssue() {},
    async commentIssue(_repository, number, body) {
      comments.get(number).push({
        user: { login: 'github-actions[bot]' },
        created_at: '2026-08-30T23:00:00Z',
        updated_at: '2026-08-30T23:00:00Z',
        body,
      });
    },
  };
  const baseEnv = { GITHUB_REPOSITORY: REPOSITORY, SOURCE_RUN_ID: '101', DRY_RUN: 'false' };
  const created = await runRepairQueue({ api, env: baseEnv, logger: { log() {} } });
  assert.equal(created.action, 'create');
  assert.equal(created.issueNumber, 10);

  currentRun = run({ id: 202, head_sha: NEXT_SHA });
  currentPullRequest = pullRequest({ head: { ...pullRequest().head, sha: NEXT_SHA } });
  const appended = await runRepairQueue({
    api,
    env: { ...baseEnv, SOURCE_RUN_ID: '202' },
    logger: { log() {} },
  });
  assert.equal(appended.action, 'append');
  assert.equal(appended.issueNumber, 10);
  assert.equal(issues.length, 1);
  assert.equal(comments.get(10).length, 1);
  assert.match(comments.get(10)[0].body, new RegExp(repairIncidentMarker(NEXT_SHA, appended.fingerprint)));
});

test('queue runtime is idempotent and mutates only the planned issue surface', async () => {
  const mutations = [];
  const api = {
    async getRun() {
      return run();
    },
    async getPullRequest() {
      return pullRequest();
    },
    async getJobs() {
      return [{ id: 202, name: 'backend and contracts', conclusion: 'failure' }];
    },
    async listRepairIssues() {
      return [];
    },
    async listIssueComments() {
      throw new Error('comments are not needed for a new fingerprint');
    },
    async ensureLabels(_repository, labels) {
      mutations.push(['labels', labels]);
    },
    async createIssue(_repository, title, body, labels) {
      mutations.push(['create', title, body, labels]);
      return 77;
    },
  };
  const result = await runRepairQueue({
    api,
    env: { GITHUB_REPOSITORY: REPOSITORY, SOURCE_RUN_ID: '101', DRY_RUN: 'false' },
    logger: { log() {} },
  });
  assert.equal(result.action, 'create');
  assert.equal(result.issueNumber, 77);
  assert.deepEqual(
    mutations.map(([action]) => action),
    ['labels', 'create'],
  );
});

test('queue runtime records successful supersession with a dedicated causal continuation identity', async () => {
  const api = {
    async getRun() {
      return run({
        path: '.github/workflows/delivery-v2.yml',
        event: 'push',
        conclusion: 'success',
        head_branch: 'main',
        pull_requests: [],
      });
    },
    async getDeliverySummary() {
      return deliverySummary();
    },
    async getJobs() {
      return [{ id: 1, name: 'delivery summary', conclusion: 'success' }];
    },
    async listRepairIssues() {
      return [];
    },
    async listIssueComments() {
      throw new Error('comments are not needed for a new supersession lineage');
    },
  };
  const result = await runRepairQueue({
    api,
    env: { GITHUB_REPOSITORY: REPOSITORY, SOURCE_RUN_ID: '101', DRY_RUN: 'true' },
    logger: { log() {} },
  });
  assert.equal(result.action, 'planned-create');
  assert.equal(result.failedJob, `main supersession ${HEAD_SHA}`);
  assert.equal(result.fingerprint, `delivery-v2.superseded-delivery-generation.main-supersession-${HEAD_SHA}`);
  assert.equal(result.callbackSupported, false);
  assert.equal(result.callbackRequested, false);
});

test('queue runtime records a successful shadow-mode incomplete delivery as an advisory configuration blocker', async () => {
  const api = {
    async getRun() {
      return run({
        path: '.github/workflows/delivery-v2.yml',
        event: 'push',
        conclusion: 'success',
        head_branch: 'main',
        pull_requests: [],
      });
    },
    async getDeliverySummary() {
      return deliverySummary({
        mode: 'shadow',
        terminalOutcome: 'incomplete',
        test: 'skipped',
        production: 'skipped',
        rawJobs: { test: 'skipped', production: 'skipped' },
        superseded: false,
        supersededBy: null,
      });
    },
    async getJobs() {
      return [{ id: 1, name: 'delivery summary', conclusion: 'success' }];
    },
    async listRepairIssues() {
      return [];
    },
    async listIssueComments() {
      throw new Error('comments are not needed for a new shadow blocker');
    },
  };
  const result = await runRepairQueue({
    api,
    env: { GITHUB_REPOSITORY: REPOSITORY, SOURCE_RUN_ID: '101', DRY_RUN: 'true' },
    logger: { log() {} },
  });
  assert.equal(result.action, 'planned-create');
  assert.equal(result.failedJob, 'delivery shadow configuration blocker');
  assert.equal(result.fingerprint, 'delivery-v2.delivery-configuration-blocker.delivery-shadow-configuration-blocker');
  assert.equal(result.callbackRequested, false);
});

test('unrelated successful supersessions create target-scoped continuations without false learning recurrence', async () => {
  const issues = [];
  let currentHead = HEAD_SHA;
  let currentRunId = 101;
  const api = {
    async getRun() {
      return run({
        id: currentRunId,
        path: '.github/workflows/delivery-v2.yml',
        event: 'push',
        conclusion: 'success',
        head_sha: currentHead,
        head_branch: 'main',
        pull_requests: [],
      });
    },
    async getDeliverySummary() {
      return deliverySummary({
        sha: currentHead,
        supersededBy: currentHead === HEAD_SHA ? NEXT_SHA : 'd'.repeat(40),
      });
    },
    async getJobs() {
      return [{ id: 1, name: 'delivery summary', conclusion: 'success' }];
    },
    async listRepairIssues() {
      return issues;
    },
    async listIssueComments() {
      throw new Error('target-scoped supersessions must not reuse an unrelated issue');
    },
    async ensureLabels() {},
    async createIssue(_repository, title, body, labels) {
      const number = issues.length + 1;
      issues.push({ number, title, body, labels, state: 'OPEN', author: { login: 'github-actions[bot]' } });
      return number;
    },
  };

  const first = await runRepairQueue({
    api,
    env: { GITHUB_REPOSITORY: REPOSITORY, SOURCE_RUN_ID: String(currentRunId), DRY_RUN: 'false' },
    logger: { log() {} },
  });
  currentHead = THIRD_SHA;
  currentRunId = 303;
  const second = await runRepairQueue({
    api,
    env: { GITHUB_REPOSITORY: REPOSITORY, SOURCE_RUN_ID: String(currentRunId), DRY_RUN: 'false' },
    logger: { log() {} },
  });

  assert.equal(first.action, 'create');
  assert.equal(second.action, 'create');
  assert.equal(issues.length, 2);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.match(first.fingerprint, new RegExp(`${HEAD_SHA}$`));
  assert.match(second.fingerprint, new RegExp(`${THIRD_SHA}$`));
  assert.equal(first.recurrenceCount, 1);
  assert.equal(second.recurrenceCount, 1);
  assert.equal(first.learningStatus, 'not-required-yet');
  assert.equal(second.learningStatus, 'not-required-yet');
  assert.ok(issues.every((issue) => !issue.labels.includes('learning-promotion-required')));
});

test('authenticated queue progress writer persists policy-checked advisory state for the next recurrence', async () => {
  const issues = [];
  const comments = new Map();
  let currentRun = run();
  let currentPullRequest = pullRequest();
  const api = {
    async getRun() {
      return currentRun;
    },
    async getPullRequest() {
      return currentPullRequest;
    },
    async getJobs() {
      return [{ id: 202, name: 'backend and contracts', conclusion: 'failure' }];
    },
    async listRepairIssues() {
      return issues;
    },
    async listIssueComments(_repository, number) {
      return comments.get(number) || [];
    },
    async ensureLabels() {},
    async createIssue(_repository, title, body, labels) {
      const number = 77;
      issues.push({ number, title, body, labels, state: 'OPEN', author: { login: 'github-actions[bot]' } });
      comments.set(number, []);
      return number;
    },
    async addLabels() {},
    async reopenIssue() {},
    async commentIssue(_repository, number, body) {
      comments.get(number).push({
        user: { login: 'github-actions[bot]' },
        created_at: '2026-08-30T21:00:00Z',
        updated_at: '2026-08-30T21:00:00Z',
        body,
      });
    },
  };
  const baseEnv = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    SOURCE_RUN_ID: '101',
    DRY_RUN: 'false',
  };
  const created = await runRepairQueue({ api, env: baseEnv, logger: { log() {} } });
  assert.equal(created.action, 'create');

  const strategyInputs = strategy();
  const strategyFingerprint = buildStrategyFingerprint(strategyInputs);
  const progress = {
    schemaVersion: 1,
    repository: REPOSITORY,
    issueNumber: 77,
    sourceRunId: 101,
    candidateSha: HEAD_SHA,
    failureFingerprint: created.fingerprint,
    diagnosis: {
      version: 1,
      strategyFingerprint,
      failureClassification: strategyInputs.failureClass,
      rootCauseHypothesisKey: strategyInputs.rootCauseHypothesis,
      rootCauseHypothesis: 'The candidate invokes a mutable validator indirection.',
      evidence: [
        {
          kind: 'discriminating-observation',
          summary: 'The fixed validator fails only for the candidate path.',
          sourceRef: `https://github.com/${REPOSITORY}/actions/runs/101`,
        },
      ],
      discriminatingAction: 'Run the fixed validator directly before changing the candidate.',
    },
    repair: {
      generation: 1,
      attempts: [
        {
          number: 1,
          generation: 1,
          strategyFingerprint,
          strategy: strategyInputs,
          outcome: 'in-progress',
          candidateSha: HEAD_SHA,
        },
      ],
      strategyFingerprints: [strategyFingerprint],
      exhaustedStrategyFingerprints: [],
    },
    continuation: {
      status: 'waiting',
      triggers: ['new-candidate-head', 'next-repository-task'],
      blocker: 'Awaiting a materially different candidate.',
    },
  };
  await assert.rejects(
    runRepairQueue({
      api,
      env: { ...baseEnv, GITHUB_ACTIONS: 'false', REPAIR_PROGRESS_JSON: JSON.stringify(progress) },
      logger: { log() {} },
    }),
    /authenticated workflow_dispatch/,
  );
  const nonSequentialProgress = {
    ...progress,
    repair: {
      ...progress.repair,
      attempts: [{ ...progress.repair.attempts[0], number: 2 }],
    },
  };
  await assert.rejects(
    runRepairQueue({
      api,
      env: { ...baseEnv, REPAIR_PROGRESS_JSON: JSON.stringify(nonSequentialProgress) },
      logger: { log() {} },
    }),
    /unique sequential attempt numbers/,
  );
  const wrongCandidateProgress = {
    ...progress,
    repair: {
      ...progress.repair,
      attempts: [{ ...progress.repair.attempts[0], candidateSha: NEXT_SHA }],
    },
  };
  await assert.rejects(
    runRepairQueue({
      api,
      env: { ...baseEnv, REPAIR_PROGRESS_JSON: JSON.stringify(wrongCandidateProgress) },
      logger: { log() {} },
    }),
    /exact current candidate SHA/,
  );
  const recorded = await runRepairQueue({
    api,
    env: { ...baseEnv, REPAIR_PROGRESS_JSON: JSON.stringify(progress) },
    logger: { log() {} },
  });
  assert.equal(recorded.action, 'record-progress');
  assert.equal(comments.get(77).length, 1);
  const recordedState = repairStateFromBody(comments.get(77)[0].body);
  assert.equal(recordedState.persistence.authority, 'advisory');
  assert.equal(recordedState.persistence.repairAuthorization, 'none');
  assert.equal(recordedState.task.status, 'active');
  assert.equal(recordedState.task.completionStatus, 'unverified');
  assert.equal(recordedState.repair.attempts.length, 1);
  assert.equal(recordedState.repair.attempts[0].strategyFingerprint, strategyFingerprint);
  assert.equal(recordedState.repair.attempts[0].outcome, 'in-progress');

  const manufacturedExhaustion = {
    ...progress,
    repair: {
      ...progress.repair,
      exhaustedStrategyFingerprints: [strategyFingerprint],
    },
  };
  await assert.rejects(
    runRepairQueue({
      api,
      env: { ...baseEnv, REPAIR_PROGRESS_JSON: JSON.stringify(manufacturedExhaustion) },
      logger: { log() {} },
    }),
    /manufacture exhausted strategy or causal hypothesis history/,
  );
  assert.equal(comments.get(77).length, 1);

  const secondAttempt = {
    number: 2,
    generation: 1,
    strategyFingerprint,
    strategy: strategyInputs,
    outcome: 'ineffective',
    candidateSha: HEAD_SHA,
  };
  const concurrentProgress = {
    ...progress,
    repair: {
      ...progress.repair,
      attempts: [...progress.repair.attempts, secondAttempt],
    },
  };
  await assert.rejects(
    runRepairQueue({
      api,
      env: { ...baseEnv, REPAIR_PROGRESS_JSON: JSON.stringify(concurrentProgress) },
      logger: { log() {} },
    }),
    /prior repair attempt is still in-progress/,
  );
  const serializedProgress = {
    ...concurrentProgress,
    repair: {
      ...concurrentProgress.repair,
      attempts: [{ ...progress.repair.attempts[0], outcome: 'ineffective' }, secondAttempt],
    },
  };
  const serialized = await runRepairQueue({
    api,
    env: { ...baseEnv, REPAIR_PROGRESS_JSON: JSON.stringify(serializedProgress) },
    logger: { log() {} },
  });
  assert.equal(serialized.action, 'record-progress');
  assert.equal(comments.get(77).length, 2);

  currentRun = run({ id: 303, head_sha: THIRD_SHA });
  currentPullRequest = pullRequest({ head: { ...pullRequest().head, sha: THIRD_SHA } });
  const recurrence = await runRepairQueue({
    api,
    env: { ...baseEnv, SOURCE_RUN_ID: '303' },
    logger: { log() {} },
  });
  assert.equal(recurrence.action, 'append');
  const carriedState = repairStateFromBody(comments.get(77).at(-1).body);
  assert.equal(carriedState.task.candidateSha, THIRD_SHA);
  assert.equal(carriedState.diagnosis.rootCauseHypothesis, progress.diagnosis.rootCauseHypothesis);
  assert.equal(carriedState.diagnosis.discriminatingAction, progress.diagnosis.discriminatingAction);
  assert.equal(carriedState.repair.generation, 1);
  assert.equal(carriedState.repair.attempts.length, 2);
  assert.equal(carriedState.repair.attempts[0].strategyFingerprint, strategyFingerprint);
  assert.deepEqual(carriedState.repair.exhaustedStrategyFingerprints, [strategyFingerprint]);
  assert.equal(carriedState.continuation.blocker, progress.continuation.blocker);
});

test('protected-main history follows one exact declared candidate and resets for an unrelated later SHA', async () => {
  const issues = [];
  const comments = new Map();
  let currentHead = HEAD_SHA;
  let currentRunId = 501;
  const api = {
    async getRun() {
      return run({
        id: currentRunId,
        path: '.github/workflows/delivery-v2.yml',
        event: 'push',
        conclusion: 'failure',
        head_sha: currentHead,
        head_branch: 'main',
        pull_requests: [],
      });
    },
    async getDeliverySummary() {
      return undefined;
    },
    async getJobs() {
      return [{ id: 202, name: 'deploy test', conclusion: 'failure' }];
    },
    async listRepairIssues() {
      return issues;
    },
    async listIssueComments(_repository, number) {
      return comments.get(number) || [];
    },
    async ensureLabels() {},
    async createIssue(_repository, title, body, labels) {
      const number = 88;
      issues.push({ number, title, body, labels, state: 'OPEN', author: { login: 'github-actions[bot]' } });
      comments.set(number, []);
      return number;
    },
    async addLabels() {},
    async reopenIssue() {},
    async commentIssue(_repository, number, body) {
      comments.get(number).push({
        user: { login: 'github-actions[bot]' },
        created_at: '2026-08-30T22:00:00Z',
        updated_at: '2026-08-30T22:00:00Z',
        body,
      });
    },
  };
  const baseEnv = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    SOURCE_RUN_ID: String(currentRunId),
    DRY_RUN: 'false',
  };
  const created = await runRepairQueue({ api, env: baseEnv, logger: { log() {} } });
  assert.equal(created.action, 'create');

  const strategyInputs = {
    failureClass: 'deployment-failure',
    failingGate: 'delivery.test',
    rootCauseHypothesis: 'test-deployment-package-mismatch',
    affectedSurface: 'azure-functions',
    repairMechanism: 'rebuild-immutable-release',
  };
  const strategyFingerprint = buildStrategyFingerprint(strategyInputs);
  const progress = {
    schemaVersion: 1,
    repository: REPOSITORY,
    issueNumber: 88,
    sourceRunId: currentRunId,
    candidateSha: HEAD_SHA,
    failureFingerprint: created.fingerprint,
    diagnosis: {
      version: 1,
      strategyFingerprint,
      failureClassification: strategyInputs.failureClass,
      rootCauseHypothesisKey: strategyInputs.rootCauseHypothesis,
      rootCauseHypothesis: 'The test deployment package does not match the candidate release.',
      discriminatingAction: 'Compare the immutable package digest with the trusted build artifact.',
    },
    repair: {
      generation: 1,
      attempts: [
        {
          number: 1,
          generation: 1,
          strategyFingerprint,
          strategy: strategyInputs,
          outcome: 'ineffective',
          candidateSha: HEAD_SHA,
        },
      ],
      strategyFingerprints: [strategyFingerprint],
      exhaustedStrategyFingerprints: [],
    },
    continuation: {
      status: 'waiting',
      triggers: ['new-candidate-head'],
      blocker: null,
      expectedCandidateSha: NEXT_SHA,
    },
  };
  await runRepairQueue({
    api,
    env: { ...baseEnv, REPAIR_PROGRESS_JSON: JSON.stringify(progress) },
    logger: { log() {} },
  });
  const declaredState = repairStateFromBody(comments.get(88).at(-1).body);
  assert.equal(declaredState.continuation.expectedCandidateSha, NEXT_SHA);

  currentHead = NEXT_SHA;
  currentRunId = 502;
  const linked = await runRepairQueue({
    api,
    env: { ...baseEnv, SOURCE_RUN_ID: String(currentRunId) },
    logger: { log() {} },
  });
  assert.equal(linked.action, 'append');
  const linkedState = repairStateFromBody(comments.get(88).at(-1).body);
  assert.equal(linkedState.task.targetRequirementRef, `https://github.com/${REPOSITORY}/commit/${HEAD_SHA}`);
  assert.equal(linkedState.task.candidateSha, NEXT_SHA);
  assert.equal(linkedState.repair.attempts.length, 1);
  assert.equal(linkedState.repair.attempts[0].strategyFingerprint, strategyFingerprint);
  assert.equal(linkedState.continuation.expectedCandidateSha, null);

  currentHead = THIRD_SHA;
  currentRunId = 503;
  const unrelated = await runRepairQueue({
    api,
    env: { ...baseEnv, SOURCE_RUN_ID: String(currentRunId) },
    logger: { log() {} },
  });
  assert.equal(unrelated.action, 'append');
  const resetState = repairStateFromBody(comments.get(88).at(-1).body);
  assert.equal(resetState.task.targetRequirementRef, `https://github.com/${REPOSITORY}/commit/${THIRD_SHA}`);
  assert.equal(resetState.task.candidateSha, THIRD_SHA);
  assert.equal(resetState.repair.generation, 1);
  assert.deepEqual(resetState.repair.attempts, []);
  assert.equal(resetState.diagnosis.rootCauseHypothesis, null);
  assert.equal(resetState.continuation.expectedCandidateSha, null);
});

test('late one-hop progress deterministically reconciles without rewinding a newer exact-run snapshot', () => {
  const firstIncident = incident({ pullRequest: 0 });
  const firstPlan = planRepairIssue({ incident: firstIncident });
  const strategyInputs = strategy();
  const strategyFingerprint = buildStrategyFingerprint(strategyInputs);
  const progressState = buildPublicRepairState({
    ...firstPlan.state,
    diagnosis: {
      version: 1,
      strategyFingerprint,
      failureClassification: strategyInputs.failureClass,
      rootCauseHypothesisKey: strategyInputs.rootCauseHypothesis,
      rootCauseHypothesis: 'The protected-main candidate bypasses the fixed command.',
      discriminatingAction: 'Run the fixed command against the exact linked candidate.',
    },
    repair: {
      generation: 1,
      attempts: [
        {
          number: 1,
          generation: 1,
          strategyFingerprint,
          rootCauseHypothesisKey: strategyInputs.rootCauseHypothesis,
          outcome: 'ineffective',
          candidateSha: HEAD_SHA,
        },
      ],
    },
    continuation: { status: 'waiting', triggers: ['new-candidate-head'], expectedCandidateSha: NEXT_SHA },
  });
  const issue = {
    number: 9,
    state: 'OPEN',
    author: { login: 'github-actions[bot]' },
    body: firstPlan.body,
  };
  const nextIncident = incident({
    pullRequest: 0,
    headSha: NEXT_SHA,
    workflowRunId: 303,
    workflowRunUrl: `https://github.com/${REPOSITORY}/actions/runs/303`,
  });
  const earlyNextPlan = planRepairIssue({ incident: nextIncident, issues: [issue] });
  assert.equal(earlyNextPlan.action, 'append');
  assert.equal(earlyNextPlan.state.task.targetRequirementRef, `https://github.com/${REPOSITORY}/commit/${NEXT_SHA}`);

  const nextComment = {
    user: { login: 'github-actions[bot]' },
    created_at: '2026-08-30T22:20:00Z',
    updated_at: '2026-08-30T22:20:00Z',
    body: earlyNextPlan.comment,
  };
  const lateProgressComment = {
    user: { login: 'github-actions[bot]' },
    created_at: '2026-08-30T22:21:00Z',
    updated_at: '2026-08-30T22:21:00Z',
    body: markedProgressState(progressState),
  };
  const reconciled = planRepairIssue({
    incident: nextIncident,
    issues: [issue],
    comments: [nextComment, lateProgressComment],
  });
  assert.equal(reconciled.action, 'reconcile');
  assert.equal(reconciled.reason, 'late-exact-candidate-handoff');
  assert.equal(reconciled.state.task.targetRequirementRef, `https://github.com/${REPOSITORY}/commit/${HEAD_SHA}`);
  assert.equal(reconciled.state.task.candidateSha, NEXT_SHA);
  assert.equal(reconciled.state.repair.attempts.length, 1);

  const reconciliationComment = {
    user: { login: 'github-actions[bot]' },
    created_at: '2026-08-30T22:22:00Z',
    updated_at: '2026-08-30T22:22:00Z',
    body: reconciled.comment,
  };
  const stable = planRepairIssue({
    incident: nextIncident,
    issues: [issue],
    comments: [nextComment, lateProgressComment, reconciliationComment],
  });
  assert.equal(stable.action, 'deduplicated');

  const inOrder = planRepairIssue({
    incident: nextIncident,
    issues: [issue],
    comments: [lateProgressComment],
  });
  assert.equal(inOrder.action, 'append');
  assert.equal(inOrder.state.task.targetRequirementRef, `https://github.com/${REPOSITORY}/commit/${HEAD_SHA}`);
  assert.equal(inOrder.state.repair.attempts.length, 1);
  const inOrderComment = {
    user: { login: 'github-actions[bot]' },
    created_at: '2026-08-30T22:22:00Z',
    updated_at: '2026-08-30T22:22:00Z',
    body: inOrder.comment,
  };
  const inOrderStable = planRepairIssue({
    incident: nextIncident,
    issues: [issue],
    comments: [lateProgressComment, inOrderComment],
  });
  assert.equal(inOrderStable.action, 'deduplicated');

  const firstProgressState = structuredClone(progressState);
  firstProgressState.repair.attempts[0].outcome = 'in-progress';
  const firstProgressComment = {
    user: { login: 'github-actions[bot]' },
    created_at: '2026-08-30T22:30:00Z',
    updated_at: '2026-08-30T22:30:00Z',
    body: markedProgressState(firstProgressState),
  };
  const nextCarryingFirstProgress = planRepairIssue({
    incident: nextIncident,
    issues: [issue],
    comments: [firstProgressComment],
  });
  assert.equal(nextCarryingFirstProgress.action, 'append');
  assert.equal(nextCarryingFirstProgress.state.repair.attempts[0].outcome, 'in-progress');
  const nextCarryingComment = {
    user: { login: 'github-actions[bot]' },
    created_at: '2026-08-30T22:31:00Z',
    updated_at: '2026-08-30T22:31:00Z',
    body: nextCarryingFirstProgress.comment,
  };
  const closingProgressComment = {
    user: { login: 'github-actions[bot]' },
    created_at: '2026-08-30T22:32:00Z',
    updated_at: '2026-08-30T22:32:00Z',
    body: markedProgressState(progressState),
  };
  const progressiveReconciliation = planRepairIssue({
    incident: nextIncident,
    issues: [issue],
    comments: [firstProgressComment, nextCarryingComment, closingProgressComment],
  });
  assert.equal(progressiveReconciliation.action, 'reconcile');
  assert.equal(progressiveReconciliation.state.repair.attempts[0].outcome, 'ineffective');

  const reverseOrderStable = planRepairIssue({
    incident: nextIncident,
    issues: [issue],
    comments: [closingProgressComment, inOrderComment, firstProgressComment],
  });
  assert.equal(reverseOrderStable.action, 'deduplicated');

  const conflictingTerminalState = structuredClone(progressState);
  conflictingTerminalState.repair.attempts[0].outcome = 'effective';
  const conflictingTerminalComment = {
    user: { login: 'github-actions[bot]' },
    created_at: '2026-08-30T22:33:00Z',
    updated_at: '2026-08-30T22:33:00Z',
    body: markedProgressState(conflictingTerminalState),
  };
  assert.throws(
    () =>
      planRepairIssue({
        incident: nextIncident,
        issues: [issue],
        comments: [closingProgressComment, conflictingTerminalComment, inOrderComment],
      }),
    /conflicting terminal outcomes/,
  );
});

test('batched next-generation progress cannot exceed the task-wide two-attempt strategy bound', async () => {
  const firstStrategy = strategy();
  const firstStrategyFingerprint = buildStrategyFingerprint(firstStrategy);
  const secondStrategy = strategy({
    rootCauseHypothesis: 'candidate-controlled-command-resolution',
    repairMechanism: 'pin-reviewed-package-command',
  });
  const secondStrategyFingerprint = buildStrategyFingerprint(secondStrategy);
  const initialPlan = planRepairIssue({ incident: incident() });
  const previousState = buildPublicRepairState({
    ...initialPlan.state,
    diagnosis: {
      version: 1,
      strategyFingerprint: secondStrategyFingerprint,
      failureClassification: secondStrategy.failureClass,
      rootCauseHypothesisKey: secondStrategy.rootCauseHypothesis,
      rootCauseHypothesis: 'The candidate-controlled command resolution selects the wrong validator.',
      discriminatingAction: 'Run the reviewed command without candidate-controlled resolution.',
    },
    repair: {
      generation: 1,
      attempts: [
        {
          number: 1,
          generation: 1,
          strategyFingerprint: firstStrategyFingerprint,
          outcome: 'ineffective',
          candidateSha: HEAD_SHA,
        },
        {
          number: 2,
          generation: 1,
          strategyFingerprint: secondStrategyFingerprint,
          outcome: 'ineffective',
          candidateSha: HEAD_SHA,
        },
        {
          number: 3,
          generation: 1,
          strategyFingerprint: secondStrategyFingerprint,
          outcome: 'ineffective',
          candidateSha: HEAD_SHA,
        },
      ],
      exhaustedStrategyFingerprints: [secondStrategyFingerprint],
    },
    continuation: { status: 'next-generation', triggers: ['next-repository-task'], blocker: null },
  });
  const issue = {
    number: 9,
    state: 'OPEN',
    author: { login: 'github-actions[bot]' },
    body: `${repairFingerprintMarker(initialPlan.state.fingerprint)}\n${markedRepairState(previousState)}`,
  };
  const appendedAttempt = (number) => ({
    number,
    generation: 2,
    strategyFingerprint: firstStrategyFingerprint,
    strategy: firstStrategy,
    outcome: 'ineffective',
    candidateSha: HEAD_SHA,
  });
  const progress = {
    schemaVersion: 1,
    repository: REPOSITORY,
    issueNumber: 9,
    sourceRunId: 101,
    candidateSha: HEAD_SHA,
    failureFingerprint: initialPlan.state.fingerprint,
    diagnosis: {
      version: 2,
      strategyFingerprint: firstStrategyFingerprint,
      failureClassification: firstStrategy.failureClass,
      rootCauseHypothesisKey: firstStrategy.rootCauseHypothesis,
      rootCauseHypothesis: 'The fixed validator command itself is bypassed.',
      discriminatingAction: 'Invoke the fixed validator without command resolution.',
    },
    repair: {
      generation: 2,
      attempts: [...previousState.repair.attempts, appendedAttempt(4), appendedAttempt(5)],
      exhaustedStrategyFingerprints: [secondStrategyFingerprint],
    },
    continuation: { status: 'waiting', triggers: ['next-repository-task'], blocker: null },
  };
  const api = {
    async getRun() {
      return run();
    },
    async getPullRequest() {
      return pullRequest();
    },
    async getJobs() {
      return [{ id: 202, name: 'backend and contracts', conclusion: 'failure' }];
    },
    async listRepairIssues() {
      return [issue];
    },
    async listIssueComments() {
      return [];
    },
    async ensureLabels() {
      throw new Error('rejected progress must not mutate labels');
    },
    async addLabels() {
      throw new Error('rejected progress must not mutate labels');
    },
    async commentIssue() {
      throw new Error('rejected progress must not append a snapshot');
    },
  };

  await assert.rejects(
    runRepairQueue({
      api,
      env: {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        SOURCE_RUN_ID: '101',
        REPAIR_PROGRESS_JSON: JSON.stringify(progress),
        DRY_RUN: 'false',
      },
      logger: { log() {} },
    }),
    /strategy-exhausted/,
  );

  const thirdStrategy = strategy({ rootCauseHypothesis: 'third-causal-hypothesis', repairMechanism: 'third-repair' });
  const thirdStrategyFingerprint = buildStrategyFingerprint(thirdStrategy);
  const atomicPreviousState = buildPublicRepairState({
    ...initialPlan.state,
    diagnosis: {
      version: 2,
      strategyFingerprint: firstStrategyFingerprint,
      failureClassification: firstStrategy.failureClass,
      rootCauseHypothesisKey: firstStrategy.rootCauseHypothesis,
      rootCauseHypothesis: 'The first causal hypothesis is being tested again in generation two.',
      discriminatingAction: 'Complete the exact generation-two attempt before admitting another.',
    },
    repair: {
      generation: 2,
      attempts: [
        {
          number: 1,
          generation: 1,
          strategyFingerprint: firstStrategyFingerprint,
          rootCauseHypothesisKey: firstStrategy.rootCauseHypothesis,
          outcome: 'ineffective',
          candidateSha: HEAD_SHA,
        },
        {
          number: 2,
          generation: 1,
          strategyFingerprint: secondStrategyFingerprint,
          rootCauseHypothesisKey: secondStrategy.rootCauseHypothesis,
          outcome: 'ineffective',
          candidateSha: HEAD_SHA,
        },
        {
          number: 3,
          generation: 1,
          strategyFingerprint: thirdStrategyFingerprint,
          rootCauseHypothesisKey: thirdStrategy.rootCauseHypothesis,
          outcome: 'ineffective',
          candidateSha: HEAD_SHA,
        },
        {
          number: 4,
          generation: 2,
          strategyFingerprint: firstStrategyFingerprint,
          rootCauseHypothesisKey: firstStrategy.rootCauseHypothesis,
          outcome: 'in-progress',
          candidateSha: HEAD_SHA,
        },
      ],
    },
  });
  const atomicIssue = {
    number: 10,
    state: 'OPEN',
    author: { login: 'github-actions[bot]' },
    body: `${repairFingerprintMarker(initialPlan.state.fingerprint)}\n${markedRepairState(atomicPreviousState)}`,
  };
  const atomicProgress = {
    ...progress,
    issueNumber: 10,
    diagnosis: atomicPreviousState.diagnosis,
    repair: {
      generation: 2,
      attempts: [
        ...atomicPreviousState.repair.attempts.slice(0, 3),
        { ...atomicPreviousState.repair.attempts[3], outcome: 'ineffective' },
        {
          number: 5,
          generation: 2,
          strategyFingerprint: firstStrategyFingerprint,
          strategy: firstStrategy,
          outcome: 'in-progress',
          candidateSha: HEAD_SHA,
        },
      ],
      exhaustedStrategyFingerprints: [],
      exhaustedRootCauseHypothesisKeys: [],
    },
  };
  await assert.rejects(
    runRepairQueue({
      api: {
        ...api,
        async listRepairIssues() {
          return [atomicIssue];
        },
      },
      env: {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        SOURCE_RUN_ID: '101',
        REPAIR_PROGRESS_JSON: JSON.stringify(atomicProgress),
        DRY_RUN: 'false',
      },
      logger: { log() {} },
    }),
    /strategy-exhausted/,
  );
});

test('workflow callback is bounded, trusted-main checked out, and cannot self-trigger', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/repair-triage.yml', import.meta.url), 'utf8');
  const prGate = readFileSync(new URL('../../.github/workflows/pr-gate.yml', import.meta.url), 'utf8');
  const deliveryDoc = readFileSync(new URL('../../docs/autonomous-delivery.md', import.meta.url), 'utf8');
  const workflowLines = workflow.split('\n');
  const repairProgressInputIndex = workflowLines.indexOf('      repair_progress_json:');
  assert.match(workflow, /^name: Repair and Learning Queue/m);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /retention-days: 30/);
  assert.notEqual(repairProgressInputIndex, -1);
  assert.deepEqual(workflowLines.slice(repairProgressInputIndex, repairProgressInputIndex + 4), [
    '      repair_progress_json:',
    '        description: Optional public-safe advisory repair progress bound to the exact source run.',
    '        required: false',
    '        type: string',
  ]);
  assert.match(workflow, /REPAIR_PROGRESS_JSON: \$\{\{ inputs\.repair_progress_json \}\}/);
  assert.equal(workflow.match(/inputs\.repair_progress_json/g)?.length, 1);
  assert.match(workflow, /group: repair-learning-\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /cancel-in-progress: false\n\s+queue: max/);
  assert.match(prGate, /! -name 'repair-triage\.yml' -print \| sort/);
  assert.match(prGate, /actionlint -shellcheck=shellcheck "\$\{workflow_files\[@\]\}"/);
  assert.match(
    prGate,
    /actionlint -shellcheck=shellcheck \\\n\s+-ignore '\^unexpected key "queue" for "concurrency" section\\\.' \\\n\s+\.github\/workflows\/repair-triage\.yml/,
  );
  assert.match(deliveryDoc, /retains at most 100 pending runs/);
  assert.match(
    deliveryDoc,
    /101st or later run canceled at that platform boundary is a visible incomplete continuation/,
  );
  assert.match(
    deliveryDoc,
    /gh workflow run repair-triage\.yml --repo JueZ\/api -f source_run_id=<exact-source-run-id> -f dry_run=false/,
  );
  assert.match(deliveryDoc, /without asking the owner to restate the requirement/);
  assert.match(deliveryDoc, /immutable source workflow run remains the evidence/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /cache:\s*false|npm ci/);
  assert.doesNotMatch(workflow, /Repair and Learning Queue\n\s+-/);
  assert.doesNotMatch(workflow, /secrets:\s*inherit|OPENAI_API_KEY|@codex/i);
});
