import { describe, expect, it } from 'vitest';
import {
  buildSpawnPlan,
  quoteForNodeOptions,
  resolveWorkingDir,
} from '../electron/core/launch/spawn-plan';
import { substitutePlaceholders } from '../electron/core/launch/placeholders';
import type { ProjectManifest, RuntimeInfo } from '../electron/types';

const runtime: RuntimeInfo = {
  version: '22.23.3',
  abi: '127',
  nodePath: 'C:\\rt\\node.exe',
  npmCliPath: 'C:\\rt\\node_modules\\npm\\bin\\npm-cli.js',
  corepackPath: 'C:\\rt\\node_modules\\corepack\\dist\\corepack.js',
  dir: 'C:\\rt',
  source: 'downloaded',
};

function manifest(patch: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schema: 1,
    id: 'p1',
    name: 'demo',
    source: 'linked',
    rootDir: 'C:\\proj\\demo',
    startMode: 'node',
    entry: 'server.js',
    portMode: 'inject',
    port: 3000,
    autoInstallDeps: 'ask',
    allowInstallScripts: false,
    restartPolicy: { mode: 'never', maxRetries: 3, backoffMs: 2000 },
    singleton: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('占位符', () => {
  it('替换已知占位符，保留未知', () => {
    expect(
      substitutePlaceholders('--port {PORT} --host {HOST} {UNKNOWN}', {
        PORT: 3000,
        HOST: '0.0.0.0',
      })
    ).toBe('--port 3000 --host 0.0.0.0 {UNKNOWN}');
  });

  it('值为空时保留占位符原文', () => {
    expect(substitutePlaceholders('{PORT}', {})).toBe('{PORT}');
  });
});

describe('buildSpawnPlan - Node 直启', () => {
  it('无 shell、逐个参数、注入 PORT/HOST 与 PATH', () => {
    const plan = buildSpawnPlan({
      manifest: manifest({ args: ['--port', '{PORT}'] }),
      runtime,
      rootDir: 'C:\\proj\\demo',
      port: 3000,
      host: '0.0.0.0',
      baseEnv: { PATH: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x' },
    });

    expect(plan.shell).toBe(false);
    expect(plan.command).toBe('C:\\rt\\node.exe');
    expect(plan.args[0]).toBe('C:\\proj\\demo\\server.js');
    expect(plan.args.slice(1)).toEqual(['--port', '3000']);
    expect(plan.env.PORT).toBe('3000');
    expect(plan.env.HOST).toBe('0.0.0.0');
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(plan.env.NODE_OPTIONS).toBeUndefined();
    expect(plan.env.PATH.startsWith('C:\\rt')).toBe(true);
  });

  it('入口越界直接抛错', () => {
    expect(() =>
      buildSpawnPlan({
        manifest: manifest({ entry: '../../evil.js' }),
        runtime,
        rootDir: 'C:\\proj\\demo',
        port: 3000,
        host: '0.0.0.0',
      })
    ).toThrow();
  });

  it('cwd 越界直接抛错', () => {
    expect(() => resolveWorkingDir('C:\\proj\\demo', '..\\..\\windows')).toThrow();
  });

  it('注入上报脚本时使用正斜杠并引号包裹', () => {
    const plan = buildSpawnPlan({
      manifest: manifest(),
      runtime,
      rootDir: 'C:\\proj\\demo',
      port: null,
      host: '0.0.0.0',
      reporterPath: 'C:\\app\\dist-electron\\core\\launch\\metrics-reporter.js',
      injectReporter: true,
    });
    expect(plan.env.NODE_OPTIONS).toBe(
      '--require "C:/app/dist-electron/core/launch/metrics-reporter.js"'
    );
    expect(quoteForNodeOptions('a\\b.js')).toBe('--require "a/b.js"');
  });

  it('portMode=display 时不注入 PORT', () => {
    const plan = buildSpawnPlan({
      manifest: manifest({ portMode: 'display' }),
      runtime,
      rootDir: 'C:\\proj\\demo',
      port: 3000,
      host: '0.0.0.0',
      baseEnv: {},
    });
    expect(plan.env.PORT).toBeUndefined();
  });
});

describe('buildSpawnPlan - 自定义命令', () => {
  it('Windows 下用 cmd.exe /d /s /c 显式调起 shell，不开 shell:true', () => {
    const plan = buildSpawnPlan({
      manifest: manifest({
        startMode: 'command',
        entry: undefined,
        command: 'npm run dev -- --port {PORT} && echo done',
        args: ['--ignored'],
      }),
      runtime,
      rootDir: 'C:\\proj\\demo',
      port: 4100,
      host: '0.0.0.0',
      baseEnv: { PATH: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      platform: 'win32',
    });

    expect(plan.mode).toBe('command');
    expect(plan.shell).toBe(false);
    expect(plan.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(plan.args).toEqual(['/d', '/s', '/c', 'npm run dev -- --port 4100 && echo done']);
    expect(plan.displayLine).toBe('npm run dev -- --port 4100 && echo done');
    expect(plan.env.PATH.startsWith('C:\\rt')).toBe(true);
    // 自定义命令下绝不再注入 ELECTRON_RUN_AS_NODE
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('POSIX 下用 /bin/sh -c', () => {
    const plan = buildSpawnPlan({
      manifest: manifest({ startMode: 'command', entry: undefined, command: 'npm start' }),
      runtime,
      rootDir: '/proj/demo',
      port: null,
      host: '0.0.0.0',
      baseEnv: {},
      platform: 'linux',
    });
    expect(plan.shell).toBe(false);
    expect(plan.command).toBe('/bin/sh');
    expect(plan.args).toEqual(['-c', 'npm start']);
  });

  it('工作区子目录作为 cwd', () => {
    const plan = buildSpawnPlan({
      manifest: manifest({ startMode: 'command', command: 'npm start', cwd: 'packages/api' }),
      runtime,
      rootDir: 'C:\\proj\\demo',
      port: null,
      host: '0.0.0.0',
    });
    expect(plan.cwd).toBe('C:\\proj\\demo\\packages\\api');
  });

  it('manifest.env 覆盖默认注入并可引用占位符', () => {
    const plan = buildSpawnPlan({
      manifest: manifest({ env: { HOST: '127.0.0.1', CUSTOM: 'port-{PORT}' } }),
      runtime,
      rootDir: 'C:\\proj\\demo',
      port: 3001,
      host: '0.0.0.0',
      baseEnv: {},
    });
    expect(plan.env.HOST).toBe('127.0.0.1');
    expect(plan.env.CUSTOM).toBe('port-3001');
  });

  it('.env 文件值优先级低于 manifest.env', () => {
    const plan = buildSpawnPlan({
      manifest: manifest({ env: { A: 'from-manifest' } }),
      runtime,
      rootDir: 'C:\\proj\\demo',
      port: null,
      host: '0.0.0.0',
      envFileValues: { A: 'from-file', B: 'only-file' },
      baseEnv: {},
    });
    expect(plan.env.A).toBe('from-manifest');
    expect(plan.env.B).toBe('only-file');
  });
});
