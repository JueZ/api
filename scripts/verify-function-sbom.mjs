#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

export function functionSbomFindings(sbom, lockfile) {
  const findings = [];
  const root = lockfile.packages?.[''];
  const rootComponent = sbom.metadata?.component;
  const expectedRootRef = `${root?.name}@${root?.version}`;
  const expectedRootPurl = `pkg:npm/${root?.name}@${root?.version}`;

  if (sbom.bomFormat !== 'CycloneDX') findings.push('Function SBOM must use CycloneDX');
  if (rootComponent?.type !== 'application') findings.push('Function SBOM root must be an application');
  if (rootComponent?.name !== root?.name) findings.push('Function SBOM root name is invalid');
  if (rootComponent?.['bom-ref'] !== expectedRootRef) findings.push('Function SBOM root reference is invalid');
  if (rootComponent?.purl !== expectedRootPurl) findings.push('Function SBOM root purl is invalid');

  const components = new Set((sbom.components ?? []).map((component) => `${component.name}@${component.version}`));
  for (const dependency of Object.keys(root?.dependencies ?? {})) {
    const version = lockfile.packages?.[`node_modules/${dependency}`]?.version;
    if (!version || !components.has(`${dependency}@${version}`)) {
      findings.push(`Function SBOM is missing direct runtime dependency ${dependency}`);
    }
  }
  for (const forbidden of ['@angular/core', 'typescript']) {
    if ((sbom.components ?? []).some((component) => component.name === forbidden)) {
      findings.push(`Function SBOM contains root-only dependency ${forbidden}`);
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sbomPath, lockfilePath] = process.argv.slice(2);
  if (!sbomPath || !lockfilePath) {
    console.error('Usage: node scripts/verify-function-sbom.mjs <sbom-path> <Function-lockfile-path>');
    process.exit(2);
  }
  const findings = functionSbomFindings(
    JSON.parse(readFileSync(sbomPath, 'utf8')),
    JSON.parse(readFileSync(lockfilePath, 'utf8')),
  );
  if (findings.length > 0) {
    console.error(`Function SBOM validation failed:\n- ${findings.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Function SBOM validation passed.');
}
