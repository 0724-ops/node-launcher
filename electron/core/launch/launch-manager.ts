import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'child_process';
import { promisify } from 'util';
import fse from 'fs-extra';

import type {
  AppConfig,
  LaunchPhase,
  LaunchState,
  LogKind,
  MetricsSnapshot,
  ProjectManifest,
  RuntimeInfo,
} from '../../types';
import type { ProjectStore } from '../store/project-store';
import type { NodeRuntimeProvider } from '../runtime/node-provider';
import type { DepsPrompt, DepsPromptAction, DepsService } from '../deps/deps-types';
import { precheckDeps } from '../deps/precheck';
import { classifyError, isInstallable } from '../deps/classify-error';
import { findFreePort, isPortAvailable, parseListeningPorts } from '../net/ports';
import { toMessage } from '../util/errors';
import { AppError } from '../util/errors';
import { loadEnvFile } from '../util/env-file';
import { projectRootDir, projectWorkDir, projectPrivateDir } from '../project/project-paths';
import { buildSpawnPlan, type SpawnPlan } from './spawn-plan';
import { MetricsCollector } from './metrics';
import { ProcessTreeProbe } from './process-tree';
import { ReadinessWatcher } from './readiness';

const execFileAsync = promisify(execFile);

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;

const MAX_OUTPUT_LINES = 400;
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

export interface LaunchManagerDeps {
  store: ProjectStore;
  provider: NodeRuntimeProvider;
  config: () => Promise<AppConfig>;
  depsService: DepsService;
  log: (projectId: string | null, kind: LogKind, msg: string) => void;
  onState: (state: LaunchState) => void;
  onMetrics: (snapshot: MetricsSnapshot) => void;
  onPrompt: (prompt: DepsPrompt) => void;
  /** metrics-reporter.js 的绝对路径（不存在则退化为轮询） */
  reporterPath: string;
  spawnFn?: SpawnFn;
  tree?: ProcessTreeProbe;
}

interface Instance {
  projectId: string;
  manifest: ProjectManifest;
  packageName: string | null;
  state: LaunchState;
  proc: ChildProcess | null;
  userStopped: boolean;
  readiness: ReadinessWatcher | null;
  metrics: MetricsCollector | null;
  output: string[];
  stopTimer: NodeJS.Timeout | null;
  forceTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
}

/**
 * 启动流水线（PLAN §6）：
 *   预检 → （可选）安装依赖 → 启动 → 就绪判定 → 运行 → 停止/失败/重启
 * 每个项目一个实例，可同时运行多个不同项目；同一项目默认只允许一个实例。
 */
export class LaunchManager {
  private instances = new Map<string, Instance>();
  private prompts = new Map<
    string,
    { resolve: (action: DepsPromptAction) => void; timer: NodeJS.Timeout }
  >();
  private readonly spawnFn: SpawnFn;
  private readonly tree: ProcessTreeProbe;

  constructor(private readonly deps: LaunchManagerDeps) {
    this.spawnFn = deps.spawnFn ?? (spawn as SpawnFn);
    this.tree = deps.tree ?? new ProcessTreeProbe();
  }

  /* ----------------------------- 查询 ----------------------------- */

  getState(projectId: string): LaunchState | null {
    return this.instances.get(projectId)?.state ?? null;
  }

  getStates(): LaunchState[] {
    return [...this.instances.values()].map((i) => i.state);
  }

  isRunning(projectId: string): boolean {
    const inst = this.instances.get(projectId);
    return !!inst && this.isActive(inst);
  }

  runningProjectIds(): string[] {
    return [...this.instances.values()]
      .filter((i) => this.isActive(i))
      .map((i) => i.projectId);
  }

  private isActive(inst: Instance): boolean {
    const phase = inst.state.phase;
    return (
      inst.proc !== null ||
      phase === 'preflight' ||
      phase === 'spawning' ||
      phase === 'starting' ||
      phase === 'ready' ||
      phase === 'stopping' ||
      phase === 'restarting'
    );
  }

  /* ----------------------------- 启动 ----------------------------- */

