import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ProcessNode {
  pid: number;
  ppid: number;
}

/**
 * 进程树探测。
 * 用途：
 *  - 指标聚合（npm start 的真实服务是孙子进程，只看根 PID 会失真）
 *  - 停止时确认子树
 * 解析逻辑是纯函数，便于单测；枚举失败时上层降级为「只统计根进程」。
 */
export function parseProcessList(output: string): ProcessNode[] {
  const nodes: ProcessNode[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 2) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    nodes.push({ pid, ppid });
  }
  return nodes;
}

/** 从全量进程表中取出 root 的全部后代（含 root 自身） */
export function collectDescendants(
  all: ProcessNode[],
  rootPid: number
): number[] {
  const byParent = new Map<number, number[]>();
  for (const node of all) {
    const list = byParent.get(node.ppid) ?? [];
    list.push(node.pid);
    byParent.set(node.ppid, list);
  }

  const result: number[] = [];
  const seen = new Set<number>();
  const queue: number[] = [rootPid];
  while (queue.length) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    for (const child of byParent.get(pid) ?? []) {
      if (!seen.has(child)) queue.push(child);
    }
  }
  return result;
}

export class ProcessTreeProbe {
  private cache: { at: number; nodes: ProcessNode[] } | null = null;
  private readonly ttlMs = 900;

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async list(force = false): Promise<ProcessNode[]> {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.at < this.ttlMs) {
      return this.cache.nodes;
    }
    const nodes = await this.enumerate();
    if (nodes.length) this.cache = { at: now, nodes };
    return nodes;
  }

  /** 返回 root 及其所有后代的 PID；枚举失败时只返回 [rootPid] */
  async descendants(rootPid: number): Promise<number[]> {
    try {
      const all = await this.list();
      if (!all.length) return [rootPid];
      const found = collectDescendants(all, rootPid);
      return found.length ? found : [rootPid];
    } catch {
      return [rootPid];
    }
  }

  private async enumerate(): Promise<ProcessNode[]> {
    try {
      if (this.platform === 'win32') {
        const { stdout } = await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ],
          { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
        );
        return parseProcessList(stdout);
      }
      const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='], {
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return parseProcessList(stdout);
    } catch {
      return [];
    }
  }
}
