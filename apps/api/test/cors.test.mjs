import assert from 'node:assert/strict';
import test from 'node:test';
import { createCorsHeaders } from '../dist/shared/http/cors.js';
import { helloHandler } from '../dist/functions/hello.js';

const allowedOrigin = 'https://app.example.test';
const evilOrigin = 'https://evil.example';

function request(method = 'OPTIONS', origin = allowedOrigin) {
  return {
    method,
    headers: new Headers(origin ? { Origin: origin } : {}),
  };
}

function context() {
  return { invocationId: 'cors-test', warn: () => undefined };
}

async function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('createCorsHeaders reflects configured allowed origins and adds Vary', () => {
  const headers = createCorsHeaders(request('OPTIONS', allowedOrigin), { methods: ['GET', 'OPTIONS'] }, {
    API_CORS_ALLOWED_ORIGINS: `${allowedOrigin}, https://admin.example.test`,
  });

  assert.equal(headers['Access-Control-Allow-Origin'], allowedOrigin);
  assert.equal(headers.Vary, 'Origin');
  assert.equal(headers['Access-Control-Allow-Methods'], 'GET, OPTIONS');
});

test('createCorsHeaders omits Access-Control-Allow-Origin for disallowed origins', () => {
  const headers = createCorsHeaders(request('OPTIONS', evilOrigin), { methods: ['GET', 'OPTIONS'] }, {
    API_CORS_ALLOWED_ORIGINS: allowedOrigin,
  });

  assert.equal(headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(headers['Access-Control-Allow-Headers'], 'Authorization, Content-Type');
});

test('createCorsHeaders preserves explicit wildcard fallback for unconfigured local environments', () => {
  const headers = createCorsHeaders(request('OPTIONS', evilOrigin), { methods: ['GET', 'OPTIONS'] }, {});

  assert.equal(headers['Access-Control-Allow-Origin'], '*');
});

test('helloHandler OPTIONS uses configured CORS allowlist', async () => {
  await withEnv({ API_CORS_ALLOWED_ORIGINS: allowedOrigin }, async () => {
    const allowedResponse = await helloHandler(request('OPTIONS', allowedOrigin), context());
    const deniedResponse = await helloHandler(request('OPTIONS', evilOrigin), context());

    assert.equal(allowedResponse.status, 204);
    assert.equal(allowedResponse.headers['Access-Control-Allow-Origin'], allowedOrigin);
    assert.equal(allowedResponse.headers.Vary, 'Origin');
    assert.equal(deniedResponse.status, 204);
    assert.equal(deniedResponse.headers['Access-Control-Allow-Origin'], undefined);
  });
});

test('helloHandler auth errors preserve WWW-Authenticate and allowed CORS headers', async () => {
  await withEnv({ API_CORS_ALLOWED_ORIGINS: allowedOrigin, AUTH_ENABLED: 'true' }, async () => {
    const response = await helloHandler(request('GET', allowedOrigin), context());

    assert.equal(response.status, 401);
    assert.equal(response.headers['Access-Control-Allow-Origin'], allowedOrigin);
    assert.match(response.headers['WWW-Authenticate'], /^Bearer/);
  });
});
