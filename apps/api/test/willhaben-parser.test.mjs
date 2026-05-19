import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
import { parseSearchHtml,parseListingHtml } from '../dist/shared/willhaben/parser.js';
const s=fs.readFileSync('apps/api/test/fixtures/willhaben/search-next-data.html','utf8'); const l=fs.readFileSync('apps/api/test/fixtures/willhaben/listing-next-data.html','utf8');
test('parser',()=>{assert.equal(parseSearchHtml(s)[0].listingId,'1993072190'); assert.equal(parseListingHtml(l).listingId,'1993072190'); assert.throws(()=>parseSearchHtml('<html></html>'));});
