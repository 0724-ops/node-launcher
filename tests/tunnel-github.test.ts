import { EventEmitter } from 'events';
import path from 'path';
import fse from 'fs-extra';
import { afterAll, describe, expect, it } from 'vitest';

import {
  applyGithubMirror,
  DEFAULT_GITHUB_MIRROR,
} from '../electron/core/net/github-mirror';
import {
  PROBE_INTERVAL_MS,
  PROBE_MAX_ATTEMPTS,
  PROBE_WINDOW_MS,
  TunnelManager,
  cloudflaredAssetName,
  isTunnelReachableStatus,
  parseTunnelUrl,
} from '../electron/core/tunnel/tunnel-manager';
import type { AppConfig, TunnelState } from '../electron/types';
import { cleanupTmpRoot, makeTmpDir } from './helpers/tmp';

afterAll(async () => {
  await cleanupTmpRoot();
});

function stubConfig(): AppConfig {
  return { githubMirror: '', tunnelUseHttp2: true } as AppConfig;
}

/** 假 cloudflared 进程：pid=0 → killProcessTree 直接返回，绝不误杀真实进程 */
function fakeProc(): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 0;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    return true;
  };
  return proc;
}

type SpawnLike = typeof import('child_process').spawn;

describe('GitHub 镜像加速（沿用旧启动器逻辑）', () => {
  const origin =
    'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

  it('未配置镜像时原样返回', () => {
    expect(applyGithubMirror(origin, '')).toBe(origin);
    expect(applyGithubMirror(origin, undefined)).toBe(origin);
    expect(applyGithubMirror(origin, '   ')).toBe(origin);
  });

  it('镜像前缀 + 原始地址；自动补斜杠', () => {
    expect(applyGithubMirror(origin, 'https://gh-proxy.com')).toBe(
      `https://gh-proxy.com/${origin}`
    );
    expect(applyGithubMirror(origin, 'https://gh-proxy.com/')).toBe(
      `https://gh-proxy.com/${origin}`
    );
    expect(DEFAULT_GITHUB_MIRROR.endsWith('/')).toBe(true);
    expect(applyGithubMirror(origin, DEFAULT_GITHUB_MIRROR)).toBe(
      `${DEFAULT_GITHUB_MIRROR}${origin}`
    );
  });

  it('已经是镜像地址时不再二次拼接', () => {
    const mirrored = applyGithubMirror(origin, 'https://gh-proxy.com/');
    expect(applyGithubMirror(mirrored, 'https://gh-proxy.com/')).toBe(mirrored);
  });
});

