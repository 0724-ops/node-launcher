import { describe, expect, it, vi } from 'vitest';

import { fetchGithubReleases, type GithubRelease } from '../electron/core/net/github-mirror';
import {
  buildReleaseCheck,
  compareVersions,
  fetchReleaseCheck,
  isNewerTag,
  isSourceArchive,
  pickReleaseAssets,
  resolveAsset,
  sortReleases,
} from '../electron/core/net/github-release';

/** 构造 release 固定数据 */
function rel(
  tag: string,
  assets: Array<[string, number]>,
  publishedAt = '2026-01-01T00:00:00Z'
): GithubRelease {
  return {
    tagName: tag,
    name: tag,
    body: '',
    publishedAt,
    assets: assets.map(([name, size]) => ({
      name,
      size,
      browserDownloadUrl: `https://example.com/${name}`,
    })),
  };
}

/** 注入用的桩函数：不联网，直接返回给定列表 */
function stubReleases(list: GithubRelease[]): typeof fetchGithubReleases {
  return vi.fn(async () => list);
}

describe('isSourceArchive', () => {
  it('识别 GitHub 自动生成的源码包名（忽略大小写），普通资产返回 false', () => {
    expect(isSourceArchive('Source code (zip)')).toBe(true);
    expect(isSourceArchive('Source code (tar.gz)')).toBe(true);
    expect(isSourceArchive('SOURCE CODE (ZIP)')).toBe(true);
    expect(isSourceArchive('sourcecode.zip')).toBe(true);
    expect(isSourceArchive('sourcecode.tar.gz')).toBe(true);
    expect(isSourceArchive('app.zip')).toBe(false);
    expect(isSourceArchive('source-code.zip')).toBe(false);
    expect(isSourceArchive('')).toBe(false);
  });
});

describe('pickReleaseAssets', () => {
  it('唯一的 Windows zip 直接作为 auto，并映射字段', () => {
    const { auto, options } = pickReleaseAssets(rel('v1.0.0', [['app-win-x64.zip', 123]]));
    expect(auto).toEqual({
      name: 'app-win-x64.zip',
      size: 123,
      url: 'https://example.com/app-win-x64.zip',
      sourceArchive: false,
    });
    expect(options).toEqual([auto]);
  });

  it('只有源码包时也作为 auto，并标记 sourceArchive', () => {
    const { auto, options } = pickReleaseAssets(rel('v1.0.0', [['Source code (zip)', 456]]));
    expect(auto?.name).toBe('Source code (zip)');
    expect(auto?.sourceArchive).toBe(true);
    expect(options).toHaveLength(1);
  });

  it('Windows 包与其它平台包并存时，auto 取 Windows 包且排在首位', () => {
    const { auto, options } = pickReleaseAssets(
      rel('v1.0.0', [
        ['app-linux-x64.zip', 1],
        ['app-win-x64.zip', 2],
      ])
    );
    expect(auto?.name).toBe('app-win-x64.zip');
    expect(options.map((o) => o.name)).toEqual(['app-win-x64.zip', 'app-linux-x64.zip']);
  });

  it('多个 Windows 首选包时 auto 为 null，options 首选在前且不重复', () => {
    const { auto, options } = pickReleaseAssets(
      rel('v1.0.0', [
        ['app-windows-x64.zip', 1],
        ['app-linux-x64.zip', 2],
        ['app-win-x64.zip', 3],
      ])
    );
    expect(auto).toBeNull();
    expect(options.map((o) => o.name)).toEqual([
      'app-windows-x64.zip',
      'app-win-x64.zip',
      'app-linux-x64.zip',
    ]);
  });

  it('只有被排除的后缀时没有任何选项', () => {
    const { auto, options } = pickReleaseAssets(
      rel('v1.0.0', [
        ['app-setup.exe', 1],
        ['app.msi', 2],
        ['app.zip.blockmap', 3],
        ['latest.yml', 4],
        ['src.tar.gz', 5],
      ])
    );
    expect(auto).toBeNull();
    expect(options).toEqual([]);
  });

  it('源码包只保留 zip，(tar.gz) 被排除', () => {
    const { options } = pickReleaseAssets(
      rel('v1.0.0', [
        ['Source code (tar.gz)', 1],
        ['Source code (zip)', 2],
      ])
    );
    expect(options.map((o) => o.name)).toEqual(['Source code (zip)']);
  });

  it('assets 缺失或为空时不抛错', () => {
    expect(pickReleaseAssets(rel('v1.0.0', []))).toEqual({ auto: null, options: [] });
    const broken = { ...rel('v1.0.0', []), assets: undefined } as unknown as GithubRelease;
    expect(pickReleaseAssets(broken)).toEqual({ auto: null, options: [] });
  });
});

