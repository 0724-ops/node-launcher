import { describe, expect, it } from 'vitest';
import {
  classifyError,
  isInstallable,
  packageNameFromSpecifier,
} from '../electron/core/deps/classify-error';

describe('classifyError - 可安装（只有裸包缺失才算）', () => {
  it('CJS 缺少模块', () => {
    const r = classifyError("Error: Cannot find module 'express'\n    at ...");
    expect(r.category).toBe('missing-module');
    expect(r.moduleName).toBe('express');
    expect(r.installable).toBe(true);
    expect(isInstallable(r.category)).toBe(true);
  });

  it('ESM 缺少包', () => {
    const r = classifyError("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fastify' imported from x");
    expect(r.category).toBe('missing-module');
    expect(r.moduleName).toBe('fastify');
  });

  it('scoped 包名归一化到包（去掉子路径）', () => {
    expect(packageNameFromSpecifier('@scope/pkg/sub/path')).toBe('@scope/pkg');
    expect(packageNameFromSpecifier('pkg/sub')).toBe('pkg');
  });
});

describe('classifyError - 不可安装（避免误装）', () => {
  it('相对路径导入缺失 → 路径问题', () => {
    const r = classifyError("Error: Cannot find module './routes/user'");
    expect(r.category).toBe('missing-relative');
    expect(r.installable).toBe(false);
  });

  it('绝对路径缺失 → 路径问题', () => {
    expect(classifyError("Error: Cannot find module '/opt/app/lib/x.js'").category).toBe(
      'missing-relative'
    );
  });

  it('内置模块缺失 → 路径/环境问题', () => {
    expect(classifyError("Error: Cannot find module 'node:fs'").category).toBe('missing-relative');
  });

  it('自引用包名不算缺依赖', () => {
    const r = classifyError("Error: Cannot find module 'my-app'", { selfName: 'my-app' });
    expect(r.installable).toBe(false);
  });

  it('原生模块 ABI 不匹配', () => {
    const r = classifyError(
      'Error: The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127.'
    );
    expect(r.category).toBe('native-abi');
    expect(r.installable).toBe(false);
  });

  it('缺少 .node 产物归为原生模块问题', () => {
    const r = classifyError("Error: Cannot find module '../build/Release/binding.node'");
    expect(r.category).toBe('native-abi');
    expect(r.installable).toBe(false);
  });

  it('node-gyp / 编译环境缺失', () => {
    expect(classifyError('gyp ERR! find VS msvs_version not set').category).toBe('build-tool');
  });

  it('端口占用', () => {
    const r = classifyError('Error: listen EADDRINUSE: address already in use :::3000');
    expect(r.category).toBe('port-in-use');
    expect(r.installable).toBe(false);
  });

  it('权限问题', () => {
    expect(classifyError('npm ERR! Error: EACCES: permission denied').category).toBe('permission');
  });

  it('网络问题', () => {
    expect(classifyError('Error: getaddrinfo ENOTFOUND registry.npmjs.org').category).toBe('network');
  });

  it('ESM/CJS 格式问题', () => {
    expect(
      classifyError('Error [ERR_REQUIRE_ESM]: require() of ES Module not supported').category
    ).toBe('syntax');
  });

  it('命令不存在', () => {
    const r = classifyError("'npxx' is not recognized as an internal or external command");
    expect(r.category).toBe('command-not-found');
  });

  it('无法识别时保持 unknown，绝不误触发安装', () => {
    const r = classifyError('some totally unknown failure');
    expect(r.category).toBe('unknown');
    expect(r.installable).toBe(false);
  });
});

describe('classifyError - 细节', () => {
  it('多行日志里取命中行作为证据', () => {
    const r = classifyError(['start', "Error: Cannot find module 'lodash'", 'exit'].join('\n'));
    expect(r.matchedLine).toContain('lodash');
  });

  it('分类优先于缺失模块：ABI 报错同时含 Cannot find module .node', () => {
    const text = [
      'NODE_MODULE_VERSION mismatch',
      "Error: Cannot find module '../build/Release/x.node'",
    ].join('\n');
    expect(classifyError(text).category).toBe('native-abi');
  });
});
