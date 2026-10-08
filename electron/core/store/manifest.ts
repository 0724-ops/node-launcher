import type {
  AutoInstallDeps,
  ErrorCategory,
  MetricsStrategy,
  PackageManager,
  PortMode,
  ProjectManifest,
  RestartPolicy,
  SourceKind,
  StartMode,
} from '../../types';
import { normalizeNodeSpec } from '../runtime/version-spec';

/**
 * 清单归一化与校验。
 * 原则：
 *  - 读取时**容错**（缺失字段补默认、非法字段丢弃），避免用户手改一处就整条记录消失；
 *  - 保存时**严格**（validateManifest 阻断明显矛盾的配置）。
 * 全部为纯函数，便于单测。
 */

const START_MODES: StartMode[] = ['node', 'command'];
const PORT_MODES: PortMode[] = ['inject', 'display', 'none'];
const SOURCES: SourceKind[] = ['linked', 'managed', 'zip', 'github', 'git'];
const AUTO_INSTALL: AutoInstallDeps[] = ['ask', 'always', 'never'];
const METRICS: MetricsStrategy[] = ['auto', 'reporter', 'polling'];

const MAX_NAME = 80;
const MAX_ARGS = 64;
const MAX_ARG_LEN = 500;
const MAX_ENV_KEYS = 128;
const MAX_ENV_VALUE = 4000;
const MAX_COMMAND = 2000;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ProjectPatch {
  name?: string;
  desc?: string;
  tags?: string[];
  cwd?: string;
  startMode?: StartMode;
  entry?: string;
  nodeVersion?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  envFile?: string;
  portMode?: PortMode;
  port?: number;
  host?: string;
  readyPattern?: string;
  healthUrl?: string;
  readyTimeoutMs?: number;
  autoInstallDeps?: AutoInstallDeps;
  allowInstallScripts?: boolean;
  restartPolicy?: Partial<RestartPolicy>;
  stopSignal?: 'SIGTERM' | 'SIGINT';
  stopTimeoutMs?: number;
  singleton?: boolean;
}

function str(value: unknown, max = 4000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

function bool(value: unknown, def: boolean): boolean {
  return typeof value === 'boolean' ? value : def;
}

function intIn(
  value: unknown,
  min: number,
  max: number,
  def: number
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  if (i < min || i > max) return def;
  return i;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: T[],
  def: T
): T {
  return allowed.includes(value as T) ? (value as T) : def;
}

export function normalizeArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const s = String(item ?? '').trim();
    if (!s) continue;
    out.push(s.length > MAX_ARG_LEN ? s.slice(0, MAX_ARG_LEN) : s);
    if (out.length >= MAX_ARGS) break;
  }
  return out.length ? out : undefined;
}

export function normalizeEnv(
  value: unknown
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!ENV_KEY_RE.test(key)) continue;
    let val = String(rawVal ?? '');
    if (val.length > MAX_ENV_VALUE) val = val.slice(0, MAX_ENV_VALUE);
    out[key] = val;
    count += 1;
    if (count >= MAX_ENV_KEYS) break;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 正则必须能编译，否则丢弃（否则启动时才炸） */
export function normalizePattern(value: unknown): string | undefined {
  const s = str(value, 500);
  if (!s) return undefined;
  try {
    new RegExp(s);
    return s;
  } catch {
    return undefined;
  }
}

export function normalizeHealthUrl(value: unknown): string | undefined {
  const s = str(value, 500);
  if (!s) return undefined;
  return /^https?:\/\//i.test(s) ? s : undefined;
}

export function normalizeRestartPolicy(
  value: unknown
): RestartPolicy {
  const raw = (value ?? {}) as Partial<RestartPolicy>;
  return {
    mode: raw.mode === 'on-failure' ? 'on-failure' : 'never',
    maxRetries: intIn(raw.maxRetries, 0, 20, 3),
    backoffMs: intIn(raw.backoffMs, 200, 60000, 2000),
  };
}

