import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const setupScript = fileURLToPath(new URL('../setup-codex-env.sh', import.meta.url));
const maintainScript = fileURLToPath(new URL('../maintain-codex-env.sh', import.meta.url));

test('Codex Azure setup supports only explicit Managed Identity or service-principal modes', async () => {
  const source = await readFile(setupScript, 'utf8');
  assert.match(source, /CODEX_AZURE_AUTH_MODE:-managed-identity/);
  assert.match(source, /az login --identity/);
  assert.match(source, /--service-principal/);
  assert.match(source, /--password "\$\{CODEX_AZURE_CLIENT_SECRET\}"/);
  assert.match(source, /CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON/);
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

test('Codex Azure setup supports an explicitly selected, unexpired Cloud service principal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-azure-cloud-setup-'));
  const capturePath = join(directory, 'service-principal.txt');
  try {
    const command = [
      'source "$SETUP_SCRIPT"',
      'az() {',
      '  local sanitized="$*"',
      '  sanitized="${sanitized//cloud-client-secret/[redacted]}"',
      '  printf \'%s\\n\' "$sanitized" >> "$CAPTURE_PATH"',
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
        CODEX_AZURE_AUTH_MODE: 'service-principal',
        CODEX_AZURE_CLIENT_ID: 'cloud-client-id',
        CODEX_AZURE_CLIENT_SECRET: 'cloud-client-secret',
        CODEX_AZURE_TENANT_ID: 'cloud-tenant-id',
        CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON: '2099-12-31',
      },
    });

    assert.equal(completed.status, 0, completed.stderr);
    assert.doesNotMatch(`${completed.stdout}\n${completed.stderr}`, /cloud-client-secret/);
    assert.deepEqual((await readFile(capturePath, 'utf8')).trim().split('\n'), [
      'login --service-principal --username cloud-client-id --password [redacted] --tenant cloud-tenant-id --output none',
      'account set --subscription 00000000-0000-0000-0000-000000000000',
      'account show --query {name:name, id:id, tenantId:tenantId} --output table',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex Azure setup rejects an expired Cloud service-principal credential before login', () => {
  const command = ['source "$SETUP_SCRIPT"', 'az() { return 97; }', 'login_azure'].join('\n');
  const completed = spawnSync('bash', ['-c', command], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SETUP_SCRIPT: setupScript,
      AZURE_SUBSCRIPTION_ID: '00000000-0000-0000-0000-000000000000',
      CODEX_AZURE_AUTH_MODE: 'service-principal',
      CODEX_AZURE_CLIENT_ID: 'cloud-client-id',
      CODEX_AZURE_CLIENT_SECRET: 'cloud-client-secret',
      CODEX_AZURE_TENANT_ID: 'cloud-tenant-id',
      CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON: '2000-01-01',
    },
  });

  assert.equal(completed.status, 1);
  assert.match(completed.stderr, /client secret is expired/);
  assert.doesNotMatch(`${completed.stdout}\n${completed.stderr}`, /cloud-client-secret/);
});

test('Codex Azure setup bypasses proxies for IMDS without duplicating the endpoint', () => {
  const command = [
    'source "$SETUP_SCRIPT"',
    'NO_PROXY="localhost,169.254.169.254"',
    'no_proxy="localhost"',
    'configure_azure_imds_proxy_bypass',
    'configure_azure_imds_proxy_bypass',
    'printf \'%s\\n%s\\n\' "$NO_PROXY" "$no_proxy"',
  ].join('\n');
  const completed = spawnSync('bash', ['-c', command], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SETUP_SCRIPT: setupScript,
    },
  });

  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.stdout, 'localhost,169.254.169.254\nlocalhost,169.254.169.254\n');
});

test('Codex environment scripts never print an existing Git remote URL', async () => {
  for (const path of [setupScript, maintainScript]) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /echo[^\n]*remote get-url origin/);
    assert.match(source, /Git remote 'origin' is already configured\./);
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
    '  if [[ "$1" == "login" ]]; then',
    '    case ",${NO_PROXY:-}," in *,169.254.169.254,*) ;; *) return 95 ;; esac',
    '    case ",${no_proxy:-}," in *,169.254.169.254,*) ;; *) return 96 ;; esac',
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
      CODEX_AZURE_AUTH_MODE: 'managed-identity',
      CODEX_AZURE_CLIENT_SECRET: 'must-not-reach-child-processes',
      ...(managedIdentityClientId === 'system'
        ? {}
        : { CODEX_AZURE_MANAGED_IDENTITY_CLIENT_ID: managedIdentityClientId }),
    },
  });
  assert.equal(completed.status, 0, completed.stderr);
  return (await readFile(capturePath, 'utf8')).trim().split('\n');
}
