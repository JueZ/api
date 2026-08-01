import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDefinitiveBudgetNotFound,
  lookupBudgetStartDate,
  resolveBudgetStartDate,
} from '../resolve-budget-start-date.mjs';

const currentMonth = '2026-08-01T00:00:00Z';
const resourceId =
  '/subscriptions/cb89936b-f739-42db-bd9f-bbdd0f052ee7/resourceGroups/rg-api-test/providers/Microsoft.Consumption/budgets/budget-api-catalogue-test';

test('existing Azure budget preserves its immutable start date', () => {
  const startDate = lookupBudgetStartDate(resourceId, currentMonth, (command, args, options) => {
    assert.equal(command, 'az');
    assert.deepEqual(args.slice(0, 3), ['rest', '--method', 'GET']);
    assert.match(args[4], /api-version=2024-08-01$/);
    assert.equal(options.encoding, 'utf8');
    return {
      status: 0,
      stdout: JSON.stringify({ properties: { timePeriod: { startDate: '2026-07-01T00:00:00Z' } } }),
      stderr: '',
    };
  });
  assert.equal(startDate, '2026-07-01T00:00:00Z');
});

test('only a definitive structured Azure 404 permits the new-budget default', () => {
  const stderr = `ERROR: Not Found(${JSON.stringify({ error: { code: '404', message: 'Budget missing.' } })})`;
  assert.equal(isDefinitiveBudgetNotFound(stderr), true);
  assert.equal(resolveBudgetStartDate(currentMonth, { status: 1, stdout: '', stderr }), currentMonth);

  for (const failure of [
    'ERROR: (403) Forbidden',
    'ERROR: (429) Too Many Requests',
    'ERROR: (500) Server Error',
    'ERROR: Not Found(not-json)',
    'request timed out after mentioning 404 unrelated bytes',
  ]) {
    assert.equal(isDefinitiveBudgetNotFound(failure), false);
    assert.throws(
      () => resolveBudgetStartDate(currentMonth, { status: 1, stdout: '', stderr: failure }),
      /Azure budget lookup failed before deployment/,
    );
  }
});

test('malformed success, invalid dates, and invalid resource IDs fail closed', () => {
  assert.throws(
    () => resolveBudgetStartDate(currentMonth, { status: 0, stdout: 'not-json', stderr: '' }),
    /malformed JSON/,
  );
  assert.throws(
    () =>
      resolveBudgetStartDate(currentMonth, {
        status: 0,
        stdout: JSON.stringify({ properties: { timePeriod: { startDate: '2026-07-02T00:00:00Z' } } }),
        stderr: '',
      }),
    /Existing Azure budget start date/,
  );
  assert.throws(
    () => lookupBudgetStartDate('/subscriptions/not-a-resource', currentMonth, () => assert.fail('not called')),
    /resource ID is invalid/,
  );
});
