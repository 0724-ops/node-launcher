import { describe, expect, it } from 'vitest';

import type { ProjectGroup, ProjectSummary } from '../electron/types';
import {
  UNGROUPED_ID,
  buildGroupedView,
  createGroup,
  deleteGroup,
  isValidGroupId,
  moveInstance,
  newGroupId,
  normalizeGroupsFile,
  normalizeRepo,
  setGroupCollapsed,
  toGroupsFile,
  updateGroup,
} from '../electron/core/project/group-logic';

/** 造最小项目摘要（真实字段由类型约束，测试只关心 id） */
function proj(id: string, name = id): ProjectSummary {
  return { id, name, running: false, phase: 'idle', depsState: 'ready' } as unknown as ProjectSummary;
}

/** 造母栏 */
function grp(id: string, instanceIds: string[] = [], patch: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    githubRepo: '',
    instanceIds,
    lastSeenTag: '',
    lastCheckedAt: '',
    collapsed: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...patch,
  };
}

const ids = (list: ProjectSummary[]): string[] => list.map((item) => item.id);

describe('母栏 id', () => {
  it('白名单格式：接受合法 id，拒绝过短 / 大写 / 缺前缀 / 非字符串', () => {
    expect(isValidGroupId('group_abcd')).toBe(true);
    expect(isValidGroupId('group_a1b2c3d4e5')).toBe(true);

    expect(isValidGroupId('group_abc')).toBe(false);
    expect(isValidGroupId('group_')).toBe(false);
    expect(isValidGroupId('GROUP_ABCD')).toBe(false);
    expect(isValidGroupId('group_ABCD')).toBe(false);
    expect(isValidGroupId('abcd')).toBe(false);
    expect(isValidGroupId('group_abc-1')).toBe(false);
    expect(isValidGroupId(123)).toBe(false);
    expect(isValidGroupId(null)).toBe(false);
    expect(isValidGroupId(undefined)).toBe(false);
  });

  it('newGroupId 生成 10 位后缀且自身合法', () => {
    const id = newGroupId();
    expect(id).toMatch(/^group_[a-z0-9]{10}$/);
    expect(isValidGroupId(id)).toBe(true);
  });
});

