import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const MONTH_BOUNDARY_PATTERN = /^[0-9]{4}-[0-9]{2}-01T00:00:00Z$/;
const RESOURCE_ID_PATTERN =
  /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.Consumption\/budgets\/[A-Za-z0-9._()-]{1,63}$/;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,16384}$/;

export function resolveBudgetStartDate(currentMonth, httpStatus, payload) {
  if (!MONTH_BOUNDARY_PATTERN.test(currentMonth)) {
    throw new Error('Current budget month is not an exact UTC month boundary.');
  }
  if (httpStatus === 404) return currentMonth;
  if (httpStatus === 200) {
    const existingStartDate = payload?.properties?.timePeriod?.startDate;
    if (!MONTH_BOUNDARY_PATTERN.test(existingStartDate)) {
      throw new Error('Existing Azure budget start date is not an exact UTC month boundary.');
    }
    return existingStartDate;
  }
  throw new Error('Azure budget lookup failed before deployment.');
}

export async function lookupBudgetStartDate(
  resourceId,
  currentMonth,
  { tokenRunner = spawnSync, fetchImpl = globalThis.fetch } = {},
) {
  if (!RESOURCE_ID_PATTERN.test(resourceId)) throw new Error('Azure budget resource ID is invalid.');
  if (typeof fetchImpl !== 'function') throw new Error('Azure budget lookup HTTP client is unavailable.');
  const tokenResult = tokenRunner(
    'az',
    [
      'account',
      'get-access-token',
      '--resource',
      'https://management.azure.com/',
      '--query',
      'accessToken',
      '--output',
      'tsv',
      '--only-show-errors',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (tokenResult.error || tokenResult.status !== 0) {
    throw new Error('Azure budget lookup authentication failed before deployment.');
  }
  const accessToken = String(tokenResult.stdout).trim();
  if (!ACCESS_TOKEN_PATTERN.test(accessToken)) {
    throw new Error('Azure budget lookup returned an invalid access token.');
  }
  let response;
  try {
    response = await fetchImpl(`https://management.azure.com${resourceId}?api-version=2024-08-01`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    throw new Error('Azure budget lookup failed before deployment.');
  }
  if (response.status === 404) return resolveBudgetStartDate(currentMonth, response.status);
  if (response.status !== 200) return resolveBudgetStartDate(currentMonth, response.status);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Azure budget lookup returned malformed JSON.');
  }
  return resolveBudgetStartDate(currentMonth, response.status, payload);
}

async function main() {
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
  process.stdout.write(`${await lookupBudgetStartDate(values['resource-id'], values['current-month'])}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Azure budget lookup failed before deployment.');
    process.exitCode = 1;
  });
}
