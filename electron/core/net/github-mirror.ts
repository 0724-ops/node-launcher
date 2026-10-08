/**
 * GitHub 访问加速（沿用旧启动器的方案）。
 *
 * 规则：mirror 为空 → 原样返回；否则把完整 GitHub 地址拼在镜像前缀之后：
 *   https://gh-proxy.com/ + https://github.com/xxx/yyy/releases/download/...
 *
 * 注意：这类镜像（gh-proxy / ghproxy 等）是**文件下载代理**，只转发
 * github.com / raw.githubusercontent.com 的文件，**不代理 api.github.com**
 * —— 给它加前缀会间歇性返回 403（实测），白白等一次失败再回退直连。
 * 所以镜像只用于「文件下载」，release 列表 API 一律直连（见 fetchGithubReleases）。
 */

/** 旧工程使用的默认加速前缀 */
export const DEFAULT_GITHUB_MIRROR = 'https://gh-proxy.com/';

export function applyGithubMirror(url: string, mirror?: string): string {
  const target = String(url ?? '').trim();
  const prefix = (mirror ?? '').trim();
  if (!target || !prefix) return target;
  // 已经是镜像地址（或显式 http 镜像）时不再二次拼接
  if (target.startsWith(prefix)) return target;
  return (prefix.endsWith('/') ? prefix : `${prefix}/`) + target;
}

export interface GithubReleaseAsset {
  name: string;
  browserDownloadUrl: string;
  size: number;
}

export interface GithubRelease {
  tagName: string;
  name: string;
  body: string;
  publishedAt: string;
  assets: GithubReleaseAsset[];
}

export interface FetchReleasesOptions {
  repo: string;
  token?: string;
  log?: (msg: string) => void;
}

async function requestJson(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {
    'User-Agent': 'node-launcher',
    Accept: 'application/vnd.github.v3+json',
  };
  if (token) headers.Authorization = `token ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function mapReleases(raw: unknown): GithubRelease[] {
  // 网关返回错误对象或 HTML 时不是数组，抛错以便上层拿到明确错误
  if (!Array.isArray(raw)) throw new Error('GitHub 返回数据异常');
  return raw.map((r: any) => ({
    tagName: String(r?.tag_name ?? ''),
    name: String(r?.name || r?.tag_name || ''),
    body: String(r?.body ?? ''),
    publishedAt: String(r?.published_at ?? ''),
    assets: Array.isArray(r?.assets)
      ? r.assets.map((a: any) => ({
          name: String(a?.name ?? ''),
          browserDownloadUrl: String(a?.browser_download_url ?? ''),
          size: Number(a?.size ?? 0),
        }))
      : [],
  }));
}

/**
 * 拉取 release 列表：**始终直连** api.github.com。
 * 下载镜像不代理 API（加前缀会 403），所以这里不拼镜像前缀；
 * 拿到 browserDownloadUrl 之后的文件下载才走镜像（调用方 applyGithubMirror）。
 */
export async function fetchGithubReleases(
  opts: FetchReleasesOptions
): Promise<GithubRelease[]> {
  const url = `https://api.github.com/repos/${opts.repo}/releases`;
  opts.log?.(`拉取 release 列表（直连 api.github.com；镜像只作用于文件下载）`);
  return mapReleases(await requestJson(url, opts.token));
}
