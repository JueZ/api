import test from 'node:test'; import assert from 'node:assert/strict';
import { buildSearchUrl } from '../dist/shared/willhaben/urlBuilder.js';
test('url mapping',()=>{const u=buildSearchUrl({categorySlug:'games-consoles',keywords:['Nintendo Switch'],price:{max:25},condition:['used','like_new'],fulfillment:['shipping','paylivery'],pagination:{page:1,limit:30}}); assert.match(u,/keyword=/); assert.match(u,/PRICE_TO=25/); assert.match(u,/rows=30/);});
