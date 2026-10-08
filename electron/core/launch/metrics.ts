import pidusage from 'pidusage';
import type { MetricsSnapshot, MetricsStrategy } from '../../types';
import { ProcessTreeProbe } from './process-tree';

export interface MetricsCollectorOptions {
  projectId: string;
  rootPid: number;
  strategy: MetricsStrategy;
  /** 是否成功注入了上报脚本 */
  hasReporter: boolean;
  tree: ProcessTreeProbe;
  intervalMs?: number;
  autoFallbackMs?: number;
  maxPollFailures?: number;
  onMetrics: (snapshot: MetricsSnapshot) => void;
  onLog: (msg: string) => void;
}

const DEFAULT_INTERVAL = 2000;
const DEFAULT_AUTO_FALLBACK = 8000;
const DEFAULT_MAX_FAILURES = 3;

/**
 * 性能采集：
 *  - reporter：子进程通过 IPC 主动上报（零额外进程开销）
 *  - polling：对**整棵进程树**求和（npm start 的真实服务在孙进程里）
 */
export class MetricsCollector {
  private timer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private inFlight = false;
  private failures = 0;
  private stopped = false;

  constructor(private readonly opts: MetricsCollectorOptions) {}

  start(): void {
    if (this.opts.strategy === 'polling' || !this.opts.hasReporter) {
      this.opts.onLog(
        this.opts.hasReporter
          ? '性能采集方式: 外部轮询（进程树）'
          : '未注入性能上报脚本，使用外部轮询（进程树）'
      );
      this.startPolling();
      return;
    }

    this.opts.onLog(`性能采集方式: 子进程上报（策略 ${this.opts.strategy}）`);
    if (this.opts.strategy === 'auto') {
      const wait = this.opts.autoFallbackMs ?? DEFAULT_AUTO_FALLBACK;
      this.fallbackTimer = setTimeout(() => {
        this.fallbackTimer = null;
        if (this.stopped) return;
        this.opts.onLog(`等待 ${Math.round(wait / 1000)} 秒未收到上报，降级为外部轮询`);
        this.startPolling();
      }, wait);
    }
  }

  /** 收到子进程上报；返回 true 表示已消费 */
  handleReporterMessage(msg: unknown): boolean {
    if (!msg || typeof msg !== 'object') return false;
    const payload = msg as { type?: string; cpu?: number; memory?: number };
    if (payload.type !== 'metrics') return false;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.emit(Number(payload.cpu) || 0, Number(payload.memory) || 0, 'reporter', 1);
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.polling = false;
    this.failures = 0;
  }

  private startPolling(): void {
    if (this.polling || this.stopped) return;
    this.polling = true;
    this.failures = 0;
    const interval = this.opts.intervalMs ?? DEFAULT_INTERVAL;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, interval);
  }

  private async pollOnce(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      const pids = await this.opts.tree.descendants(this.opts.rootPid);
      const stats = await pidusage(pids);
      if (this.stopped) return;

      const list =
        typeof (stats as { cpu?: number }).cpu === 'number'
          ? [stats as pidusage.PidStat]
          : Object.values(stats as Record<string, pidusage.PidStat>);

      if (!list.length) throw new Error('no stats');

      let cpu = 0;
      let memoryBytes = 0;
      for (const stat of list) {
        cpu += Number(stat?.cpu) || 0;
        memoryBytes += Number(stat?.memory) || 0;
      }
      this.failures = 0;
      this.emit(
        Math.min(cpu, 100 * list.length),
        memoryBytes / 1024 / 1024,
        'polling',
        list.length
      );
    } catch {
      this.failures += 1;
      const max = this.opts.maxPollFailures ?? DEFAULT_MAX_FAILURES;
      if (this.failures >= max) {
        this.opts.onLog(`性能采集连续失败 ${this.failures} 次，已停止轮询`);
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        this.polling = false;
      }
    } finally {
      this.inFlight = false;
    }
  }

  private emit(
    cpu: number,
    memoryMb: number,
    strategy: 'reporter' | 'polling',
    pidCount: number
  ): void {
    this.opts.onMetrics({
      projectId: this.opts.projectId,
      cpu: Math.round(cpu * 10) / 10,
      memoryMb: Math.round(memoryMb * 10) / 10,
      strategy,
      pidCount,
      at: Date.now(),
    });
  }
}
