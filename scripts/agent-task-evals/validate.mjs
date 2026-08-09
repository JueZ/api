import { validateTaskRepository } from './definitions.mjs';

const unsupported = process.argv.slice(2);
if (unsupported.length > 0) {
  console.error(`Unsupported arguments: ${unsupported.join(' ')}`);
  process.exitCode = 2;
} else {
  const result = validateTaskRepository();
  if (result.errors.length > 0) {
    console.error(`Agent-task validation failed:\n- ${result.errors.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Validated ${result.tasks.length} historical agent tasks.`);
  }
}
