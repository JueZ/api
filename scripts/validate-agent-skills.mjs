#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillsRoot = resolve(repositoryRoot, '.agents/skills');
const allowedFrontmatterKeys = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata']);
const allowedInterfaceKeys = new Set([
  'display_name',
  'short_description',
  'icon_small',
  'icon_large',
  'brand_color',
  'default_prompt',
]);

export function validateAgentSkills(root = skillsRoot) {
  const findings = [];
  const names = new Map();
  if (!existsSync(root)) return ['.agents/skills: no repository skills found'];
  const files = walk(root).filter((file) => basename(file) === 'SKILL.md');

  for (const file of files) {
    const label = relative(repositoryRoot, file);
    const source = readFileSync(file, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (!match) {
      findings.push(`${label}: missing YAML frontmatter`);
      continue;
    }
    let metadata;
    try {
      metadata = YAML.parse(match[1]);
    } catch (error) {
      findings.push(`${label}: invalid YAML (${error.message})`);
      continue;
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      findings.push(`${label}: frontmatter must be a YAML mapping`);
      continue;
    }
    for (const key of Object.keys(metadata)) {
      if (!allowedFrontmatterKeys.has(key)) findings.push(`${label}: unsupported frontmatter key ${key}`);
    }

    const expectedName = basename(dirname(file));
    if (metadata.name !== expectedName) findings.push(`${label}: name must be ${expectedName}`);
    if (typeof metadata.name !== 'string' || !/^[a-z0-9-]+$/.test(metadata.name)) {
      findings.push(`${label}: name must contain only lowercase letters, digits, and hyphens`);
    } else if (metadata.name.startsWith('-') || metadata.name.endsWith('-') || metadata.name.includes('--')) {
      findings.push(`${label}: name cannot start or end with a hyphen or contain consecutive hyphens`);
    }
    if (typeof metadata.name === 'string' && metadata.name.length > 64) {
      findings.push(`${label}: name exceeds 64 characters`);
    }
    if (typeof metadata.description !== 'string' || metadata.description.trim().length < 20) {
      findings.push(`${label}: description must explain when to use the skill`);
    }
    if (typeof metadata.description === 'string' && /[<>]/.test(metadata.description)) {
      findings.push(`${label}: description cannot contain angle brackets`);
    }
    if (metadata.description?.length > 1024) findings.push(`${label}: description exceeds 1024 characters`);
    if (names.has(metadata.name)) findings.push(`${label}: duplicate skill name ${metadata.name}`);
    else names.set(metadata.name, file);

    const body = source.slice(match[0].length);
    if (!/^#\s+\S/m.test(body)) findings.push(`${label}: missing top-level heading`);
    if (body.split(/\r?\n/).length > 500) findings.push(`${label}: body exceeds 500 lines`);
    findings.push(...brokenLocalLinks(file, body).map((message) => `${label}: ${message}`));
    findings.push(...validateOpenAiMetadata(dirname(file), metadata.name, label));
  }
  if (files.length === 0) findings.push('.agents/skills: no repository skills found');
  return findings;
}

function brokenLocalLinks(file, body) {
  const findings = [];
  for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '').split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:|skill:|#)/i.test(target)) continue;
    if (!existsSync(resolve(dirname(file), decodeURIComponent(target)))) {
      findings.push(`local link does not exist: ${target}`);
    }
  }
  return findings;
}

function validateOpenAiMetadata(skillDirectory, skillName, label) {
  const metadataPath = resolve(skillDirectory, 'agents/openai.yaml');
  if (!existsSync(metadataPath)) return [];
  const findings = [];
  let document;
  try {
    document = YAML.parse(readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    return [`${label}: agents/openai.yaml is invalid YAML (${error.message})`];
  }
  const interfaceMetadata = document?.interface;
  if (!interfaceMetadata || typeof interfaceMetadata !== 'object' || Array.isArray(interfaceMetadata)) {
    return [`${label}: agents/openai.yaml must contain an interface mapping`];
  }
  for (const key of Object.keys(interfaceMetadata)) {
    if (!allowedInterfaceKeys.has(key))
      findings.push(`${label}: agents/openai.yaml has unsupported interface key ${key}`);
  }
  if (typeof interfaceMetadata.display_name !== 'string' || !interfaceMetadata.display_name.trim()) {
    findings.push(`${label}: agents/openai.yaml display_name is required`);
  }
  const shortDescription = interfaceMetadata.short_description;
  if (typeof shortDescription !== 'string' || shortDescription.length < 25 || shortDescription.length > 64) {
    findings.push(`${label}: agents/openai.yaml short_description must be 25-64 characters`);
  }
  const defaultPrompt = interfaceMetadata.default_prompt;
  if (typeof defaultPrompt !== 'string' || !defaultPrompt.includes(`$${skillName}`)) {
    findings.push(`${label}: agents/openai.yaml default_prompt must mention $${skillName}`);
  }
  return findings;
}

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const entry = resolve(directory, name);
    return statSync(entry).isDirectory() ? walk(entry) : [entry];
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = validateAgentSkills();
  if (findings.length) {
    console.error(`Agent skill validation failed:\n- ${findings.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Agent skill validation passed.');
}
