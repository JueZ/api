import test from 'node:test'; import assert from 'node:assert/strict';
import { WillhabenService } from '../dist/shared/willhaben/service.js';
process.env.WILLHABEN_ENABLED='true';
test('categories+schema',()=>{const s=new WillhabenService(); assert.ok(s.listCategories().categories.length>=9); assert.equal(s.getFilterSchema('games-consoles').filters.pagination.maxLimit>0,true); assert.throws(()=>s.getFilterSchema('nope'));});
