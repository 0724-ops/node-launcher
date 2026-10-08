/**
 * GitHub release 解析与筛选。
 *
 * 只做纯计算（资产挑选、版本比较、检查结果组装），网络请求全部复用在
 * `github-mirror` 里，测试可通过 `fetchReleases` 注入桩函数，避免真实联网。
 */

import {
  fetchGithubReleases,
  type GithubRelease,
  type GithubReleaseAsset,
} from './github-mirror';
import type { GroupReleaseCheck, ReleaseAssetOption, ReleaseVersionOption } from '../../types';

/** 拉取 release 列表的实现（便于测试注入） */
type FetchReleases = typeof fetchGithubReleases;

/** 需要排除的资产后缀：安装器/校验文件等，不适合直接作为 Node 运行时包 */
const EXCLUDED_EXT =
  /\.(tar\.gz|tar\.xz|tgz|deb|rpm|dmg|appimage|exe|msi|blockmap|yml|yaml|json|txt|sha256|sig|asc|7z|apk|jar)$/i;

/** 首选资产特征：Windows 平台 */
const PREFERRED_INCLUDE = /(win|windows|x64|amd64)/i;

/** 首选资产排除特征：其它平台/架构 */
const PREFERRED_EXCLUDE =
  /(linux|macos|darwin|osx|arm64|armv7|aarch64|android|ios)/i;

/**
 * 是否是 GitHub 自动生成的源码包。
 * 兼容 `Source code (zip)` / `Source code (tar.gz)` 以及压缩后的 `sourcecode.zip`。
 */
export function isSourceArchive(name: string): boolean {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return false;
  return (
    n === 'source code (zip)' ||
    n === 'source code (tar.gz)' ||
    n === 'sourcecode.zip' ||
    n === 'sourcecode.tar.gz'
  );
}

/** 结尾的括号段，如 `(tar.gz)` / `(zip)` */
const PAREN_TAIL = /\(([^()]*)\)\s*$/;

/**
 * 判断资产名是否命中排除后缀。
 *
 * GitHub 自动生成的源码包名形如 `Source code (tar.gz)`：这里**没有** `.tar.gz` 这个后缀
 * （`tar` 前面没有点），直接跑后缀正则永远匹配不到，所以要把括号里那段当成扩展名再判一次。
 * 于是 `Source code (tar.gz)` 被排除，而 `Source code (zip)` 保留（`.zip` 不在排除表里）。
 */
function isExcludedName(name: string): boolean {
  if (EXCLUDED_EXT.test(name)) return true;
  const tail = PAREN_TAIL.exec(name);
  if (!tail) return false;
  return EXCLUDED_EXT.test(`x.${tail[1]}`);
}

function toOption(asset: GithubReleaseAsset): ReleaseAssetOption {
  const name = String(asset?.name ?? '');
  return {
    name,
    size: Number(asset?.size ?? 0),
    url: String(asset?.browserDownloadUrl ?? ''),
    sourceArchive: isSourceArchive(name),
  };
}

/**
 * 从 release 资产里挑出可下载项。
 * 候选 = `.zip` 或源码包，排除安装器/校验文件；Windows 包优先，唯一时作为 auto。
 */
export function pickReleaseAssets(release: GithubRelease): {
  auto: ReleaseAssetOption | null;
  options: ReleaseAssetOption[];
} {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const seen = new Set<string>();
  const candidates: GithubReleaseAsset[] = [];
  for (const asset of assets) {
    const name = String(asset?.name ?? '');
    if (!name) continue;
    // 按名字去重，避免同一资产重复出现在选项里
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (!isSourceArchive(name) && !/\.zip$/i.test(name)) continue;
    if (isExcludedName(name)) continue;
    seen.add(key);
    candidates.push(asset);
  }

  const preferred = candidates.filter((asset) => {
    const name = String(asset?.name ?? '');
    return (
      !isSourceArchive(name) &&
      PREFERRED_INCLUDE.test(name) &&
      !PREFERRED_EXCLUDE.test(name)
    );
  });
  const preferredSet = new Set(preferred);
  const ordered = [...preferred, ...candidates.filter((a) => !preferredSet.has(a))];

  let auto: ReleaseAssetOption | null = null;
  if (preferred.length === 1) auto = toOption(preferred[0]);
  else if (preferred.length === 0 && candidates.length === 1) {
    auto = toOption(candidates[0]);
  }
  return { auto, options: ordered.map(toOption) };
}

