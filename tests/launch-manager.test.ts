import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';
import fse from 'fs-extra';

import { LaunchManager } from '../electron/core/launch/launch-manager';
import { CONFIG_DEFAULTS } from '../electron/core/store/config-store';
import type { DepsPrompt } from '../electron/core/deps/deps-types';
import type { LaunchState, ProjectManifest, RuntimeInfo } from '../electron/types';
import { cleanupTmpRoot, makeTmpDir, writeJson } from './helpers/tmp';

/**
 * 启动流水线状态机测试。
 * 用假 spawn 驱动，不真的启动子进程——这样既能在沙箱里跑，
 * 也能精确构造「启动失败 / 缺依赖 / 相对路径缺失」等场景。
 */

class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  kill(): boolean {
    this.killed = true;
    return true;
  }

  out(text: string): void {
    this.stdout.emit('data', Buffer.from(text));
  }

  err(text: string): void {
    this.stderr.emit('data', Buffer.from(text));
  }

  exit(code: number | null): void {
    this.emit('exit', code, null);
  }
}

const runtime: RuntimeInfo = {
  version: '22.23.3',
  abi: '127',
  nodePath: 'C:\\rt\\node.exe',
  npmCliPath: 'C:\\rt\\node_modules\\npm\\bin\\npm-cli.js',
  corepackPath: null,
  dir: 'C:\\rt',
  source: 'downloaded',
};

interface Harness {
  manager: LaunchManager;
  children: FakeChild[];
  prompts: DepsPrompt[];
  states: LaunchState[];
  install: ReturnType<typeof vi.fn>;
  spawnCount: () => number;
  spawnCall: (index: number) => { command: string; args: string[]; shell?: boolean; env: Record<string, string> };
  state: () => LaunchState | undefined;
}

async function setup(
  projectDir: string,
  manifestPatch: Partial<ProjectManifest> = {}
): Promise<Harness> {
  const manifest: ProjectManifest = {
    schema: 1,
    id: 'p1',
    name: 'demo',
    source: 'managed',
    rootDir: projectDir,
    startMode: 'node',
    entry: 'server.js',
    portMode: 'none',
    autoInstallDeps: 'ask',
    allowInstallScripts: false,
    restartPolicy: { mode: 'never', maxRetries: 0, backoffMs: 200 },
    singleton: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...manifestPatch,
  };

  const children: FakeChild[] = [];
  const prompts: DepsPrompt[] = [];
  const states: LaunchState[] = [];
  const install = vi.fn(async () => ({
    ok: true,
    command: 'npm ci',
    exitCode: 0,
    outputTail: '',
    cancelled: false,
  }));

  const spawnFn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });

  const store = {
    get: async () => manifest,
    srcDir: () => projectDir,
    projectDir: () => projectDir,
    recordStarted: async () => {},
    recordExit: async () => {},
  };

  const manager = new LaunchManager({
    store: store as never,
    provider: { ensureRuntime: async () => runtime } as never,
    config: async () => ({
      ...CONFIG_DEFAULTS,
      metricsStrategy: 'polling',
      autoPickFreePort: true,
      defaultPort: 3999,
    }),
    depsService: {
      install,
      cancel: () => {},
      isInstalling: () => false,
    },
    log: () => {},
    onState: (s) => states.push({ ...s }),
    onMetrics: () => {},
    onPrompt: (p) => prompts.push(p),
    reporterPath: path.join(projectDir, '__no_reporter__.js'),
    spawnFn: spawnFn as never,
    tree: { descendants: async (pid: number) => [pid] } as never,
  });

  return {
    manager,
    children,
    prompts,
    states,
    install,
    spawnCount: () => spawnFn.mock.calls.length,
    spawnCall: (index: number) => {
      const call = spawnFn.mock.calls[index] as unknown as [
        string,
        string[],
        { shell?: boolean; env?: Record<string, string> },
      ];
      return {
        command: call[0],
        args: call[1] ?? [],
        shell: call[2]?.shell,
        env: call[2]?.env ?? {},
      };
    },
    state: () => manager.getState('p1') ?? undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanupTmpRoot();
});

