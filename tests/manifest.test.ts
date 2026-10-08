import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  defaultManifest,
  normalizeManifest,
  validateManifest,
} from '../electron/core/store/manifest';

const base = {
  id: 'p1',
  name: 'demo',
  rootDir: 'D:\\proj\\demo',
  source: 'linked',
  startMode: 'node',
  entry: 'server.js',
  portMode: 'inject',
  autoInstallDeps: 'ask',
  allowInstallScripts: false,
  restartPolicy: { mode: 'never', maxRetries: 3, backoffMs: 2000 },
  singleton: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('normalizeManifest', () => {
  it('为缺失字段补默认值（读取容错）', () => {
    const m = normalizeManifest({ id: 'a1', name: 'x', rootDir: 'D:\\x' });
    expect(m).not.toBeNull();
    expect(m!.startMode).toBe('node');
    expect(m!.portMode).toBe('inject');
    expect(m!.autoInstallDeps).toBe('ask');
    expect(m!.allowInstallScripts).toBe(false);
    expect(m!.singleton).toBe(true);
    expect(m!.restartPolicy).toEqual({ mode: 'never', maxRetries: 3, backoffMs: 2000 });
  });

  it('拒绝非法 ID，但可用目录名兜底', () => {
    expect(normalizeManifest({ id: '../evil', rootDir: 'D:\\x' })).toBeNull();
    expect(normalizeManifest({ id: 'nope/../..', rootDir: 'D:\\x' }, 'real-id')!.id).toBe('real-id');
  });

  it('缺少 rootDir 直接判定为损坏', () => {
    expect(normalizeManifest({ id: 'ok', name: 'x' })).toBeNull();
  });

  it('丢弃非法的正则与非法地址', () => {
    const m = normalizeManifest({
      ...base,
      readyPattern: '([unclosed',
      healthUrl: 'ftp://nope',
    });
    expect(m!.readyPattern).toBeUndefined();
    expect(m!.healthUrl).toBeUndefined();
  });

  it('端口越界时丢弃并回落', () => {
    expect(normalizeManifest({ ...base, port: 70000 })!.port).toBeUndefined();
    expect(normalizeManifest({ ...base, port: 3000 })!.port).toBe(3000);
  });

  it('环境变量按 KEY 规则过滤', () => {
    const m = normalizeManifest({ ...base, env: { OK: '1', 'bad key': '2', '3BAD': '3' } });
    expect(m!.env).toEqual({ OK: '1' });
  });

  it('node 模式保留 args，command 模式忽略 args', () => {
    expect(normalizeManifest({ ...base, args: ['--x'] })!.args).toEqual(['--x']);
    const cmd = normalizeManifest({ ...base, startMode: 'command', command: 'npm start', args: ['--x'] });
    expect(cmd!.args).toBeUndefined();
  });
});

describe('validateManifest', () => {
  it('两种模式的必填字段各自校验', () => {
    const m = normalizeManifest(base)!;
    expect(validateManifest(m)).toEqual([]);
    expect(validateManifest({ ...m, entry: '' })).toContain('Node 直启模式必须填写入口文件');

    const cmd = normalizeManifest({ ...base, startMode: 'command', command: 'npm start' })!;
    expect(validateManifest(cmd)).toEqual([]);
    expect(validateManifest({ ...cmd, command: '  ' })).toContain('自定义命令模式必须填写命令');
  });
});

describe('applyPatch 切换启动模式时清理矛盾字段', () => {
  it('node → command 清掉 entry/args', () => {
    const current = normalizeManifest({ ...base, args: ['--a'] })!;
    const next = applyPatch(current, { startMode: 'command', command: 'npm run dev' });
    expect(next.command).toBe('npm run dev');
    expect(next.entry).toBeUndefined();
    expect(next.args).toBeUndefined();
  });

  it('command → node 清掉 command', () => {
    const current = normalizeManifest({ ...base, startMode: 'command', command: 'npm start' })!;
    const next = applyPatch(current, { startMode: 'node', entry: 'index.js' });
    expect(next.entry).toBe('index.js');
    expect(next.command).toBeUndefined();
  });

  it('非法补丁抛错（不写入坏配置）', () => {
    const current = normalizeManifest(base)!;
    expect(() => applyPatch(current, { name: '' })).not.toThrow();
    expect(() => applyPatch(current, { startMode: 'node', entry: '' })).toThrow();
  });
});

describe('defaultManifest', () => {
  it('携带配置默认值且通过校验', () => {
    const m = defaultManifest({
      id: 'new-1',
      name: 'demo',
      rootDir: 'D:\\demo',
      source: 'linked',
      defaults: { portMode: 'display', port: 4000, autoInstallDeps: 'always' },
    });
    expect(m.port).toBe(4000);
    expect(m.portMode).toBe('display');
    expect(m.autoInstallDeps).toBe('always');
    expect(validateManifest(m)).toEqual([]);
  });
});
