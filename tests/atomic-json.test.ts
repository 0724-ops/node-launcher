import fse from 'fs-extra';
import path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  readJsonSafe,
  writeJsonAtomic,
  writeTextAtomic,
} from '../electron/core/util/atomic-json';
import { cleanupTmpRoot, makeTmpDir } from './helpers/tmp';

afterAll(cleanupTmpRoot);

function tmpFiles(names: string[]): string[] {
  return names.filter((n) => n.endsWith('.tmp'));
}

describe('atomic-json', () => {
  it('写入后可读回，且目录不存在会自动创建', async () => {
    const dir = await makeTmpDir('atomic');
    const file = path.join(dir, 'nested', 'deep', 'config.json');
    await writeJsonAtomic(file, { a: 1, zh: '中文' });
    expect(await readJsonSafe(file)).toEqual({ a: 1, zh: '中文' });
  });

  it('文件不存在 / JSON 损坏都返回 null，绝不抛错', async () => {
    const dir = await makeTmpDir('atomic');
    expect(await readJsonSafe(path.join(dir, 'none.json'))).toBeNull();

    const bad = path.join(dir, 'bad.json');
    await fse.writeFile(bad, '{ 这不是 JSON');
    expect(await readJsonSafe(bad)).toBeNull();
  });

  it('并发写同一文件：结果是某一次的完整内容，且不残留 .tmp', async () => {
    const dir = await makeTmpDir('atomic');
    const file = path.join(dir, 'config.json');
    // 把时钟钉死在同一毫秒：只带 pid + 毫秒的旧命名会让所有并发写共用同一个临时文件
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const payloads = Array.from({ length: 8 }, (_, i) => ({
        seq: i,
        pad: 'x'.repeat(i * 400),
      }));
      await Promise.all(payloads.map((p) => writeJsonAtomic(file, p)));

      const final = await readJsonSafe<{ seq: number }>(file);
      expect(final).not.toBeNull();
      expect(payloads).toContainEqual(final);
      expect(tmpFiles(await fse.readdir(dir))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('writeTextAtomic 同样原子且不留临时文件', async () => {
    const dir = await makeTmpDir('atomic');
    const file = path.join(dir, 'notes.txt');
    await writeTextAtomic(file, '你好');
    expect(await fse.readFile(file, 'utf8')).toBe('你好');
    expect(tmpFiles(await fse.readdir(dir))).toEqual([]);
  });
});
