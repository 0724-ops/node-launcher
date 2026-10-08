import { afterAll, describe, expect, it } from 'vitest';
import path from 'path';
import fse from 'fs-extra';

import { ConfigStore, CONFIG_DEFAULTS } from '../electron/core/store/config-store';
import { ProjectStore } from '../electron/core/store/project-store';
import { ProjectService } from '../electron/core/project/project-service';
import { projectRootDir, projectWorkDir } from '../electron/core/project/project-paths';
import { createStoredZip } from './helpers/zip';
import { cleanupTmpRoot, makeTmpDir, writeJson } from './helpers/tmp';

afterAll(async () => {
  await cleanupTmpRoot();
});

async function makeService(dataDir: string) {
  const configStore = new ConfigStore(dataDir);
  const projectStore = new ProjectStore(path.join(dataDir, 'projects'));
  await configStore.save({ defaultPort: 4200, defaultPortMode: 'inject' });
  const service = new ProjectService(projectStore, () => configStore.load());
  return { configStore, projectStore, service };
}

describe('项目接入 - 引用目录（不复制源码）', () => {
  it('登记已有目录并自动探测启动配置', async () => {
    const dataDir = await makeTmpDir('ps-data');
    const src = await makeTmpDir('ps-src');
    await writeJson(path.join(src, 'package.json'), {
      name: 'demo-api',
      scripts: { start: 'node src/server.js' },
    });
    await fse.outputFile(path.join(src, 'src', 'server.js'), 'console.log(1)');
    await fse.writeFile(path.join(src, 'package-lock.json'), '{}');

    const { projectStore, service } = await makeService(dataDir);
    const manifest = await service.createFromFolder({ folderPath: src, mode: 'link' });

    expect(manifest.source).toBe('linked');
    expect(manifest.rootDir).toBe(path.resolve(src));
    // 清单落在启动器数据目录，用户目录不被写入
    expect(await fse.pathExists(path.join(projectStore.projectDir(manifest.id), 'manifest.json'))).toBe(true);
    expect(await fse.pathExists(path.join(src, 'manifest.json'))).toBe(false);

    // 探测结果：node 直启 + 入口来自 scripts.start
    expect(manifest.startMode).toBe('node');
    expect(manifest.entry).toBe('src/server.js');

    const detect = await service.detect(manifest.id);
    expect(detect.hasPackageJson).toBe(true);
    expect(detect.packageManager).toBe('npm');
    expect(detect.lockfile).toBe('package-lock.json');
    expect(detect.suggestedStartMode).toBe('node');
  });

  it('非 node 脚本 → 建议自定义命令', async () => {
    const dataDir = await makeTmpDir('ps-data2');
    const src = await makeTmpDir('ps-src2');
    await writeJson(path.join(src, 'package.json'), {
      name: 'demo-web',
      scripts: { start: 'vite preview', dev: 'vite' },
    });
    await fse.writeFile(path.join(src, 'pnpm-lock.yaml'), 'lockfileVersion: 9');

    const { service } = await makeService(dataDir);
    const manifest = await service.createFromFolder({ folderPath: src, mode: 'link' });
    expect(manifest.startMode).toBe('command');
    expect(manifest.command).toBe('pnpm start');
    expect(manifest.entry).toBeUndefined();
  });

  it('monorepo：识别 workspaces 子包供选择工作目录', async () => {
    const dataDir = await makeTmpDir('ps-data3');
    const src = await makeTmpDir('ps-src3');
    await writeJson(path.join(src, 'package.json'), {
      name: 'mono',
      workspaces: ['packages/*'],
    });
    await writeJson(path.join(src, 'packages', 'api', 'package.json'), { name: '@m/api' });
    await writeJson(path.join(src, 'packages', 'web', 'package.json'), { name: '@m/web' });

    const { service } = await makeService(dataDir);
    const manifest = await service.createFromFolder({ folderPath: src, mode: 'link' });
    const detect = await service.detect(manifest.id);
    expect(detect.workspaceCandidates.sort()).toEqual(['packages/api', 'packages/web']);
  });

  it('cwd 指向子包后，工作目录解析正确', async () => {
    const dataDir = await makeTmpDir('ps-data4');
    const src = await makeTmpDir('ps-src4');
    await writeJson(path.join(src, 'packages', 'api', 'package.json'), { name: 'api' });
    await fse.outputFile(path.join(src, 'packages', 'api', 'index.js'), 'console.log(1)');

    const { projectStore, service } = await makeService(dataDir);
    const manifest = await service.createFromFolder({ folderPath: src, mode: 'link' });
    const updated = await service.update(manifest.id, { cwd: 'packages/api', entry: 'index.js' });

    expect(projectWorkDir(projectStore, updated)).toBe(
      path.join(path.resolve(src), 'packages', 'api')
    );
  });
});

