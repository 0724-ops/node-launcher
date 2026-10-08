import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fse from 'fs-extra';

import type { AppConfig, TunnelState, TunnelStatus } from '../../types';
import { downloadFile } from '../download/downloader';
import { applyGithubMirror, DEFAULT_GITHUB_MIRROR } from '../net/github-mirror';
import { probeTcp } from '../net/ports';
import { toMessage } from '../util/errors';

/**
 * 内网穿透（Cloudflare Tunnel / cloudflared），方案沿用旧专用启动器：
 *   cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate
 * 公网地址由 cloudflared 输出，形如 https://xxxx.trycloudflare.com。
 *
 * 关于「地址出来了但打不开」：**打印出地址 ≠ 公网已经可用**。
 * quick tunnel 的 DNS/边缘生效有延迟（首次请求常见 502/1033），回源没起好也会 502。
 * 因此这里不把「解析到地址」当作成功，而是额外做两步校验：
 *   1) 回源校验：本地端口是否真的在监听（没监听 → 必然 502）；
 *   2) 公网校验：反复请求公网地址，直到不再返回 502/503/504/530 才置为 running。
 * 校验通过前状态是 probing，界面上不会再谎报「已连接」。
 */

const URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
/** 等待 cloudflared 输出公网地址的最长时间 */
const START_TIMEOUT_MS = 60000;
/** 公网可达性验证窗口：最多持续 40 秒（边缘生效慢时给足时间） */
export const PROBE_WINDOW_MS = 40000;
/** 两次探测之间的间隔 */
export const PROBE_INTERVAL_MS = 2000;
/** 探测次数上限（由窗口与间隔推导，改窗口不用改这里） */
export const PROBE_MAX_ATTEMPTS = Math.ceil(PROBE_WINDOW_MS / PROBE_INTERVAL_MS);

/** cloudflared 的资产名（与官方 release 一致） */
export function cloudflaredAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  if (platform === 'win32') {
    return arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  }
  throw new Error('当前系统暂不支持自动下载 cloudflared');
}

/** 从 cloudflared 的一行输出里解析公网地址；解析不到返回 null */
export function parseTunnelUrl(line: string): string | null {
  const match = String(line ?? '').match(URL_REGEX);
  return match ? match[0].toLowerCase() : null;
}

/**
 * 该 HTTP 状态码是否说明「公网已经通了」。
 * 502/503/504/530 是 Cloudflare 边缘可达但**回源失败或隧道尚未生效**的典型状态，
 * 其余（200、302、401、404…）都说明请求已经打到源站，隧道是通的。
 */
export function isTunnelReachableStatus(status: number): boolean {
  return ![502, 503, 504, 530].includes(status);
}

export interface TunnelManagerDeps {
  /** cloudflared 可执行文件的落点（userData/bin） */
  binDir: string;
  getConfig: () => Promise<AppConfig>;
  log: (projectId: string | null, kind: 'sys' | 'err', msg: string) => void;
  onState: (state: TunnelState) => void;
  /** 便于测试注入 */
  spawnFn?: typeof spawn;
  download?: typeof downloadFile;
  /** 便于测试注入：公网可达性探测 */
  probePublic?: (url: string) => Promise<boolean>;
  probeLocal?: (port: number) => Promise<boolean>;
}

interface Entry {
  proc: ChildProcess | null;
  status: TunnelStatus;
  url: string | null;
  message: string;
  stopping: boolean;
  startTimer: NodeJS.Timeout | null;
  probeTimer: NodeJS.Timeout | null;
  probeAttempts: number;
}

export class TunnelManager {
  private readonly entries = new Map<string, Entry>();
  private readonly downloading = new Map<string, Promise<string>>();

  constructor(private readonly deps: TunnelManagerDeps) {}

  /** cloudflared 可执行文件路径 */
  binaryPath(): string {
    const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    return path.join(this.deps.binDir, name);
  }

  isInstalled(): boolean {
    return fse.existsSync(this.binaryPath());
  }

  private entry(projectId: string): Entry {
    let entry = this.entries.get(projectId);
    if (!entry) {
      entry = {
        proc: null,
        status: 'stopped',
        url: null,
        message: '',
        stopping: false,
        startTimer: null,
        probeTimer: null,
        probeAttempts: 0,
      };
      this.entries.set(projectId, entry);
    }
    return entry;
  }

  isRunning(projectId: string): boolean {
    const entry = this.entries.get(projectId);
    return !!entry?.proc && !entry.proc.killed;
  }

  runningProjectIds(): string[] {
    return [...this.entries.entries()].filter(([, e]) => !!e.proc).map(([id]) => id);
  }

  getState(projectId: string): TunnelState {
    const entry = this.entry(projectId);
    return {
      projectId,
      status: entry.status,
      url: entry.url,
      message: entry.message || undefined,
    };
  }

  getStates(): TunnelState[] {
    return [...this.entries.keys()].map((id) => this.getState(id));
  }

