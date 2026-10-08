import path from 'path';
import fse from 'fs-extra';
import type { LogEntry, LogKind } from '../../types';
import { redactSecrets } from '../util/redact';

export type LogSink = (entry: LogEntry) => void;

export interface LogServiceOptions {
  maxLinesPerProject: number;
  logToFile: boolean;
  logDir: string;
}

/**
 * 日志：内存环形缓冲 + 可选落盘 + 广播。
 * projectId 为 null 表示启动器自身的日志。
 */
export class LogService {
  private buffers = new Map<string, LogEntry[]>();
  private sink: LogSink | null = null;
  /** 每个项目独立文件句柄队列，避免并发 append 交错 */
  private writeChains = new Map<string, Promise<void>>();
  private today = new Date().toISOString().slice(0, 10);

  constructor(private opts: LogServiceOptions) {
    this.today = new Date().toISOString().slice(0, 10);
  }

  attach(sink: LogSink): void {
    this.sink = sink;
  }

  setOptions(patch: Partial<LogServiceOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  private key(projectId: string | null): string {
    return projectId ?? '__app__';
  }

  push(projectId: string | null, kind: LogKind, msg: string): void {
    const text = redactSecrets(String(msg ?? ''));
    if (!text) return;
    const entry: LogEntry = {
      projectId,
      kind,
      msg: text,
      timestamp: Date.now(),
    };

    const key = this.key(projectId);
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = [];
      this.buffers.set(key, buf);
    }
    buf.push(entry);
    const max = Math.max(200, this.opts.maxLinesPerProject);
    if (buf.length > max) buf.splice(0, buf.length - max);

    this.sink?.(entry);
    if (this.opts.logToFile) this.appendFile(projectId, entry);
  }

  /** 多行文本按行入日志（子进程 stdout/stderr 用） */
  pushLines(projectId: string | null, kind: LogKind, chunk: string): void {
    for (const line of String(chunk ?? '').split(/\r?\n/)) {
      if (line.trim()) this.push(projectId, kind, line);
    }
  }

  private appendFile(projectId: string | null, entry: LogEntry): void {
    const key = this.key(projectId);
    const day = new Date(entry.timestamp).toISOString().slice(0, 10);
    const file = path.join(this.opts.logDir, key, `${day}.log`);
    const line = `${new Date(entry.timestamp).toISOString()}\t${entry.kind}\t${entry.msg}\n`;

    const prev = this.writeChains.get(key) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await fse.ensureDir(path.dirname(file));
        await fse.appendFile(file, line, 'utf8');
      })
      .catch(() => {
        /* 落盘失败不影响运行 */
      });
    this.writeChains.set(key, next);
  }

  get(projectId?: string | null): LogEntry[] {
    if (projectId === undefined) {
      const all: LogEntry[] = [];
      for (const buf of this.buffers.values()) all.push(...buf);
      return all.sort((a, b) => a.timestamp - b.timestamp);
    }
    return [...(this.buffers.get(this.key(projectId)) ?? [])];
  }

  clear(projectId?: string | null): void {
    if (projectId === undefined) {
      this.buffers.clear();
      return;
    }
    this.buffers.delete(this.key(projectId));
  }

  /** 导出某个项目（或全部）的内存缓冲为文本 */
  exportText(projectId?: string | null): string {
    const entries = this.get(projectId);
    return entries
      .map(
        (e) =>
          `${new Date(e.timestamp).toISOString()}\t${e.kind}\t${e.projectId ?? '-'}\t${e.msg}`
      )
      .join('\n');
  }
}
