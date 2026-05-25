import test from 'node:test';
import assert from 'node:assert/strict';
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
