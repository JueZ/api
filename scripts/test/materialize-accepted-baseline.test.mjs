import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { materializeAcceptedBaseline } from '../materialize-accepted-baseline.mjs';

const execFileAsync = promisify(execFile);
const materializeScript = fileURLToPath(new URL('../materialize-accepted-baseline.mjs', import.meta.url));
const sourceRef = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const releaseRunId = 101;
const releaseCorrelation = 'prod-101-abcdefgh';
const acceptanceRunId = 202;
const acceptanceCorrelation = 'recovery-202-abcdefgh';
const acceptedCoordinates = {
  sourceRef,
  runId: String(releaseRunId),
  correlation: releaseCorrelation,
  acceptanceRunId: String(acceptanceRunId),
  acceptanceCorrelation,
};

const releaseFiles = {
  'frontend.tar.gz': Buffer.from('frontend archive'),
  'functionapp.zip': Buffer.from('function archive'),
  'release-manifest.json': Buffer.from('{"schemaVersion":1}'),
  'sbom.cdx.json': Buffer.from('{"bomFormat":"CycloneDX"}'),
};
const ledgerBytes = Buffer.from('{"environment":"prod"}');
function baseline(overrides = {}) {
  const value = {
    schemaVersion: 1,
    status: 'accepted',
    sourceRef,
    runId: releaseRunId,
    correlation: releaseCorrelation,
    acceptanceRunId,
    acceptanceCorrelation,
    acceptanceKind: 'recovery',
    releaseArtifactName: `production-release-${sourceRef}-${releaseCorrelation}`,
    ledgerArtifactName: `release-ledger-prod-${sourceRef}-${acceptanceCorrelation}`,
    ...overrides,
  };
  return Buffer.from(JSON.stringify(value));
}

test('materializes a complete accepted transfer by copying every exact filesystem byte', async (context) => {
  const fixture = await createFixture(context, { bundled: true });

  assert.deepEqual(
    await materializeAcceptedBaseline({ transferDirectory: fixture.transfer, outputDirectory: fixture.output }),
    { bundled: true, ...acceptedCoordinates },
  );
  assert.deepEqual((await readdir(fixture.output)).sort(), [
    'accepted-baseline',
    'accepted-ledger',
    'accepted-release',
  ]);
  assert.deepEqual(
    await readFile(join(fixture.output, 'accepted-baseline', 'accepted-baseline.json')),
    fixture.baselineBytes,
  );
  for (const [file, bytes] of Object.entries(releaseFiles)) {
    assert.deepEqual(await readFile(join(fixture.output, 'accepted-release', file)), bytes);
  }
  assert.deepEqual(await readFile(join(fixture.output, 'accepted-ledger', 'release-ledger-prod.json')), ledgerBytes);
});

test('materializes a legacy identity-only transfer without inventing release bytes', async (context) => {
  const fixture = await createFixture(context, { bundled: false });

  assert.deepEqual(
    await materializeAcceptedBaseline({ transferDirectory: fixture.transfer, outputDirectory: fixture.output }),
    { bundled: false, ...acceptedCoordinates },
  );
  assert.deepEqual((await readdir(fixture.output)).sort(), ['accepted-baseline']);
  assert.deepEqual(
    await readFile(join(fixture.output, 'accepted-baseline', 'accepted-baseline.json')),
    fixture.baselineBytes,
  );
});

test('preserves original release coordinates while accepting a later recovery ledger', async (context) => {
  const fixture = await createFixture(context, { bundled: true });

  const result = await materializeAcceptedBaseline({
    transferDirectory: fixture.transfer,
    outputDirectory: fixture.output,
  });

  assert.deepEqual(result, { bundled: true, ...acceptedCoordinates });
  assert.notEqual(result.runId, result.acceptanceRunId);
  assert.notEqual(result.correlation, result.acceptanceCorrelation);
});

