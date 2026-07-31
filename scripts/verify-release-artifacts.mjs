#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const expectedArtifacts = {
  functionapp: 'functionapp.zip',
  frontend: 'frontend.tar.gz',
  sbom: 'sbom.cdx.json',
};

export async function verifyReleaseArtifacts(directory, expectedSourceRef) {
  const manifestPath = resolve(directory, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const errors = [];

  if (manifest.schemaVersion !== 1) errors.push('release manifest schemaVersion must be 1');
  if (manifest.sourceRef !== expectedSourceRef.toLowerCase()) {
    errors.push('release manifest sourceRef does not match the deployment source');
  }

  const artifactNames = Object.keys(manifest.artifacts ?? {});
  for (const unexpected of artifactNames.filter((name) => !(name in expectedArtifacts))) {
    errors.push(`unexpected artifact: ${unexpected}`);
  }

  for (const [name, expectedFile] of Object.entries(expectedArtifacts)) {
    const artifact = manifest.artifacts?.[name];
    if (!artifact) {
      errors.push(`missing required artifact: ${name}`);
      continue;
    }
    if (!artifact?.file || !/^[0-9a-f]{64}$/.test(artifact?.sha256 ?? '')) {
      errors.push(`${name} artifact metadata is invalid`);
      continue;
    }
    if (artifact.file !== expectedFile) {
      errors.push(`${name} artifact filename is invalid`);
      continue;
    }
    const artifactPath = resolve(directory, expectedFile);
    let bytes;
    try {
      const stats = await lstat(artifactPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        errors.push(`${name} artifact must be a regular file`);
        continue;
      }
      bytes = await readFile(artifactPath);
    } catch {
      errors.push(`${name} artifact is missing or unreadable`);
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== artifact.sha256) errors.push(`${name} artifact digest does not match`);
  }

  return { ok: errors.length === 0, errors, manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.argv[2];
  const expectedSourceRef = process.argv[3];
  if (!directory || !/^[0-9a-f]{40}$/i.test(expectedSourceRef ?? '')) {
    console.error('Usage: node scripts/verify-release-artifacts.mjs <directory> <40-char-source-sha>');
    process.exit(2);
  }
  const result = await verifyReleaseArtifacts(directory, expectedSourceRef);
  if (!result.ok) {
    console.error(result.errors.join('\n'));
    process.exit(1);
  }
  console.log(JSON.stringify(result.manifest, null, 2));
}