describe('启动流水线', () => {
  it('缺少依赖时先询问，选「直接启动」后正常启动', async () => {
    const dir = await makeTmpDir('lm-ask');
    await writeJson(path.join(dir, 'package.json'), { name: 'demo', scripts: { start: 'node server.js' } });
    await fse.writeFile(path.join(dir, 'server.js'), 'console.log(1)');

    const h = await setup(dir);
    h.manager.start('p1');

    await vi.waitFor(() => expect(h.prompts.length).toBe(1), { timeout: 5000 });
    expect(h.prompts[0].kind).toBe('preflight-missing');
    expect(h.spawnCount()).toBe(0);

    h.manager.resolvePrompt('p1', 'skip');
    await vi.waitFor(() => expect(h.spawnCount()).toBe(1), { timeout: 5000 });

    h.children[0].out('listening on 3999\n');
    h.children[0].exit(0);
    await vi.waitFor(() => expect(h.state()?.phase).toBe('idle'), { timeout: 5000 });
    expect(h.state()?.message).toContain('自行退出');
  });

  it('缺依赖时选「安装依赖」→ 安装成功后继续启动', async () => {
    const dir = await makeTmpDir('lm-install');
    await writeJson(path.join(dir, 'package.json'), { name: 'demo' });
    await fse.writeFile(path.join(dir, 'server.js'), 'console.log(1)');

    const h = await setup(dir);
    h.manager.start('p1');

    await vi.waitFor(() => expect(h.prompts.length).toBe(1), { timeout: 5000 });
    h.manager.resolvePrompt('p1', 'install');

    await vi.waitFor(() => expect(h.install).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await vi.waitFor(() => expect(h.spawnCount()).toBe(1), { timeout: 5000 });
  });

  it('运行期缺裸包 → 提示安装 → 安装后仅重试一次', async () => {
    const dir = await makeTmpDir('lm-missing-module');
    await writeJson(path.join(dir, 'package.json'), { name: 'demo' });
    await fse.writeFile(path.join(dir, 'server.js'), 'console.log(1)');
    // node_modules 非空 → 跳过启动前预检，直接进入运行期判定
    await fse.outputFile(path.join(dir, 'node_modules', '.keep'), 'x');

    const h = await setup(dir);
    h.manager.start('p1');
    await vi.waitFor(() => expect(h.spawnCount()).toBe(1), { timeout: 5000 });

    h.children[0].err("Error: Cannot find module 'express'\n    at Module._resolveFilename\n");
    h.children[0].exit(1);

    await vi.waitFor(() => expect(h.prompts.length).toBe(1), { timeout: 5000 });
    expect(h.prompts[0].kind).toBe('runtime-missing-module');
    expect(h.prompts[0].moduleName).toBe('express');

    h.manager.resolvePrompt('p1', 'install');
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await vi.waitFor(() => expect(h.spawnCount()).toBe(2), { timeout: 5000 });
    expect(h.state()?.installAttempted).toBe(true);

    // 第二次仍然失败 → 不再第三次安装（防死循环）
    h.children[1].err("Error: Cannot find module 'express'\n");
    h.children[1].exit(1);
    await vi.waitFor(() => expect(h.state()?.phase).toBe('failed'), { timeout: 5000 });
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(h.spawnCount()).toBe(2);
  });

  it('相对路径导入缺失 → 不提示安装、不误装', async () => {
    const dir = await makeTmpDir('lm-relative');
    await writeJson(path.join(dir, 'package.json'), { name: 'demo' });
    await fse.writeFile(path.join(dir, 'server.js'), 'console.log(1)');
    await fse.outputFile(path.join(dir, 'node_modules', '.keep'), 'x');

    const h = await setup(dir);
    h.manager.start('p1');
    await vi.waitFor(() => expect(h.spawnCount()).toBe(1), { timeout: 5000 });

    h.children[0].err("Error: Cannot find module './routes/user'\n");
    h.children[0].exit(1);

    await vi.waitFor(() => expect(h.state()?.phase).toBe('failed'), { timeout: 5000 });
    expect(h.prompts.length).toBe(0);
    expect(h.install).not.toHaveBeenCalled();
    expect(h.state()?.category).toBe('missing-relative');
  });

  it('从不自动安装策略下直接失败，不打扰用户', async () => {
    const dir = await makeTmpDir('lm-never');
    await writeJson(path.join(dir, 'package.json'), { name: 'demo' });
    await fse.writeFile(path.join(dir, 'server.js'), 'console.log(1)');
    await fse.outputFile(path.join(dir, 'node_modules', '.keep'), 'x');

    const h = await setup(dir, { autoInstallDeps: 'never' });
    h.manager.start('p1');
    await vi.waitFor(() => expect(h.spawnCount()).toBe(1), { timeout: 5000 });

    h.children[0].err("Error: Cannot find module 'express'\n");
    h.children[0].exit(1);

    await vi.waitFor(() => expect(h.state()?.phase).toBe('failed'), { timeout: 5000 });
    expect(h.prompts.length).toBe(0);
    expect(h.install).not.toHaveBeenCalled();
  });

  it('停止流程会切到 stopping 并最终回到 idle', async () => {
    const dir = await makeTmpDir('lm-stop');
    await writeJson(path.join(dir, 'package.json'), { name: 'demo' });
    await fse.writeFile(path.join(dir, 'server.js'), 'console.log(1)');
    await fse.outputFile(path.join(dir, 'node_modules', '.keep'), 'x');

    const h = await setup(dir);
    h.manager.start('p1');
    await vi.waitFor(() => expect(h.spawnCount()).toBe(1), { timeout: 5000 });

    const stopping = h.manager.stop('p1');
    expect(h.state()?.phase).toBe('stopping');
    h.children[0].exit(null);
    await stopping;
    await vi.waitFor(() => expect(h.state()?.phase).toBe('idle'), { timeout: 5000 });
    expect(h.state()?.message).toBe('已停止');
  });

  it('自定义命令模式不做入口校验，命令原样交给 shell 并注入 PORT', async () => {
    const dir = await makeTmpDir('lm-command');
    await writeJson(path.join(dir, 'package.json'), { name: 'demo' });
    await fse.outputFile(path.join(dir, 'node_modules', '.keep'), 'x');

    const h = await setup(dir, {
      startMode: 'command',
      entry: undefined,
      command: 'npm run start -- --port {PORT}',
      portMode: 'inject',
      port: 4321,
    });
    h.manager.start('p1');
    await vi.waitFor(() => expect(h.spawnCount()).toBe(1), { timeout: 5000 });

    const call = h.spawnCall(0);
    expect(call.shell).toBe(false);
    if (process.platform === 'win32') {
      expect(call.command.toLowerCase()).toContain('cmd');
      expect(call.args).toEqual(['/d', '/s', '/c', 'npm run start -- --port 4321']);
    } else {
      expect(call.command).toBe('/bin/sh');
      expect(call.args).toEqual(['-c', 'npm run start -- --port 4321']);
    }
    expect(call.env.PORT).toBe('4321');
    expect(call.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
