import { describe, expect, it } from 'vitest';
import path from 'path';
import { isValidId, newProjectId, sanitizeId } from '../electron/core/util/ids';
import { isInside, resolveInside } from '../electron/core/util/paths';
import { redactEnv, redactSecrets } from '../electron/core/util/redact';
import { parseEnvFile } from '../electron/core/util/env-file';
import { collectDescendants, parseProcessList } from '../electron/core/launch/process-tree';
import { parseListeningPorts } from '../electron/core/net/ports';

describe('ids', () => {
  it('白名单校验', () => {
    expect(isValidId('p-1')).toBe(true);
    expect(isValidId('a'.repeat(64))).toBe(true);
    expect(isValidId('a'.repeat(65))).toBe(false);
    expect(isValidId('../evil')).toBe(false);
    expect(isValidId('.hidden')).toBe(false);
    expect(isValidId('has space')).toBe(false);
    expect(isValidId('')).toBe(false);
  });

  it('清洗外部字符串（release tag / zip 名）', () => {
    expect(sanitizeId('v1.2.3-beta')).toBe('v1.2.3-beta');
    expect(sanitizeId('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeId('a/b\\c')).toBe('a-b-c');
    expect(sanitizeId('!!!')).toBe('project');
    expect(sanitizeId('', 'fb')).toBe('fb');
  });

  it('生成的 ID 合法且唯一', () => {
    const a = newProjectId();
    const b = newProjectId();
    expect(isValidId(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('paths', () => {
  const root = path.resolve('C:\\root\\proj');

  it('isInside 判定包含关系', () => {
    expect(isInside(root, path.join(root, 'a'))).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.resolve('C:\\root\\other'))).toBe(false);
  });

  it('resolveInside 拦截路径穿越', () => {
    expect(resolveInside(root, 'src/index.js')).toBe(path.join(root, 'src', 'index.js'));
    expect(() => resolveInside(root, '../../windows/system32')).toThrow();
    expect(() => resolveInside(root, 'C:\\Windows')).toThrow();
  });
});

describe('redact', () => {
  it('打码密钥类赋值', () => {
    expect(redactSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnop')).toContain('***');
    expect(redactSecrets('apiKey: "sk-1234567890"')).toContain('***');
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrst')).toContain('***');
    expect(redactSecrets('PORT=3000')).toBe('PORT=3000');
  });

  it('环境变量表脱敏保留非敏感值', () => {
    expect(redactEnv({ DB_PASSWORD: 'x', PORT: '3000' })).toEqual({
      DB_PASSWORD: '***',
      PORT: '3000',
    });
  });
});

describe('parseEnvFile', () => {
  it('忽略注释与空行，支持引号', () => {
    const parsed = parseEnvFile(
      ['# comment', '', 'A=1', 'B="two words"', "C='three'", 'bad line', '=x'].join('\n')
    );
    expect(parsed).toEqual({ A: '1', B: 'two words', C: 'three' });
  });
});

describe('process-tree', () => {
  it('解析进程表并收集后代', () => {
    const nodes = parseProcessList(
      ['100 1', '200 100', '300 200', '400 1', 'garbage line'].join('\n')
    );
    expect(nodes).toHaveLength(4);
    expect(collectDescendants(nodes, 100).sort()).toEqual([100, 200, 300]);
    expect(collectDescendants(nodes, 999)).toEqual([999]);
  });

  it('容忍 PowerShell/CIM 输出的多余空白', () => {
    expect(parseProcessList('  12   4  \r\n')).toEqual([{ pid: 12, ppid: 4 }]);
  });
});

describe('ports', () => {
  it('只挑出目标 PID 的 LISTENING 端口', () => {
    const netstat = [
      '  TCP    0.0.0.0:3000     0.0.0.0:0    LISTENING    4242',
      '  TCP    127.0.0.1:9229   0.0.0.0:0    LISTENING    4242',
      '  TCP    0.0.0.0:8080     0.0.0.0:0    LISTENING    9999',
      '  TCP    0.0.0.0:5000     0.0.0.0:0    ESTABLISHED  4242',
    ].join('\r\n');
    expect(parseListeningPorts(netstat, [4242])).toEqual([3000, 9229]);
    expect(parseListeningPorts(netstat, [])).toEqual([]);
  });
});
