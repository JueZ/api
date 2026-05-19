import test from 'node:test'; import assert from 'node:assert/strict';
import { willhabenSearchHandler } from '../dist/functions/willhabenSearch.js';
test('options',async()=>{const r=await willhabenSearchHandler({method:'OPTIONS'} ,{}); assert.equal(r.status,204);});
