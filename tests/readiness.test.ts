import { describe, expect, it } from 'vitest';
import { ReadinessWatcher, type ReadySource } from '../electron/core/launch/readiness';

/** 起一个 watcher，等它给出就绪来源（或超时兜底） */
function watch(opts: {
  healthUrl?: string | null;
  port: number | null;
  isAlive?: () => boolean;
  probeHttpFn?: (url: string) => Promise<boolean>;
  probeTcpFn?: (port: number, host: string) => Promise<boolean>;
  pattern?: string | null;
  feed?: string;
  timeoutMs?: number;
}): Promise<ReadySource> {
  return new Promise<ReadySource>((resolve) => {
    const watcher = new ReadinessWatcher({
      projectId: 'p1',
      pattern: opts.pattern ?? null,
      healthUrl: opts.healthUrl ?? null,
      port: opts.port,
      host: '127.0.0.1',
      timeoutMs: opts.timeoutMs ?? 3000,
      intervalMs: 20,
      onLog: () => {},
      isAlive: opts.isAlive,
      probeHttpFn: opts.probeHttpFn,
      probeTcpFn: opts.probeTcpFn,
      onReady: resolve,
    });
    watcher.start();
    if (opts.feed) watcher.feed(opts.feed);
  });
}

describe('就绪判定：端口探测', () => {
  it('进程存活且端口监听即判定就绪', async () => {
    const source = await watch({ port: 3080, probeTcpFn: async () => true });
    expect(source).toBe('tcp');
  });

  it('配了健康检查 URL 时端口探测依然生效（不被挡住）', async () => {
    const source = await watch({
      port: 3080,
      healthUrl: 'http://127.0.0.1:{PORT}/health',
      probeHttpFn: async () => false, // 健康检查一直不通
      probeTcpFn: async () => true, // 端口已监听
    });
    expect(source).toBe('tcp');
  });

  it('进程已退出时端口命中不视为就绪', async () => {
    const source = await watch({
      port: 3080,
      isAlive: () => false,
      probeTcpFn: async () => true,
      healthUrl: 'http://127.0.0.1:{PORT}/health',
      probeHttpFn: async () => true,
    });
    expect(source).toBe('http');
  });

  it('健康检查命中优先于尚未监听的端口', async () => {
    const source = await watch({
      port: 3080,
      healthUrl: 'http://127.0.0.1:{PORT}/health',
      probeHttpFn: async () => true,
      probeTcpFn: async () => false,
    });
    expect(source).toBe('http');
  });

  it('日志正则命中即就绪', async () => {
    const source = await watch({
      port: null,
      pattern: 'listening on',
      feed: 'server listening on 3080',
    });
    expect(source).toBe('pattern');
  });
});