/** 拆出版本号：前 3 段数字 + 预发布后缀（`-` 之后的部分） */
function splitVersion(raw: string): { core: number[]; prerelease: string | null } {
  const text = String(raw ?? '').trim().replace(/^[vV]/, '');
  const dash = text.indexOf('-');
  const coreText = dash >= 0 ? text.slice(0, dash) : text;
  const prerelease = dash >= 0 ? text.slice(dash + 1) : null;
  const parts = coreText.split('.');
  const core: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    // 缺失段与非数字段一律按 0 处理；数字段取前导数字
    const value = Number.parseInt(parts[i] ?? '', 10);
    core.push(Number.isFinite(value) ? value : 0);
  }
  return { core, prerelease };
}

/** 比较版本号：负数 / 0 / 正数；预发布版本低于同版本正式版 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  const lp = left.prerelease;
  const rp = right.prerelease;
  if (lp === rp) return 0;
  // 正式版高于同版本号的预发布版
  if (lp === null) return 1;
  if (rp === null) return -1;
  return lp < rp ? -1 : 1;
}

/** latest 是否比 current 新；current 为空时视为「无法比较」返回 false */
export function isNewerTag(latest: string, current: string): boolean {
  if (!String(current ?? '').trim()) return false;
  return compareVersions(latest, current) > 0;
}

/** 把某个 release 映射成一个可选的版本项（含该版本的可下载资产） */
function toVersionOption(release: GithubRelease): ReleaseVersionOption {
  const { auto, options } = pickReleaseAssets(release);
  return {
    tag: String(release?.tagName ?? ''),
    name: String(release?.name ?? ''),
    publishedAt: String(release?.publishedAt ?? ''),
    auto,
    options,
  };
}

/** 组装一次 release 检查结果（纯计算，不联网） */
export function buildReleaseCheck(
  release: GithubRelease,
  currentTag: string,
  releases: GithubRelease[] = [release]
): GroupReleaseCheck {
  const current = String(currentTag ?? '');
  const firstCheck = !current.trim();
  const { auto, options } = pickReleaseAssets(release);
  return {
    hasUpdate: !firstCheck && isNewerTag(String(release?.tagName ?? ''), current),
    firstCheck,
    latestTag: String(release?.tagName ?? ''),
    currentTag: current,
    releaseName: String(release?.name ?? ''),
    releaseBody: String(release?.body ?? ''),
    publishedAt: String(release?.publishedAt ?? ''),
    auto,
    options,
    releases: releases.map(toVersionOption),
  };
}

/** release 列表按版本号降序（版本号相等时回退到发布时间），供 UI 展示全部版本 */
export function sortReleases(list: GithubRelease[]): GithubRelease[] {
  return [...list].sort((a, b) => {
    const cmp = compareVersions(String(b?.tagName ?? ''), String(a?.tagName ?? ''));
    if (cmp !== 0) return cmp;
    return String(b?.publishedAt ?? '').localeCompare(String(a?.publishedAt ?? ''));
  });
}

/** 取最新 release：先按 tag 版本号，版本号相等时回退到发布时间 */
function pickNewest(list: GithubRelease[]): GithubRelease {
  return sortReleases(list)[0];
}

/** 拉取并检查指定仓库的 release（返回全部版本供选择） */
export async function fetchReleaseCheck(opts: {
  repo: string;
  token?: string;
  currentTag?: string;
  log?: (msg: string) => void;
  fetchReleases?: FetchReleases;
}): Promise<GroupReleaseCheck> {
  const fetchReleases = opts.fetchReleases ?? fetchGithubReleases;
  const list = await fetchReleases({
    repo: opts.repo,
    token: opts.token,
    log: opts.log,
  });
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('仓库没有任何 release');
  }
  const sorted = sortReleases(list);
  return buildReleaseCheck(sorted[0], opts.currentTag ?? '', sorted);
}

/** 定位指定 tag（缺省为最新）下的某个具体资产 */
export async function resolveAsset(opts: {
  repo: string;
  token?: string;
  tag?: string;
  assetName: string;
  log?: (msg: string) => void;
  fetchReleases?: FetchReleases;
}): Promise<{ release: GithubRelease; asset: GithubReleaseAsset }> {
  const fetchReleases = opts.fetchReleases ?? fetchGithubReleases;
  const list = await fetchReleases({
    repo: opts.repo,
    token: opts.token,
    log: opts.log,
  });
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('仓库没有任何 release');
  }
  const release = opts.tag
    ? list.find((item) => String(item?.tagName ?? '') === opts.tag)
    : pickNewest(list);
  const tag = opts.tag ?? String(release?.tagName ?? '');
  const asset = release?.assets?.find(
    (item) => String(item?.name ?? '') === opts.assetName
  );
  if (!release || !asset) {
    throw new Error(`release ${tag} 中找不到资产「${opts.assetName}」`);
  }
  return { release, asset };
}
