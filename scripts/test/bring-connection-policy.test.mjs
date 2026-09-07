import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import * as connectionModule from '../../apps/api/dist/application/providerConnections/bring.js';
import { validateBringConnectionPolicy } from '../validate-bring-connection-policy.mjs';

const grant = {
  connectionId: 'operator',
  principal: {
    tokenType: 'user',
    tenantId: '11111111-1111-4111-8111-111111111111',
    objectId: '00000000-0000-0000-1234-abcdefabcdef',
  },
};
const policy = (grants) => JSON.stringify({ version: 1, grants });

test('deployment preflight accepts explicit operator grants using the actual package parser', () => {
  assert.deepEqual(
    validateBringConnectionPolicy(connectionModule, {
      BRING_ENABLED: 'true',
      BRING_CONNECTION_GRANTS: policy([grant]),
    }),
    { status: 'passed', grantCount: 1 },
  );
});

test('missing, malformed, wildcard or unbound policy fails before deployment mutation', () => {
  for (const value of [
    undefined,
    '',
    '{}',
    policy([]),
    policy([grant, grant]),
    policy([{ ...grant, connectionId: 'unknown' }]),
    policy([{ ...grant, principal: { ...grant.principal, objectId: '*' } }]),
  ]) {
    assert.throws(() =>
      validateBringConnectionPolicy(connectionModule, {
        BRING_ENABLED: 'true',
        BRING_CONNECTION_GRANTS: value,
      }),
    );
  }
});

test('disabled Bring needs no connection module while malformed enablement cannot skip preflight', () => {
  assert.deepEqual(validateBringConnectionPolicy(undefined, { BRING_ENABLED: 'false' }), { status: 'not_applicable' });
  assert.throws(() => validateBringConnectionPolicy(undefined, { BRING_ENABLED: 'enabled' }));
});

test('delivery validates the candidate connection policy before its first mutation and wires the exact setting', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/deploy-environment.yml', import.meta.url), 'utf8'),
  );
  const job = workflow.jobs.deploy;
  assert.equal(job.env.BRING_CONNECTION_GRANTS, '${{ vars.BRING_CONNECTION_GRANTS }}');
  const preflight = job.steps.findIndex((step) => step.id === 'identity_preflight');
  const firstWrite = job.steps.findIndex((step) => step.id === 'mutation_intent');
  assert.ok(preflight >= 0 && preflight < firstWrite);
  assert.match(job.steps[preflight].run, /validate-bring-connection-policy\.mjs/);
  assert.match(job.steps[preflight].run, /\$auth_dir\/dist\/application\/providerConnections\/bring\.js/);
  assert.match(job.steps[preflight].run, /if \[ "\$ALLOW_ROLLBACK" != "true" \]/);
  assert.match(job.steps[preflight].run, /\[ ! -f "\$auth_dir\/dist\/application\/providerConnections\/bring.js" \]/);
  const runtime = job.steps.find((step) => step.id === 'runtime_policy').run;
  assert.match(runtime, /\[ "\$ALLOW_ROLLBACK" = "true" \]/);
  assert.match(runtime, /inputs.reconcileConfiguration/);
  assert.match(runtime, /steps.identity_preflight.outputs.legacy_bring_policy/);
  assert.match(runtime, /--allow-legacy-bring-policy/);
  assert.match(
    job.steps.find((step) => step.id === 'infra').run,
    /bringConnectionGrants="\$\{BRING_CONNECTION_GRANTS:-\}"/,
  );
});
