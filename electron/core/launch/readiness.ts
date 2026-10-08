import { probeTcp } from '../net/ports';
import { substitutePlaceholders } from './placeholders';

export type ReadySource = 'pattern' | 'http' | 'tcp' | 'timeout';

export interface ReadinessOptions {
  projectId: string;
  pattern?: string | null;
  healthUrl?: string | null;
  port: number | null;
  host: string;
  timeoutMs: number;
  onReady: (source: ReadySource) => void;
  onLog: (msg: string) => void;
  /** 进程是否仍在运行；TCP 探测命中时用它排除「端口早就被别人占着」的假就绪 */
  isAlive?: () => boolean;
  /** 测试注入点 */
  probeTcpFn?: (port: number, host: string) => Promise<boolean>;
  probeHttpFn?: (url: string) => Promise<boolean>;
  intervalMs?: number;
}

/**
 * 就绪判定（PLAN §6.3）：
 *   日志正则（feed） / 健康检查 URL / TCP 端口探测 三种信号并行等待，谁先命中谁生效。
 * 只要配了端口就一定会做 TCP 探测——进程存活 + 端口进入监听即视为就绪，
 * 不再被健康检查 URL 或日志正则挡住。三者都没配时，短延时后兜底判定完成。
 */
export class ReadinessWatcher {
  private done = false;
  private timers = new Set<NodeJS.Timeout>();
  private timeoutTimer: NodeJS.Timeout | null = null;
  private regex: RegExp | null = null;

  constructor(private readonly opts: ReadinessOptions) {
    if (opts.pattern) {
      try {
        this.regex = new RegExp(opts.pattern);
      } catch {
        this.regex = null;
        opts.onLog(`就绪正则无效，已忽略：${opts.pattern}`);
      }
    }
  }

  start(): void {
    const timeout = Math.max(1000, this.opts.timeoutMs);
    this.timeoutTimer = setTimeout(() => {
      if (this.done) return;
      this.opts.onLog(`等待 ${Math.round(timeout / 1000)} 秒未探测到就绪信号，进程仍在运行`);
      this.finish('timeout');
    }, timeout);

    const url = this.resolveHealthUrl();
    if (url) {
      this.opts.onLog(`就绪判定: 健康检查 ${url}`);
      this.poll(() => this.probeHttp(url), 'http');
    }

    // 端口探测独立于健康检查：进程存活且端口进入监听就直接判定就绪
    if (this.opts.port) {
      const port = this.opts.port;
      this.opts.onLog(`就绪判定: TCP 探测 127.0.0.1:${port}`);
      this.poll(() => this.probeTcp(port), 'tcp');
    }

    // 无端口无健康检查：给一个短暂的缓冲期，避免「瞬间 ready」的假象
    if (!url && !this.opts.port) {
      this.schedule(() => this.finish('timeout'), 1200);
    }
  }

  /** 把子进程输出喂进来做正则匹配 */
  feed(chunk: string): ReadySource | null {
    if (this.done || !this.regex) return null;
    for (const line of String(chunk ?? '').split(/\r?\n/)) {
      if (line && this.regex.test(line)) {
        this.finish('pattern');
        return 'pattern';
      }
    }
    return null;
  }

  stop(): void {
    this.done = true;
    this.clearTimers();
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  /** 注册一个一次性定时器，统一登记以便 stop/finish 时全部清掉 */
  private schedule(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private resolveHealthUrl(): string | null {
    const raw = (this.opts.healthUrl ?? '').trim();
    if (!raw) return null;
    return substitutePlaceholders(raw, {
      PORT: this.opts.port ?? undefined,
      HOST: this.opts.host === '0.0.0.0' ? '127.0.0.1' : this.opts.host,
    });
  }

  private poll(check: () => Promise<boolean>, source: ReadySource): void {
    const interval = this.opts.intervalMs ?? 800;
    const tick = async (): Promise<void> => {
      if (this.done) return;
      try {
        if (await check()) {
          this.finish(source);
          return;
        }
      } catch {
        /* 继续重试 */
      }
      if (!this.done) {
        this.schedule(() => void tick(), interval);
      }
    };
    this.schedule(() => void tick(), 300);
  }

  private async probeTcp(port: number): Promise<boolean> {
    // 进程已退出时不再把端口命中当成就绪（端口可能是别人的）
    if (this.opts.isAlive && !this.opts.isAlive()) return false;
    const fn = this.opts.probeTcpFn ?? ((p: number, h: string) => probeTcp(p, h));
    return fn(port, '127.0.0.1');
  }

  private async probeHttp(url: string): Promise<boolean> {
    if (this.opts.probeHttpFn) return this.opts.probeHttpFn(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private finish(source: ReadySource): void {
    if (this.done) return;
    this.done = true;
    this.clearTimers();
    this.opts.onReady(source);
  }
}
