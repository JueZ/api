import type { DiagnosticCapsule } from './diagnosticCapsule.js';
import { analyzeRepairableErrorWithLlm } from './llmDiagnosticAnalyzer.js';
import {
  createDiagnosticId,
  sanitizeRepairableProblem,
  validateRepairableProblem,
  type InvalidField,
  type RepairPlanStep,
  type RepairableErrorClassification,
  type RepairableProblem,
  type RepairableProblemExpected,
  type RetryPolicy,
} from './repairableProblem.js';

export type RepairableErrorAnalyzer = typeof analyzeRepairableErrorWithLlm;

export async function resolveRepairableProblem(args: {
  deterministic: RepairableProblem;
  capsule: DiagnosticCapsule;
  expected: RepairableProblemExpected;
  analyzer?: RepairableErrorAnalyzer;
}): Promise<RepairableProblem> {
  const deterministic = acceptProblem(args.deterministic, args.expected);
  if (!deterministic) {
    throw new Error('Deterministic repairable problem failed its local policy gate.');
  }

  // REC is deterministic-first. Known failures never spend tokens or add model
  // latency; only an explicitly uncertain deterministic result may reach OpenAI.
  if (deterministic.classification !== 'diagnostic_uncertain') return deterministic;

  const analyzed = await (args.analyzer ?? analyzeRepairableErrorWithLlm)({
    capsule: args.capsule,
    expected: args.expected,
  });
  const accepted = acceptProblem(analyzed, args.expected);
  if (!accepted) return deterministic;

  // Model-produced JSON Patch is not mechanically verified. Keep such repairs
  // as a plan unless a deterministic analyzer creates and verifies the patch.
  if (accepted.analysis_mode !== 'deterministic' && accepted.repair_patch?.length) return deterministic;
  if (accepted.analysis_mode !== 'llm_assisted' && accepted.analysis_mode !== 'hybrid') return deterministic;
  return accepted;
}

export function buildDeterministicRepairableProblem(args: {
  operationId: string;
  status: number;
  endpoint: string;
  classification: RepairableErrorClassification;
  title: string;
  detail: string;
  callerInstruction: string;
  safeDebugSummary: string;
  repairable: boolean;
  retryPolicy: RetryPolicy;
  confidence?: number;
  traceId?: string;
  diagnosticId?: string;
  invalidFields?: InvalidField[];
  repairPlan?: RepairPlanStep[];
  correctRequestExample?: unknown;
  analysisMode?: RepairableProblem['analysis_mode'];
}): RepairableProblem {
  const diagnosticId = args.diagnosticId ?? createDiagnosticId();
  return {
    type: `https://api.juez.local/problems/${problemSlug(args.endpoint)}/${args.classification}`,
    title: args.title,
    status: args.status,
    detail: args.detail,
    instance: `urn:diagnostic:${diagnosticId}`,
    rec_version: '1.0',
    operation_id: args.operationId,
    diagnostic_id: diagnosticId,
    ...(args.traceId ? { trace_id: args.traceId } : {}),
    classification: args.classification,
    repairable: args.repairable,
    confidence: args.confidence ?? 0.98,
    retry_policy: args.retryPolicy,
    ...(args.invalidFields ? { invalid_fields: args.invalidFields } : {}),
    ...(args.repairPlan ? { repair_plan: args.repairPlan } : {}),
    ...(args.correctRequestExample !== undefined ? { correct_request_example: args.correctRequestExample } : {}),
    caller_instruction: args.callerInstruction,
    llm_instruction: args.callerInstruction,
    safe_debug_summary: args.safeDebugSummary,
    analysis_mode: args.analysisMode ?? 'deterministic',
  };
}

function acceptProblem(
  problem: RepairableProblem | null | undefined,
  expected: RepairableProblemExpected,
): RepairableProblem | null {
  const validated = validateRepairableProblem(problem, expected);
  if (!validated) return null;
  return sanitizeRepairableProblem(validated, {
    allowedRequestFields: expected.allowedRequestFields,
    allowedOperationIds: expected.allowedOperationIds,
  });
}

function problemSlug(endpoint: string): string {
  const slug = endpoint
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'api';
}
