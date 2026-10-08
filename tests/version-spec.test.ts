import { describe, expect, it, vi } from 'vitest';
import path from 'path';

import { NodeRuntimeProvider } from '../electron/core/runtime/node-provider';
import {
  isConcreteVersion,
  majorOf,
  normalizeNodeSpec,
  safeSegment,
  specMatchesVersion,
} from '../electron/core/runtime/version-spec';
import { makeTmpDir, cleanupTmpRoot } from './helpers/tmp';

describe('版本约束归一化', () => {
  it('把 engines 里的范围写法收敛成主版本号', () => {
    expect(normalizeNodeSpec('22')).toBe('22');
    expect(normalizeNodeSpec('v22')).toBe('22');
    expect(normalizeNodeSpec('>=22')).toBe('22');
    expect(normalizeNodeSpec('^20.11.0')).toBe('20');
    expect(normalizeNodeSpec('~18')).toBe('18');
    expect(normalizeNodeSpec('>=20 <23')).toBe('20');
    expect(normalizeNodeSpec('22.x')).toBe('22');
    expect(normalizeNodeSpec('  >= 22.1.0  ')).toBe('22');
  });

  it('完整版本原样保留', () => {
    expect(normalizeNodeSpec('22.11.0')).toBe('22.11.0');
    expect(normalizeNodeSpec('v22.11.0')).toBe('22.11.0');
  });

  it('识别不了的返回 null，绝不原样透传', () => {
    expect(normalizeNodeSpec('')).toBeNull();
    expect(normalizeNodeSpec('latest')).toBeNull();
    expect(normalizeNodeSpec('>=x')).toBeNull();
  });

  it('majorOf 取第一个数字', () => {
    expect(majorOf('>=22')).toBe('22');
    expect(majorOf('nope')).toBeNull();
  });

  it('specMatchesVersion：主版本号匹配 22.x.y，完整版本要求精确相等', () => {
    expect(specMatchesVersion('22.23.3', '>=22')).toBe(true);
    expect(specMatchesVersion('22.23.3', '22')).toBe(true);
    expect(specMatchesVersion('22.23.3', '22.23.3')).toBe(true);
    expect(specMatchesVersion('22.23.3', '22.11.0')).toBe(false);
    expect(specMatchesVersion('20.1.0', '22')).toBe(false);
  });

  it('safeSegment 清掉 Windows 非法字符（回归：.tmp->=22-... 曾导致路径非法）', () => {
    expect(safeSegment('.tmp->=22-1791344059070')).toBe('.tmp-__22-1791344059070');
    expect(safeSegment('node-22.23.3-win32-x64')).toBe('node-22.23.3-win32-x64');
    expect(safeSegment('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('isConcreteVersion 只认 x.y.z', () => {
    expect(isConcreteVersion('22.23.3')).toBe(true);
    expect(isConcreteVersion('>=22')).toBe(false);
    expect(isConcreteVersion('22')).toBe(false);
  });
});

describe('运行时解析（回归：">=22" 不再产生非法目录名）', () => {
  const provider = (dir: string): NodeRuntimeProvider =>
    new NodeRuntimeProvider({
      bundledDir: path.join(dir, 'bundled'),
      runtimesDir: path.join(dir, 'runtimes'),
      platform: 'win32',
      arch: 'x64',
      getConfig: async () => ({
        defaultNodeVersion: '22',
        nodeDownloadMirror: 'https://example.invalid/',
        preferBundledRuntime: true,
      }),
      download: async () => {
        throw new Error('不应触发下载');
      },
    });

  it('resolveVersion 把 ">=22" 解析成具体版本号', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { version: 'v22.10.0', files: [] },
          { version: 'v22.11.0', files: [] },
          { version: 'v20.19.0', files: [] },
        ],
      }))
    );

    const dir = await makeTmpDir('vs');
    const resolved = await provider(dir).resolveVersion('>=22', 'https://example.invalid/');
    expect(resolved).toBe('22.11.0');
    expect(isConcreteVersion(resolved)).toBe(true);
    // 拼出来的目录名必须没有非法字符
    expect(safeSegment(resolved)).toBe(resolved);

    vi.unstubAllGlobals();
    await cleanupTmpRoot();
  });

  it('索引拿不到时回退到内置已知版本', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );
    const dir = await makeTmpDir('vs2');
    await expect(provider(dir).resolveVersion('>=22', 'https://example.invalid/')).resolves.toBe(
      '22.23.3'
    );
    vi.unstubAllGlobals();
    await cleanupTmpRoot();
  });

  it('无法识别的版本直接报错，而不是拼出非法路径', async () => {
    const dir = await makeTmpDir('vs3');
    await expect(provider(dir).ensureRuntime('latest')).rejects.toThrow(/无法识别/);
    await cleanupTmpRoot();
  });
});