describe('compareVersions', () => {
  it('按数字段比较，v 前缀不影响结果', () => {
    expect(compareVersions('v1.2.10', 'v1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.9', 'v1.2.10')).toBeLessThan(0);
    expect(compareVersions('v2.0.0', 'v1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });

  it('缺失段与非数字段都按 0 容忍', () => {
    expect(compareVersions('v1.2', 'v1.2.0')).toBe(0);
    expect(compareVersions('v1', 'v1.0.1')).toBeLessThan(0);
    expect(compareVersions('v1.x.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('vabc', 'v0.0.0')).toBe(0);
  });

  it('预发布低于同版本正式版，两个预发布按后缀字符串比较', () => {
    expect(compareVersions('v1.0.0-beta.1', 'v1.0.0')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', 'v1.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0-beta.2', 'v1.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('v2.0.0-rc.1', 'v1.9.0')).toBeGreaterThan(0);
  });
});

describe('isNewerTag', () => {
  it('新版本为 true，相同/更旧/空 current 为 false', () => {
    expect(isNewerTag('v1.2.0', 'v1.1.0')).toBe(true);
    expect(isNewerTag('v1.2.0', 'v1.2.0')).toBe(false);
    expect(isNewerTag('v1.0.0', 'v1.2.0')).toBe(false);
    expect(isNewerTag('v1.2.0', '')).toBe(false);
    expect(isNewerTag('v1.2.0', '   ')).toBe(false);
  });
});

describe('buildReleaseCheck', () => {
  it('首次检查只记录，不谎报有新版本', () => {
    const check = buildReleaseCheck(rel('v1.2.0', [['app-win-x64.zip', 1]]), '');
    expect(check.firstCheck).toBe(true);
    expect(check.hasUpdate).toBe(false);
    expect(check.latestTag).toBe('v1.2.0');
    expect(check.currentTag).toBe('');
  });

  it('有 currentTag 时正确判断更新，并复制 release 元数据', () => {
    const release: GithubRelease = {
      ...rel('v1.2.0', [['app-win-x64.zip', 10]]),
      name: '1.2.0 正式版',
      body: '更新说明',
      publishedAt: '2026-02-01T00:00:00Z',
    };
    const check = buildReleaseCheck(release, 'v1.1.0');
    expect(check.hasUpdate).toBe(true);
    expect(check.firstCheck).toBe(false);
    expect(check.currentTag).toBe('v1.1.0');
    expect(check.releaseName).toBe('1.2.0 正式版');
    expect(check.releaseBody).toBe('更新说明');
    expect(check.publishedAt).toBe('2026-02-01T00:00:00Z');
    expect(check.auto?.name).toBe('app-win-x64.zip');
    expect(check.options).toHaveLength(1);
    expect(buildReleaseCheck(release, 'v1.2.0').hasUpdate).toBe(false);
  });
});

describe('fetchReleaseCheck', () => {
  it('列表未排序时按 tag 取最新，并把参数透传给拉取函数', async () => {
    const stub = stubReleases([
      rel('v1.0.0', [], '2026-01-01T00:00:00Z'),
      rel('v1.3.0', [], '2026-01-02T00:00:00Z'),
      rel('v1.2.0', [], '2026-01-03T00:00:00Z'),
    ]);
    const check = await fetchReleaseCheck({
      repo: 'o/r',
      token: 't',
      currentTag: 'v1.2.0',
      fetchReleases: stub,
    });
    expect(check.latestTag).toBe('v1.3.0');
    expect(check.hasUpdate).toBe(true);
    expect(stub).toHaveBeenCalledWith({
      repo: 'o/r',
      token: 't',
      log: undefined,
    });
  });

  it('tag 版本号相同时回退按发布时间取最新', async () => {
    const stub = stubReleases([
      rel('v1.0.0', [], '2026-01-01T00:00:00Z'),
      rel('1.0.0', [], '2026-03-01T00:00:00Z'),
    ]);
    const check = await fetchReleaseCheck({ repo: 'o/r', fetchReleases: stub });
    expect(check.latestTag).toBe('1.0.0');
    expect(check.currentTag).toBe('');
  });

  it('空列表抛错', async () => {
    await expect(
      fetchReleaseCheck({ repo: 'o/r', fetchReleases: stubReleases([]) })
    ).rejects.toThrow('仓库没有任何 release');
  });
});

describe('全部版本', () => {
  it('sortReleases 按版本号降序，版本号相同时按发布时间降序', () => {
    const list = [
      rel('v1.0.0', [], '2026-01-01T00:00:00Z'),
      rel('v1.3.0', [], '2026-01-02T00:00:00Z'),
      rel('v1.2.0', [], '2026-01-03T00:00:00Z'),
      rel('1.1.0', [], '2026-02-01T00:00:00Z'),
    ];
    expect(sortReleases(list).map((r) => r.tagName)).toEqual([
      'v1.3.0',
      'v1.2.0',
      '1.1.0',
      'v1.0.0',
    ]);
  });

  it('buildReleaseCheck 缺省只带当前这一个版本', () => {
    const check = buildReleaseCheck(rel('v1.2.0', [['app-win-x64.zip', 1]]), 'v1.0.0');
    expect(check.releases.map((v) => v.tag)).toEqual(['v1.2.0']);
    expect(check.releases[0].options.map((o) => o.name)).toEqual(['app-win-x64.zip']);
    expect(check.releases[0].auto?.name).toBe('app-win-x64.zip');
  });

  it('fetchReleaseCheck 返回全部版本（降序）及各版本自己的资产', async () => {
    const stub = stubReleases([
      rel('v1.0.0', [['app-win-x64.zip', 1]], '2026-01-01T00:00:00Z'),
      rel('v1.3.0', [['app-win-x64.zip', 3]], '2026-01-02T00:00:00Z'),
      rel('v1.2.0', [['app-linux-x64.zip', 2]], '2026-01-03T00:00:00Z'),
    ]);
    const check = await fetchReleaseCheck({ repo: 'o/r', currentTag: 'v1.2.0', fetchReleases: stub });

    expect(check.latestTag).toBe('v1.3.0');
    expect(check.hasUpdate).toBe(true);
    expect(check.releases.map((v) => v.tag)).toEqual(['v1.3.0', 'v1.2.0', 'v1.0.0']);
    // 每个版本带的是它自己的资产，而不是最新版那一套
    expect(check.releases[1].options.map((o) => o.name)).toEqual(['app-linux-x64.zip']);
    expect(check.releases[1].publishedAt).toBe('2026-01-03T00:00:00Z');
  });
});

describe('resolveAsset', () => {
  const list = () => [
    rel('v1.0.0', [['app-win-x64.zip', 1]]),
    rel('v2.0.0', [
      ['app-win-x64.zip', 2],
      ['extra.zip', 3],
    ]),
  ];

  it('指定 tag 时返回该 tag 的 release 与资产，缺省时取最新', async () => {
    const found = await resolveAsset({
      repo: 'o/r',
      tag: 'v1.0.0',
      assetName: 'app-win-x64.zip',
      fetchReleases: stubReleases(list()),
    });
    expect(found.release.tagName).toBe('v1.0.0');
    expect(found.asset.name).toBe('app-win-x64.zip');
    expect(found.asset.size).toBe(1);

    const latest = await resolveAsset({
      repo: 'o/r',
      assetName: 'extra.zip',
      fetchReleases: stubReleases(list()),
    });
    expect(latest.release.tagName).toBe('v2.0.0');
    expect(latest.asset.browserDownloadUrl).toBe('https://example.com/extra.zip');
  });

  it('资产不存在时抛错，错误信息带上 tag 与资产名', async () => {
    await expect(
      resolveAsset({
        repo: 'o/r',
        tag: 'v1.0.0',
        assetName: 'nope.zip',
        fetchReleases: stubReleases(list()),
      })
    ).rejects.toThrow('release v1.0.0 中找不到资产「nope.zip」');
  });

  it('空列表抛错', async () => {
    await expect(
      resolveAsset({ repo: 'o/r', assetName: 'a.zip', fetchReleases: stubReleases([]) })
    ).rejects.toThrow('仓库没有任何 release');
  });
});
