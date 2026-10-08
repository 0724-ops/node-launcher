/** 把任意 catch 到的值转成可读文案 */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const anyErr = err as { message?: unknown };
    if (typeof anyErr.message === 'string') return anyErr.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** 统一的 IPC 错误：带上稳定的 code，渲染层不必解析文案 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string = 'E_APP',
    readonly detail?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 去掉 Electron IPC 包装的 "Error invoking remote method ..." 前缀 */
export function unwrapIpcMessage(message: string): string {
  return message.replace(
    /^Error invoking remote method '[^']*':\s*(Error:\s*)?/,
    ''
  );
}
