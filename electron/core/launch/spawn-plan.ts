import path from 'path';
import type { ProjectManifest, RuntimeInfo } from '../../types';
import { resolveInside } from '../util/paths';
import { substitutePlaceholders } from './placeholders';

/**
 * 由清单推导出「要执行什么」——纯函数，不碰文件系统、不启动进程。
 *
 * 两种模式的差异（PLAN §6.2）：
 *  - node：直接执行真 Node，无 shell，参数逐个传递，绝无注入风险
 *  - command：整条命令行交给 shell（Windows cmd /d /s /c、POSIX /bin/sh -c），
 *            支持 && 与管道；不再追加 args
 */

export interface SpawnPlanInput {
  manifest: ProjectManifest;
  /** 运行时；command 模式下也需要（用于 PATH 注入与 {NODE}） */
  runtime: RuntimeInfo;
  /** 项目根目录（已被调用方校验过） */
  rootDir: string;
  /** 本次生效端口（portMode=inject 时为实际端口，否则可能为 null） */
  port: number | null;
  host: string;
  /** 基础环境（通常是 process.env） */
  baseEnv?: NodeJS.ProcessEnv;
  /** .env 文件解析结果（优先级低于 manifest.env） */
  envFileValues?: Record<string, string>;
  /** 性能上报脚本路径；为空表示不注入 */
  reporterPath?: string | null;
  /** 采集策略为 polling 时不注入 NODE_OPTIONS */
  injectReporter?: boolean;
  /** 目标平台；默认 process.platform，测试可注入 */
  platform?: NodeJS.Platform;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  shell: boolean;
  cwd: string;
  env: Record<string, string>;
  /** 日志展示用 */
  displayLine: string;
  mode: 'node' | 'command';
  /** node 模式下解析后的入口绝对路径 */
  entryPath: string | null;
}

/** 解析工作目录：始终落在项目根目录内 */
export function resolveWorkingDir(rootDir: string, cwd?: string): string {
  const rel = (cwd ?? '').trim();
  if (!rel) return path.resolve(rootDir);
  return resolveInside(rootDir, rel);
}

/** Windows 上给 NODE_OPTIONS 里的路径加引号并用正斜杠（反斜杠会被当转义符） */
export function quoteForNodeOptions(file: string): string {
  return `--require "${file.replace(/\\/g, '/')}"`;
}

/**
 * 把整条命令行包成「显式 shell 调用」，避免 spawn 的 shell:true。
 * Windows: %ComSpec% /d /s /c "<命令>"；POSIX: /bin/sh -c "<命令>"。
 */
export function shellInvocation(
  line: string,
  platform: NodeJS.Platform,
  comspec?: string
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return { command: comspec || process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', line] };
  }
  return { command: '/bin/sh', args: ['-c', line] };
}

export function buildSpawnPlan(input: SpawnPlanInput): SpawnPlan {
  const { manifest, runtime } = input;
  const cwd = resolveWorkingDir(input.rootDir, manifest.cwd);

  const values = {
    PORT: input.port ?? undefined,
    HOST: input.host,
    CWD: cwd,
    ENTRY: manifest.entry ?? undefined,
    NODE: runtime.nodePath,
  };

  // ---- 环境变量 ----
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.baseEnv ?? {})) {
    if (typeof v === 'string') base[k] = v;
  }
  // Electron/Node 专有变量必须清掉：command 模式下一旦注入 ELECTRON_RUN_AS_NODE，
  // 用户自己的 Electron 程序会被当成 node 执行。
  delete base.ELECTRON_RUN_AS_NODE;
  delete base.ELECTRON_NO_ATTACH_CONSOLE;
  delete base.NODE_OPTIONS;

  const env: Record<string, string> = { ...base };

  if (manifest.portMode === 'inject' && input.port) {
    env.PORT = String(input.port);
    env.HOST = input.host;
  }
  for (const [k, v] of Object.entries(input.envFileValues ?? {})) {
    env[k] = substitutePlaceholders(String(v), values);
  }
  for (const [k, v] of Object.entries(manifest.env ?? {})) {
    env[k] = substitutePlaceholders(String(v), values);
  }

  // 把运行时目录前置到 PATH：项目里的 node/npm/npx 直接可用（无需用户装 Node）
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const currentPath = env[pathKey] ?? '';
  env[pathKey] = currentPath ? `${runtime.dir}${path.delimiter}${currentPath}` : runtime.dir;

  if (input.injectReporter && input.reporterPath) {
    env.NODE_OPTIONS = quoteForNodeOptions(input.reporterPath);
  }

  // ---- 命令行 ----
  if (manifest.startMode === 'command') {
    const line = substitutePlaceholders((manifest.command ?? '').trim(), values);
    // 显式调起 shell，而不是 spawn 的 shell:true：
    // shell:true + args 会触发 Node 的 DEP0190 弃用警告（参数不做转义，只做拼接）。
    const shell = shellInvocation(line, input.platform ?? process.platform, env.ComSpec);
    return {
      command: shell.command,
      args: shell.args,
      shell: false,
      cwd,
      env,
      displayLine: line,
      mode: 'command',
      entryPath: null,
    };
  }

  const entryRel = (manifest.entry ?? '').trim();
  if (!entryRel) throw new Error('Node 直启模式缺少入口文件');
  const entryPath = resolveInside(cwd, entryRel);
  const args = (manifest.args ?? []).map((a) =>
    substitutePlaceholders(String(a), { ...values, ENTRY: entryPath })
  );

  return {
    command: runtime.nodePath,
    args: [entryPath, ...args],
    shell: false,
    cwd,
    env,
    displayLine: `node ${path.basename(entryPath)}${args.length ? ' ' + args.join(' ') : ''}`,
    mode: 'node',
    entryPath,
  };
}