describe('仓库地址归一化', () => {
  it('清洗后不是严格 owner/repo 的一律拒绝', () => {
    const bad: unknown[] = [
      'owner/repo/../../../etc',
      'owner/repo?x=1',
      'owner/repo#a',
      'owner repo',
      '../../x',
      'justowner',
      'a/b/c',
      'owner/..',
      'https://github.com/owner/repo/tree/main',
      '',
      null,
      123,
    ];
    for (const input of bad) {
      expect(normalizeRepo(input)).toBe('');
    }
  });

  it('接受常见写法并保留原始大小写', () => {
    expect(normalizeRepo('owner/repo')).toBe('owner/repo');
    expect(normalizeRepo('Owner/Repo')).toBe('Owner/Repo');
    expect(normalizeRepo('owner/repo.git')).toBe('owner/repo');
    expect(normalizeRepo('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(normalizeRepo('https://github.com/owner/repo')).toBe('owner/repo');
    expect(normalizeRepo('https://www.github.com/owner/repo/')).toBe('owner/repo');
    expect(normalizeRepo('github.com/owner/repo')).toBe('owner/repo');
  });
});

describe('母栏文件归一化', () => {
  const known = ['p1', 'p2', 'p3'];

  it('非对象 / groups 非数组 / 杂项输入都返回空数组且不抛错', () => {
    expect(normalizeGroupsFile(null, known)).toEqual([]);
    expect(normalizeGroupsFile(123, known)).toEqual([]);
    expect(normalizeGroupsFile('x', known)).toEqual([]);
    expect(normalizeGroupsFile({}, known)).toEqual([]);
    expect(normalizeGroupsFile({ groups: 'x' }, known)).toEqual([]);
    expect(normalizeGroupsFile([{ id: 'group_abcd' }], known)).toEqual([]);
    expect(normalizeGroupsFile({ groups: [null, 1, {}] }, known)).toEqual([]);
  });

  it('丢弃非法 id 与重复 id（保留第一条）', () => {
    const out = normalizeGroupsFile(
      {
        groups: [
          { id: 'bad' },
          { id: 'group_aaaa', name: '第一' },
          { id: 'group_aaaa', name: '重复' },
          { id: 'group_bbbb', name: '第二' },
        ],
      },
      known,
      '2024-05-01T00:00:00.000Z'
    );
    expect(out.map((g) => g.id)).toEqual(['group_aaaa', 'group_bbbb']);
    expect(out[0].name).toBe('第一');
  });

  it('名称为空用默认名，超长截断到 40 字', () => {
    const out = normalizeGroupsFile(
      { groups: [{ id: 'group_aaaa', name: '   ' }, { id: 'group_bbbb', name: 'x'.repeat(60) }] },
      known,
      '2024-05-01T00:00:00.000Z'
    );
    expect(out[0].name).toBe('未命名母栏');
    expect(out[1].name).toHaveLength(40);
  });

  it('成员只保留已知项目，栏内去重，非字符串一律丢弃', () => {
    const out = normalizeGroupsFile(
      {
        groups: [
          {
            id: 'group_aaaa',
            instanceIds: ['p1', 'p1', 'ghost', '', '  ', null, 7, {}, [], 'p2'],
          },
        ],
      },
      known,
      '2024-05-01T00:00:00.000Z'
    );
    expect(out[0].instanceIds).toEqual(['p1', 'p2']);
  });

  it('跨母栏去重：已归属前一个母栏的 id 不再出现在后面的母栏', () => {
    const out = normalizeGroupsFile(
      {
        groups: [
          { id: 'group_aaaa', instanceIds: ['p1', 'p2'] },
          { id: 'group_bbbb', instanceIds: ['p2', 'p3'] },
        ],
      },
      known,
      '2024-05-01T00:00:00.000Z'
    );
    expect(out[0].instanceIds).toEqual(['p1', 'p2']);
    expect(out[1].instanceIds).toEqual(['p3']);
  });

  it('仓库归一化、collapsed 布尔化、tag / 时间取字符串', () => {
    const out = normalizeGroupsFile(
      {
        groups: [
          {
            id: 'group_aaaa',
            githubRepo: 'https://github.com/owner/repo.git',
            collapsed: 'yes',
            lastSeenTag: 5,
            lastCheckedAt: null,
          },
          { id: 'group_bbbb', collapsed: 0 },
        ],
      },
      known,
      '2024-05-01T00:00:00.000Z'
    );
    expect(out[0].githubRepo).toBe('owner/repo');
    expect(out[0].collapsed).toBe(true);
    expect(out[0].lastSeenTag).toBe('5');
    expect(out[0].lastCheckedAt).toBe('');
    expect(out[1].collapsed).toBe(false);
  });

  it('createdAt 保留非空字符串，否则回落到注入的 now', () => {
    const out = normalizeGroupsFile(
      {
        groups: [
          { id: 'group_aaaa', createdAt: '2023-03-03T00:00:00.000Z' },
          { id: 'group_bbbb', createdAt: '   ' },
          { id: 'group_cccc' },
        ],
      },
      known,
      '2024-05-01T00:00:00.000Z'
    );
    expect(out.map((g) => g.createdAt)).toEqual([
      '2023-03-03T00:00:00.000Z',
      '2024-05-01T00:00:00.000Z',
      '2024-05-01T00:00:00.000Z',
    ]);
  });

  it('深层杂项输入不抛错且不改动入参对象', () => {
    const raw = {
      schema: 1,
      groups: [
        { id: 'group_aaaa', name: '甲', instanceIds: ['p1', { deep: [1, 2, { x: null }] }] },
        { id: 'group_bbbb', nested: { a: [{ b: 1 }] } },
      ],
    };
    const snapshot = JSON.stringify(raw);
    const out = normalizeGroupsFile(raw, known, '2024-05-01T00:00:00.000Z');
    expect(out).toHaveLength(2);
    expect(out[0].instanceIds).toEqual(['p1']);
    expect(JSON.stringify(raw)).toBe(snapshot);
    expect(raw.groups[0].instanceIds).toHaveLength(2);
  });
});

describe('母栏增删改', () => {
  const base = [grp('group_aaaa', ['p1'], { name: '甲' }), grp('group_bbbb', ['p2'], { name: '乙' })];

  it('createGroup 追加到末尾并填默认值，不修改原数组', () => {
    const out = createGroup(base, {
      id: 'group_cccc',
      name: '  新栏  ',
      githubRepo: 'git@github.com:Owner/Repo.git',
      now: '2024-06-06T00:00:00.000Z',
    });
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({
      id: 'group_cccc',
      name: '新栏',
      githubRepo: 'Owner/Repo',
      instanceIds: [],
      lastSeenTag: '',
      lastCheckedAt: '',
      collapsed: false,
      createdAt: '2024-06-06T00:00:00.000Z',
    });
    expect(base).toHaveLength(2);
  });

  it('createGroup 对非法 id 抛错', () => {
    expect(() => createGroup(base, { id: 'bad', name: 'x' })).toThrow('非法母栏 ID');
  });

  it('updateGroup 只改传入字段并归一化，未知 id 时其余母栏不变', () => {
    const renamed = updateGroup(base, 'group_aaaa', { name: '  ' });
    expect(renamed[0].name).toBe('未命名母栏');
    expect(renamed[0].instanceIds).toEqual(['p1']);
    expect(renamed[0]).not.toBe(base[0]);
    expect(base[0].name).toBe('甲');

    const repoOnly = updateGroup(base, 'group_bbbb', { githubRepo: 'owner/repo?x=1' });
    expect(repoOnly[1].name).toBe('乙');
    expect(repoOnly[1].githubRepo).toBe('');
    expect(repoOnly[1].instanceIds).toEqual(['p2']);
    expect(repoOnly[1].collapsed).toBe(false);

    const missing = updateGroup(base, 'group_zzzz', { name: 'x' });
    expect(missing).toHaveLength(2);
    expect(missing.map((g) => g.name)).toEqual(['甲', '乙']);
    expect(base.map((g) => g.name)).toEqual(['甲', '乙']);
  });

  it('deleteGroup 移除母栏，其余不动也不改原数组', () => {
    const out = deleteGroup(base, 'group_aaaa');
    expect(out.map((g) => g.id)).toEqual(['group_bbbb']);
    expect(base).toHaveLength(2);
    expect(deleteGroup(base, 'group_zzzz').map((g) => g.id)).toEqual([
      'group_aaaa',
      'group_bbbb',
    ]);
  });

  it('setGroupCollapsed 布尔化设置，未知 id 时全部保持原值', () => {
    const out = setGroupCollapsed(base, 'group_bbbb', 1 as unknown as boolean);
    expect(out[1].collapsed).toBe(true);
    expect(base[1].collapsed).toBe(false);

    const missed = setGroupCollapsed(base, 'group_zzzz', true);
    expect(missed.map((g) => g.collapsed)).toEqual([false, false]);
    expect(missed[0].instanceIds).toEqual(['p1']);
  });
});

describe('实例移动', () => {
  const base = [grp('group_aaaa', ['p1', 'p2']), grp('group_bbbb', ['p3'])];

  it('跨母栏移动：从原母栏移除并追加到目标末尾', () => {
    const out = moveInstance(base, 'p1', 'group_bbbb');
    expect(out[0].instanceIds).toEqual(['p2']);
    expect(out[1].instanceIds).toEqual(['p3', 'p1']);
    expect(base[0].instanceIds).toEqual(['p1', 'p2']);
  });

  it('移到 null / UNGROUPED_ID / 未知母栏 id 都变成未分组', () => {
    for (const target of [null, UNGROUPED_ID, 'group_zzzz', '']) {
      const out = moveInstance(base, 'p1', target);
      expect(out[0].instanceIds).toEqual(['p2']);
      expect(out[1].instanceIds).toEqual(['p3']);
    }
  });

  it('重复移动保持幂等（不会出现两份）', () => {
    const once = moveInstance(base, 'p1', 'group_bbbb');
    const twice = moveInstance(once, 'p1', 'group_bbbb');
    expect(twice[1].instanceIds).toEqual(['p3', 'p1']);
    expect(twice).toEqual(once);
  });

  it('未知实例 id 也会被放进目标母栏', () => {
    const out = moveInstance(base, 'p9', 'group_bbbb');
    expect(out[1].instanceIds).toEqual(['p3', 'p9']);
    expect(out[0].instanceIds).toEqual(['p1', 'p2']);
  });
});

describe('视图组装', () => {
  const groups = [
    grp('group_aaaa', ['b', 'a'], { name: '甲', collapsed: true }),
    grp('group_bbbb', [], { name: '乙' }),
  ];

  it('栏内沿用顺序表，未分组排在最后且同样遵守顺序表', () => {
    const view = buildGroupedView(
      groups,
      [proj('a'), proj('b'), proj('c'), proj('d')],
      ['d', 'b', 'a', 'c']
    );
    expect(ids(view.groups[0].projects)).toEqual(['b', 'a']);
    expect(ids(view.groups[1].projects)).toEqual([]);
    expect(ids(view.ungrouped)).toEqual(['d', 'c']);
    expect(view.groups[0].name).toBe('甲');
    expect(view.groups[0].collapsed).toBe(true);
    expect(view.groups[1].projects).toEqual([]);
  });

  it('同一 id 出现在两个母栏时只归第一个母栏', () => {
    const view = buildGroupedView(
      [grp('group_aaaa', ['p1']), grp('group_bbbb', ['p1', 'p2'])],
      [proj('p1'), proj('p2')],
      []
    );
    expect(ids(view.groups[0].projects)).toEqual(['p1']);
    expect(ids(view.groups[1].projects)).toEqual(['p2']);
    expect(view.ungrouped).toEqual([]);
  });

  it('空母栏照常返回；顺序表含失效 id 时忽略', () => {
    const view = buildGroupedView([grp('group_zzzz', [])], [proj('a'), proj('b')], [
      'ghost',
      'b',
      'a',
    ]);
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0].projects).toEqual([]);
    expect(ids(view.ungrouped)).toEqual(['b', 'a']);
  });

  it('全部项目都有归属时 ungrouped 为空，且不修改入参', () => {
    const projects = [proj('p1'), proj('p2')];
    const order = ['p2', 'p1'];
    const view = buildGroupedView([grp('group_aaaa', ['p1', 'p2'])], projects, order);
    expect(view.ungrouped).toEqual([]);
    expect(ids(view.groups[0].projects)).toEqual(['p2', 'p1']);
    expect(projects.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(order).toEqual(['p2', 'p1']);
  });

  it('无母栏时所有项目都是未分组', () => {
    const view = buildGroupedView([], [proj('a'), proj('b')], ['b']);
    expect(view.groups).toEqual([]);
    expect(ids(view.ungrouped)).toEqual(['b', 'a']);
  });
});

describe('落盘结构', () => {
  it('toGroupsFile 返回 schema 1 与母栏数组', () => {
    const groups = [grp('group_aaaa', ['p1'])];
    expect(toGroupsFile(groups)).toEqual({ schema: 1, groups });
    expect(toGroupsFile(groups).schema).toBe(1);
  });
});
