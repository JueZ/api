import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { readWlhConfig } from './config.js';
import type { WlhCategory } from './types.js';

export interface CategoryIndex {
  byId: Map<string, WlhCategory>;
  childrenByParentId: Map<string, WlhCategory[]>;
  top: WlhCategory[];
}
let cached: CategoryIndex | null = null;
export async function getCategoryIndex(): Promise<CategoryIndex> {
  if (cached) return cached;
  const raw = await loadRaw();
  cached = buildIndex(raw);
  return cached;
}
export function resetCategoryStoreForTesting() {
  cached = null;
}
export function setCategoryIndexForTesting(index: CategoryIndex | null) {
  cached = index;
}

async function loadRaw(): Promise<any[]> {
  const cfg = readWlhConfig();
  let text = '';
  if (cfg.categoryFile) text = await readFile(cfg.categoryFile, 'utf8');
  else {
    const url = `https://${cfg.storageAccountName}.blob.core.windows.net`;
    const bc = new BlobServiceClient(url, new DefaultAzureCredential())
      .getContainerClient(cfg.categoryBlobContainer)
      .getBlobClient(cfg.categoryBlobName);
    const dl = await bc.download();
    const chunks: Buffer[] = [];
    for await (const ch of dl.readableStreamBody!) chunks.push(Buffer.from(ch));
    const buf = Buffer.concat(chunks);
    text = cfg.categoryBlobName.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.categories) ? parsed.categories : [];
}
function buildIndex(rows: any[]): CategoryIndex {
  const byId = new Map<string, WlhCategory>();
  const childrenByParentId = new Map<string, WlhCategory[]>();
  const sourceById = new Map<string, any>();
  for (const row of rows) {
    const id = String(row.id);
    sourceById.set(id, row);
    const c: WlhCategory = {
      id,
      label: String(row.label ?? ''),
      path: String(row.path ?? ''),
      depth: Number(row.depth ?? 0),
      parentId: row.parent_id != null ? String(row.parent_id) : undefined,
      hitCount: typeof row.hits === 'number' ? row.hits : undefined,
      hasChildren: Array.isArray(row.children) && row.children.length > 0,
      url: typeof row.url === 'string' ? row.url : undefined,
    };
    byId.set(id, c);
  }
  for (const [id, row] of sourceById) {
    const ids = Array.isArray(row.children) ? row.children.map((x: any) => String(x)) : [];
    childrenByParentId.set(id, ids.map((cid: string) => byId.get(cid)).filter(Boolean) as WlhCategory[]);
  }
  const top = childrenByParentId.get('0') ?? [];
  return { byId, childrenByParentId, top };
}
