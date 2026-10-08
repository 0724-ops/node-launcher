/**
 * 性能上报脚本。
 *
 * 启动器通过 NODE_OPTIONS=--require 把它注入到被启动的 Node 进程，
 * 该进程每 3 秒通过 IPC（process.send）上报 CPU 与内存占用。
 * 相比外部轮询，不会额外拉起 PowerShell/WMIC 进程。
 *
 * 注意：编译产物为 dist-electron/core/launch/metrics-reporter.js，
 * 打包时通过 asarUnpack 解包，以保证能被真实文件路径 require。
 */

const REPORT_INTERVAL = 3000;

let lastCpu = process.cpuUsage();
let lastTime = Date.now();

function report(): void {
  if (typeof process.send !== 'function') return;
  try {
    const now = Date.now();
    const diff = process.cpuUsage(lastCpu);
    const elapsedMs = now - lastTime;
    lastCpu = process.cpuUsage();
    lastTime = now;

    const cpu =
      elapsedMs > 0 ? ((diff.user + diff.system) / 1000 / elapsedMs) * 100 : 0;
    const memoryMb = process.memoryUsage().rss / 1024 / 1024;

    process.send({
      type: 'metrics',
      cpu: Math.round(cpu * 10) / 10,
      memory: Math.round(memoryMb * 10) / 10,
    });
  } catch {
    // 上报失败静默忽略，绝不影响被注入的进程
  }
}

const timer = setInterval(report, REPORT_INTERVAL);
if (typeof timer.unref === 'function') timer.unref();

export {};
