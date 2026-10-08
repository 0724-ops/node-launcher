import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fse from 'fs-extra';

import type { AppConfig, DepsState, DepsStatus, LogKind } from '../../types';
import type { ProjectStore } from '../store/project-store';
import type { DepsInstallRequest, DepsInstallResult, DepsService } from './deps-types';
import { precheckDeps } from './precheck';
import { buildInstallInvocation, detectPackageManager } from '../runtime/package-manager';
import { readJsonSafe, writeJsonAtomic } from '../util/atomic-json';
import { toMessage } from '../util/errors';
import { projectPrivateDir, projectWorkDir } from '../project/project-paths';
import type { SpawnFn } from '../launch/launch-manager';

const MAX_TAIL_CHARS = 20000;

export interface DepsInstallerOptions {
  store: ProjectStore;
  config: () => Promise<AppConfig>;
  log: (projectId: string, kind: LogKind, msg: string) => void;
  onProgress?: (progress: { projectId: string; installing: boolean; lines: number }) => void;
  spawnFn?: SpawnFn;
}

interface DepsStateFile {
  lastInstallAt?: string;
  lastError?: string;
}

/**
 * 依赖安装服务（PLAN §8.2）。
 * 安全默认：默认追加 --ignore-scripts，需要原生编译时由用户显式允许。
 * 命令一律用 `node <cli.js>` 调用，绕开 Windows 上 .cmd 的 EINVAL 问题。
 */
export class DepsInstaller implements DepsService {
  private running = new Map<string, ChildProcess>();
  private lines = new Map<string, number>();
  private readonly spawnFn: SpawnFn;

  constructor(private readonly opts: DepsInstallerOptions) {
    this.spawnFn = opts.spawnFn ?? (spawn as SpawnFn);
  }

  isInstalling(projectId: string): boolean {
    return this.running.has(projectId);
  }

