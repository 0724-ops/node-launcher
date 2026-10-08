import { afterAll, describe, expect, it } from 'vitest';
import path from 'path';
import fse from 'fs-extra';

import { ConfigStore } from '../electron/core/store/config-store';
import { ProjectStore } from '../electron/core/store/project-store';
import { ProjectService } from '../electron/core/project/project-service';
import { NodeRuntimeProvider } from '../electron/core/runtime/node-provider';
import { DepsInstaller } from '../electron/core/deps/installer';
import { LaunchManager } from '../electron/core/launch/launch-manager';
import { projectWorkDir } from '../electron/core/project/project-paths';
import { CONFIG_DEFAULTS } from '../electron/core/store/config-store';
import type { LaunchState } from '../electron/types';
import { cleanupTmpRoot, makeTmpDir, writeJson } from './helpers/tmp';

/**
 * 端到端冒烟（默认跳过，需 NL_E2E=1）：
 * 真实 Node 运行时 + 真实 spawn + 就绪探测 + HTTP 探活 + 停止，
 * 覆盖 GUI 无法在无人值守环境里验证的那部分主进程链路。
 *
 * 运行： NL_E2E=1 vitest run tests/e2e.test.ts
 */
const enabled = process.env.NL_E2E === '1';

describe.skipIf(!enabled)('端到端：真实 Node 项目', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanups) await fn().catch(() => {});
    await cleanupTmpRoot();
  });

  it('链接真实项目 → 启动 → 探活 → 停止', async () => {
    const dataDir = await makeTmpDir('e2e-data');
    const projectDir = await makeTmpDir('e2e-project');

    // 1) 造一个最小的真实项目
    await writeJson(path.join(projectDir, 'package.json'), {
      name: 'e2e-demo',
      version: '1.0.0',
      scripts: { start: 'node server.js' },
    });
    await fse.writeFile(
      path.join(projectDir, 'server.js'),
      [
        "const http = require('http');",
        'const port = Number(process.env.PORT || 0);',
        'const server = http.createServer((req, res) => { res.end("ok"); });',
        "server.listen(port, '127.0.0.1', () => {",
        "  console.log('LISTENING ' + server.address().port);",
        '});',
      ].join('\n')
    );

    // 2) 存储与项目服务（走真实的清单读写 + 探测）
    const configStore = new ConfigStore(dataDir);
    const projectStore = new ProjectStore(path.join(dataDir, 'projects'));
    await configStore.save({ defaultPort: 41731 });

    const projects = new ProjectService(projectStore, () => configStore.load());
    const manifest = await projects.createFromFolder({
      folderPath: projectDir,
      mode: 'link',
    });

    expect(manifest.source).toBe('linked');
    expect(manifest.startMode).toBe('node');
    expect(manifest.entry).toBe('server.js');

    // 3) 真实运行时：把自带的 Node 以约定目录名暴露给 provider
    const runtimesDir = path.join(dataDir, 'runtimes');
    const bundledNode = path.resolve('.tools', 'node');
    const runtimeDir = path.join(runtimesDir, `node-${process.versions.node}-${process.platform}-${process.arch}`);
    await fse.ensureDir(runtimesDir);
    await fse.symlink(bundledNode, runtimeDir, 'junction');

    const provider = new NodeRuntimeProvider({
      bundledDir: path.join(dataDir, 'nonexistent'),
      runtimesDir,
      platform: process.platform,
      arch: process.arch,
      getConfig: async () => ({
        defaultNodeVersion: process.versions.node,
        nodeDownloadMirror: 'https://npmmirror.com/mirrors/node/',
        preferBundledRuntime: true,
      }),
    });
    const runtime = await provider.ensureRuntime(process.versions.node);
    expect(runtime.version).toBe(process.versions.node);
    expect(runtime.abi).toMatch(/^\d+$/);
    expect(runtime.nodePath).toContain('node.exe');
    expect(runtime.npmCliPath.length).toBeGreaterThan(0);

    // 4) 启动流水线（真实 spawn）
    const logs: string[] = [];
    const states: LaunchState[] = [];
    const installer = new DepsInstaller({
      store: projectStore,
      config: () => configStore.load(),
      log: () => {},
    });

    const manager = new LaunchManager({
      store: projectStore,
      provider,
      config: async () => ({
        ...CONFIG_DEFAULTS,
        defaultPort: 41731,
        metricsStrategy: 'auto',
      }),
      depsService: installer,
      log: (_id, _kind, msg) => logs.push(msg),
      onState: (s) => states.push({ ...s }),
      onMetrics: () => {},
      onPrompt: () => {},
      reporterPath: path.resolve('dist-electron', 'core', 'launch', 'metrics-reporter.js'),
    });
    cleanups.push(async () => {
      await manager.stop(manifest.id).catch(() => {});
    });

    // 项目里没有 node_modules 但也没有依赖 → precheck 认为需要安装；避免弹窗：
    await writeJson(path.join(projectDir, 'node_modules', '.keep'), {});

    manager.start(manifest.id);

    const ready = await waitForState(manager, manifest.id, (s) => s.phase === 'ready', 30000);
    expect(ready.pid).toBeGreaterThan(0);
    expect(ready.port).toBe(41731);

    // 5) 真实探活
    const res = await fetch(`http://127.0.0.1:${ready.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');

    // 6) 日志里应包含就绪关键字与运行时信息
    expect(logs.some((l) => l.includes('LISTENING'))).toBe(true);
    expect(logs.some((l) => l.includes('Node v'))).toBe(true);

    // 7) 停止
    await manager.stop(manifest.id);
    await waitForState(manager, manifest.id, (s) => s.phase === 'idle', 15000);
    expect(manager.isRunning(manifest.id)).toBe(false);

    // 探活应当失败（服务已停止）
    await expect(fetch(`http://127.0.0.1:${ready.port}/`)).rejects.toBeTruthy();

    // 顺带验证依赖状态与工作目录解析
    expect(projectWorkDir(projectStore, manifest)).toBe(path.resolve(projectDir));
    const deps = await installer.status(manifest.id);
    expect(deps.packageManager).toBe('npm');
  }, 90000);
});

async function waitForState(
  manager: LaunchManager,
  projectId: string,
  predicate: (state: LaunchState) => boolean,
  timeoutMs: number
): Promise<LaunchState> {
  const start = Date.now();
  for (;;) {
    const state = manager.getState(projectId);
    if (state && predicate(state)) return state;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `等待状态超时，当前状态：${state?.phase} ${state?.message ?? ''}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