  start(projectId: string, opts: { depsAction?: DepsPromptAction } = {}): void {
    void this.doStart(projectId, opts).catch((err) => {
      this.log(projectId, 'err', toMessage(err));
      const inst = this.instances.get(projectId);
      if (inst) {
        this.setState(inst, {
          phase: 'failed',
          message: toMessage(err),
          pid: null,
        });
      }
    });
  }

  private async doStart(
    projectId: string,
    opts: { depsAction?: DepsPromptAction }
  ): Promise<void> {
    const manifest = await this.deps.store.get(projectId);
    if (!manifest) throw new AppError('项目不存在', 'E_NOT_FOUND');

    const existing = this.instances.get(projectId);
    if (existing && this.isActive(existing)) {
      throw new AppError('该项目已在运行', 'E_ALREADY_RUNNING');
    }

    const inst = this.createInstance(manifest);
    this.instances.set(projectId, inst);
    await this.runAttempt(inst, opts.depsAction);
  }

  private createInstance(manifest: ProjectManifest): Instance {
    return {
      projectId: manifest.id,
      manifest,
      packageName: null,
      state: {
        projectId: manifest.id,
        phase: 'idle',
        pid: null,
        port: manifest.port ?? null,
        url: null,
        startedAt: null,
        exitCode: null,
        signal: null,
        category: null,
        message: '',
        restarts: 0,
        installAttempted: false,
      },
      proc: null,
      userStopped: false,
      readiness: null,
      metrics: null,
      output: [],
      stopTimer: null,
      forceTimer: null,
      restartTimer: null,
    };
  }

  /** 一次完整的启动尝试（失败后重试会再次进入这里） */
  private async runAttempt(
    inst: Instance,
    depsAction?: DepsPromptAction
  ): Promise<void> {
    const { manifest } = inst;
    const config = await this.deps.config();

    this.setState(inst, {
      phase: 'preflight',
      message: '正在准备启动…',
      pid: null,
      exitCode: null,
      signal: null,
      category: null,
    });

    const rootDir = projectRootDir(this.deps.store, manifest);
    if (!(await fse.pathExists(rootDir))) {
      throw new AppError(`项目目录不存在：${rootDir}`, 'E_NO_DIR');
    }
    const workDir = projectWorkDir(this.deps.store, manifest);

    /* 1) 运行时 */
    const runtime = await this.deps.provider.ensureRuntime(manifest.nodeVersion);

    /* 2) 依赖预检（第一级触发，PLAN §8.1） */
    const precheck = await precheckDeps(workDir);
    if (precheck.hasPackageJson) {
      inst.packageName = await readPackageName(workDir);
    }
    let allowScripts = manifest.allowInstallScripts;

    if (precheck.hasPackageJson && precheck.needsInstall) {
      const policy = manifest.autoInstallDeps ?? config.defaultAutoInstallDeps;
      if (policy !== 'never') {
        let action: DepsPromptAction | undefined = depsAction;
        if (!action || action === 'cancel') {
          action =
            policy === 'always'
              ? manifest.allowInstallScripts
                ? 'install-allow-scripts'
                : 'install'
              : await this.askPrompt(inst, {
                  projectId: inst.projectId,
                  kind: 'preflight-missing',
                  moduleName: null,
                  message: '该项目尚未安装依赖',
                  detail: `目录 ${workDir} 下存在 package.json，但没有可用的 node_modules。安装依赖后即可启动${
                    precheck.lockfile ? `（检测到 ${precheck.lockfile}）` : ''
                  }。`,
                  installLabel: '安装依赖并启动',
                });
        }
        if (action === 'cancel') {
          this.setState(inst, { phase: 'idle', message: '已取消启动' });
          return;
        }
        if (action === 'install' || action === 'install-allow-scripts') {
          allowScripts = allowScripts || action === 'install-allow-scripts';
          const ok = await this.installDeps(inst, runtime, workDir, 'preflight', null, allowScripts);
          if (!ok) {
            this.setState(inst, { phase: 'failed', message: '依赖安装失败，已中止启动' });
            return;
          }
        }
      }
    }

    /* 3) 端口 */
    const port = await this.resolvePort(inst, config);

    /* 4) 生成执行计划 */
    const reporterExists = await fse.pathExists(this.deps.reporterPath);
    const injectReporter =
      reporterExists && config.metricsStrategy !== 'polling' && manifest.startMode === 'node';

    const plan: SpawnPlan = buildSpawnPlan({
      manifest,
      runtime,
      rootDir,
      port,
      host: manifest.host || configHostPlaceholder(manifest),
      baseEnv: process.env,
      envFileValues: manifest.envFile
        ? await loadEnvFile(workDir, manifest.envFile)
        : undefined,
      reporterPath: this.deps.reporterPath,
      injectReporter,
    });

    this.log(inst.projectId, 'sys', `运行时: Node v${runtime.version}（ABI ${runtime.abi}，${runtime.source === 'bundled' ? '内置' : '已下载'}）`);
    this.log(inst.projectId, 'sys', `工作目录: ${plan.cwd}`);
    this.log(inst.projectId, 'sys', `执行: ${plan.displayLine}`);
    if (plan.env.PORT) {
      this.log(inst.projectId, 'sys', `注入 PORT=${plan.env.PORT} HOST=${plan.env.HOST}`);
    }

    /* 5) 启动 */
    inst.userStopped = false;
    inst.output = [];
    this.setState(inst, { phase: 'spawning', message: '正在启动进程…', port });

    const useIpc = injectReporter;
    const child = this.spawnFn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: plan.shell,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: useIpc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    inst.proc = child;

    this.attachChild(inst, child, plan, useIpc, config);

    if (child.pid) {
      this.setState(inst, {
        phase: 'starting',
        pid: child.pid,
        startedAt: Date.now(),
        message: '进程已启动，等待就绪…',
      });
      this.log(inst.projectId, 'sys', `已启动进程 PID=${child.pid}`);
    } else {
      this.setState(inst, { phase: 'starting', message: '进程已启动，等待就绪…' });
    }

    await this.deps.store.recordStarted(inst.projectId);
  }

