import { describe, expect, it } from 'vitest';

import {
  applyProjectOrder,
  normalizeProjectOrder,
} from '../electron/core/project/project-order';

interface Item {
  id: string;
  label: string;
}

const items = (...ids: string[]): Item[] => ids.map((id) => ({ id, label: `项目 ${id}` }));

describe('项目列表排序（拖拽排序）', () => {
  it('顺序表为空时原样返回（保持后端既有排序）', () => {
    const list = items('a', 'b', 'c');
    expect(applyProjectOrder(list, []).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('按顺序表排列', () => {
    expect(applyProjectOrder(items('a', 'b', 'c'), ['c', 'a', 'b']).map((i) => i.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('顺序表只覆盖一部分时，其余保持原有相对次序并排在后面', () => {
    expect(
      applyProjectOrder(items('a', 'b', 'c', 'd'), ['d', 'b']).map((i) => i.id)
    ).toEqual(['d', 'b', 'a', 'c']);
  });

  it('顺序表里的失效 id 不影响结果（删项目 / 换目录后）', () => {
    expect(
      applyProjectOrder(items('a', 'b'), ['ghost', 'b', 'a']).map((i) => i.id)
    ).toEqual(['b', 'a']);
  });

  it('不修改传入数组', () => {
    const list = items('a', 'b');
    applyProjectOrder(list, ['b', 'a']);
    expect(list.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('顺序归一化', () => {
  it('过滤未知 id、重复 id 与空值', () => {
    expect(normalizeProjectOrder(['a', 'b', 'c'], ['b', 'ghost', 'b', '', '  ', 'a'])).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('把「存在但没被列出」的项目补到末尾（新项目不会丢）', () => {
    expect(normalizeProjectOrder(['a', 'b', 'c'], ['c'])).toEqual(['c', 'a', 'b']);
  });

  it('传入空数组时等价于按已知 id 原顺序全量补齐', () => {
    expect(normalizeProjectOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});
