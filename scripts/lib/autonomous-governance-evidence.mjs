export const AUTONOMOUS_GOVERNANCE_EVALUATOR = 'deterministic-protected-controller-v1';

export function validateAutonomousGovernanceEvidence(
  evidence,
  expectedHeadSha,
  expectedEvaluator = AUTONOMOUS_GOVERNANCE_EVALUATOR,
) {
  const errors = [];
  if (!isRecord(evidence)) return { ok: false, errors: ['governance evidence must be an object'] };
  const expectedKeys = new Set(['decision', 'verifiedHeadSha', 'summary', 'findings', 'risk', 'evaluator']);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(evidence, key)) errors.push(`governance evidence is missing ${key}`);
  }
  for (const key of Object.keys(evidence)) {
    if (!expectedKeys.has(key)) errors.push(`governance evidence contains unsupported field ${key}`);
  }
  if (expectedEvaluator !== AUTONOMOUS_GOVERNANCE_EVALUATOR) {
    errors.push('configured governance evaluator identity is invalid');
  }
  if (evidence.decision !== 'approve') errors.push('autonomous governance did not approve the exact head');
  if (evidence.verifiedHeadSha !== expectedHeadSha) {
    errors.push('governance evidence does not match expected head SHA');
  }
  if (!isBoundedString(evidence.summary, 2000)) errors.push('governance evidence summary is invalid');
  if (!Array.isArray(evidence.findings) || evidence.findings.length !== 0) {
    errors.push('successful deterministic governance evidence must contain no findings');
  }
  if (!validRiskClassification(evidence.risk)) errors.push('governance risk classification is invalid');
  if (evidence.evaluator !== expectedEvaluator) errors.push('governance evaluator identity is invalid');
  return { ok: errors.length === 0, errors };
}

function validRiskClassification(risk) {
  return (
    isRecord(risk) &&
    typeof risk.highRisk === 'boolean' &&
    Array.isArray(risk.highRiskPaths) &&
    risk.highRiskPaths.every((path) => typeof path === 'string' && path.length > 0) &&
    isRecord(risk.classes)
  );
}

function isBoundedString(value, maximumLength) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximumLength;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
