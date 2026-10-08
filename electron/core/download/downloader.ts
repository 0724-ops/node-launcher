import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import fse from 'fs-extra';
import { toMessage } from '../util/errors';

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}

export interface DownloadOptions {
  url: string;
  dest: string;
  /** 重定向上限，默认 5 */
  maxRedirects?: number;
  /** 空闲（无数据）超时，默认 60s */
  idleTimeoutMs?: number;
  expectedSha256?: string;
  /** 允许 http:// （仅当用户显式配置了 http 镜像时由调用方置 true） */
  allowInsecure?: boolean;
  onProgress?: (p: DownloadProgress) => void;
  isCancelled?: () => boolean;
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
  finalUrl: string;
}

class CancelledError extends Error {
  constructor() {
    super('下载已取消');
    this.name = 'CancelledError';
  }
}

/**
 * 下载器（重写版）：
 *  - 默认只允许 https（除非调用方显式 allowInsecure）
 *  - 限制重定向次数、空闲超时
 *  - content-length 校验、可选 sha256 校验
 *  - 失败/取消时清理半成品
 */
export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60000;

  await fse.ensureDir(path.dirname(opts.dest));
  const partPath = `${opts.dest}.part`;

  const cleanup = async (): Promise<void> => {
    await fse.remove(partPath).catch(() => {});
  };

  const run = (url: string, redirectsLeft: number): Promise<DownloadResult> =>
    new Promise<DownloadResult>((resolve, reject) => {
      if (opts.isCancelled?.()) {
        reject(new CancelledError());
        return;
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        reject(new Error(`非法下载地址: ${url}`));
        return;
      }
      if (parsed.protocol !== 'https:' && !opts.allowInsecure) {
        reject(new Error(`出于安全考虑拒绝非 https 下载: ${url}`));
        return;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        reject(new Error(`不支持的协议: ${parsed.protocol}`));
        return;
      }

      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.get(
        parsed,
        { headers: { 'User-Agent': 'node-launcher', Accept: '*/*' } },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;

          if (status >= 300 && status < 400 && location) {
            res.resume();
            if (redirectsLeft <= 0) {
              reject(new Error('重定向次数过多'));
              return;
            }
            const next = new URL(location, parsed).toString();
            resolve(run(next, redirectsLeft - 1));
            return;
          }

          if (status !== 200) {
            res.resume();
            reject(new Error(`HTTP ${status}`));
            return;
          }

          const total = Number(res.headers['content-length'] ?? 0) || 0;
          let downloaded = 0;
          const hash = crypto.createHash('sha256');
          const file = fs.createWriteStream(partPath);

          const fail = (err: unknown): void => {
            try {
              file.destroy();
            } catch {
              /* ignore */
            }
            void cleanup().finally(() => reject(err instanceof Error ? err : new Error(toMessage(err))));
          };

          res.on('data', (chunk: Buffer) => {
            if (opts.isCancelled?.()) {
              req.destroy();
              fail(new CancelledError());
              return;
            }
            downloaded += chunk.length;
            hash.update(chunk);
            file.write(chunk);
            opts.onProgress?.({
              downloaded,
              total,
              percent: total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0,
            });
          });

          res.on('error', fail);

          res.on('end', () => {
            file.end(() => {
              void (async () => {
                try {
                  if (total > 0 && downloaded !== total) {
                    throw new Error(`下载不完整：${downloaded}/${total} 字节`);
                  }
                  const sha256 = hash.digest('hex');
                  if (opts.expectedSha256 && sha256.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
                    throw new Error('校验和不匹配，文件可能损坏或被篡改');
                  }
                  await fse.move(partPath, opts.dest, { overwrite: true });
                  resolve({ bytes: downloaded, sha256, finalUrl: parsed.toString() });
                } catch (err) {
                  await cleanup();
                  reject(err instanceof Error ? err : new Error(toMessage(err)));
                }
              })();
            });
          });

          file.on('error', fail);
        }
      );

      req.setTimeout(idleTimeoutMs, () => {
        req.destroy(new Error(`下载超时（${idleTimeoutMs / 1000}s 无数据）`));
      });

      req.on('error', (err) => {
        void cleanup().finally(() => reject(err));
      });
    });

  return run(opts.url, maxRedirects);
}

/** 供调用方判断是否为「用户取消」 */
export function isCancelledError(err: unknown): boolean {
  return err instanceof CancelledError || (err as Error)?.name === 'CancelledError';
}
