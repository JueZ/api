export function normalizeStock(payload) {
  return {
    items: payload.items.map(({ id, quantity }) => ({ id, quantity })),
    nextCursor: payload.nextCursor ?? null,
  };
}
