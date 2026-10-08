import { afterAll, describe, expect, it } from 'vitest';
import path from 'path';
import fse from 'fs-extra';

import {
  buildRootInfo,
  countProjectsIn,
  defaultProjectsRoot,
  migrateContents,
  migrationSourcePatch,
  resolveProjectsRoot,
} from '../electron/core/store/projects-root';
import { ProjectStore } from '../electron/core/store/project-store';
import { cleanupTmpRoot, makeTmpDir, writeJson } from './helpers/tmp';

afterAll(async () => {
  await cleanupTmpRoot();
});

async function seedProject(root: string, id: string): Promise<void> {
  await writeJson(path.join(root, id, 'manifest.json'), { id, name: id });
}

describe('受管项目根目录解析（与旧启动器同规则）', () => {
  it('未配置时用默认目录', () => {
    expect(defaultProjectsRoot('C:\\data')).toBe(path.join('C:\\data', 'projects'));
    expect(resolveProjectsRoot('C:\\data', '')).toBe(path.join('C:\\data', 'projects'));
  });

  it('自定义目录下再拼 projects，避免套娃', () => {
    const dir = path.resolve('D:\\games');
    expect(resolveProjectsRoot('C:\\data', dir)).toBe(path.join(dir, 'projects'));
  });

  it('目录本身就叫 projects 时直接使用', () => {
    const dir = path.resolve('D:\\x\\projects');
    expect(resolveProjectsRoot('C:\\data', dir)).toBe(dir);
    const upper = path.resolve('D:\\x\\PROJECTS');
    expect(resolveProjectsRoot('C:\\data', upper)).toBe(upper);
  });
});

describe('项目统计与迁移', () => {
  it('只统计含 manifest.json 的目录', async () => {
    const dir = await makeTmpDir('root-count');
    await seedProject(dir, 'a');
    await fse.ensureDir(path.join(dir, 'no-manifest'));
    await fse.outputFile(path.join(dir, 'loose-file.txt'), 'x');
    expect(await countProjectsIn(dir)).toBe(1);
    expect(await countProjectsIn(path.join(dir, 'missing'))).toBe(0);
  });

  it('migrateContents 移动内容、同名跳过、同目录返回 0', async () => {
    const from = await makeTmpDir('root-from');
    const to = await makeTmpDir('root-to');
    await seedProject(from, 'a');
    await seedProject(from, 'b');
    await seedProject(to, 'b'); // 同名 → 跳过，绝不覆盖

    const moved = await migrateContents(from, to);
    expect(moved).toBe(1);
    expect(await fse.pathExists(path.join(to, 'a', 'manifest.json'))).toBe(true);
    expect(await fse.pathExists(path.join(from, 'b', 'manifest.json'))).toBe(true);
    expect(await migrateContents(to, to)).toBe(0);
  });

  it('换目录时把「还有项目的旧目录」记为迁移来源', async () => {
    const dataDir = await makeTmpDir('root-data');
    const oldRoot = path.join(dataDir, 'old');
    await seedProject(resolveProjectsRoot(dataDir, oldRoot), 'a');

    const patch = await migrationSourcePatch(
      dataDir,
      { projectsRootUser: oldRoot, projectsRootActive: '' },
      path.join(dataDir, 'new')
    );
    expect(patch.projectsRootActive).toBe(oldRoot);

    // 旧目录为空 → 不记录来源，避免把真正存放数据的目录丢掉
    const empty = await migrationSourcePatch(
      dataDir,
      { projectsRootUser: path.join(dataDir, 'empty'), projectsRootActive: 'keep-me' },
      path.join(dataDir, 'new')
    );
    expect(empty).toEqual({});

    // 同一个目录 → 什么都不做
    const same = await migrationSourcePatch(
      dataDir,
      { projectsRootUser: oldRoot, projectsRootActive: '' },
      oldRoot
    );
    expect(same).toEqual({});
  });

  it('buildRootInfo 给出迁移引导所需的全部信息', async () => {
    const dataDir = await makeTmpDir('root-info');
    const user = path.join(dataDir, 'new');
    const active = path.join(dataDir, 'old');
    await seedProject(resolveProjectsRoot(dataDir, active), 'a');
    await seedProject(resolveProjectsRoot(dataDir, active), 'b');

    const info = await buildRootInfo(dataDir, { projectsRootUser: user, projectsRootActive: active });
    expect(info.changed).toBe(true);
    expect(info.currentDir).toBe(resolveProjectsRoot(dataDir, user));
    expect(info.prevDir).toBe(resolveProjectsRoot(dataDir, active));
    expect(info.prevCount).toBe(2);
    expect(info.defaultDir).toBe(defaultProjectsRoot(dataDir));

    const same = await buildRootInfo(dataDir, { projectsRootUser: user, projectsRootActive: user });
    expect(same.changed).toBe(false);
    expect(same.prevCount).toBe(0);
  });
});

describe('ProjectStore 可切换根目录', () => {
  it('setRoot 之后清单与源码目录都跟着走', async () => {
    const base = await makeTmpDir('root-store');
    const first = path.join(base, 'one');
    const second = path.join(base, 'two');
    const store = new ProjectStore(first);
    expect(store.projectDir('p1')).toBe(path.join(first, 'p1'));

    store.setRoot(second);
    expect(store.dir).toBe(second);
    expect(store.srcDir('p1')).toBe(path.join(second, 'p1', 'src'));
  });
});
