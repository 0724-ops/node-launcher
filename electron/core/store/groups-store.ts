import path from 'path';
import type { ProjectGroup } from '../../types';
import { readJsonSafe, writeJsonAtomic } from '../util/atomic-json';
import { normalizeGroupsFile, toGroupsFile } from '../project/group-logic';

/**
 * 母栏定义的持久化：`userData/groups.json`（与 `config.json` 同级）。
 *
 * 为什么不放进 `projects/`：那个目录会被 `ProjectStore.list()` 的 `isValidId(entry)`
 * 扫描当成项目候选，塞一个 `groups.json` 进去虽然无害但语义脏；而且换「项目数据目录」
 * 时母栏定义不该被牵连搬迁。
 *
 * 所有写操作串行化：并发 IPC 下的「读-改-写」必须原子，否则后写的会整体覆盖先写的（丢更新）。
 */
export class GroupsStore {
  /** 串行队列；链上只保留已完成态，单次失败不会卡死后续写入 */
  private queue: Promise<ProjectGroup[]> = Promise.resolve([]);

  constructor(private readonly dataDir: string) {}

  get file(): string {
    return path.join(this.dataDir, 'groups.json');
  }

  /**
   * 读一次磁盘并归一化。
   * 不做内存缓存：`groups.json` 很小，读取代价可以忽略；缓存反而会引入陈旧副本
   * （多个写入者时极易出现「以为是最新、其实已经落后」的 bug）。
   */
  async load(knownProjectIds: string[]): Promise<ProjectGroup[]> {
    const raw = await readJsonSafe<unknown>(this.file);
    return normalizeGroupsFile(raw, knownProjectIds);
  }

  /**
   * 串行化的读-改-写：`fn` 拿到的是**刚从磁盘读出来的**最新状态，因此并发调用不丢更新。
   * 落盘前统一归一化（清掉已不存在的项目 id、名字超长、跨母栏重复等），
   * 保证脏数据不会在文件里越积越多。返回落盘后的最新状态。
   */
  async mutate(
    knownProjectIds: string[],
    fn: (groups: ProjectGroup[]) => ProjectGroup[]
  ): Promise<ProjectGroup[]> {
    const run = this.queue.then(async () => {
      const current = await this.load(knownProjectIds);
      const next = normalizeGroupsFile(toGroupsFile(fn(current)), knownProjectIds);
      await writeJsonAtomic(this.file, toGroupsFile(next));
      return next;
    });
    // 错误照样抛给调用方，但队列本身必须继续可用
    this.queue = run.catch(() => [] as ProjectGroup[]);
    return run;
  }
}
