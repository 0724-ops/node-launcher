import { afterAll, describe, expect, it } from 'vitest';
import path from 'path';
import fse from 'fs-extra';
import {
  buildInstallInvocation,
  buildScriptCommand,
  detectPackageManager,
  extractEntryFromScript,
  readPackageJson,
} from '../electron/core/runtime/package-manager';
import { precheckDeps } from '../electron/core/deps/precheck';
import {
  compareVersions,
  parseRuntimeDirName,
  pickBestMatch,
  runtimeDirName,
} from '../electron/core/runtime/node-provider';
import type { RuntimeInfo } from '../electron/types';
import { cleanupTmpRoot, makeTmpDir, writeJson } from './helpers/tmp';

afterAll(async () => {
  await cleanupTmpRoot();
});

const runtime: RuntimeInfo = {
  version: '22.23.3',
  abi: '127',
  nodePath: 'C:\\rt\\node.exe',
  npmCliPath: 'C:\\rt\\node_modules\\npm\\bin\\npm-cli.js',
  corepackPath: 'C:\\rt\\node_modules\\corepack\\dist\\corepack.js',
  dir: 'C:\\rt',
  source: 'downloaded',
};

describe('包管理器探测', () => {
  it('无 package.json → 默认 npm 且不误判', async () => {
    const dir = await makeTmpDir('pm-none');
    const detected = await detectPackageManager(dir);
    expect(detected.name).toBe('npm');
    expect(detected.lockfile).toBeNull();
  });

  it('package-lock.json → npm（含 ci 判定依据）', async () => {
    const dir = await makeTmpDir('pm-npm');
    await writeJson(path.join(dir, 'package.json'), { name: 'a' });
    await fse.writeFile(path.join(dir, 'package-lock.json'), '{}');
    const detected = await detectPackageManager(dir);
    expect(detected.name).toBe('npm');
    expect(detected.lockfile).toBe('package-lock.json');
  });

  it('pnpm-lock.yaml → pnpm', async () => {
    const dir = await makeTmpDir('pm-pnpm');
    await writeJson(path.join(dir, 'package.json'), { name: 'a' });
    await fse.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    expect((await detectPackageManager(dir)).name).toBe('pnpm');
  });

  it('packageManager 字段优先于 lockfile', async () => {
    const dir = await makeTmpDir('pm-field');
    await writeJson(path.join(dir, 'package.json'), {
      name: 'a',
      packageManager: 'pnpm@9.1.0',
    });
    await fse.writeFile(path.join(dir, 'yarn.lock'), '');
    const detected = await detectPackageManager(dir);
    expect(detected.name).toBe('pnpm');
    expect(detected.fromField).toBe(true);
  });

  it('读取 scripts / type / engines', async () => {
    const dir = await makeTmpDir('pm-read');
    await writeJson(path.join(dir, 'package.json'), {
      name: 'demo',
      type: 'module',
      main: 'dist/main.js',
      engines: { node: '>=20' },
      scripts: { start: 'node src/server.js', dev: 'vite' },
    });
    const pkg = await readPackageJson(dir);
    expect(pkg.moduleType).toBe('module');
    expect(pkg.main).toBe('dist/main.js');
    expect(pkg.enginesNode).toBe('>=20');
    expect(Object.keys(pkg.scripts)).toEqual(['start', 'dev']);
  });
});

describe('安装命令构造（必须绕开 .cmd）', () => {
  it('npm + lockfile → ci，并默认附加 --ignore-scripts', () => {
    const inv = buildInstallInvocation('npm', runtime, {
      hasLockfile: true,
      ignoreScripts: true,
      registry: 'https://registry.npmmirror.com',
    });
    expect(inv.command).toBe(runtime.nodePath);
    expect(inv.args[0]).toBe(runtime.npmCliPath);
    expect(inv.args).toContain('ci');
    expect(inv.args).toContain('--ignore-scripts');
    expect(inv.args).toContain('--registry=https://registry.npmmirror.com');
    expect(inv.args).toContain('--no-audit');
  });

  it('无 lockfile → install；允许脚本时不带 --ignore-scripts', () => {
    const inv = buildInstallInvocation('npm', runtime, {
      hasLockfile: false,
      ignoreScripts: false,
    });
    expect(inv.args).toContain('install');
    expect(inv.args).not.toContain('--ignore-scripts');
  });

  it('pnpm 走 corepack（同样是 node + js 入口）', () => {
    const inv = buildInstallInvocation('pnpm', runtime, {
      hasLockfile: true,
      ignoreScripts: true,
    });
    expect(inv.command).toBe(runtime.nodePath);
    expect(inv.args[0]).toBe(runtime.corepackPath);
    expect(inv.args.slice(1, 3)).toEqual(['pnpm', 'install']);
  });

  it('缺少 corepack 时给出明确错误而不是 ENOENT', () => {
    expect(() =>
      buildInstallInvocation('yarn', { ...runtime, corepackPath: null }, {
        hasLockfile: true,
        ignoreScripts: true,
      })
    ).toThrow(/corepack/);
  });

  it('运行时缺 npm 时给出明确错误', () => {
    expect(() =>
      buildInstallInvocation('npm', { ...runtime, npmCliPath: '' }, {
        hasLockfile: true,
        ignoreScripts: false,
      })
    ).toThrow(/npm/);
  });
});

