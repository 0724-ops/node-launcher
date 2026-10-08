import net from 'net';

/** 判断端口是否可用（只做提示，不作为启动的唯一判据） */
export function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/** 从 start 开始找一个可用端口 */
export async function findFreePort(
  start: number,
  host = '127.0.0.1',
  attempts = 50
): Promise<number | null> {
  for (let i = 0; i < attempts; i += 1) {
    const port = start + i;
    if (port > 65535) break;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port, host)) return port;
  }
  return null;
}

/** TCP 探测：能连上即认为服务已监听 */
export function probeTcp(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 800
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * 解析 netstat 输出，找出某个 PID 正在 LISTEN 的端口。
 * 只用于「真实端口」展示，失败不影响运行。
 */
export function parseListeningPorts(
  netstatOutput: string,
  pids: number[]
): number[] {
  const wanted = new Set(pids);
  const ports = new Set<number>();
  for (const rawLine of netstatOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !/LISTENING/i.test(line)) continue;
    const cols = line.split(/\s+/);
    // 形如: TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  1234
    const local = cols[1];
    const pidRaw = cols[cols.length - 1];
    const pid = Number(pidRaw);
    if (!local || !Number.isFinite(pid) || !wanted.has(pid)) continue;
    const portMatch = local.match(/:(\d+)$/);
    if (portMatch) ports.add(Number(portMatch[1]));
  }
  return [...ports].sort((a, b) => a - b);
}