  private clearTimers(entry: Entry): void {
    if (entry.startTimer) {
      clearTimeout(entry.startTimer);
      entry.startTimer = null;
    }
    if (entry.probeTimer) {
      clearTimeout(entry.probeTimer);
      entry.probeTimer = null;
    }
  }

  /** probing 状态保留已分配的地址，其余非 running 状态一律清空 */
  private push(projectId: string, status: TunnelStatus, message = ''): TunnelState {
    const entry = this.entry(projectId);
    entry.status = status;
    entry.message = message;
    if (status !== 'running' && status !== 'probing') entry.url = null;
    const state = this.getState(projectId);
    this.deps.onState(state);
    return state;
  }

  /** 下载 cloudflared（首次使用）；并发调用共享同一个下载 */
  async ensureBinary(mirror?: string): Promise<string> {
    const dest = this.binaryPath();
    if (await fse.pathExists(dest)) return dest;

    const existing = this.downloading.get(dest);
    if (existing) return existing;

    const task = (async (): Promise<string> => {
      const asset = cloudflaredAssetName();
      const direct = `${RELEASE_BASE}/${asset}`;
      const prefix = (mirror ?? '').trim() || DEFAULT_GITHUB_MIRROR;
      const url = applyGithubMirror(direct, prefix);

      await fse.ensureDir(path.dirname(dest));
      this.deps.log(null, 'sys', '正在下载 cloudflared（首次使用需下载）…');
      this.deps.log(null, 'sys', `下载地址: ${url}`);

      const download = this.deps.download ?? downloadFile;
      const runDownload = async (target: string): Promise<void> => {
        let lastTick = -1;
        await download({
          url: target,
          dest,
          allowInsecure: target.startsWith('http://'),
          onProgress: (p) => {
            const tick = Math.floor(p.percent / 20);
            if (tick !== lastTick) {
              lastTick = tick;
              this.deps.log(null, 'sys', `cloudflared 下载中 ${p.percent}%`);
            }
          },
        });
      };

      try {
        await runDownload(url);
      } catch (err) {
        // 镜像是第三方代理，挂了不能连累用户；回退直连 GitHub
        if (url === direct) throw err;
        this.deps.log(null, 'sys', `镜像下载失败（${toMessage(err)}），回退直连 GitHub`);
        this.deps.log(null, 'sys', `下载地址: ${direct}`);
        await runDownload(direct);
      }
      if (process.platform !== 'win32') await fse.chmod(dest, 0o755);
      this.deps.log(null, 'sys', 'cloudflared 已就绪');
      return dest;
    })().finally(() => this.downloading.delete(dest));

    this.downloading.set(dest, task);
    return task;
  }

