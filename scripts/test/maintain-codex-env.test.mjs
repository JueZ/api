import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../maintain-codex-env.sh', import.meta.url));
const harness = `
source "$MAINTAIN_SCRIPT"
repaired=false
node() { printf '%s\\n' "\${NODE_VERSION:-v22.23.2}"; }
npm() { echo 10.9.8; }
git() {
  case "$*" in
    --version) echo 'git version 2.50.0' ;;
    'rev-parse --show-toplevel') echo /checkout ;;
    '-C /checkout remote get-url origin'|'remote get-url origin') printf '%s\\n' "\${ORIGIN:-https://github.com/JueZ/api.git}" ;;
    *) echo 'Unexpected git mutation' >&2; return 96 ;;
  esac
}
az() {
  case "$1 $2" in
    'version --query')
      if [[ "$CASE" == azure-broken && "$repaired" == false ]]; then return 1; fi
      echo 2.80.0 ;;
    'account show')
      echo AZURE_AUTH
      [[ "$CASE" != auth-expired ]] ;;
    'account get-access-token'|'rest --help') return 0 ;;
    *) echo 'Unexpected Azure operation' >&2; return 96 ;;
  esac
}
gh() {
  case "$1 \${2:-}" in
    '--version ')
      if [[ "$CASE" == github-missing && "$repaired" == false ]]; then return 127; fi
      echo 'gh version 2.80.0 (2026-01-01)' ;;
    'pr merge')
      if [[ "$CASE" == github-incompatible && "$repaired" == false ]]; then echo '--auto --squash'; else echo '--auto --squash --match-head-commit'; fi ;;
    'run view') return 0 ;;
    'auth status') [[ -z "\${GH_TOKEN:-}" && -z "\${GITHUB_TOKEN:-}" ]] && echo GITHUB_AUTH ;;
    *) echo 'Unexpected GitHub operation' >&2; return 96 ;;
  esac
}
install_tools() {
  echo "INSTALL:$*"
  if [[ "$CASE" != repair-ineffective ]]; then repaired=true; fi
}
if [[ "$CASE" == repair-ineffective ]]; then azure_tool_healthy() { return 1; }; fi
if [[ "$CASE" == upgrade ]]; then maintain --upgrade-tools; else maintain; fi
`;

function run(scenario, environment = {}) {
  return spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      MAINTAIN_SCRIPT: script,
      CASE: scenario,
      GH_TOKEN: 'must-be-cleared',
      GITHUB_TOKEN: 'must-be-cleared',
      ...environment,
    },
  });
}

test('healthy cached startup verifies capabilities, persisted authentication and remote without installing', () => {
  const result = run('healthy');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AZURE_AUTH/);
  assert.match(result.stdout, /GITHUB_AUTH/);
  assert.match(result.stdout, /maintenance complete/);
  assert.doesNotMatch(result.stdout, /INSTALL:|must-be-cleared/);
});

for (const [scenario, selection] of [
  ['azure-broken', 'azure-cli'],
  ['github-missing', 'gh'],
  ['github-incompatible', 'gh'],
]) {
  test(`${scenario} repairs only the failing CLI and rechecks its capabilities`, () => {
    const result = run(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.match(/INSTALL:.*/g), [`INSTALL:--reinstall ${selection}`]);
    assert.match(result.stdout, /maintenance complete/);
  });
}

test('expired authentication fails without installation or implicit login', () => {
  const result = run('auth-expired');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /INSTALL:|GITHUB_AUTH|maintenance complete/);
});

test('an explicit upgrade updates both tools without unconditional reinstall', () => {
  const result = run('upgrade');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.match(/INSTALL:.*/g), ['INSTALL:azure-cli gh']);
});

test('an ineffective package repair stops before authentication or successful completion', () => {
  const result = run('repair-ineffective');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /capability verification failed/);
  assert.doesNotMatch(result.stdout, /AZURE_AUTH|maintenance complete/);
});

test('a mismatched remote is preserved and its potentially sensitive URL is never printed', () => {
  const result = run('healthy', { ORIGIN: 'https://private-token@github.com/unrelated/repo.git' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /origin does not match/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-token|unrelated|maintenance complete/);
});

test('an incompatible host Node version stops without attempting unrelated APT repair', () => {
  const result = run('healthy', { NODE_VERSION: 'v24.0.0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Select Node.js 22/);
  assert.doesNotMatch(result.stdout, /INSTALL:|AZURE_AUTH|maintenance complete/);
});
