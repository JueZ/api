import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupBudgetStartDate, resolveBudgetStartDate } from '../resolve-budget-start-date.mjs';

const currentMonth = '2026-08-01T00:00:00Z';
const resourceId =
  '/subscriptions/cb89936b-f739-42db-bd9f-bbdd0f052ee7/resourceGroups/rg-api-test/providers/Microsoft.Consumption/budgets/budget-api-catalogue-test';

function tokenRunner(command, args, options) {
  assert.equal(command, 'az');
  assert.deepEqual(args.slice(0, 2), ['account', 'get-access-token']);
  assert.equal(args[3], 'https://management.azure.com/');
  assert.equal(options.encoding, 'utf8');
  return { status: 0, stdout: 'header.payload.signature', stderr: '' };
}

test('existing Azure budget preserves its immutable start date without exposing the token', async () => {
  const startDate = await lookupBudgetStartDate(resourceId, currentMonth, {
    tokenRunner,
    async fetchImpl(url, options) {
      assert.match(url, /api-version=2024-08-01$/);
      assert.equal(options.headers.Authorization, 'Bearer header.payload.signature');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return {
        status: 200,
        async json() {
          return { properties: { timePeriod: { startDate: '2026-07-01T00:00:00Z' } } };
        },
      };
    },
  });
  assert.equal(startDate, '2026-07-01T00:00:00Z');
});

test('only the actual ARM HTTP 404 permits the new-budget default', async () => {
  assert.equal(resolveBudgetStartDate(currentMonth, 404), currentMonth);
  assert.equal(
    await lookupBudgetStartDate(resourceId, currentMonth, {
      tokenRunner,
      async fetchImpl() {
        return { status: 404 };
      },
    }),
    currentMonth,
  );
  for (const status of [0, 401, 403, 408, 429, 500, 503]) {
    assert.throws(() => resolveBudgetStartDate(currentMonth, status), /lookup failed before deployment/);
    await assert.rejects(
      lookupBudgetStartDate(resourceId, currentMonth, {
        tokenRunner,
        async fetchImpl() {
          return { status };
        },
      }),
      /lookup failed before deployment/,
    );
  }
});

test('network, authentication, malformed success, invalid dates, and invalid resource IDs fail closed', async () => {
  await assert.rejects(
    lookupBudgetStartDate(resourceId, currentMonth, {
      tokenRunner,
      async fetchImpl() {
        throw new Error('network details must not be returned');
      },
    }),
    /lookup failed before deployment/,
  );
  await assert.rejects(
    lookupBudgetStartDate(resourceId, currentMonth, {
      tokenRunner() {
        return { status: 1, stdout: '', stderr: 'authorization details must not be returned' };
      },
      async fetchImpl() {
        assert.fail('not called');
      },
    }),
    /authentication failed before deployment/,
  );
  await assert.rejects(
    lookupBudgetStartDate(resourceId, currentMonth, {
      tokenRunner,
      async fetchImpl() {
        return {
          status: 200,
          async json() {
            throw new Error('malformed');
          },
        };
      },
    }),
    /malformed JSON/,
  );
  assert.throws(
    () =>
      resolveBudgetStartDate(currentMonth, 200, {
        properties: { timePeriod: { startDate: '2026-07-02T00:00:00Z' } },
      }),
    /Existing Azure budget start date/,
  );
  await assert.rejects(
    lookupBudgetStartDate('/subscriptions/not-a-resource', currentMonth, {
      tokenRunner() {
        assert.fail('not called');
      },
    }),
    /resource ID is invalid/,
  );
});
