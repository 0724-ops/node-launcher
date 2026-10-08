/**
 * 项目母栏（分组）逻辑。
 *
 * 母栏只描述「哪些实例属于我」，属于界面组织信息，**不是**项目业务数据：
 *   - 栏内顺序一律交给 `config.projectOrder`（单一顺序来源），所以 `instanceIds` 顺序无意义；
 *   - 删母栏不删项目，成员自动回落到「未分组」；
 *   - 读取外部文件一律归一化，畸形输入不抛错。
 * 全部为纯函数（时间戳由调用方传入），便于单测。
 */

import type { GroupedProjects, GroupsFile, ProjectGroup, ProjectSummary } from '../../types';
import { applyProjectOrder } from './project-order';

/** 虚拟母栏「未分组」的保留 id（不是合法母栏 id，不会被持久化） */
export const UNGROUPED_ID = '__ungrouped__';

/** 母栏 id 白名单格式 */
const GROUP_ID_RE = /^group_[a-z0-9]{4,32}$/;
/** GitHub owner（用户 / 组织）格式 */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** GitHub 仓库名格式 */
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** 全点号段（`.`、`..`）单独判掉，避免路径穿越 */
const DOTS_RE = /^\.+$/;
/** 名称最大长度 */
const NAME_MAX = 40;
/** 兜底 ISO 时间（`now` 也非法时使用，保证确定性） */
const FALLBACK_ISO = '1970-01-01T00:00:00.000Z';

/** 生成新母栏 id：`group_` + 10 位 [a-z0-9] */
export function newGroupId(): string {
  let suffix = '';
  while (suffix.length < 10) suffix += Math.random().toString(36).slice(2);
  return `group_${suffix.slice(0, 10)}`;
}

/** 是否为合法母栏 id */
export function isValidGroupId(id: unknown): id is string {
  return typeof id === 'string' && GROUP_ID_RE.test(id);
}

/** 任意值转文本；null / undefined 视为空串 */
function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** 母栏名称归一化：去空白、空则默认名、超长截断 */
function normalizeGroupName(input: unknown): string {
  const name = toText(input).trim();
  if (!name) return '未命名母栏';
  return name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name;
}

/**
 * 归一化 GitHub 仓库地址为 `owner/repo`（保留原始大小写）。
 * 白名单策略：清洗后不是严格的 `owner/repo` 一律返回空串，绝不猜测。
 */