describe('项目接入 - 复制导入', () => {
  it('复制源码但排除 node_modules/.git，且原目录不被改动', async () => {
    const dataDir = await makeTmpDir('ps-copy-data');
    const src = await makeTmpDir('ps-copy-src');
    await writeJson(path.join(src, 'package.json'), { name: 'copied', main: 'app.js' });
    await fse.outputFile(path.join(src, 'app.js'), 'console.log(1)');
    await fse.outputFile(path.join(src, 'node_modules', 'big', 'index.js'), 'x'.repeat(100));
    await fse.outputFile(path.join(src, '.git', 'HEAD'), 'ref: refs/heads/main');

    const { projectStore, service } = await makeService(dataDir);
    const manifest = await service.createFromFolder({ folderPath: src, mode: 'copy' });

    expect(manifest.source).toBe('managed');
    const root = projectRootDir(projectStore, manifest);
    expect(await fse.pathExists(path.join(root, 'package.json'))).toBe(true);
    expect(await fse.pathExists(path.join(root, 'app.js'))).toBe(true);
    expect(await fse.pathExists(path.join(root, 'node_modules'))).toBe(false);
    expect(await fse.pathExists(path.join(root, '.git'))).toBe(false);
    // 原目录仍然完好
    expect(await fse.pathExists(path.join(src, 'node_modules', 'big', 'index.js'))).toBe(true);
  });
});

describe('项目接入 - zip 导入', () => {
  it('解压、单层目录提升、自动探测入口', async () => {
    const dataDir = await makeTmpDir('ps-zip-data');
    const zipDir = await makeTmpDir('ps-zip-src');
    const zipPath = path.join(zipDir, 'bundle.zip');
    await fse.writeFile(
      zipPath,
      createStoredZip([
        { name: 'demo-1.0.0/' },
        { name: 'demo-1.0.0/package.json', data: JSON.stringify({ name: 'zipped', main: 'server.js' }) },
        { name: 'demo-1.0.0/server.js', data: 'console.log(1)' },
      ])
    );

    const { projectStore, service } = await makeService(dataDir);
    const manifest = await service.importZip(zipPath, '我的压缩包');

    expect(manifest.source).toBe('zip');
    expect(manifest.name).toBe('我的压缩包');
    const root = projectRootDir(projectStore, manifest);
    // 单层目录已提升
    expect(await fse.pathExists(path.join(root, 'package.json'))).toBe(true);
    expect(await fse.pathExists(path.join(root, 'server.js'))).toBe(true);
    expect(manifest.entry).toBe('server.js');
  });

  it('多层内容不会被错误提升', async () => {
    const dataDir = await makeTmpDir('ps-zip2-data');
    const zipDir = await makeTmpDir('ps-zip2-src');
    const zipPath = path.join(zipDir, 'flat.zip');
    await fse.writeFile(
      zipPath,
      createStoredZip([
        { name: 'package.json', data: JSON.stringify({ name: 'flat' }) },
        { name: 'index.js', data: 'console.log(1)' },
      ])
    );

    const { projectStore, service } = await makeService(dataDir);
    const manifest = await service.importZip(zipPath);
    const root = projectRootDir(projectStore, manifest);
    expect(await fse.pathExists(path.join(root, 'package.json'))).toBe(true);
    expect(await fse.pathExists(path.join(root, 'index.js'))).toBe(true);
  });
});