  async start(projectId: string, port: number): Promise<TunnelState> {
    if (this.isRunning(projectId)) return this.getState(projectId);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`端口不合法，无法建立穿透：${port}`);
    }

    const config = await this.deps.getConfig();

    // 回源校验：本地端口没在监听的话，公网一定是 502，先明确告诉用户
    const localProbe = this.deps.probeLocal ?? ((p: number) => probeTcp(p, '127.0.0.1'));
    if (!(await localProbe(port))) {
      this.deps.log(
        projectId,
        'sys',
        `提示：本地端口 ${port} 目前没有监听，穿透会返回 502；请确认项目已就绪。`
      );
    }

    const bin = await this.ensureBinary(config.githubMirror);

    const entry = this.entry(projectId);
    entry.stopping = false;
    entry.probeAttempts = 0;
    this.clearTimers(entry);
    this.push(projectId, 'starting');

    // 显式用 127.0.0.1：Windows 上 localhost 可能先解析到 ::1，
    // 而很多 Node 服务只监听 IPv4，会造成额外回退与超时。
    const localUrl = `http://127.0.0.1:${port}`;
    const args = ['tunnel', '--url', localUrl, '--no-autoupdate'];
    if (config.tunnelUseHttp2) args.push('--protocol', 'http2', '--edge-ip-version', '4');

    this.deps.log(
      projectId,
      'sys',
      `正在建立内网穿透: ${localUrl}（协议 ${config.tunnelUseHttp2 ? 'HTTP2/TCP' : 'QUIC/UDP'}）`
    );

    const spawnFn = this.deps.spawnFn ?? spawn;
    const proc = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    entry.proc = proc;

    const handleLine = (raw: string): void => {
      const line = raw.trim();
      if (!line) return;
      this.deps.log(projectId, 'sys', `[cloudflared] ${line}`);
      const url = parseTunnelUrl(line);
      if (url && entry.status === 'starting') {
        entry.url = url;
        if (entry.startTimer) {
          clearTimeout(entry.startTimer);
          entry.startTimer = null;
        }
        // 先不报成功：地址分配 ≠ 公网可达
        this.push(projectId, 'probing', '地址已分配，正在验证公网可达…');
        this.deps.log(projectId, 'sys', `已分配公网地址 ${url}，正在验证可达性…`);
        this.schedulePublicProbe(projectId, url);
      }
    };

    proc.stdout?.on('data', (data: Buffer) => data.toString().split('\n').forEach(handleLine));
    proc.stderr?.on('data', (data: Buffer) => data.toString().split('\n').forEach(handleLine));

    entry.startTimer = setTimeout(() => {
      if (entry.status === 'starting') {
        this.push(projectId, 'error', '建立内网穿透超时（60s 未拿到公网地址），请检查网络后重试');
      }
    }, START_TIMEOUT_MS);

    proc.on('exit', (code, signal) => {
      this.clearTimers(entry);
      entry.proc = null;
      this.deps.log(projectId, 'sys', `cloudflared 已退出 (code=${code}, signal=${signal})`);
      if (entry.stopping) this.push(projectId, 'stopped');
      else this.push(projectId, 'stopped', `cloudflared 意外退出 (code=${code})`);
    });

    proc.on('error', (err) => {
      this.clearTimers(entry);
      entry.proc = null;
      const msg = `cloudflared 启动失败: ${toMessage(err)}`;
      this.deps.log(projectId, 'err', msg);
      this.push(projectId, 'error', msg);
    });

    return this.getState(projectId);
  }

  /** 反复探测公网地址，直到不再返回 502/503/504/530（或次数用尽） */
  private schedulePublicProbe(projectId: string, url: string): void {
    const probe = this.deps.probePublic ?? ((u: string) => this.probePublicUrl(u));

    const attempt = (): void => {
      const current = this.entries.get(projectId);
      // 期间被停止 / 地址变了 → 放弃本轮探测
      if (!current || current.stopping || current.status !== 'probing' || current.url !== url) {
        return;
      }
      void probe(url).then((ok) => {
        const entry = this.entries.get(projectId);
        if (!entry || entry.stopping || entry.status !== 'probing' || entry.url !== url) return;

        if (ok) {
          this.push(projectId, 'running');
          this.deps.log(projectId, 'sys', `内网穿透已就绪（公网可达）: ${url}`);
          return;
        }

        entry.probeAttempts += 1;
        if (entry.probeAttempts >= PROBE_MAX_ATTEMPTS) {
          // 探测超时不等于失败：边缘可能刚生效，交给用户重试
          this.push(
            projectId,
            'running',
            '地址已分配，但自动检测未能确认公网可达；若首次打开失败，请等几秒重试'
          );
          this.deps.log(
            projectId,
            'sys',
            '公网可达性自动检测超时；如页面 502/1033，稍等几秒后重试即可'
          );
          return;
        }
        this.push(
          projectId,
          'probing',
          `地址已分配，正在等待公网可达…（最多 ${Math.round(
            PROBE_WINDOW_MS / 1000
          )} 秒，已检测 ${entry.probeAttempts} 次）`
        );
        entry.probeTimer = setTimeout(attempt, PROBE_INTERVAL_MS);
      });
    };

    const entry = this.entry(projectId);
    entry.probeTimer = setTimeout(attempt, 1200);
  }

  /** 单次公网可达性探测 */
  private async probePublicUrl(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      return isTunnelReachableStatus(res.status);
    } catch {
      return false;
    }
  }

  /**
   * 手动重新检测公网可达性。
   * 自动验证窗口（40s）用完后若仍不确定，用户可点「重新检测」再跑一轮，不用拆掉隧道。
   */
  recheck(projectId: string): TunnelState {
    const entry = this.entries.get(projectId);
    if (!entry?.url || !entry.proc) {
      throw new Error('当前没有已分配地址的穿透，无法重新检测');
    }
    this.clearTimers(entry);
    entry.stopping = false;
    entry.probeAttempts = 0;
    this.push(projectId, 'probing', '正在重新检测公网可达…');
    this.deps.log(projectId, 'sys', `重新检测公网可达性: ${entry.url}`);
    this.schedulePublicProbe(projectId, entry.url);
    return this.getState(projectId);
  }

  async stop(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry) return;

    const proc = entry.proc;
    entry.stopping = true;
    entry.proc = null;
    this.clearTimers(entry);
    this.push(projectId, 'stopped');

    if (!proc?.pid) return;
    this.deps.log(projectId, 'sys', '正在关闭内网穿透 …');
    await killProcessTree(proc);
  }

  async stopAll(): Promise<void> {
    for (const id of this.runningProjectIds()) {
      // eslint-disable-next-line no-await-in-loop
      await this.stop(id);
    }
  }
}

/** Windows 用 taskkill 杀进程树；其它平台先 TERM 再 KILL */
export function killProcessTree(proc: ChildProcess): Promise<void> {
  const pid = proc.pid;
  if (!pid) return Promise.resolve();

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      // 注意：不要用 exec（需要捕获 stdio，在受限环境下会 EPERM）
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    });
  }

  return new Promise((resolve) => {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 3000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
