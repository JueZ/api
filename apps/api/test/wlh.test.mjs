import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { wlhSearchHandler, setWlhSearchServiceForTesting } from '../dist/functions/wlhSearch.js';
import { handler as wlhCategoriesHandler, setWlhCategoryServiceForTesting } from '../dist/functions/wlhCategories.js';
import { setWlhOfferServiceForTesting } from '../dist/functions/wlhOffer.js';
import { WlhService, searchUrlForCategory, wlhPathFromStoredUrl } from '../dist/shared/wlh/service.js';

const cfg = { baseUrl: 'https://example.test', storageAccountName: 'x', categoryBlobContainer: 'wlh-reference', categoryBlobName: 'categories-marketplace.v1.json.gz', categoryFile: '', categoryVersion: 'v1' };
const idx = { byId: new Map([['0',{id:'0',label:'root',path:'/',depth:0,hasChildren:true}],['10', { id: '10', label: 'Cars', path: '/cars', depth: 1, parentId: '0', hasChildren: true, url: 'https://evil.example/cars?x=1' }],['11',{id:'11',label:'SUV',path:'/cars/suv',depth:2,parentId:'10',hasChildren:false}]]), childrenByParentId: new Map([['0',[{id:'10',label:'Cars',path:'/cars',depth:1,parentId:'0',hasChildren:true}]],['10',[{id:'11',label:'SUV',path:'/cars/suv',depth:2,parentId:'10',hasChildren:false}]]]), top: [{ id: '10', label: 'Cars', path: '/cars', depth: 1, parentId: '0', hasChildren: true }] };

test('stored category url origin is discarded', () => {
  assert.equal(wlhPathFromStoredUrl('https://evil.example/a/b?x=1'), '/a/b');
  assert.equal(searchUrlForCategory('https://evil.example/a/b?x=1', cfg.baseUrl).toString(), 'https://example.test/a/b');
});

test('search payload rowsFound/rowsRequested/rowsReturned/pageRequested and date-string attributes', async () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { searchResult: { rowsFound: 2, rowsRequested: 30, rowsReturned: 2, pageRequested: 1, advertSummaryList: { advertSummary: [{ id: '1', attributes: [{ name: 'HEADING', values: ['red bike'] }, { name: 'BODY_DYN', values: ['fast'] }, { name: 'SEO_URL', values: ['/ad/1'] }, { name: 'PUBLISHED_String', values: ['2026-05-20T10:00:00Z'] }, { name: 'CHANGED_String', values: ['2026-05-21T10:00:00Z'] }], advertImageList: { images: [{ mainImageUrl: 'u1' }] } }, { id: '2', attributes: [{ name: 'HEADING', values: ['blue car'] }, { name: 'BODY_DYN', values: ['slow'] }] }] } } } } })}</script>`;
  let called = '';
  const s = new WlhService({ config: cfg, getIndex: async () => idx, fetchImpl: async (input) => { called = String(input); return new Response(html, { status: 200 }); } });
  const out = await s.search({ categoryId: '10', condition: 'used', delivery: ['pickup', 'shipping'], requiredTerms: ['bike'] });
  assert.match(called, /treeAttributes=23/); assert.match(called, /treeAttributes=2536/); assert.match(called, /treeAttributes=2537/);
  assert.equal(out.rowsFound, 2); assert.equal(out.rowsReturned, 2); assert.equal(out.filteredRowsReturned, 1);
  assert.ok(out.results[0].publishedAt?.startsWith('2026-05-20'));
});

test('detail uses advert status/address/contact and paylivery false string not truthy', async () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { advertDetails: { attributes: [{ name: 'ADID', values: ['abc'] }, { name: 'HEADING', values: ['T'] }, { name: 'DESCRIPTION', values: ['<b>x</b>'] }, { name: 'PRICE', values: ['74,99'] }, { name: 'PAYLIVERY', values: ['false'] }], advertStatus: { id: 'ACTIVE' }, advertAddressDetails: { postCode: '1010', postalName: 'Vienna', district: 'D', province: 'W' }, advertContactDetails: { contactDetail:[{contactDetailField:[{name:'postalName',value:'Vienna2'}]}] }, advertImageList: { advertImage: [{ referenceImageUrl: 'i1' }, { mainImageUrl: 'i1' }, { thumbnailImageUrl: 'i2' }] }, p2ppOptions: { paymentOptions:[{id:'p'}], deliveryOptions: [{ carrier: { description: 'C' }, parcelSize: { size: 'M', longName: 'Medium' }, price: '1', originalPrice: '2', description: 'd', deliveryDays: 2, parcelInsurance: true }] } } } } })}</script>`;
  const s = new WlhService({ config: cfg, getIndex: async () => idx, fetchImpl: async () => new Response(html, { status: 200 }) });
  const d = await s.offer('abc');
  assert.equal(d.priceAmount, 74.99); assert.equal(d.status, 'ACTIVE'); assert.equal(d.location, 'Vienna'); assert.equal(d.paylivery, true); assert.equal(d.images.length, 2);
});

