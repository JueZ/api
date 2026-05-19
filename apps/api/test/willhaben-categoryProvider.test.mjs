import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotWillhabenCategoryProvider } from '../dist/shared/willhaben/categoryProvider.js';

test('snapshot provider basic traversal and search', () => {
  const p = new SnapshotWillhabenCategoryProvider();
  const flat = p.getFlatCategories();
  assert.ok(flat.length > 0);
  assert.ok(p.findCategoryByCodePath(['MARKETPLACE','GAMES_CONSOLES','GAMES','NINTENDO_GAMES']));
  assert.ok(p.searchCategories('nintendo').length > 0);
});
