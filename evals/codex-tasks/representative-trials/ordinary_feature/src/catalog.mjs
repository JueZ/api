export function listItems(items) {
  return items.filter((item) => !item.archived);
}