  private attachChild(
    inst: Instance,
    child: ChildProcess,
    plan: SpawnPlan,
    useIpc: boolean,
    config: AppConfig
  ): void {
    child.stdout?.on('data', (data: Buffer) => this.onOutput(inst, 'out', data.toString()));
    child.stderr?.on('data', (data: Buffer) => this.onOutput(inst, 'err', data.toString()));

    if (useIpc) {
      child.on('message', (msg) => {
        if (inst.metrics?.handleReporterMessage(msg)) return;
      });
    }

    child.on('error', (err) => {
      this.log(inst.projectId, 'err', `进程错误: ${toMessage(err)}`);
      inst.proc = null;
      this.teardownWatchers(inst);
      const category =
        (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'command-not-found' : 'unknown';
      this.setState(inst, {
        phase: 'failed',
        message:
          category === 'command-not-found'
            ? `找不到命令：${plan.displayLine}（检查命令是否可用，或改用 Node 直启）`
            : `启动失败：${toMessage(err)}`,
        category,
        pid: null,
      });
    });

    child.on('exit', (code, signal) => {
      void this.handleExit(inst, code, signal, config);
    });

    const hasReporter = useIpc;
    inst.metrics = new MetricsCollector({
      projectId: inst.projectId,
      rootPid: child.pid ?? 0,
      strategy: config.metricsStrategy,
      hasReporter,
      tree: this.tree,
      onMetrics: (snapshot) => this.deps.onMetrics(snapshot),
      onLog: (msg) => this.log(inst.projectId, 'sys', msg),
    });
    inst.metrics.start();

    inst.readiness = new ReadinessWatcher({
      projectId: inst.projectId,
      pattern: inst.manifest.readyPattern,
      healthUrl: inst.manifest.healthUrl,
      port: this.statePort(inst),
      host: '127.0.0.1',
      timeoutMs: inst.manifest.readyTimeoutMs ?? 60000,
      onLog: (msg) => this.log(inst.projectId, 'sys', msg),
      // 端口探测生效的前提：进程还在跑，且没进入停止流程
      isAlive: () => inst.proc !== null && inst.state.phase !== 'stopping',
      onReady: (source) => {
        if (inst.state.phase === 'stopping' || !inst.proc) return;
        const message =
          source === 'timeout'
            ? '进程仍在运行（未探测到就绪信号）'
            : `服务已就绪（${readinessLabel(source)}）`;
        this.setState(inst, { phase: 'ready', message });
        this.log(inst.projectId, 'sys', message);
        void this.refreshListeningPort(inst);
      },
    });
    inst.readiness.start();
  }

  private statePort(inst: Instance): number | null {
    if (inst.manifest.portMode === 'none') return null;
    return inst.state.port ?? inst.manifest.port ?? null;
  }

  private onOutput(inst: Instance, kind: 'out' | 'err', chunk: string): void {
    this.deps.log(inst.projectId, kind, chunk.replace(/\r?\n$/, ''));
    inst.output.push(chunk);
    if (inst.output.length > MAX_OUTPUT_LINES) {
      inst.output.splice(0, inst.output.length - MAX_OUTPUT_LINES);
    }
    inst.readiness?.feed(chunk);
  }

  /* ----------------------------- 退出处理 ----------------------------- */

  private async handleExit(
    inst: Instance,
    code: number | null,
    signal: NodeJS.Signals | null,
    config: AppConfig
  ): Promise<void> {
    inst.proc = null;
    this.teardownWatchers(inst);
    this.clearTimers(inst);

    const output = inst.output.join('\n');
    const result = classifyError(output, { selfName: inst.packageName });
    await this.deps.store
      .recordExit(inst.projectId, { code, signal, category: result.category })
      .catch(() => {});

    this.log(
      inst.projectId,
      'sys',
      `进程已退出 (code=${code}, signal=${signal})${result.category !== 'unknown' ? `，判定: ${result.category}` : ''}`
    );

    if (inst.userStopped) {
      this.setState(inst, {
        phase: 'idle',
        message: '已停止',
        pid: null,
        exitCode: code,
        signal,
      });
      return;
    }

    /* 正常自行退出（code=0）不算失败，也不触发重启 */
    if (code === 0 && !result.installable) {
      this.setState(inst, {
        phase: 'idle',
        message: '进程已自行退出（code=0）',
        pid: null,
        exitCode: code,
        signal,
      });
      return;
    }

    /* 依赖自动安装（第二级触发，PLAN §8.1）：一次启动最多装一次 */
    const policy = inst.manifest.autoInstallDeps ?? config.defaultAutoInstallDeps;
    if (
      isInstallable(result.category) &&
      result.installable &&
      !inst.state.installAttempted &&
      policy !== 'never'
    ) {
      const moduleLabel = result.moduleName ? `模块 ${result.moduleName}` : '依赖';
      let action: DepsPromptAction | undefined;
      if (policy === 'always') {
        action = inst.manifest.allowInstallScripts ? 'install-allow-scripts' : 'install';
      } else if (result.category === 'native-abi') {
        action = 'skip';
      } else {
        action = await this.askPrompt(inst, {
          projectId: inst.projectId,
          kind: 'runtime-missing-module',
          moduleName: result.moduleName,
          message: `启动失败：缺少 ${moduleLabel}`,
          detail: `${result.hint}\n\n命中日志：${result.matchedLine ?? '(见完整日志)'}`,
          installLabel: '安装依赖后重试',
        });
      }

      if (action === 'cancel' || action === 'skip') {
        this.setState(inst, {
          phase: 'failed',
          message: result.hint,
          category: result.category,
          exitCode: code,
          signal,
          pid: null,
        });
        return;
      }

      inst.state.installAttempted = true;
      const runtime = await this.deps.provider.ensureRuntime(inst.manifest.nodeVersion);
      const workDir = projectWorkDir(this.deps.store, inst.manifest);
      const ok = await this.installDeps(
        inst,
        runtime,
        workDir,
        'missing-module',
        result.moduleName,
        inst.manifest.allowInstallScripts || action === 'install-allow-scripts'
      );
      if (!ok) {
        this.setState(inst, {
          phase: 'failed',
          message: '依赖安装失败，未重试启动',
          category: result.category,
          exitCode: code,
          signal,
          pid: null,
        });
        return;
      }

      this.log(inst.projectId, 'sys', '依赖安装完成，自动重试启动（仅重试一次）');
      this.setState(inst, { phase: 'restarting', message: '依赖安装完成，正在重试启动…' });
      await this.runAttempt(inst, 'skip');
      return;
    }

    /* 崩溃重启（仅对未知原因的失败生效，避免对配置错误做无意义重试） */
    const restart = inst.manifest.restartPolicy;
    if (
      restart.mode === 'on-failure' &&
      result.category === 'unknown' &&
      inst.state.restarts < restart.maxRetries
    ) {
      inst.state.restarts += 1;
      this.setState(inst, {
        phase: 'restarting',
        message: `进程异常退出，${Math.round(restart.backoffMs / 1000)} 秒后自动重启（第 ${inst.state.restarts}/${restart.maxRetries} 次）`,
        exitCode: code,
        signal,
        pid: null,
      });
      inst.restartTimer = setTimeout(() => {
        inst.restartTimer = null;
        void this.runAttempt(inst).catch((err) => {
          this.log(inst.projectId, 'err', toMessage(err));
          this.setState(inst, { phase: 'failed', message: toMessage(err) });
        });
      }, restart.backoffMs);
      return;
    }

    this.setState(inst, {
      phase: 'failed',
      message: result.hint,
      category: result.category,
      exitCode: code,
      signal,
      pid: null,
    });
  }

  /* ----------------------------- 停止 ----------------------------- */

  async stop(projectId: string): Promise<void> {
    const inst = this.instances.get(projectId);
    if (!inst) return;
    if (!inst.proc) {
      this.setState(inst, { phase: 'idle', message: '未在运行', pid: null });
      return;
    }

    inst.userStopped = true;
    this.setState(inst, { phase: 'stopping', message: '正在停止进程…' });
    inst.readiness?.stop();
    inst.metrics?.stop();

    const timeout = inst.manifest.stopTimeoutMs ?? 8000;
    await this.killTree(inst, false);

    inst.stopTimer = setTimeout(() => {
      inst.stopTimer = null;
      if (inst.proc) {
        this.log(inst.projectId, 'sys', `等待 ${Math.round(timeout / 1000)} 秒未退出，强制结束进程树`);
        void this.killTree(inst, true);
      }
    }, timeout);

    inst.forceTimer = setTimeout(() => {
      inst.forceTimer = null;
      if (inst.proc) {
        inst.proc = null;
        this.teardownWatchers(inst);
        this.setState(inst, { phase: 'idle', message: '已停止（强制）', pid: null });
      }
    }, timeout + 5000);
  }

  async stopAll(): Promise<void> {
    const ids = this.runningProjectIds();
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private async killTree(inst: Instance, force: boolean): Promise<void> {
    const pid = inst.proc?.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      const args = force
        ? ['/PID', String(pid), '/T', '/F']
        : ['/PID', String(pid), '/T'];
      await execFileAsync('taskkill', args, { windowsHide: true }).catch(() => {});
      return;
    }
    const signal: NodeJS.Signals = force
      ? 'SIGKILL'
      : (inst.manifest.stopSignal ?? 'SIGTERM');
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        inst.proc?.kill(signal);
      } catch {
        /* ignore */
      }
    }
  }

  private teardownWatchers(inst: Instance): void {
    inst.readiness?.stop();
    inst.readiness = null;
    inst.metrics?.stop();
    inst.metrics = null;
  }

  private clearTimers(inst: Instance): void {
    if (inst.stopTimer) {
      clearTimeout(inst.stopTimer);
      inst.stopTimer = null;
    }
    if (inst.forceTimer) {
      clearTimeout(inst.forceTimer);
      inst.forceTimer = null;
    }
  }

  /* ----------------------------- 端口探测 ----------------------------- */

  private async resolvePort(inst: Instance, config: AppConfig): Promise<number | null> {
    const { manifest } = inst;
    if (manifest.portMode === 'none') return null;

    const desired = manifest.port ?? config.defaultPort ?? 3000;
    if (manifest.portMode === 'display') return desired;

    const available = await isPortAvailable(desired);
    if (available) return desired;

    if (config.autoPickFreePort) {
      const free = await findFreePort(desired + 1);
      if (free) {
        this.log(inst.projectId, 'sys', `端口 ${desired} 已被占用，自动改用 ${free}`);
        return free;
      }
    }
    throw new AppError(
      `端口 ${desired} 已被占用，请关闭占用程序或在「编辑」中修改端口`,
      'E_PORT_IN_USE'
    );
  }

  private async refreshListeningPort(inst: Instance): Promise<void> {
    if (inst.manifest.portMode === 'none') return;
    const pid = inst.state.pid;
    if (!pid) return;
    try {
      const pids = await this.tree.descendants(pid);
      const output = await this.listListeningOutput();
      if (!output) return;
      const ports = parseListeningPorts(output, pids);
      const current = inst.state.port;
      const found = ports.find((p) => p !== current) ?? ports[0];
      if (found && found !== current) {
        this.setState(inst, { port: found, url: `http://localhost:${found}` });
        this.log(inst.projectId, 'sys', `检测到实际监听端口: ${found}`);
      } else if (found && !inst.state.url) {
        this.setState(inst, { url: `http://localhost:${found}` });
      }
    } catch {
      /* 探测失败不影响运行 */
    }
  }

  private async listListeningOutput(): Promise<string | null> {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], {
          timeout: 8000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        });
        return stdout;
      }
      const { stdout } = await execFileAsync('sh', ['-c', 'netstat -ltnp 2>/dev/null || ss -ltnp'], {
        timeout: 8000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
    }
  }

  /* ----------------------------- 依赖提示 ----------------------------- */

  private askPrompt(inst: Instance, prompt: DepsPrompt): Promise<DepsPromptAction> {
    this.setState(inst, { phase: 'preflight', message: prompt.message });
    return new Promise<DepsPromptAction>((resolve) => {
      const timer = setTimeout(() => {
        this.prompts.delete(inst.projectId);
        resolve('cancel');
      }, PROMPT_TIMEOUT_MS);
      this.prompts.set(inst.projectId, { resolve, timer });
      this.deps.onPrompt(prompt);
    });
  }

  /** 渲染层回传用户选择 */
  resolvePrompt(projectId: string, action: DepsPromptAction): boolean {
    const pending = this.prompts.get(projectId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.prompts.delete(projectId);
    pending.resolve(action);
    return true;
  }

  private async installDeps(
    inst: Instance,
    runtime: RuntimeInfo,
    workDir: string,
    reason: 'preflight' | 'missing-module' | 'manual' | 'reinstall',
    moduleName: string | null,
    allowScripts: boolean
  ): Promise<boolean> {
    this.log(
      inst.projectId,
      'dep',
      reason === 'missing-module'
        ? `开始安装依赖（缺少 ${moduleName ?? '模块'}）…`
        : '开始安装依赖…'
    );
    const result = await this.deps.depsService.install({
      projectId: inst.projectId,
      manifest: inst.manifest,
      workDir,
      runtime,
      allowScripts,
      reason,
      moduleName,
    });
    if (result.cancelled) {
      this.log(inst.projectId, 'dep', '依赖安装已取消');
      return false;
    }
    if (!result.ok) {
      this.log(inst.projectId, 'err', `依赖安装失败：${result.error ?? `退出码 ${result.exitCode}`}`);
      if (result.outputTail) this.log(inst.projectId, 'dep', result.outputTail);
      return false;
    }
    this.log(inst.projectId, 'dep', '依赖安装完成');
    return true;
  }

  /* ----------------------------- 内部工具 ----------------------------- */

  private setState(inst: Instance, patch: Partial<LaunchState>): void {
    inst.state = { ...inst.state, ...patch };
    this.deps.onState(inst.state);
  }

  private log(projectId: string | null, kind: LogKind, msg: string): void {
    this.deps.log(projectId, kind, msg);
  }

  /** 供 UI 展示的私有目录（安装日志等） */
  privateDir(manifest: ProjectManifest): string {
    return projectPrivateDir(this.deps.store, manifest);
  }
}

function readinessLabel(source: string): string {
  if (source === 'pattern') return '日志关键字';
  if (source === 'http') return '健康检查';
  if (source === 'tcp') return '端口探测';
  return '兜底';
}

function configHostPlaceholder(manifest: ProjectManifest): string {
  return manifest.host || '0.0.0.0';
}

async function readPackageName(dir: string): Promise<string | null> {
  try {
    const file = `${dir}/package.json`;
    if (!(await fse.pathExists(file))) return null;
    const pkg = (await fse.readJson(file)) as { name?: unknown };
    return typeof pkg.name === 'string' ? pkg.name : null;
  } catch {
    return null;
  }
}

export type { LaunchPhase };
