import path from 'path';
import crypto from 'crypto';
import fse from 'fs-extra';

/**
 * 临时文件名：pid + 毫秒 + 随机后缀。
 * 只有 pid 和毫秒是不够的——同进程同一毫秒内的并发写会命中同一个临时文件，
 * 后写覆盖先写，move 到的内容就可能张冠李戴。随机后缀从根上避免碰撞。
 */
function tempPath(file: string): string {
  const rand = crypto.randomBytes(4).toString('hex');
  return `${file}.${process.pid}.${Date.now()}.${rand}.tmp`;
}

/**
 * 同一目标文件的写入串行队列。
 *
 * 光有唯一临时名还不够：`fse.move(..., { overwrite: true })` 的实现是
 * 「先删目标、再改名」，多个写者并发打到**同一个目标**时删除与改名会交错，
 * Windows 上直接抛 `EPERM: operation not permitted, rename`（实测复现）。
 * 按目标路径串行化之后，「删 + 改名」不会再被另一个写者打断。
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite<T>(file: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const prev = writeQueues.get(key) ?? Promise.resolve();
  // 前一次无论成功失败都要继续（失败已经通过 run 抛给各自的调用方）
  const run = prev.then(task, task);
  const settled: Promise<void> = run.then(
    () => undefined,
    () => undefined
  );
  writeQueues.set(key, settled);
  void settled.then(() => {
    // 只有后续没人接队时才清理，避免把后来者的队列丢掉
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  });
  return run;
}

/** 读取 JSON；文件不存在或内容损坏时返回 null，绝不抛错 */
export async function readJsonSafe<T>(file: string): Promise<T | null> {
  try {
    if (!(await fse.pathExists(file))) return null;
    return (await fse.readJson(file)) as T;
  } catch {
    return null;
  }
}

/** 原子写 JSON：先写临时文件再 rename，避免断电留下半截文件 */
export function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  return enqueueWrite(file, async () => {
    await fse.ensureDir(path.dirname(file));
    const tmp = tempPath(file);
    await fse.writeJson(tmp, data, { spaces: 2 });
    await fse.move(tmp, file, { overwrite: true });
  });
}

/** 原子写文本 */
export function writeTextAtomic(file: string, text: string): Promise<void> {
  return enqueueWrite(file, async () => {
    await fse.ensureDir(path.dirname(file));
    const tmp = tempPath(file);
    await fse.writeFile(tmp, text, 'utf8');
    await fse.move(tmp, file, { overwrite: true });
  });
}