test('search listing SEO_URL prepends /iad for kaufen-und-verkaufen paths', async () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { searchResult: { rowsFound: 1, rowsRequested: 30, rowsReturned: 1, pageRequested: 1, advertSummaryList: { advertSummary: [{ id: '997764051', attributes: [{ name: 'HEADING', values: ['super mario'] }, { name: 'SEO_URL', values: ['/kaufen-und-verkaufen/d/super-mario-3d-all-stars-nintendo-switch-997764051'] }] }] } } } } })}</script>`;
  const s = new WlhService({ config: cfg, getIndex: async () => idx, fetchImpl: async () => new Response(html, { status: 200 }) });
  const out = await s.search({ categoryId: '10' });
  assert.equal(out.results[0].url, 'https://example.test/iad/kaufen-und-verkaufen/d/super-mario-3d-all-stars-nintendo-switch-997764051');
});

test('invalid JSON on WLH search returns RepairableProblem', async () => {
  await withWlhEnv({ AUTH_ENABLED: 'false' }, async () => {
    const response = await wlhSearchHandler(requestThatThrowsJson(), contextStub());
    assertRepairableProblem(response, 400, 'postWlhSearch', 'caller_contract_violation');
  });
});

test('invalid search body returns RepairableProblem', async () => {
  await withWlhEnv({ AUTH_ENABLED: 'false' }, async () => {
    const s = new WlhService({ config: cfg, getIndex: async () => idx, fetchImpl: async () => new Response('', { status: 500 }) });
    setWlhSearchServiceForTesting(s);
    const response = await wlhSearchHandler(requestWithJson({ categoryId: '10', condition: 'broken' }), contextStub());
    assertRepairableProblem(response, 400, 'postWlhSearch', 'caller_contract_violation');
    assert.equal(response.jsonBody.invalid_fields[0].path, 'condition');
  });
});

test('unknown category returns RepairableProblem', async () => {
  await withWlhEnv({ AUTH_ENABLED: 'false' }, async () => {
    setWlhCategoryServiceForTesting(new WlhService({ config: cfg, getIndex: async () => idx }));
    const response = await wlhCategoryHandlerRequest('GET', 'https://api.test/api/wlh/categories/999', { categoryId: '999' });
    assertRepairableProblem(response, 404, 'getWlhCategory', 'caller_contract_violation');
  });
});

test('upstream 429 maps to capacity_or_timeout', async () => {
  await withWlhEnv({ AUTH_ENABLED: 'false' }, async () => {
    const s = new WlhService({ config: cfg, getIndex: async () => idx, fetchImpl: async () => new Response('<html></html>', { status: 429 }) });
    setWlhSearchServiceForTesting(s);
    const response = await wlhSearchHandler(requestWithJson({ categoryId: '10' }), contextStub());
    assertRepairableProblem(response, 429, 'postWlhSearch', 'capacity_or_timeout');
  });
});

test('parse failure maps to version_skew or dependency_failure', async () => {
  await withWlhEnv({ AUTH_ENABLED: 'false' }, async () => {
    const s = new WlhService({ config: cfg, getIndex: async () => idx, fetchImpl: async () => new Response('<html>shape changed</html>', { status: 200 }) });
    setWlhSearchServiceForTesting(s);
    const response = await wlhSearchHandler(requestWithJson({ categoryId: '10' }), contextStub());
    assert.equal(response.status, 502);
    assert.equal(response.headers['Content-Type'], 'application/problem+json');
    assert.ok(['version_skew', 'dependency_failure'].includes(response.jsonBody.classification));
    assert.equal(response.jsonBody.operation_id, 'postWlhSearch');
  });
});

test('401/403 WLH auth failures keep auth envelope', async () => {
  await withWlhEnv({ AUTH_ENABLED: 'true' }, async () => {
    const unauthorized = await wlhSearchHandler(requestWithJson({ categoryId: '10' }, null), contextStub());
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.jsonBody.error.code, 'unauthorized');
    assert.equal(unauthorized.jsonBody.rec_version, undefined);
    assert.notEqual(unauthorized.headers['Content-Type'], 'application/problem+json');
  });

  const { server, issuer, jwksUri, privateKey, kid } = await startJwksServer();
  try {
    const token = await new SignJWT({ sub: 'blocked-sub', oid: 'blocked-oid', scp: 'api.access' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(issuer)
      .setAudience('api://catalogue-test')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await withWlhEnv({
      AUTH_ENABLED: 'true',
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: 'api://catalogue-test',
      OIDC_JWKS_URI: jwksUri,
      OIDC_ALLOWED_OBJECT_IDS: 'allowed-oid',
      OIDC_ALLOWED_SUBJECTS: '',
      OIDC_ALLOWED_APP_OBJECT_IDS: '',
      OIDC_ALLOWED_CLIENT_IDS: '',
    }, async () => {
      const forbidden = await wlhSearchHandler(requestWithJson({ categoryId: '10' }, `Bearer ${token}`), contextStub());
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.jsonBody.error.code, 'forbidden');
      assert.equal(forbidden.jsonBody.rec_version, undefined);
      assert.notEqual(forbidden.headers['Content-Type'], 'application/problem+json');
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

async function wlhCategoryHandlerRequest(method, url, params) {
  return wlhCategoriesHandler({ method, url, params, headers: new Headers(), json: async () => ({}) }, contextStub());
}

function requestWithJson(body, authorization = undefined) {
  return {
    method: 'POST',
    url: 'https://api.test/api/wlh/search',
    params: {},
    headers: new Headers(authorization === undefined ? {} : authorization === null ? {} : { authorization }),
    json: async () => body,
  };
}

function requestThatThrowsJson(authorization = undefined) {
  return {
    method: 'POST',
    url: 'https://api.test/api/wlh/search',
    params: {},
    headers: new Headers(authorization === undefined ? {} : authorization === null ? {} : { authorization }),
    json: async () => { throw new Error('invalid json'); },
  };
}

function contextStub() {
  return { invocationId: 'invocation-test', warn: () => undefined };
}

function assertRepairableProblem(response, status, operationId, classification) {
  assert.equal(response.status, status);
  assert.equal(response.headers['Content-Type'], 'application/problem+json');
  assert.equal(response.jsonBody.rec_version, '1.0');
  assert.equal(response.jsonBody.operation_id, operationId);
  assert.equal(response.jsonBody.classification, classification);
  assert.equal(response.jsonBody.analysis_mode, 'deterministic');
  assert.ok(response.jsonBody.diagnostic_id.startsWith('diag_'));
  assert.ok(response.jsonBody.retry_policy);
  assert.ok(response.jsonBody.caller_instruction);
  assert.ok(response.jsonBody.safe_debug_summary);
  const serialized = JSON.stringify(response.jsonBody);
  assert.doesNotMatch(serialized, /<html|Authorization|Bearer|access_token|client_secret|raw upstream response body/i);
}

async function withWlhEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    setWlhSearchServiceForTesting(null);
    setWlhCategoryServiceForTesting(null);
    setWlhOfferServiceForTesting(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function startJwksServer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const kid = 'wlh-test-key';
  jwk.kid = kid;
  jwk.alg = 'RS256';
  const server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, issuer: 'https://login.example.test/tenant/v2.0', jwksUri: `http://127.0.0.1:${port}/jwks`, privateKey, kid };
}