test('rejects invalid accepted coordinates and artifact names before any output write', async (context) => {
  const cases = [
    ['missing sourceRef', { sourceRef: undefined }],
    ['missing release run id', { runId: undefined }],
    ['missing release correlation', { correlation: undefined }],
    ['missing acceptance run id', { acceptanceRunId: undefined }],
    ['missing acceptance correlation', { acceptanceCorrelation: undefined }],
    ['malformed sourceRef', { sourceRef: 'not-a-sha' }],
    ['malformed run id', { runId: 'not-a-run-id' }],
    ['malformed correlation', { correlation: 'bad correlation' }],
    ['malformed acceptance run id', { acceptanceRunId: 'not-a-run-id' }],
    ['malformed acceptance correlation', { acceptanceCorrelation: 'bad correlation' }],
    ['line break in sourceRef', { sourceRef: `${sourceRef}\nextra` }],
    ['line break in run id', { runId: '101\nextra' }],
    ['line break in correlation', { correlation: `${releaseCorrelation}\nextra` }],
    ['line break in acceptance run id', { acceptanceRunId: '202\nextra' }],
    ['line break in acceptance correlation', { acceptanceCorrelation: `${acceptanceCorrelation}\nextra` }],
    ['trailing newline in sourceRef', { sourceRef: `${sourceRef}\n` }],
    ['trailing newline in run id', { runId: '101\n' }],
    ['trailing newline in correlation', { correlation: `${releaseCorrelation}\n` }],
    ['trailing newline in acceptance run id', { acceptanceRunId: '202\n' }],
    ['trailing newline in acceptance correlation', { acceptanceCorrelation: `${acceptanceCorrelation}\n` }],
    ['release artifact mismatch', { releaseArtifactName: `production-release-${sourceRef}-${acceptanceCorrelation}` }],
    ['ledger artifact mismatch', { ledgerArtifactName: `release-ledger-prod-${sourceRef}-${releaseCorrelation}` }],
  ];

  for (const [name, overrides] of cases) {
    const fixture = await createFixture(context, { bundled: true, baselineOverrides: overrides });
    await assert.rejects(
      materializeAcceptedBaseline({ transferDirectory: fixture.transfer, outputDirectory: fixture.output }),
      /accepted|coordinate|artifact|baseline/i,
      name,
    );
    assert.deepEqual(await readdir(fixture.output), [], `${name} wrote output before rejection`);
  }
});

test('CLI emits validated accepted coordinates to GitHub output and environment files', async (context) => {
  const fixture = await createFixture(context, { bundled: true, cliLayout: true });
  const githubOutput = join(fixture.root, 'github-output');
  const githubEnv = join(fixture.root, 'github-env');
  await writeFile(githubOutput, '');
  await writeFile(githubEnv, '');

  await execFileAsync(
    process.execPath,
    [materializeScript, '--transfer', fixture.transfer, '--output', fixture.output, '--github-output', githubOutput],
    { env: { ...process.env, RUNNER_TEMP: fixture.output, GITHUB_ENV: githubEnv } },
  );

  assert.equal(
    await readFile(githubOutput, 'utf8'),
    [
      'bundled=true',
      `accepted_source_ref=${sourceRef}`,
      `accepted_release_run_id=${releaseRunId}`,
      `accepted_release_correlation=${releaseCorrelation}`,
      `accepted_ledger_run_id=${acceptanceRunId}`,
      `accepted_ledger_correlation=${acceptanceCorrelation}`,
      '',
    ].join('\n'),
  );
  assert.equal(
    await readFile(githubEnv, 'utf8'),
    [
      `ACCEPTED_SOURCE_REF=${sourceRef}`,
      `ACCEPTED_RELEASE_RUN_ID=${releaseRunId}`,
      `ACCEPTED_RELEASE_CORRELATION=${releaseCorrelation}`,
      `ACCEPTED_LEDGER_RUN_ID=${acceptanceRunId}`,
      `ACCEPTED_LEDGER_CORRELATION=${acceptanceCorrelation}`,
      '',
    ].join('\n'),
  );
});

test('CLI refuses staging when GITHUB_ENV is unavailable', async (context) => {
  const fixture = await createFixture(context, { bundled: true, cliLayout: true });
  const githubOutput = join(fixture.root, 'github-output');
  await writeFile(githubOutput, 'preserve me\n');
  const environment = { ...process.env, RUNNER_TEMP: fixture.output };
  delete environment.GITHUB_ENV;
  const error = await execFileAsync(
    process.execPath,
    [materializeScript, '--transfer', fixture.transfer, '--output', fixture.output, '--github-output', githubOutput],
    { env: environment },
  ).then(
    () => assert.fail('CLI accepted a missing GITHUB_ENV'),
    (reason) => reason,
  );
  assert.match(error.stderr, /Invalid baseline staging arguments/);
  assert.equal(await readFile(githubOutput, 'utf8'), 'preserve me\n');
  assert.deepEqual(await readdir(fixture.output), ['accepted-transfer']);
});

