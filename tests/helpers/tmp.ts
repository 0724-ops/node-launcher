import fse from 'fs-extra';
import path from 'path';

// 每个测试文件跑在独立的 worker 进程里：按 pid 分目录，
// 避免某个文件 afterAll 清理时删掉其它文件正在使用的临时目录（并行竞态）。
const ROOT = path.join(process.cwd(), '.test-tmp', 'work', String(process.pid));

export async function makeTmpDir(name: string): Promise<string> {
  await fse.ensureDir(ROOT);
  return fse.mkdtemp(path.join(ROOT, `${name}-`));
}

export async function cleanupTmpRoot(): Promise<void> {
  await fse.remove(ROOT).catch(() => {});
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fse.ensureDir(path.dirname(file));
  await fse.writeJson(file, data, { spaces: 2 });
}
