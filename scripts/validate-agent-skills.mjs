#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillsRoot = resolve(repositoryRoot, '.agents/skills');

export function validateAgentSkills(root = skillsRoot) {
  const findings = [];
  const names = new Map();
  const files = walk(root).filter((file) => basename(file) === 'SKILL.md');

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (!match) {
      findings.push(`${relative(repositoryRoot, file)}: missing YAML frontmatter`);
      continue;
    }
    let metadata;
    try {
      metadata = YAML.parse(match[1]);
    } catch (error) {
      findings.push(`${relative(repositoryRoot, file)}: invalid YAML (${error.message})`);
      continue;
    }
    const expectedName = basename(dirname(file));
    if (metadata?.name !== expectedName) {
      findings.push(`${relative(repositoryRoot, file)}: name must be ${expectedName}`);
    }
    if (typeof metadata?.description !== 'string' || metadata.description.trim().length < 20) {
      findings.push(`${relative(repositoryRoot, file)}: description must explain when to use the skill`);
    }
    if (metadata?.description?.length > 1024) {
      findings.push(`${relative(repositoryRoot, file)}: description exceeds 1024 characters`);
    }
    if (names.has(metadata?.name)) {
      findings.push(`${relative(repositoryRoot, file)}: duplicate skill name ${metadata.name}`);
    } else {
      names.set(metadata?.name, file);
    }
    if (!/^#\s+\S/m.test(source.slice(match[0].length))) {
      findings.push(`${relative(repositoryRoot, file)}: missing top-level heading`);
    }
  }
  if (files.length === 0) findings.push('.agents/skills: no repository skills found');
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