test('missing, extra, or substituted transfer directories fail before any output write', async (context) => {
  const cases = [
    {
      name: 'missing ledger directory',
      mutate: async (transfer) => rm(join(transfer, 'ledger'), { recursive: true, force: true }),
    },
    {
      name: 'unexpected top-level entry',
      mutate: async (transfer) => writeFile(join(transfer, 'unexpected'), 'extra'),
    },
    {
      name: 'release directory replaced by a regular file',
      mutate: async (transfer) => {
        await rm(join(transfer, 'release'), { recursive: true, force: true });
        await writeFile(join(transfer, 'release'), 'not a directory');
      },
    },
    {
      name: 'unexpected release entry',
      mutate: async (transfer) => writeFile(join(transfer, 'release', 'unexpected'), 'extra'),
    },
  ];

  for (const scenario of cases) {
    const fixture = await createFixture(context, { bundled: true });
    await scenario.mutate(fixture.transfer);
    await assert.rejects(
      materializeAcceptedBaseline({ transferDirectory: fixture.transfer, outputDirectory: fixture.output }),
      /Baseline transfer (?:directory|layout) is invalid/,
      scenario.name,
    );
    assert.deepEqual(await readdir(fixture.output), [], `${scenario.name} wrote output before rejection`);
  }
});

test('a Windows directory junction in the transfer is rejected before any output write', async (context) => {
  const fixture = await createFixture(context, { bundled: true });
  const target = join(fixture.root, 'release-target');
  await mkdir(target);
  for (const [file, bytes] of Object.entries(releaseFiles)) await writeFile(join(target, file), bytes);
  await rm(join(fixture.transfer, 'release'), { recursive: true, force: true });
  try {
    await symlink(target, join(fixture.transfer, 'release'), 'junction');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES')
      return context.skip('directory junctions are unavailable to this user');
    throw error;
  }

  await assert.rejects(
    materializeAcceptedBaseline({ transferDirectory: fixture.transfer, outputDirectory: fixture.output }),
    /Baseline transfer directory is invalid/,
  );
  assert.deepEqual(await readdir(fixture.output), []);
});

test('an existing destination is refused without replacing its contents', async (context) => {
  const fixture = await createFixture(context, { bundled: true });
  const destination = join(fixture.output, 'accepted-baseline');
  await mkdir(destination);
  await writeFile(join(destination, 'existing.json'), 'preserve me');

  await assert.rejects(
    materializeAcceptedBaseline({ transferDirectory: fixture.transfer, outputDirectory: fixture.output }),
    /EEXIST/,
  );
  assert.deepEqual(await readFile(join(destination, 'existing.json'), 'utf8'), 'preserve me');
  assert.equal(await exists(join(fixture.output, 'accepted-release')), false);
  assert.equal(await exists(join(fixture.output, 'accepted-ledger')), false);
});

async function createFixture(context, { bundled, baselineOverrides, cliLayout = false }) {
  const root = await mkdtemp(join(tmpdir(), 'materialize-accepted-baseline-'));
  const output = cliLayout ? join(root, 'runner') : join(root, 'output');
  const transfer = cliLayout ? join(output, 'accepted-transfer') : join(root, 'transfer');
  await mkdir(output);
  await mkdir(transfer);
  const baselineBytes = baseline(baselineOverrides);
  await writeFile(join(transfer, 'accepted-baseline.json'), baselineBytes);
  if (bundled) {
    await mkdir(join(transfer, 'release'));
    await mkdir(join(transfer, 'ledger'));
    for (const [file, bytes] of Object.entries(releaseFiles)) await writeFile(join(transfer, 'release', file), bytes);
    await writeFile(join(transfer, 'ledger', 'release-ledger-prod.json'), ledgerBytes);
  }
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, transfer, output, baselineBytes };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
