import test from 'node:test'; import assert from 'node:assert/strict';
import { WillhabenService } from '../dist/shared/willhaben/service.js';
process.env.WILLHABEN_ENABLED='true';
test('categories+schema',()=>{const s=new WillhabenService(); assert.ok(s.listCategories().categories.length>=1); assert.equal(s.getFilterSchema(['MARKETPLACE','GAMES_CONSOLES','GAMES','NINTENDO_GAMES']).filters.pagination.maxLimit>0,true); assert.throws(()=>s.getFilterSchema('nope'));});
