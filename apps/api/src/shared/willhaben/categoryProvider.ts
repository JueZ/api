import snapshot from './categories.snapshot.json' with { type: 'json' };
import type { WillhabenCategoryNode } from './types.js';

function slugify(parts: string[]): string {
  return parts.join('-').toLowerCase().replace(/_/g, '-');
}

export function flattenCategories(node: WillhabenCategoryNode, path: string[] = [], labels: string[] = []): any[] {
  const nextPath = [...path, node.code];
  const nextLabels = [...labels, node.label];
  const current = {
    slug: slugify(nextPath.slice(1)),
    code: node.code,
    label: node.label,
    treeId: node.treeId,
    path: nextPath,
    labels: nextLabels,
    level: Math.max(0, nextPath.length - 2),
    isLeaf: node.children.length === 0,
    aliases: node.label.toLowerCase().split(/\W+/).filter(Boolean),
    attributeReferences: node.attributeReferences,
  };
  return [current, ...node.children.flatMap((child) => flattenCategories(child, nextPath, nextLabels))];
}

export class SnapshotWillhabenCategoryProvider {
  tree = snapshot as any;
  getCategoryTree() { return this.tree; }
  getFlatCategories() { return flattenCategories(this.tree.categoryNode).filter((c) => c.path.length > 1); }
  findCategoryByCodePath(path: string[]) { return this.getFlatCategories().find((x) => x.path.join('/') === path.join('/')) ?? null; }
  searchCategories(query: string) {
    const q = query.toLowerCase();
    return this.getFlatCategories().filter((x) => [x.code, x.label, x.slug, ...(x.aliases ?? [])].some((v: string) => v.toLowerCase().includes(q)));
  }
}