describe('cloudflared 资产名与公网地址解析', () => {
  it('按平台/架构选资产', () => {
    expect(cloudflaredAssetName('win32', 'x64')).toBe('cloudflared-windows-amd64.exe');
    expect(cloudflaredAssetName('win32', 'arm64')).toBe('cloudflared-windows-arm64.exe');
    expect(cloudflaredAssetName('linux', 'x64')).toBe('cloudflared-linux-amd64');
  });

  it('从 cloudflared 输出里解析 trycloudflare 地址', () => {
    const line =
      '2026-10-07T11:00:00Z INF |  https://random-words-here.trycloudflare.com  |';
    expect(parseTunnelUrl(line)).toBe('https://random-words-here.trycloudflare.com');
    expect(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
    expect(parseTunnelUrl('')).toBeNull();
    // 大小写混排也归一化
    expect(parseTunnelUrl('https://ABC-DEF.trycloudflare.com')).toBe(
      'https://abc-def.trycloudflare.com'
    );
  });
});

describe('公网可达性判定（地址出来 ≠ 已经能访问）', () => {
  it('502/503/504/530 视为回源未就绪，其余视为请求已打到源站', () => {
    for (const status of [502, 503, 504, 530]) {
      expect(isTunnelReachableStatus(status)).toBe(false);
    }
    for (const status of [200, 301, 302, 401, 403, 404]) {
      expect(isTunnelReachableStatus(status)).toBe(true);
    }
  });
});

describe('公网可达性验证窗口', () => {
  it('至少持续 40 秒（用户反馈 20 秒不够）', () => {
    expect(PROBE_WINDOW_MS).toBeGreaterThanOrEqual(40000);
    expect(PROBE_INTERVAL_MS).toBeGreaterThan(0);
    // 次数由窗口推导，改窗口不用改次数
    expect(PROBE_MAX_ATTEMPTS * PROBE_INTERVAL_MS).toBeGreaterThanOrEqual(PROBE_WINDOW_MS);
  });
});

describe('穿透状态机（回归：不再在地址分配的瞬间谎报成功）', () => {
  it('地址分配后先进入 probing，确认公网可达才置为 running', async () => {
    const binDir = await makeTmpDir('tunnel-bin');
    await fse.outputFile(path.join(binDir, 'cloudflared.exe'), 'stub');

    const proc = fakeProc();
    const states: TunnelState[] = [];
    const manager = new TunnelManager({
      binDir,
      getConfig: async () => stubConfig(),
      log: () => {},
      onState: (s) => states.push(s),
      spawnFn: (() => proc) as unknown as SpawnLike,
      probeLocal: async () => true,
      probePublic: async () => true,
    });

    await manager.start('p1', 4321);
    proc.stderr.emit('data', Buffer.from('INF | https://abc-def.trycloudflare.com |\n'));

    // 刚拿到地址：只能说明「正在验证」
    expect(manager.getState('p1').status).toBe('probing');
    expect(manager.getState('p1').url).toBe('https://abc-def.trycloudflare.com');

    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(manager.getState('p1').status).toBe('running');
    expect(states.map((s) => s.status)).toContain('probing');

    await manager.stop('p1');
    expect(manager.getState('p1').status).toBe('stopped');
    expect(manager.getState('p1').url).toBeNull();
  });

  it('公网持续不可达时保持 probing 并给出说明', async () => {
    const binDir = await makeTmpDir('tunnel-bin2');
    await fse.outputFile(path.join(binDir, 'cloudflared.exe'), 'stub');

    const proc = fakeProc();
    const manager = new TunnelManager({
      binDir,
      getConfig: async () => stubConfig(),
      log: () => {},
      onState: () => {},
      spawnFn: (() => proc) as unknown as SpawnLike,
      probeLocal: async () => false,
      probePublic: async () => false,
    });

    await manager.start('p2', 4321);
    proc.stderr.emit('data', Buffer.from('INF | https://xyz-123.trycloudflare.com |\n'));

    await new Promise((resolve) => setTimeout(resolve, 3600));
    const state = manager.getState('p2');
    expect(state.status).toBe('probing');
    expect(state.message ?? '').toContain('等待公网可达');
    // 地址在验证期间就要能看到（用户可以自己先试）
    expect(state.url).toBe('https://xyz-123.trycloudflare.com');

    await manager.stop('p2');
  });

  it('recheck 可手动再跑一轮检测（自动窗口用完后不必拆掉隧道）', async () => {
    const binDir = await makeTmpDir('tunnel-bin3');
    await fse.outputFile(path.join(binDir, 'cloudflared.exe'), 'stub');

    const proc = fakeProc();
    let reachable = false;
    const manager = new TunnelManager({
      binDir,
      getConfig: async () => stubConfig(),
      log: () => {},
      onState: () => {},
      spawnFn: (() => proc) as unknown as SpawnLike,
      probeLocal: async () => true,
      probePublic: async () => reachable,
    });

    await manager.start('p3', 4321);
    proc.stderr.emit('data', Buffer.from('INF | https://re-3.trycloudflare.com |\n'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(manager.getState('p3').status).toBe('probing');

    reachable = true;
    const state = manager.recheck('p3');
    expect(state.status).toBe('probing');
    expect(state.url).toBe('https://re-3.trycloudflare.com');

    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(manager.getState('p3').status).toBe('running');

    // 没有地址时不允许重新检测
    expect(() => manager.recheck('不存在')).toThrow(/无法重新检测/);

    await manager.stop('p3');
  });
});
