import { CONTEXT_VARIANTS, loadTaskById, validateTaskRepository } from './definitions.mjs';
import { runTaskEvaluation } from './controller.mjs';

function parseArguments(args) {
  const result = {
    all: false,
    taskId: null,
    contextVariant: 'current-agent-context',
    adapterId: 'codex-cli',
    confirmAccountUsage: false,
    fakeMode: 'noop',
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--all') result.all = true;
    else if (arg === '--confirm-account-usage') result.confirmAccountUsage = true;
    else if (['--task', '--context', '--adapter', '--fake-mode'].includes(arg)) {
      if (index === args.length - 1) throw new Error(`Missing value for ${arg}`);
      const value = args[++index];
      if (arg === '--task') result.taskId = value;
      if (arg === '--context') result.contextVariant = value;
      if (arg === '--adapter') result.adapterId = value;
      if (arg === '--fake-mode') result.fakeMode = value;
    } else throw new Error(`Unsupported argument: ${arg}`);
  }
  if (result.all === Boolean(result.taskId)) throw new Error('Select exactly one of --task <id> or --all');
  if (!CONTEXT_VARIANTS.includes(result.contextVariant))
    throw new Error(`Unsupported context: ${result.contextVariant}`);
  if (!['codex-cli', 'fake-adapter'].includes(result.adapterId))
    throw new Error(`Unsupported adapter: ${result.adapterId}`);
  if (!['noop', 'fixture-success', 'tamper', 'timeout'].includes(result.fakeMode))
    throw new Error('Unsupported fake mode');
  if (result.adapterId === 'codex-cli' && !result.confirmAccountUsage) {
    throw new Error('Real Codex execution is optional and requires --confirm-account-usage');
  }
  if (result.adapterId === 'fake-adapter' && result.confirmAccountUsage)
    throw new Error('Account-usage confirmation is invalid for fake-adapter');
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const validation = validateTaskRepository();
  if (validation.errors.length > 0)
    throw new Error(`Agent-task validation failed:\n- ${validation.errors.join('\n- ')}`);
  const tasks = options.all ? validation.tasks : [loadTaskById(options.taskId)];
  let failed = false;
  for (const task of tasks) {
    const result = await runTaskEvaluation({
      task,
      contextVariant: options.contextVariant,
      adapterId: options.adapterId,
      confirmAccountUsage: options.confirmAccountUsage,
      fakeMode: options.fakeMode,
    });
    console.log(`${task.id}: ${result.report.passed ? 'PASS' : 'FAIL'} (${result.resultPath})`);
    failed ||= !result.report.passed;
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