export function normalizeRepo(input: unknown): string {
  let text = toText(input).trim();
  if (!text) return '';
  text = text.replace(/^git@github\.com:/i, '');
  text = text.replace(/^https?:\/\//i, '');
  text = text.replace(/^www\./i, '');
  text = text.replace(/^github\.com\//i, '');
  text = text.replace(/\/+$/, '');
  text = text.replace(/\.git$/i, '');
  text = text.replace(/\/+$/, '');

  const segments = text.split('/').filter((part) => part !== '');
  if (segments.length !== 2) return '';
  const [owner, repo] = segments;
  if (DOTS_RE.test(owner) || DOTS_RE.test(repo)) return '';
  if (!OWNER_RE.test(owner)) return '';
  if (!REPO_RE.test(repo)) return '';
  return `${owner}/${repo}`;
}

/**
 * 归一化母栏文件内容。任何畸形输入都退化为「忽略该条」，不抛错、不改动入参。
 * `now` 用于 `createdAt` 缺失时的兜底，由调用方注入以保证可测。
 */
export function normalizeGroupsFile(
  raw: unknown,
  knownProjectIds: string[],
  now: string = new Date().toISOString()
): ProjectGroup[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const list = (raw as { groups?: unknown }).groups;
  if (!Array.isArray(list)) return [];

  const known = new Set<string>();
  for (const id of knownProjectIds ?? []) {
    const text = toText(id).trim();
    if (text) known.add(text);
  }

  const fallbackCreatedAt =
    typeof now === 'string' && now.trim() ? now.trim() : FALLBACK_ISO;

  const seenGroupIds = new Set<string>();
  const claimed = new Set<string>();
  const out: ProjectGroup[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const id = item.id;
    if (!isValidGroupId(id)) continue;
    if (seenGroupIds.has(id)) continue; // 重复 id 只保留第一条
    seenGroupIds.add(id);

    const instanceIds: string[] = [];
    const rawMembers = Array.isArray(item.instanceIds) ? item.instanceIds : [];
    for (const member of rawMembers) {
      if (typeof member !== 'string') continue;
      const memberId = member.trim();
      if (!memberId) continue;
      if (!known.has(memberId)) continue; // 未知项目直接丢弃
      if (claimed.has(memberId)) continue; // 跨母栏去重：先到先得
      if (instanceIds.includes(memberId)) continue; // 同栏内去重
      claimed.add(memberId);
      instanceIds.push(memberId);
    }

    const createdAt = toText(item.createdAt).trim();

    out.push({
      id,
      name: normalizeGroupName(item.name),
      githubRepo: normalizeRepo(item.githubRepo),
      instanceIds,
      lastSeenTag: toText(item.lastSeenTag),
      lastCheckedAt: toText(item.lastCheckedAt),
      collapsed: Boolean(item.collapsed),
      createdAt: createdAt || fallbackCreatedAt,
    });
  }

  return out;
}

/** 新建母栏并追加到末尾（id 非法属编码错误，直接抛） */
export function createGroup(
  groups: ProjectGroup[],
  input: { id: string; name: string; githubRepo?: string; now?: string }
): ProjectGroup[] {
  const id = input?.id;
  if (!isValidGroupId(id)) throw new Error('非法母栏 ID');
  const group: ProjectGroup = {
    id,
    name: normalizeGroupName(input?.name),
    githubRepo: normalizeRepo(input?.githubRepo),
    instanceIds: [],
    lastSeenTag: '',
    lastCheckedAt: '',
    collapsed: false,
    createdAt: typeof input?.now === 'string' && input.now.trim() ? input.now : new Date().toISOString(),
  };
  return [...(groups ?? []), group];
}

/** 修改母栏名称 / 仓库；只动传入的字段，找不到 id 时原样返回新数组 */
export function updateGroup(
  groups: ProjectGroup[],
  id: string,
  patch: { name?: string; githubRepo?: string }
): ProjectGroup[] {
  return (groups ?? []).map((group) => {
    if (group.id !== id) return { ...group };
    const next: ProjectGroup = { ...group };
    if (patch && patch.name !== undefined) next.name = normalizeGroupName(patch.name);
    if (patch && patch.githubRepo !== undefined) next.githubRepo = normalizeRepo(patch.githubRepo);
    return next;
  });
}

/** 删除母栏；成员不删除，自动回落到「未分组」 */
export function deleteGroup(groups: ProjectGroup[], id: string): ProjectGroup[] {
  return (groups ?? []).filter((group) => group.id !== id);
}

/** 设置折叠状态（强制布尔） */
export function setGroupCollapsed(
  groups: ProjectGroup[],
  id: string,
  collapsed: boolean
): ProjectGroup[] {
  return (groups ?? []).map((group) =>
    group.id === id ? { ...group, collapsed: Boolean(collapsed) } : { ...group }
  );
}

/**
 * 移动实例：先从所有母栏移除，再追加到目标母栏末尾。
 * `null` / `UNGROUPED_ID` / 未知 id 表示移出分组。
 */
export function moveInstance(
  groups: ProjectGroup[],
  instanceId: string,
  targetGroupId: string | null
): ProjectGroup[] {
  const list = groups ?? [];
  const id = toText(instanceId).trim();
  const target =
    typeof targetGroupId === 'string' &&
    targetGroupId !== '' &&
    targetGroupId !== UNGROUPED_ID &&
    list.some((group) => group.id === targetGroupId)
      ? targetGroupId
      : null;

  if (!id) return list.map((group) => ({ ...group, instanceIds: [...(group.instanceIds ?? [])] }));

  return list.map((group) => {
    const members = (group.instanceIds ?? []).filter((member) => member !== id);
    if (target !== null && group.id === target) members.push(id);
    return { ...group, instanceIds: members };
  });
}

/**
 * 组装界面视图：栏内项目沿用全局顺序表，未分组恒在最后。
 * 同一 id 出现在多个母栏时只归第一个母栏。
 */
export function buildGroupedView(
  groups: ProjectGroup[],
  projects: ProjectSummary[],
  order: string[]
): GroupedProjects {
  const ordered = applyProjectOrder(projects ?? [], order ?? []);
  const claimed = new Set<string>();

  const view = (groups ?? []).map((group) => {
    const members = new Set<string>(group.instanceIds ?? []);
    const items: ProjectSummary[] = [];
    for (const project of ordered) {
      if (claimed.has(project.id)) continue;
      if (!members.has(project.id)) continue;
      claimed.add(project.id);
      items.push(project);
    }
    return {
      id: group.id,
      name: group.name,
      githubRepo: group.githubRepo,
      lastSeenTag: group.lastSeenTag,
      lastCheckedAt: group.lastCheckedAt,
      collapsed: group.collapsed,
      projects: items,
    };
  });

  const ungrouped = ordered.filter((project) => !claimed.has(project.id));
  return { groups: view, ungrouped };
}

/** 序列化为落盘结构 */
export function toGroupsFile(groups: ProjectGroup[]): GroupsFile {
  return { schema: 1, groups: groups ?? [] };
}