describe('脚本入口提取', () => {
  it('识别 node <file> 形式', () => {
    expect(extractEntryFromScript('node src/server.js')).toBe('src/server.js');
    expect(extractEntryFromScript('node --enable-source-maps app.mjs')).toBe('app.mjs');
  });

  it('非 node 形式不误判（ts-node/vite/nest 都应交给自定义命令）', () => {
    expect(extractEntryFromScript('vite')).toBeNull();
    expect(extractEntryFromScript('nest start')).toBeNull();
    expect(extractEntryFromScript('ts-node index.ts')).toBeNull();
    expect(extractEntryFromScript('nodemon index.js')).toBeNull();
    expect(extractEntryFromScript('')).toBeNull();
  });

  it('按包管理器生成脚本命令', () => {
    expect(buildScriptCommand('npm', 'dev')).toBe('npm run dev');
    expect(buildScriptCommand('pnpm', 'dev')).toBe('pnpm dev');
    expect(buildScriptCommand('bun', 'dev')).toBe('bun run dev');
  });
});

describe('依赖预检', () => {
  it('无 package.json → 不参与依赖管理', async () => {
    const dir = await makeTmpDir('pre-na');
    const result = await precheckDeps(dir);
    expect(result.hasPackageJson).toBe(false);
    expect(result.needsInstall).toBe(false);
  });

  it('有 package.json 无 node_modules → 需要安装', async () => {
    const dir = await makeTmpDir('pre-missing');
    await writeJson(path.join(dir, 'package.json'), { name: 'a' });
    const result = await precheckDeps(dir);
    expect(result.needsInstall).toBe(true);
    expect(result.nodeModulesExists).toBe(false);
  });

  it('空 node_modules 目录仍视为缺失', async () => {
    const dir = await makeTmpDir('pre-empty');
    await writeJson(path.join(dir, 'package.json'), { name: 'a' });
    await fse.ensureDir(path.join(dir, 'node_modules'));
    const result = await precheckDeps(dir);
    expect(result.needsInstall).toBe(true);
  });

  it('已有 node_modules → 视为就绪并统计体积', async () => {
    const dir = await makeTmpDir('pre-ready');
    await writeJson(path.join(dir, 'package.json'), { name: 'a' });
    await fse.outputFile(path.join(dir, 'node_modules', 'x', 'index.js'), 'x'.repeat(500));
    const result = await precheckDeps(dir);
    expect(result.needsInstall).toBe(false);
    expect(result.nodeModulesEntries).toBeGreaterThan(0);
    expect(result.nodeModulesSizeBytes).toBeGreaterThanOrEqual(500);
  });
});

describe('运行时版本选择', () => {
  it('版本号比较按数值', () => {
    expect(compareVersions('22.10.0', '22.9.0')).toBeGreaterThan(0);
    expect(compareVersions('v22.0.0', '22.0.0')).toBe(0);
    expect(compareVersions('20.1.0', '22.0.0')).toBeLessThan(0);
  });

  it('目录命名约定', () => {
    expect(runtimeDirName('22.23.3', 'win32', 'x64')).toBe('node-22.23.3-win32-x64');
  });

  it('只认约定目录名（避免内置运行时永远识别不到）', () => {
    expect(parseRuntimeDirName('node-22.23.3-win32-x64', 'win32', 'x64')).toBe('22.23.3');
    expect(parseRuntimeDirName('node-20.11.1-win32-x64', 'win32', 'x64')).toBe('20.11.1');
    // 平台/架构不符
    expect(parseRuntimeDirName('node-22.23.3-linux-x64', 'win32', 'x64')).toBeNull();
    // 缺少版本号
    expect(parseRuntimeDirName('node-win32-x64', 'win32', 'x64')).toBeNull();
    // 完全不相关
    expect(parseRuntimeDirName('something-else', 'win32', 'x64')).toBeNull();
    expect(parseRuntimeDirName('node_modules', 'win32', 'x64')).toBeNull();
  });

  it('spec 匹配主版本并优先内置', () => {
    const list: RuntimeInfo[] = [
      { ...runtime, version: '22.10.0', source: 'downloaded' },
      { ...runtime, version: '22.9.0', source: 'bundled' },
      { ...runtime, version: '20.11.0', source: 'bundled' },
    ];
    expect(pickBestMatch(list, '22', false)!.version).toBe('22.10.0');
    expect(pickBestMatch(list, '22', true)!.version).toBe('22.9.0');
    expect(pickBestMatch(list, '18', true)).toBeNull();
  });
});
