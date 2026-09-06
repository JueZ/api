const GATE_RULES = Object.freeze({
  pr: Object.freeze({
    classify: 'always',
    policy: 'always',
    backend: 'backendOrContracts',
    frontend: 'frontend',
    portability: 'privileged',
    infrastructure: 'infrastructure',
    workflow: 'workflow',
  }),
  security: Object.freeze({
    classify: 'always',
    gitleaks: 'always',
    dependencyAudit: 'dependencies',
    codeqlJavascript: 'codeqlJavascript',
    codeqlActions: 'codeqlActions',
    trivy: 'trivy',
  }),
});

export function verifyGateAggregate(gate, flags, needs) {
  const rules = GATE_RULES[gate];
  if (!rules) throw new Error(`unknown gate: ${gate}`);
  if (!isRecord(flags) || !isRecord(needs)) throw new Error('gate inputs must be objects');

  const applicable = [];
  const skipped = [];
  const failures = [];
  for (const [job, condition] of Object.entries(rules)) {
    const expected = condition === 'always' || conditionApplies(condition, flags);
    const result = needs[job]?.result;
    if (expected) {
      applicable.push(job);
      if (result !== 'success') failures.push(`${job} expected success, got ${result ?? 'missing'}`);
    } else {
      skipped.push(job);
      if (result !== 'skipped') failures.push(`${job} expected skipped, got ${result ?? 'missing'}`);
    }
  }
  const unexpected = Object.keys(needs).filter((job) => !(job in rules));
  if (unexpected.length > 0) failures.push(`unexpected aggregate dependencies: ${unexpected.join(', ')}`);

  return { passed: failures.length === 0, applicable, skipped, failures };
}

function conditionApplies(condition, flags) {
  if (condition === 'backendOrContracts') return flags.backend === true || flags.contracts === true;
  return flags[condition] === true;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
