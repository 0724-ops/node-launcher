declare module 'pidusage' {
  export interface PidStat {
    cpu: number;
    memory: number;
    ppid: number;
    pid: number;
    ctime: number;
    elapsed: number;
    timestamp: number;
  }

  function pidusage(
    pids: number | number[],
    options?: { maxage?: number }
  ): Promise<PidStat | Record<string, PidStat>>;

  export = pidusage;
}