/** 从任意对象归一化出完整清单；无法使用时返回 null */
export function normalizeManifest(
  raw: unknown,
  fallbackId?: string
): ProjectManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const rawId = str(r.id, 64);
  const id = rawId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rawId)
    ? rawId
    : fallbackId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(fallbackId)
      ? fallbackId
      : null;
  if (!id) return null;

  const rootDir = str(r.rootDir, 1000);
  if (!rootDir) return null;

  const startMode = oneOf<StartMode>(r.startMode, START_MODES, 'node');
  const args = startMode === 'node' ? normalizeArgs(r.args) : undefined;

  const rawExit = r.lastExit as Record<string, unknown> | null | undefined;
  let lastExit: ProjectManifest['lastExit'] = null;
  if (rawExit && typeof rawExit === 'object') {
    lastExit = {
      code:
        rawExit.code === null || rawExit.code === undefined
          ? null
          : Number(rawExit.code),
      signal:
        rawExit.signal === null || rawExit.signal === undefined
          ? null
          : String(rawExit.signal),
      at: str(rawExit.at, 40) ?? new Date().toISOString(),
      category: rawExit.category
        ? (String(rawExit.category) as ErrorCategory)
        : undefined,
    };
  }

  const manifest: ProjectManifest = {
    schema: 1,
    id,
    name: str(r.name, MAX_NAME) ?? id,
    source: oneOf<SourceKind>(r.source, SOURCES, 'managed'),
    rootDir,
    startMode,
    portMode: oneOf<PortMode>(r.portMode, PORT_MODES, 'inject'),
    autoInstallDeps: oneOf<AutoInstallDeps>(r.autoInstallDeps, AUTO_INSTALL, 'ask'),
    allowInstallScripts: bool(r.allowInstallScripts, false),
    restartPolicy: normalizeRestartPolicy(r.restartPolicy),
    singleton: bool(r.singleton, true),
    createdAt: str(r.createdAt, 40) ?? new Date().toISOString(),
    lastStartedAt:
      r.lastStartedAt === null || r.lastStartedAt === undefined
        ? null
        : String(r.lastStartedAt),
    lastExit,
  };

  const desc = str(r.desc, 500);
  if (desc) manifest.desc = desc;

  if (Array.isArray(r.tags)) {
    const tags = r.tags
      .map((t) => str(t, 32))
      .filter((t): t is string => !!t)
      .slice(0, 20);
    if (tags.length) manifest.tags = tags;
  }

  const cwd = str(r.cwd, 500);
  if (cwd) manifest.cwd = cwd;

  const entry = str(r.entry, 500);
  if (entry) manifest.entry = entry;

  // engines.node 里的范围写法（">=22" / "^20.11.0"）必须归一化：
  // 原样保留会被拼进运行时目录名，在 Windows 上产生非法路径。
  const nodeVersion = normalizeNodeSpec(str(r.nodeVersion, 32) ?? '');
  if (nodeVersion) manifest.nodeVersion = nodeVersion;

  const command = str(r.command, MAX_COMMAND);
  if (command) manifest.command = command;

  if (args) manifest.args = args;

  const env = normalizeEnv(r.env);
  if (env) manifest.env = env;

  const envFile = str(r.envFile, 500);
  if (envFile) manifest.envFile = envFile;

  const port = r.port === undefined || r.port === null ? undefined : Number(r.port);
  if (port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535) {
    manifest.port = port;
  }

  const host = str(r.host, 255);
  if (host) manifest.host = host;

  const readyPattern = normalizePattern(r.readyPattern);
  if (readyPattern) manifest.readyPattern = readyPattern;

  const healthUrl = normalizeHealthUrl(r.healthUrl);
  if (healthUrl) manifest.healthUrl = healthUrl;

  if (r.readyTimeoutMs !== undefined) {
    manifest.readyTimeoutMs = intIn(r.readyTimeoutMs, 1000, 1800000, 60000);
  }
  if (r.stopTimeoutMs !== undefined) {
    manifest.stopTimeoutMs = intIn(r.stopTimeoutMs, 500, 120000, 8000);
  }
  if (r.stopSignal === 'SIGINT' || r.stopSignal === 'SIGTERM') {
    manifest.stopSignal = r.stopSignal;
  }

  return manifest;
}

/** 保存前校验：返回错误列表，空数组表示可保存 */
export function validateManifest(m: ProjectManifest): string[] {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(m.id)) {
    errors.push('项目 ID 非法');
  }
  if (!m.name.trim()) errors.push('项目名称不能为空');
  if (!m.rootDir.trim()) errors.push('项目目录不能为空');

  if (m.startMode === 'node') {
    if (!m.entry || !m.entry.trim()) errors.push('Node 直启模式必须填写入口文件');
  } else {
    if (!m.command || !m.command.trim()) errors.push('自定义命令模式必须填写命令');
    if (m.command && m.command.length > MAX_COMMAND) {
      errors.push(`命令过长（上限 ${MAX_COMMAND} 字符）`);
    }
    if (/[\u0000]/.test(m.command ?? '')) errors.push('命令包含非法字符');
  }

  if (m.portMode !== 'none' && m.port !== undefined) {
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) {
      errors.push('端口需为 1-65535 之间的整数');
    }
  }
  if (m.healthUrl && !/^https?:\/\//i.test(m.healthUrl)) {
    errors.push('健康检查地址必须是 http/https');
  }
  return errors;
}

/** 应用补丁（含归一化），返回新的清单对象 */
export function applyPatch(
  current: ProjectManifest,
  patch: ProjectPatch
): ProjectManifest {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  // 切到 command 模式时清掉 node 专有字段，避免残留矛盾配置
  if (patch.startMode === 'command') {
    delete merged.entry;
    delete merged.args;
  }
  // 切到 node 模式时清掉命令
  if (patch.startMode === 'node') {
    delete merged.command;
  }
  const normalized = normalizeManifest(merged, current.id);
  if (!normalized) {
    throw new Error('清单归一化失败');
  }
  // 保留 patch 未覆盖的既有可选字段（normalizeManifest 已全量重建，这里无需额外处理）
  const errors = validateManifest(normalized);
  if (errors.length) throw new Error(errors.join('；'));
  return normalized;
}

/** 新建项目的默认清单 */
export function defaultManifest(input: {
  id: string;
  name: string;
  rootDir: string;
  source: SourceKind;
  desc?: string;
  defaults?: {
    portMode?: PortMode;
    port?: number;
    autoInstallDeps?: AutoInstallDeps;
  };
}): ProjectManifest {
  const base = normalizeManifest(
    {
      id: input.id,
      name: input.name,
      rootDir: input.rootDir,
      source: input.source,
      desc: input.desc,
      startMode: 'node',
      entry: 'index.js',
      portMode: input.defaults?.portMode ?? 'inject',
      port: input.defaults?.port ?? 3000,
      autoInstallDeps: input.defaults?.autoInstallDeps ?? 'ask',
      createdAt: new Date().toISOString(),
    },
    input.id
  );
  if (!base) throw new Error('无法创建清单');
  return base;
}

export const MANIFEST_LIMITS = {
  MAX_NAME,
  MAX_ARGS,
  MAX_COMMAND,
  MAX_ENV_KEYS,
};

export type { PackageManager, MetricsStrategy };