  cancel(projectId: string): void {
    const child = this.running.get(projectId);
    if (!child?.pid) return;
    this.opts.log(projectId, 'dep', '正在取消依赖安装…');
    if (process.platform === 'win32') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFile } = require('child_process') as typeof import('child_process');
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  }

  async install(request: DepsInstallRequest): Promise<DepsInstallResult> {
    const { projectId, workDir, runtime } = request;
    if (this.isInstalling(projectId)) {
      return {
        ok: false,
        command: '',
        exitCode: null,
        outputTail: '',
        cancelled: false,
        error: '该项目正在安装依赖，请稍候',
      };
    }

    const config = await this.opts.config();
    const detected = await detectPackageManager(workDir);
    const hasLockfile = !!detected.lockfile;
    const ignoreScripts = !request.allowScripts;

    let invocation;
    try {
      invocation = buildInstallInvocation(detected.name, runtime, {
        hasLockfile,
        ignoreScripts,
        registry: config.npmRegistry,
      });
    } catch (err) {
      return {
        ok: false,
        command: '',
        exitCode: null,
        outputTail: '',
        cancelled: false,
        error: toMessage(err),
      };
    }

    this.opts.log(
      projectId,
      'dep',
      `依赖安装：${invocation.display}${ignoreScripts ? '（已跳过安装脚本；如需原生编译请在编辑中允许执行安装脚本）' : '（允许执行安装脚本）'}`
    );

    const stateFile = await this.stateFilePath(projectId, request);
    const tail: string[] = [];
    let tailChars = 0;
    let cancelled = false;
    let lineCount = 0;
    this.lines.set(projectId, 0);

    const result = await new Promise<DepsInstallResult>((resolve) => {
      const child = this.spawnFn(invocation.command, invocation.args, {
        cwd: workDir,
        env: {
          ...(process.env as Record<string, string>),
          npm_config_registry: config.npmRegistry || undefined,
        } as NodeJS.ProcessEnv,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.running.set(projectId, child);
      this.opts.onProgress?.({ projectId, installing: true, lines: 0 });

      const timeout = setTimeout(() => {
        this.opts.log(projectId, 'dep', `安装超时（${Math.round(config.installTimeoutMs / 1000)}s），已终止`);
        this.cancel(projectId);
      }, config.installTimeoutMs);

      const consume = (kind: LogKind, chunk: string): void => {
        for (const line of String(chunk ?? '').split(/\r?\n/)) {
          if (!line.trim()) continue;
          lineCount += 1;
          this.lines.set(projectId, lineCount);
          this.opts.log(projectId, kind === 'err' ? 'dep' : 'dep', line);
          tail.push(line);
          tailChars += line.length + 1;
          while (tailChars > MAX_TAIL_CHARS && tail.length > 1) {
            const removed = tail.shift() as string;
            tailChars -= removed.length + 1;
          }
        }
        this.opts.onProgress?.({ projectId, installing: true, lines: lineCount });
      };

      child.stdout?.on('data', (d: Buffer) => consume('out', d.toString()));
      child.stderr?.on('data', (d: Buffer) => consume('err', d.toString()));

      child.on('error', (err) => {
        clearTimeout(timeout);
        this.running.delete(projectId);
        this.opts.onProgress?.({ projectId, installing: false, lines: lineCount });
        resolve({
          ok: false,
          command: invocation.display,
          exitCode: null,
          outputTail: tail.join('\n'),
          cancelled: false,
          error: toMessage(err),
        });
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        this.running.delete(projectId);
        this.opts.onProgress?.({ projectId, installing: false, lines: lineCount });
        cancelled = child.killed;
        resolve({
          ok: code === 0,
          command: invocation.display,
          exitCode: code,
          outputTail: tail.join('\n'),
          cancelled,
          error: code === 0 ? undefined : `安装进程退出码 ${code}`,
        });
      });
    });

    await writeJsonAtomic(stateFile, {
      lastInstallAt: result.ok ? new Date().toISOString() : undefined,
      lastError: result.ok ? undefined : result.error,
    } satisfies DepsStateFile).catch(() => {});

    await this.writeInstallLog(projectId, request, invocation.display, tail, result).catch(() => {});
    this.lines.delete(projectId);
    return result;
  }

  /** 读取依赖状态（用于详情页与启动前展示） */
  async status(projectId: string): Promise<DepsStatus> {
    const manifest = await this.opts.store.get(projectId);
    if (!manifest) throw new Error('项目不存在');
    const workDir = projectWorkDir(this.opts.store, manifest);
    const precheck = await precheckDeps(workDir);
    const stateFile = path.join(
      projectPrivateDir(this.opts.store, manifest),
      'deps-state.json'
    );
    const saved = await readJsonSafe<DepsStateFile>(stateFile);

    let state: DepsState;
    if (this.isInstalling(projectId)) state = 'installing';
    else if (!precheck.hasPackageJson) state = 'na';
    else if (precheck.needsInstall) state = saved?.lastError ? 'failed' : 'missing';
    else state = 'ready';

    return {
      projectId,
      state,
      hasPackageJson: precheck.hasPackageJson,
      packageManager: precheck.packageManager,
      lockfile: precheck.lockfile,
      nodeModulesExists: precheck.nodeModulesExists,
      nodeModulesSizeBytes: precheck.nodeModulesSizeBytes,
      lastInstallAt: saved?.lastInstallAt ?? null,
      lastError: saved?.lastError ?? null,
      installLines: this.lines.get(projectId) ?? 0,
    };
  }

  /** 轻量状态（用于项目列表，不做体积统计） */
  async quickState(projectId: string): Promise<DepsState> {
    const manifest = await this.opts.store.get(projectId);
    if (!manifest) return 'unknown';
    if (this.isInstalling(projectId)) return 'installing';
    const workDir = projectWorkDir(this.opts.store, manifest);
    const hasPkg = await fse.pathExists(path.join(workDir, 'package.json'));
    if (!hasPkg) return 'na';
    const hasModules = await fse.pathExists(path.join(workDir, 'node_modules'));
    return hasModules ? 'ready' : 'missing';
  }

  /** 清理 node_modules（用户主动操作） */
  async clean(projectId: string): Promise<void> {
    const manifest = await this.opts.store.get(projectId);
    if (!manifest) throw new Error('项目不存在');
    const workDir = projectWorkDir(this.opts.store, manifest);
    await fse.remove(path.join(workDir, 'node_modules'));
    this.opts.log(projectId, 'dep', '已清理 node_modules');
  }

  private async stateFilePath(
    projectId: string,
    request: DepsInstallRequest
  ): Promise<string> {
    const dir = projectPrivateDir(this.opts.store, request.manifest);
    await fse.ensureDir(dir);
    return path.join(dir, 'deps-state.json');
  }

  private async writeInstallLog(
    projectId: string,
    request: DepsInstallRequest,
    command: string,
    tail: string[],
    result: DepsInstallResult
  ): Promise<void> {
    const dir = projectPrivateDir(this.opts.store, request.manifest);
    await fse.ensureDir(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `install-${stamp}.log`);
    const header = [
      `# 依赖安装日志`,
      `项目: ${request.manifest.name} (${projectId})`,
      `时间: ${new Date().toISOString()}`,
      `目录: ${request.workDir}`,
      `命令: ${command}`,
      `允许安装脚本: ${request.allowScripts}`,
      `结果: ${result.ok ? '成功' : '失败'} (exit=${result.exitCode ?? '-'})`,
      '',
    ].join('\n');
    await fse.writeFile(file, `${header}${tail.join('\n')}\n`, 'utf8');
  }
}
