#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const roots = ['function-releases/functionapp-', 'function-releases/accepted/'];
const DAY = 24 * 60 * 60 * 1000;

export function buildReleaseRetentionPolicy({ functionDigests, controllerRefs }) {
  for (const [values, length] of [
    [functionDigests, 64],
    [controllerRefs, 40],
  ]) {
    if (
      !Array.isArray(values) ||
      values.length < 1 ||
      values.length > 2 ||
      values.some((value) => !new RegExp(`^[0-9a-f]{${length}}$`).test(value))
    ) {
      throw new Error('Retention requires the candidate and at most one verified accepted rollback target.');
    }
  }
  const rules = [];
  for (const [index, values] of [functionDigests, controllerRefs].entries()) {
    const protectedBuckets = new Set(values.map((value) => value.slice(0, 2)));
    const prefixes = Array.from({ length: 256 }, (_, bucket) => bucket.toString(16).padStart(2, '0'))
      .filter((bucket) => !protectedBuckets.has(bucket))
      .map((bucket) => `${roots[index]}${bucket}`);
    for (let offset = 0; offset < prefixes.length; offset += 10) {
      rules.push({
        name: `expire-retired-${index}-${offset / 10}`,
        enabled: true,
        type: 'Lifecycle',
        definition: {
          actions: {
            baseBlob: { delete: { daysAfterModificationGreaterThan: 180 } },
            version: { delete: { daysAfterCreationGreaterThan: 30 } },
          },
          filters: { blobTypes: ['blockBlob'], prefixMatch: prefixes.slice(offset, offset + 10) },
        },
      });
    }
  }
  return { rules };
}

export function mayDeleteBlob(policy, path) {
  if (!Array.isArray(policy?.rules)) return true;
  return policy.rules.some((rule) => {
    if (rule?.enabled === false) return false;
    const definition = rule?.definition;
    if (!definition || !definition.actions) return true;
    const deletion = ['baseBlob', 'version', 'snapshot'].some((kind) => definition.actions[kind]?.delete !== undefined);
    if (!deletion) return false;
    const prefixes = definition.filters?.prefixMatch;
    // Unknown or tag-dependent matching is conservatively considered applicable.
    return (
      !Array.isArray(prefixes) ||
      prefixes.length === 0 ||
      prefixes.some((prefix) => typeof prefix !== 'string' || path.startsWith(prefix))
    );
  });
}

/** A lifecycle update can take a day to take effect. An old exact version needs established protection. */
export function validateRetentionTransition({ currentPolicy, protectedVersions, now = Date.now() }) {
  const errors = [];
  if (!Array.isArray(protectedVersions) || protectedVersions.length === 0)
    return ['Protected package versions are required.'];
  for (const version of protectedVersions) {
    const created = Date.parse(version?.versionId ?? '');
    const path = `function-releases/${version?.blobName ?? ''}`;
    if (
      !/^(functionapp-[0-9a-f]{64}\.zip|accepted\/[0-9a-f]{40}\/[1-9][0-9]*\/1\/(promotion|recovery)\/[a-z0-9.-]+)$/.test(
        version?.blobName ?? '',
      ) ||
      !Number.isFinite(created) ||
      created > now
    ) {
      errors.push('Protected blob must have a control-plane verified immutable version timestamp.');
      continue;
    }
    // 48 hours of headroom below the shortest existing deletion threshold (30 days).
    if (now - created < 28 * DAY) continue;
    const updated = Date.parse(currentPolicy?.properties?.lastModifiedTime ?? '');
    if (
      mayDeleteBlob(currentPolicy?.properties?.policy, path) ||
      !Number.isFinite(updated) ||
      now - updated < 2 * DAY
    ) {
      errors.push(`Old protected blob requires an established retention exclusion: ${version.blobName}`);
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    const functionDigests = [env.FUNCTION_ARTIFACT_SHA256];
    const controllerRefs = [env.GITHUB_SHA];
    const protectedVersions = [];
    if (env.ENVIRONMENT_NAME === 'prod') {
      const baseline = JSON.parse(
        await readFile(`${env.RUNNER_TEMP}/accepted-baseline/accepted-baseline.json`, 'utf8'),
      );
      if (baseline.status !== 'accepted') throw new Error('Verified production baseline is required.');
      functionDigests.push(baseline.identity.function.digests.function);
      controllerRefs.push(baseline.identity.mutationReceipt?.controllerRef ?? baseline.sourceRef);
      protectedVersions.push(baseline.identity.function.package);
    }
    const existingCandidate = JSON.parse(await readFile(`${env.RUNNER_TEMP}/candidate-package-version.json`, 'utf8'));
    if (existingCandidate.exists)
      protectedVersions.push({
        blobName: `functionapp-${env.FUNCTION_ARTIFACT_SHA256}.zip`,
        versionId: existingCandidate.versionId,
      });
    const policy = buildReleaseRetentionPolicy({ functionDigests, controllerRefs });
    if (protectedVersions.length) {
      const currentPolicy = JSON.parse(await readFile(`${env.RUNNER_TEMP}/installed-release-retention.json`, 'utf8'));
      const errors = validateRetentionTransition({ currentPolicy, protectedVersions });
      if (errors.length) throw new Error(errors.join('\n'));
    }
    await writeFile(
      `${env.RUNNER_TEMP}/release-retention-parameters.json`,
      JSON.stringify({ releaseRetentionPolicy: { value: policy } }),
    );
    console.log(
      JSON.stringify({
        protectedFunctionBuckets: [...new Set(functionDigests.map((value) => value.slice(0, 2)))],
        protectedArchiveBuckets: [...new Set(controllerRefs.map((value) => value.slice(0, 2)))],
        rules: policy.rules.length,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
