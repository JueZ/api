import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const MONTH_BOUNDARY_PATTERN = /^[0-9]{4}-[0-9]{2}-01T00:00:00Z$/;
const RESOURCE_ID_PATTERN =
  /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.Consumption\/budgets\/[A-Za-z0-9._()-]{1,63}$/;

export function isDefinitiveBudgetNotFound(stderr) {
  const message = String(stderr).trim();
  const prefix = 'ERROR: Not Found(';
  if (!message.startsWith(prefix) || !message.endsWith(')')) return false;
  try {
    const payload = JSON.parse(message.slice(prefix.length, -1));
    return payload?.error?.code === '404';
  } catch {
    return false;
  }
}

export function resolveBudgetStartDate(currentMonth, azureResult) {
  if (!MONTH_BOUNDARY_PATTERN.test(currentMonth)) {
    throw new Error('Current budget month is not an exact UTC month boundary.');
  }
  if (azureResult?.status === 0) {
    let payload;
    try {
      payload = JSON.parse(String(azureResult.stdout));
    } catch {
      throw new Error('Azure budget lookup returned malformed JSON.');
    }
    const existingStartDate = payload?.properties?.timePeriod?.startDate;
    if (!MONTH_BOUNDARY_PATTERN.test(existingStartDate)) {
      throw new Error('Existing Azure budget start date is not an exact UTC month boundary.');
    }
    return existingStartDate;
  }
  if (isDefinitiveBudgetNotFound(azureResult?.stderr)) return currentMonth;
  throw new Error('Azure budget lookup failed before deployment.');
}

export function lookupBudgetStartDate(resourceId, currentMonth, runner = spawnSync) {
  if (!RESOURCE_ID_PATTERN.test(resourceId)) throw new Error('Azure budget resource ID is invalid.');
  const result = runner(
    'az',
    [
      'rest',
      '--method',
      'GET',
      '--url',
      `https://management.azure.com${resourceId}?api-version=2024-08-01`,
      '--output',
      'json',
      '--only-show-errors',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (result.error) throw new Error('Azure budget lookup could not start.');
  return resolveBudgetStartDate(currentMonth, result);
}

function main() {
  const { values } = parseArgs({
    options: {
      'resource-id': { type: 'string' },
      'current-month': { type: 'string' },
    },
    strict: true,
  });
  if (!values['resource-id'] || !values['current-month']) {
    throw new Error('--resource-id and --current-month are required.');
  }
  process.stdout.write(`${lookupBudgetStartDate(values['resource-id'], values['current-month'])}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Azure budget lookup failed before deployment.');
    process.exitCode = 1;
  }
}
