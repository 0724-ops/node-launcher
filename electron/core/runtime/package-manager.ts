import path from 'path';
import fse from 'fs-extra';
import type { PackageManager } from '../../types';
import type { RuntimeInfo } from '../../types';

export const LOCKFILES: { file: string; pm: PackageManager }[] = [
  { file: 'package-lock.json', pm: 'npm' },
  { file: 'npm-shrinkwrap.json', pm: 'npm' },
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'bun.lockb', pm: 'bun' },
  { file: 'bun.lock', pm: 'bun' },
];

export interface DetectedPackageJson {
  exists: boolean;
  name: string | null;
  version: string | null;
  main: string | null;
  moduleType: 'module' | 'commonjs' | null;
  enginesNode: string | null;
  scripts: Record<string, string>;
  packageManagerField: string | null;
  workspaces: string[];
}

export async function readPackageJson(dir: string): Promise<DetectedPackageJson> {
  const empty: DetectedPackageJson = {
    exists: false,
    name: null,
    version: null,
    main: null,
    moduleType: null,
    enginesNode: null,
    scripts: {},
    packageManagerField: null,
    workspaces: [],
  };
  const file = path.join(dir, 'package.json');
  if (!(await fse.pathExists(file))) return empty;

  try {
    const pkg = (await fse.readJson(file)) as Record<string, unknown>;
    const scripts: Record<string, string> = {};
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      for (const [k, v] of Object.entries(pkg.scripts as Record<string, unknown>)) {
        if (typeof v === 'string') scripts[k] = v;
      }
    }
    const engines = (pkg.engines ?? {}) as Record<string, unknown>;
    let workspaces: string[] = [];
    if (Array.isArray(pkg.workspaces)) {
      workspaces = pkg.workspaces.filter((w): w is string => typeof w === 'string');
    } else if (pkg.workspaces && typeof pkg.workspaces === 'object') {
      const packages = (pkg.workspaces as { packages?: unknown }).packages;
      if (Array.isArray(packages)) {
        workspaces = packages.filter((w): w is string => typeof w === 'string');
      }
    }

    return {
      exists: true,
      name: typeof pkg.name === 'string' ? pkg.name : null,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      main: typeof pkg.main === 'string' ? pkg.main : null,
      moduleType:
        pkg.type === 'module' ? 'module' : pkg.type === 'commonjs' ? 'commonjs' : null,
      enginesNode: typeof engines.node === 'string' ? engines.node : null,
      scripts,
      packageManagerField:
        typeof pkg.packageManager === 'string' ? pkg.packageManager : null,
      workspaces,
    };
  } catch {
    return empty;
  }
}

export interface PackageManagerDetection {
  name: PackageManager;
  lockfile: string | null;
  /** 来自 package.json 的 packageManager 字段（优先于 lockfile） */
  fromField: boolean;
}

/** 探测包管理器：packageManager 字段 > lockfile > npm */
export async function detectPackageManager(dir: string): Promise<PackageManagerDetection> {
  const pkg = await readPackageJson(dir);

  if (pkg.packageManagerField) {
    const name = pkg.packageManagerField.split('@')[0]?.trim().toLowerCase();
    if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
      const lockfile =
        (await findLockfile(dir, name)) ??
        (await findAnyLockfile(dir))?.file ??
        null;
      return { name, lockfile, fromField: true };
    }
  }

  const found = await findAnyLockfile(dir);
  if (found) return { name: found.pm, lockfile: found.file, fromField: false };
  return { name: 'npm', lockfile: null, fromField: false };
}

export async function findLockfile(
  dir: string,
  pm: PackageManager
): Promise<string | null> {
  for (const candidate of LOCKFILES) {
    if (candidate.pm !== pm) continue;
    if (await fse.pathExists(path.join(dir, candidate.file))) return candidate.file;
  }
  return null;
}

async function findAnyLockfile(
  dir: string
): Promise<{ file: string; pm: PackageManager } | null> {
  for (const candidate of LOCKFILES) {
    if (await fse.pathExists(path.join(dir, candidate.file))) return candidate;
  }
  return null;
}

export interface InstallInvocation {
  command: string;
  args: string[];
  /** 供日志展示的可读命令行 */
  display: string;
}

/**
 * 构造安装命令。
 * 关键点：Windows 上 spawn('npm.cmd') 会 EINVAL，因此统一用 `node <cli.js>` 调用，
 * 完全绕开 .cmd/.bat 与 shell 引号问题。
 */
export function buildInstallInvocation(
  pm: PackageManager,
  runtime: RuntimeInfo,
  opts: {
    /** 是否存在 lockfile → 优先 npm ci */
    hasLockfile: boolean;
    ignoreScripts: boolean;
    registry?: string;
  }
): InstallInvocation {
  const flags: string[] = [];
  if (opts.ignoreScripts) flags.push('--ignore-scripts');
  if (opts.registry?.trim()) flags.push(`--registry=${opts.registry.trim()}`);

  if (pm === 'npm') {
    if (!runtime.npmCliPath) {
      throw new Error('当前 Node 运行时缺少 npm，无法安装依赖');
    }
    const sub = opts.hasLockfile ? 'ci' : 'install';
    const args = [runtime.npmCliPath, sub, ...flags, '--no-audit', '--no-fund'];
    return {
      command: runtime.nodePath,
      args,
      display: `node npm-cli.js ${sub} ${flags.concat(['--no-audit', '--no-fund']).join(' ')}`.trim(),
    };
  }

  if (!runtime.corepackPath) {
    throw new Error(`当前 Node 运行时缺少 corepack，无法使用 ${pm}；请改用 npm 或安装 ${pm}`);
  }
  const args = [runtime.corepackPath, pm, 'install', ...flags];
  return {
    command: runtime.nodePath,
    args,
    display: `corepack ${pm} install ${flags.join(' ')}`.trim(),
  };
}

/** 供「编辑弹窗 → 从 package.json 选脚本」使用 */
export function buildScriptCommand(pm: PackageManager, script: string): string {
  if (pm === 'npm') return `npm run ${script}`;
  if (pm === 'bun') return `bun run ${script}`;
  return `${pm} ${script}`;
}

/** 从 package.json 的 scripts.start 里提取 `node <file>` 形式的入口 */
export function extractEntryFromScript(script: string): string | null {
  if (!script) return null;
  const match = script.match(/(?:^|\s)node\s+(?:--?[\w=-]+\s+)*([^\s|&;]+\.(?:js|mjs|cjs|ts))/);
  if (!match) return null;
  const candidate = match[1].replace(/^['"]|['"]$/g, '');
  if (candidate.startsWith('-')) return null;
  return candidate;
}