describe('项目更新与删除', () => {
  it('切换启动模式会清掉矛盾字段', async () => {
    const dataDir = await makeTmpDir('ps-upd-data');
    const src = await makeTmpDir('ps-upd-src');
    await writeJson(path.join(src, 'package.json'), { name: 'u', main: 'index.js' });
    await fse.outputFile(path.join(src, 'index.js'), 'console.log(1)');

    const { service } = await makeService(dataDir);
    const manifest = await service.createFromFolder({ folderPath: src, mode: 'link' });
    expect(manifest.startMode).toBe('node');

    const asCommand = await service.update(manifest.id, {
      startMode: 'command',
      command: 'npm run dev',
      args: ['--x'],
    });
    expect(asCommand.command).toBe('npm run dev');
    expect(asCommand.entry).toBeUndefined();
    expect(asCommand.args).toBeUndefined();

    const backToNode = await service.update(manifest.id, {
      startMode: 'node',
      entry: 'index.js',
    });
    expect(backToNode.entry).toBe('index.js');
    expect(backToNode.command).toBeUndefined();
  });

  it('引用项目删除时不碰用户目录；托管项目删除时清理副本', async () => {
    const dataDir = await makeTmpDir('ps-del-data');
    const linkedSrc = await makeTmpDir('ps-del-linked');
    await fse.outputFile(path.join(linkedSrc, 'index.js'), 'console.log(1)');
    const copySrc = await makeTmpDir('ps-del-copy');
    await fse.outputFile(path.join(copySrc, 'index.js'), 'console.log(1)');

    const { projectStore, service } = await makeService(dataDir);
    const linked = await service.createFromFolder({ folderPath: linkedSrc, mode: 'link' });
    const copied = await service.createFromFolder({ folderPath: copySrc, mode: 'copy' });

    await service.remove(linked.id, true);
    expect(await fse.pathExists(linkedSrc)).toBe(true); // 用户目录必须保留
    expect(await projectStore.get(linked.id)).toBeNull();

    const copiedRoot = projectRootDir(projectStore, copied);
    await service.remove(copied.id, true);
    expect(await fse.pathExists(copiedRoot)).toBe(false);
  });

  it('清单列表按最近启动时间排序并跳过损坏记录', async () => {
    const dataDir = await makeTmpDir('ps-list-data');
    const src = await makeTmpDir('ps-list-src');
    await fse.outputFile(path.join(src, 'index.js'), 'console.log(1)');

    const { projectStore, service } = await makeService(dataDir);
    const a = await service.createFromFolder({ folderPath: src, mode: 'link', name: 'A' });
    // 制造一条损坏记录
    await fse.outputFile(path.join(projectStore.projectDir(a.id), '..', 'bad-id', 'manifest.json'), '{oops');

    const list = await projectStore.list();
    expect(list.map((m) => m.id)).toContain(a.id);
    expect(list.map((m) => m.id)).not.toContain('bad-id');

    await projectStore.recordStarted(a.id);
    const again = await projectStore.list();
    expect(again[0].id).toBe(a.id);
    expect(again[0].lastStartedAt).toBeTruthy();
  });
});

describe('全局配置存储', () => {
  it('首次读取落盘默认值，保存后合并', async () => {
    const dataDir = await makeTmpDir('cfg-data');
    const store = new ConfigStore(dataDir);

    const defaults = await store.load();
    expect(defaults.defaultNodeVersion).toBe(CONFIG_DEFAULTS.defaultNodeVersion);
    expect(defaults.schema).toBe(1);

    const next = await store.save({ defaultPort: 5000 });
    expect(next.defaultPort).toBe(5000);
    expect(next.defaultNodeVersion).toBe(CONFIG_DEFAULTS.defaultNodeVersion);

    store.resetCache();
    const reloaded = await store.load();
    expect(reloaded.defaultPort).toBe(5000);
  });
});
