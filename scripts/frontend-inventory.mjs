#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256Pattern = /^[0-9a-f]{64}$/;

export function validateBlobName(name) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('frontend blob name must be non-empty');
  if (name.startsWith('/') || name.endsWith('/')) throw new Error(`unsafe frontend blob name: ${JSON.stringify(name)}`);
  if (name.includes('\\') || containsControlCharacter(name)) {
    throw new Error(`unsafe frontend blob name: ${JSON.stringify(name)}`);
  }
  const segments = name.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`unsafe frontend blob name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function validateDeployedBlobName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('deployed frontend blob name must be non-empty');
  }
  if (containsControlCharacter(name)) {
    throw new Error(`unsafe deployed frontend blob name: ${JSON.stringify(name)}`);
  }
  return name;
}

export async function createFrontendInventory(directory) {
  const root = resolve(directory);
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('frontend inventory root must be a regular directory');
  }

  const files = [];
  await walkDirectory(root, [], files);
  return { schemaVersion: 1, files };
}

async function walkDirectory(root, segments, files) {
  const directory = join(root, ...segments);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareStrings(left.name, right.name));

  for (const entry of entries) {
    const nextSegments = [...segments, entry.name];
    const blobName = validateBlobName(nextSegments.join('/'));
    const absolutePath = join(root, ...nextSegments);
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) throw new Error(`frontend entry must not be a symbolic link: ${blobName}`);
    if (stats.isDirectory()) {
      await walkDirectory(root, nextSegments, files);
      continue;
    }
    if (!stats.isFile()) throw new Error(`frontend entry must be a regular file: ${blobName}`);

    const bytes = await readFile(absolutePath);
    files.push({
      name: blobName,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    });
  }
}

export function validateFrontendInventory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error('frontend inventory schemaVersion must be 1');
  }
  if (!Array.isArray(value.files)) throw new Error('frontend inventory files must be an array');

  const files = value.files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error('frontend inventory entry must be an object');
    }
    const name = validateBlobName(file.name);
    if (!sha256Pattern.test(file.sha256 ?? '')) {
      throw new Error(`frontend inventory digest is invalid: ${name}`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`frontend inventory size is invalid: ${name}`);
    }
    return { name, sha256: file.sha256, size: file.size };
  });

  const sorted = [...files].sort((left, right) => compareStrings(left.name, right.name));
  for (let index = 0; index < files.length; index += 1) {
    if (files[index].name !== sorted[index].name) throw new Error('frontend inventory must be sorted by blob name');
    if (index > 0 && files[index - 1].name === files[index].name) {
      throw new Error(`frontend inventory contains a duplicate blob name: ${files[index].name}`);
    }
  }
  return { schemaVersion: 1, files };
}

export function validateBlobNameList(value) {
  if (!Array.isArray(value)) throw new Error('frontend blob-name response must be an array');
  const names = value.map(validateDeployedBlobName);
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) throw new Error('frontend blob-name response contains duplicates');
  return names.sort(compareStrings);
}

export function compareFrontendNames(expectedInventory, actualNames) {
  const expected = validateFrontendInventory(expectedInventory).files.map(({ name }) => name);
  const actual = validateBlobNameList(actualNames);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const errors = [];

  for (const name of expected) {
    if (!actualSet.has(name)) errors.push(`missing deployed frontend blob: ${name}`);
  }
  for (const name of actual) {
    if (!expectedSet.has(name)) errors.push(`unexpected deployed frontend blob: ${name}`);
  }
  return { ok: errors.length === 0, errors };
}

export function compareFrontendInventories(expectedInventory, actualInventory) {
  const expected = validateFrontendInventory(expectedInventory);
  const actual = validateFrontendInventory(actualInventory);
  const errors = compareFrontendNames(
    expected,
    actual.files.map(({ name }) => name),
  ).errors;
  const actualByName = new Map(actual.files.map((file) => [file.name, file]));

  for (const expectedFile of expected.files) {
    const actualFile = actualByName.get(expectedFile.name);
    if (!actualFile) continue;
    if (actualFile.size !== expectedFile.size) {
      errors.push(`deployed frontend blob size does not match: ${expectedFile.name}`);
    }
    if (actualFile.sha256 !== expectedFile.sha256) {
      errors.push(`deployed frontend blob digest does not match: ${expectedFile.name}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function planStaleFrontendBlobs(expectedInventory, actualNames) {
  const expectedNames = new Set(validateFrontendInventory(expectedInventory).files.map(({ name }) => name));
  return validateBlobNameList(actualNames).filter((name) => !expectedNames.has(name));
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

async function runCli() {
  const [command, firstPath, secondPath, thirdPath] = process.argv.slice(2);
  if (command === 'create' && firstPath && secondPath && !thirdPath) {
    await writeJson(secondPath, await createFrontendInventory(firstPath));
    return;
  }
  if (command === 'plan-stale' && firstPath && secondPath && thirdPath) {
    const expected = await readJson(firstPath);
    const actualNames = await readJson(secondPath);
    await writeJson(thirdPath, planStaleFrontendBlobs(expected, actualNames));
    return;
  }
  if (command === 'compare-names' && firstPath && secondPath && !thirdPath) {
    const result = compareFrontendNames(await readJson(firstPath), await readJson(secondPath));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    return;
  }
  if (command === 'compare-directory' && firstPath && secondPath && !thirdPath) {
    const expected = await readJson(firstPath);
    const actual = await createFrontendInventory(secondPath);
    const result = compareFrontendInventories(expected, actual);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    return;
  }
  throw new Error(
    'Usage: frontend-inventory.mjs create <directory> <manifest> | plan-stale <manifest> <names-json> <plan-json> | compare-names <manifest> <names-json> | compare-directory <manifest> <directory>',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
