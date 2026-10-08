/**
 * 项目列表顺序（拖拽排序）。
 *
 * 顺序存在全局配置里（`config.projectOrder`），而不是写进每个项目清单：
 *   - 只影响界面展示，不属于项目业务数据；
 *   - 删项目 / 换数据目录迁移时不会牵连清单，缺失的 id 自动忽略；
 *   - 新项目排在末尾，符合直觉。
 * 全部为纯函数，便于单测。
 */

/** 按给定 id 顺序排列；不在顺序表里的项保持原有相对次序，统一排在后面 */
export function applyProjectOrder<T extends { id: string }>(
  items: T[],
  order: string[]
): T[] {
  if (!order.length) return [...items];
  const rank = new Map<string, number>();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });

  return items
    .map((item, index) => ({ item, index, rank: rank.get(item.id) }))
    .sort((a, b) => {
      const ar = a.rank ?? Number.MAX_SAFE_INTEGER;
      const br = b.rank ?? Number.MAX_SAFE_INTEGER;
      if (ar !== br) return ar - br;
      // 都不在顺序表里（或同一个 rank）时保持原有次序，保证排序稳定
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

/**
 * 归一化用户拖出来的顺序：丢掉不存在的 id 与重复项，
 * 再把「存在但没被列进去」的项目按原次序补到末尾。
 */
export function normalizeProjectOrder(knownIds: string[], incoming: string[]): string[] {
  const known = new Set(knownIds);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of incoming ?? []) {
    const id = String(raw ?? '').trim();
    if (!id || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of knownIds) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
