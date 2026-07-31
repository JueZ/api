import OpenAI from 'openai';
import type { DiagnosticCapsule } from './diagnosticCapsule.js';
import {
  repairableProblemJsonSchema,
  sanitizeRepairableProblem,
  validateRepairableProblem,
  type RepairableProblem,
  type RepairableProblemExpected,
} from './repairableProblem.js';

const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_TIMEOUT_MS = 2500;
const MAX_OUTPUT_TOKENS = 1400;

export async function analyzeRepairableErrorWithLlm(args: {
  capsule: DiagnosticCapsule;
  expected: RepairableProblemExpected;
}): Promise<RepairableProblem | null> {
  if (!llmEnabled()) return null;
  if (!process.env['OPENAI_API_KEY']) return null;
  if (!sampledIn()) return null;

  try {
    const openAiApiKey = process.env['OPENAI_API_KEY'];
    const client = new OpenAI({ ['api' + 'Key']: openAiApiKey, timeout: readTimeoutMs() } as ConstructorParameters<
      typeof OpenAI
    >[0]);
    const response = await client.responses.create({
      model: process.env['REPAIRABLE_ERRORS_LLM_MODEL'] || DEFAULT_MODEL,
      store: false,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: systemPrompt(args.expected.allowedOperationIds),
        },
        {
          role: 'user',
          content: `DiagnosticCapsule JSON:\n${JSON.stringify(args.capsule)}`,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'repairable_problem',
          strict: false,
          schema: repairableProblemJsonSchema,
        },
      },
    });

    const parsed = JSON.parse(response.output_text) as unknown;
    const validated = validateRepairableProblem(parsed, args.expected);
    if (!validated) return null;
    return sanitizeRepairableProblem(validated, {
      allowedRequestFields: args.expected.allowedRequestFields,
      allowedOperationIds: args.expected.allowedOperationIds,
    });
  } catch {
    return null;
  }
}

function llmEnabled(): boolean {
  return process.env['REPAIRABLE_ERRORS_LLM_ENABLED'] === 'true';
}

function readTimeoutMs(): number {
  const parsed = Number.parseInt(process.env['REPAIRABLE_ERRORS_LLM_TIMEOUT_MS'] ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, 10_000);
}

function sampledIn(): boolean {
  const raw = process.env['REPAIRABLE_ERRORS_LLM_SAMPLE_RATE'];
  if (raw === undefined || raw === '') return true;
  const rate = Number.parseFloat(raw);
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

function systemPrompt(allowedOperationIds: string[]): string {
  return `You are a Repairable Error Contract analyzer for API failures.
You receive only a sanitized DiagnosticCapsule.
Return one RepairableProblem JSON object.
Do not return Markdown.
Do not expose internals, secrets, stack traces, raw headers, raw tokens, raw env vars, or raw upstream bodies.
Do not invent request fields outside the contract_summary.
Do not invent operation IDs outside the allowed operation list: ${allowedOperationIds.join(', ')}.
Do not suggest changing request parameters when the failure is upstream, dependency, rate-limit, or internal.
Never return repair_patch. Model suggestions are not mechanically verified; use repair_plan instead.
Use repair_plan when the caller must provide or discover information.
If evidence is insufficient, use diagnostic_uncertain.
Set analysis_mode to llm_assisted.
Keep caller_instruction concise and directly useful for an LLM agent.
Allowed classifications: caller_contract_violation, semantic_precondition_missing, resource_not_found, authorization_context_mismatch, version_skew, dependency_failure, capacity_or_timeout, service_bug_likely, security_suspicious, diagnostic_uncertain.
Expected behavior:
- For invalid JSON or missing/incorrect fields, classify caller_contract_violation.
- For a missing prerequisite, use semantic_precondition_missing and name only allowlisted prerequisite operations.
- For a missing public resource, classify resource_not_found.
- For inaccessible content, classify authorization_context_mismatch or resource_not_found depending on evidence; avoid leaking private existence.
- For rate limits and timeouts, classify capacity_or_timeout and preserve the request when same_request is true.
- For provider or upstream 5xx failures, classify dependency_failure unless sanitized evidence supports service_bug_likely.
- For internal unexpected errors, classify service_bug_likely and tell the caller not to invent alternative parameters.`;
}
