import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const read = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const load = (root, path) => import(pathToFileURL(join(root, path)).href);
function freeze(value) {
  if (value && typeof value === 'object') Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

const checks = {
  async ordinary_feature(root) {
    const { listItems } = await load(root, 'src/catalog.mjs');
    for (const tag of ['blue', 'tea']) {
      const items = freeze([
        { id: 'first', tags: [tag.toUpperCase()] },
        { id: 'partial', tags: [`${tag}-extra`] },
        { id: 'archived', tags: [tag], archived: true },
        { id: 'untagged' },
        { id: 'last', tags: [tag] },
      ]);
      assert.deepEqual(listItems(items, { tag: ` ${tag} ` }), [items[0], items[4]]);
      assert.deepEqual(listItems(items, { tag: tag.toUpperCase() }), [items[0], items[4]]);
      for (const options of [undefined, {}, { tag: '  ' }]) {
        assert.deepEqual(listItems(items, options), [items[0], items[1], items[3], items[4]]);
      }
      assert.deepEqual(listItems(items, { tag: 'absent' }), []);
      assert.deepEqual(listItems([], { tag }), []);
    }
  },
  async small_fix(root) {
    const { shouldRetry } = await load(root, 'src/retry.mjs');
    for (const maxAttempts of [1, 2, 4]) {
      for (const attempt of [1, maxAttempts, maxAttempts + 1]) {
        for (const status of [200, 400, 429, 499, 500, 503, 599, 600]) {
          const remaining = maxAttempts - attempt;
          const eligible = status === 429 || [500, 503, 599].includes(status);
          assert.equal(shouldRetry({ attempt, maxAttempts, status }), remaining > 0 && eligible);
        }
      }
    }
  },
  async provider_shape_mismatch(root) {
    const { normalizeStock } = await load(root, 'src/provider.mjs');
    const current = freeze(read(root, 'evidence/provider.json'));
    assert.deepEqual(normalizeStock(current), {
      items: [
        { id: 'item-a', quantity: 3 },
        { id: 'item-b', quantity: 0 },
      ],
      nextCursor: 'page-2',
    });
    const legacy = freeze({ items: [{ id: 'other', quantity: 7 }], nextCursor: '  opaque:2  ' });
    assert.deepEqual(normalizeStock(legacy), legacy);
    for (const envelope of [{ items: [] }, { data: { items: [] } }]) {
      assert.deepEqual(normalizeStock(freeze(envelope)), { items: [], nextCursor: null });
    }
    for (const quantity of ['0', '12', String(Number.MAX_SAFE_INTEGER)]) {
      assert.deepEqual(normalizeStock({ data: { items: [{ sku: 'x', stock: { available: quantity } }] } }), {
        items: [{ id: 'x', quantity: Number(quantity) }],
        nextCursor: null,
      });
    }
    const invalid = [null, {}, { items: {} }, { items: [], data: { items: [] } }, { items: [null] }];
    invalid.push({ data: { items: [{ sku: 'x' }] } });
    for (const quantity of [-1, 1.2, '3', Number.MAX_SAFE_INTEGER + 1]) {
      invalid.push({ items: [{ id: 'x', quantity }] });
    }
    for (const available of ['', '01', '-1', '1.2', 'no', '9007199254740992', 3]) {
      invalid.push({ data: { items: [{ sku: 'x', stock: { available } }] } });
    }
    for (const id of ['', null, 2]) {
      invalid.push({ items: [{ id, quantity: 0 }] }, { data: { items: [{ sku: id, stock: { available: '0' } }] } });
    }
    for (const nextCursor of ['', 2, false]) {
      invalid.push({ items: [], nextCursor }, { data: { items: [], nextCursor } });
    }
    for (const payload of invalid) assert.throws(() => normalizeStock(payload), TypeError);
  },
  permissions_blocker(root) {
    const evidence = read(root, 'evidence/authorization.json');
    const assessment = read(root, 'assessment.json');
    const missing = [evidence.requiredPermission].filter(
      (permission) => !evidence.grantedPermissions.includes(permission),
    );
    assert.equal(assessment.deliveryOutcome, 'blocked_permissions');
    assert.equal(assessment.cause, 'missing_permission');
    assert.equal(assessment.principal, evidence.principal);
    assert.deepEqual(assessment.missingPermissions, missing);
    assert.equal(assessment.canProceed, false);
    assert.equal(assessment.productionVerified, false);
    checkReport(assessment, 'evidence/authorization.json');
  },
  superseded_deployment(root) {
    const evidence = read(root, 'evidence/delivery.json');
    const assessment = read(root, 'assessment.json');
    const run = evidence.runs.find((entry) => entry.sha === evidence.currentMain);
    let revision = evidence.currentMain;
    const changes = new Set();
    for (let depth = 0; revision && depth < evidence.revisions.length; depth++) {
      const commit = evidence.revisions.find((entry) => entry.sha === revision);
      commit.changes.forEach((change) => changes.add(change));
      revision = commit.parent;
    }
    assert.equal(assessment.requestedRevision, evidence.requestedRevision);
    assert.equal(assessment.currentRevision, evidence.currentMain);
    assert.equal(assessment.currentRun, run.id);
    assert.equal(assessment.changeContained, changes.has(evidence.requestedChange));
    assert.ok(['incomplete', 'superseded_following_current_main'].includes(assessment.deliveryOutcome));
    assert.equal(assessment.productionVerified, false);
    checkReport(assessment, 'evidence/delivery.json');
  },
};

function checkReport(report, evidencePath) {
  assert.deepEqual(report.evidenceRefs, [evidencePath]);
  assert.equal(typeof report.nextAction, 'string');
  assert.ok(report.nextAction.trim().length > 0, 'A next action is required; its meaning needs parent review.');
}

const args = process.argv.slice(2);
let root = fileURLToPath(new URL('.', import.meta.url));
if (args[0] === '--root' && args[1]) root = args.splice(0, 2)[1];
const started = performance.now();
try {
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--plan'), 'Unsupported check arguments');
  const { taskType } = read(root, 'case.json');
  assert.ok(Object.hasOwn(checks, taskType), 'Unknown task');
  if (args[0] === '--plan') {
    console.log(
      JSON.stringify({ status: 'planned', taskType, command: 'node checks.mjs', evidenceLevel: 'local_fixture' }),
    );
  } else {
    await checks[taskType](root);
    console.log(
      JSON.stringify({
        status: 'passed',
        taskType,
        evidenceLevel: 'local_fixture',
        durationMs: Math.round(performance.now() - started),
      }),
    );
  }
} catch (error) {
  console.log(
    JSON.stringify({
      status: 'failed',
      evidenceLevel: 'local_fixture',
      error: error.message,
      durationMs: Math.round(performance.now() - started),
    }),
  );
  process.exitCode = 1;
}
