import fse from 'fs-extra';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { GroupsStore } from '../electron/core/store/groups-store';
import {
  createGroup,
  moveInstance,
  setGroupCollapsed,
} from '../electron/core/project/group-logic';
import { cleanupTmpRoot, makeTmpDir } from './helpers/tmp';

afterAll(cleanupTmpRoot);

const IDS = ['p1', 'p2', 'p3', 'p4'];
const GA = 'group_aaaaaaaa';
const GB = 'group_bbbbbbbb';

async function makeStore(): Promise<{ dir: string; store: GroupsStore }> {
  const dir = await makeTmpDir('groups-store');
  return { dir, store: new GroupsStore(dir) };
}

function leftovers(names: string[]): string[] {
  return names.filter((n) => n.endsWith('.tmp'));
}

describe('GroupsStore', () => {
  it('文件不存在时返回空结构，且不产生副作用（不写文件）', async () => {
    const { dir, store } = await makeStore();
    expect(await store.load(IDS)).toEqual([]);
    expect(await fse.pathExists(path.join(dir, 'groups.json'))).toBe(false);
  });

  it('损坏 JSON 自愈为空，不抛错', async () => {
    const { dir, store } = await makeStore();
    await fse.writeFile(path.join(dir, 'groups.json'), '{ 这不是 JSON');
    expect(await store.load(IDS)).toEqual([]);
  });

  it('保存后重新加载一致（新建 + 改名 + 折叠 + 移动）', async () => {
    const { store } = await makeStore();
    await store.mutate(IDS, (g) => createGroup(g, { id: GA, name: '卫戍协议', githubRepo: 'o/r' }));
    await store.mutate(IDS, (g) => moveInstance(g, 'p1', GA));
    await store.mutate(IDS, (g) => setGroupCollapsed(g, GA, true));

    const loaded = await store.load(IDS);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: GA,
      name: '卫戍协议',
      githubRepo: 'o/r',
      instanceIds: ['p1'],
      collapsed: true,
    });
  });

  it('落盘后不残留 .tmp', async () => {
    const { dir, store } = await makeStore();
    await store.mutate(IDS, (g) => createGroup(g, { id: GA, name: 'A' }));
    expect(leftovers(await fse.readdir(dir))).toEqual([]);
  });

  it('写路径会把「已不存在的项目 id」清掉', async () => {
    const { store } = await makeStore();
    await store.mutate(IDS, (g) => createGroup(g, { id: GA, name: 'A' }));
    await store.mutate(IDS, (g) => moveInstance(g, 'p2', GA));
    // p2 已被删除：只把 p1 当作现存项目
    const after = await store.mutate(['p1'], (g) => g);
    expect(after[0].instanceIds).toEqual([]);
    expect(await store.load(['p1'])).toEqual([
      expect.objectContaining({ id: GA, instanceIds: [] }),
    ]);
  });

  it('并发 20 次 moveInstance 不丢更新', async () => {
    const { store } = await makeStore();
    await store.mutate(IDS, (g) => createGroup(g, { id: GA, name: 'A' }));

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.mutate(IDS, (g) => moveInstance(g, `p${(i % 4) + 1}`, GA))
      )
    );

    const final = await store.load(IDS);
    expect(final).toHaveLength(1);
    // 若「读-改-写」没有串行化，后面几次会整体覆盖前面的结果，必然缺 id
    expect([...final[0].instanceIds].sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('并发建两个母栏：两个都在，没有互相覆盖', async () => {
    const { store } = await makeStore();
    await Promise.all([
      store.mutate(IDS, (g) => createGroup(g, { id: GA, name: 'A' })),
      store.mutate(IDS, (g) => createGroup(g, { id: GB, name: 'B' })),
    ]);
    const final = await store.load(IDS);
    expect(final.map((g) => g.id).sort()).toEqual([GA, GB].sort());
  });

  it('单次写入失败不会卡死队列', async () => {
    const { store } = await makeStore();
    await expect(
      store.mutate(IDS, () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    // 后续写入照常工作
    const after = await store.mutate(IDS, (g) => createGroup(g, { id: GA, name: 'A' }));
    expect(after).toHaveLength(1);
  });
});
