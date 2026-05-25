import test from 'node:test';
import assert from 'node:assert/strict';
import { WlhService, searchUrlForCategory, wlhPathFromStoredUrl } from '../dist/shared/wlh/service.js';

const cfg = { baseUrl: 'https://example.test', storageAccountName: 'x', categoryBlobContainer: 'wlh-reference', categoryBlobName: 'categories-marketplace.v1.json.gz', categoryFile: '', categoryVersion: 'v1' };
const idx = { byId: new Map([['10', { id: '10', label: 'Cars', path: '/cars', depth: 1, parentId: '0', hasChildren: true, url: 'https://evil.example/cars?x=1' }]]), childrenByParentId: new Map([['0', [{ id: '10', label: 'Cars', path: '/cars', depth: 1, parentId: '0', hasChildren: true }]], ['10', []]]), top: [{ id: '10', label: 'Cars', path: '/cars', depth: 1, parentId: '0', hasChildren: true }] };

test('stored category url origin is discarded', () => {
  assert.equal(wlhPathFromStoredUrl('https://evil.example/a/b?x=1'), '/a/b');
  assert.equal(searchUrlForCategory('https://evil.example/a/b?x=1', cfg.baseUrl).toString(), 'https://example.test/a/b');
});

test('search emits repeated treeAttributes and requiredTerms filter', async () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { searchResult: { numFound: 2, advertSummaryList: { advertSummary: [{ id: '1', attributes: [{ name: 'HEADING', values: ['red bike'] }, { name: 'BODY_DYN', values: ['fast'] }, { name: 'SEO_URL', values: ['/ad/1'] }], advertImageList: { images: [{ mainImageUrl: 'u1' }] } }, { id: '2', attributes: [{ name: 'HEADING', values: ['blue car'] }, { name: 'BODY_DYN', values: ['slow'] }] }] } } } } })}</script>`;
  let called = '';
  const s = new WlhService({ config: cfg, getIndex: async () => idx, fetchImpl: async (input) => { called = String(input); return new Response(html, { status: 200 }); } });
  const out = await s.search({ categoryId: '10', condition: 'used', delivery: ['pickup', 'shipping'], requiredTerms: ['bike'] });
  assert.match(called, /treeAttributes=23/);
  assert.match(called, /treeAttributes=2536/);
  assert.match(called, /treeAttributes=2537/);
  assert.equal(out.filteredRowsReturned, 1);
  assert.ok(out.results[0].url.startsWith('https://example.test/'));
});

test('detail parsing supports attributes and p2p paylivery', async () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { advertDetails: { attributes: [{ name: 'ADID', values: ['abc'] }, { name: 'HEADING', values: ['T'] }, { name: 'DESCRIPTION', values: ['<b>x</b>'] }, { name: 'PRICE', values: ['74,99'] }, { name: 'POSTCODE', values: ['1010'] }], advertImageList: { advertImage: [{ referenceImageUrl: 'i1' }, { mainImageUrl: 'i1' }, { thumbnailImageUrl: 'i2' }] }, p2ppOptions: { deliveryOptions: [{ carrier: 'C', parcelSize: 'M', price: '1', deliveryDays: 2, insurance: true }] } } } } })}</script>`;
  let called = '';
  const s = new WlhService({ config: cfg, getIndex: async () => idx, fetchImpl: async (input) => { called = String(input); return new Response(html, { status: 200 }); } });
  const d = await s.offer('abc');
  assert.match(called, /\/iad\/object\?adId=abc/);
  assert.equal(d.priceAmount, 74.99);
  assert.equal(d.paylivery, true);
  assert.equal(d.images.length, 2);
});
