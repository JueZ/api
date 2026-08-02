import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const setupScript = fileURLToPath(new URL('../setup-codex-env.sh', import.meta.url));

test('Codex Azure setup has no service-principal secret argument path', async () => {
  const source = await readFile(setupScript, 'utf8');
  assert.doesNotMatch(source, /--service-principal|--password/);
  assert.doesNotMatch(source, /\$\{?CODEX_AZURE_CLIENT_SECRET/);
  assert.match(source, /az login --identity/);
});

test('Codex Azure setup selects system or user-assigned managed identity without inheriting legacy secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-azure-setup-'));
  try {
    const systemCalls = await captureAzureLogin(directory, 'system');
    assert.deepEqual(systemCalls, [
      'login --identity --output none',
      'account set --subscription 00000000-0000-0000-0000-000000000000',
      'account show --query {name:name, id:id, tenantId:tenantId} --output table',
    ]);

    const userAssignedCalls = await captureAzureLogin(directory, 'user-assigned-client-id');
    assert.deepEqual(userAssignedCalls, [
      'login --identity --client-id user-assigned-client-id --output none',
      'account set --subscription 00000000-0000-0000-0000-000000000000',
      'account show --query {name:name, id:id, tenantId:tenantId} --output table',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function captureAzureLogin(directory, managedIdentityClientId) {
  const capturePath = join(directory, `${managedIdentityClientId}.txt`);
  const command = [
    'source "$SETUP_SCRIPT"',
    'az() {',
    '  if [[ -n "${CODEX_AZURE_CLIENT_SECRET:-}" ]]; then',
    '    return 97',
    '  fi',
    '  printf \'%s\\n\' "$*" >> "$CAPTURE_PATH"',
    '}',
    'login_azure',
  ].join('\n');
  const completed = spawnSync('bash', ['-c', command], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SETUP_SCRIPT: setupScript,
      CAPTURE_PATH: capturePath,
      AZURE_SUBSCRIPTION_ID: '00000000-0000-0000-0000-000000000000',
      CODEX_AZURE_CLIENT_SECRET: 'must-not-reach-child-processes',
      ...(managedIdentityClientId === 'system'
        ? {}
        : { CODEX_AZURE_MANAGED_IDENTITY_CLIENT_ID: managedIdentityClientId }),
    },
  });
  assert.equal(completed.status, 0, completed.stderr);
  return (await readFile(capturePath, 'utf8')).trim().split('\n');
}
