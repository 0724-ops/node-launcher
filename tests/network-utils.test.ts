import { describe, expect, it } from 'vitest';
import {
  classifyIface,
  classifyIp,
  collectLocalIPs,
  compareAddresses,
  type RawInterfaces,
} from '../electron/core/net/network-utils';
import type { IpType, NetworkInterface } from '../electron/types';

function addr(address: string, iface: string, type: IpType): NetworkInterface {
  return { iface, address, type };
}

describe('classifyIface', () => {
  it('按网卡名识别组网工具', () => {
    expect(classifyIface('Tailscale')).toBe('vpn');
    expect(classifyIface('ZeroTier One [8056c2e21c000001]')).toBe('vpn');
    expect(classifyIface('OpenVPN TAP-Windows6')).toBe('vpn');
  });

  it('按网卡名识别虚拟机 / 容器网卡', () => {
    expect(classifyIface('vEthernet (Default Switch)')).toBe('virtual');
    expect(classifyIface('VMware Network Adapter VMnet8')).toBe('virtual');
    expect(classifyIface('VirtualBox Host-Only Network')).toBe('virtual');
  });

  it('普通物理网卡识别不出类型（交给网段判断）', () => {
    expect(classifyIface('以太网')).toBeNull();
    expect(classifyIface('WLAN')).toBeNull();
    expect(classifyIface('')).toBeNull();
  });
});

describe('classifyIp', () => {
  it('普通私网地址算真实局域网', () => {
    expect(classifyIp('192.168.1.5', '以太网')).toBe('lan');
    expect(classifyIp('10.0.0.7', 'WLAN')).toBe('lan');
  });

  it('ZeroTier / Tailscale 网段算 VPN', () => {
    expect(classifyIp('26.12.34.56')).toBe('vpn');
    expect(classifyIp('100.101.102.103')).toBe('vpn');
  });

  it('CGNAT 边界之外不算 VPN', () => {
    // 100.64.0.0/10 之外的 100.x 是普通地址
    expect(classifyIp('100.63.0.1')).toBe('lan');
    expect(classifyIp('100.128.0.1')).toBe('lan');
  });

  it('172.16/12 归到 virtual，不再冒充 VPN 联机地址', () => {
    expect(classifyIp('172.20.144.1')).toBe('virtual');
    expect(classifyIp('172.15.0.1')).toBe('lan');
    expect(classifyIp('172.32.0.1')).toBe('lan');
  });

  it('网卡名优先于网段判断', () => {
    expect(classifyIp('192.168.56.1', 'VirtualBox Host-Only Network')).toBe('virtual');
    expect(classifyIp('192.168.1.5', 'Tailscale')).toBe('vpn');
  });
});

describe('collectLocalIPs', () => {
  const snapshot: RawInterfaces = {
    以太网: [
      { address: '192.168.1.5', family: 'IPv4', internal: false },
      { address: 'fe80::1234', family: 'IPv6', internal: false },
      { address: '169.254.10.20', family: 'IPv4', internal: false },
    ],
    'Loopback Pseudo-Interface 1': [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
    ],
    'vEthernet (WSL)': [{ address: '172.20.144.1', family: 'IPv4', internal: false }],
    以太网2: [{ address: '192.168.1.5', family: 'IPv4', internal: false }],
  };

  it('只取非内部 IPv4，剔除回环/链路本地并去重', () => {
    const out = collectLocalIPs(snapshot);
    expect(out.map((i) => i.address)).toEqual(['192.168.1.5', '172.20.144.1']);
    expect(out.map((i) => i.type)).toEqual(['lan', 'virtual']);
    expect(out[0].iface).toBe('以太网');
  });

  it('真实局域网排在 VPN / 虚拟网卡之前', () => {
    const out = collectLocalIPs({
      'vEthernet (WSL)': [{ address: '172.20.144.1', family: 'IPv4', internal: false }],
      Tailscale: [{ address: '100.64.0.2', family: 'IPv4', internal: false }],
      以太网: [{ address: '192.168.1.5', family: 'IPv4', internal: false }],
    });
    expect(out.map((i) => i.address)).toEqual(['192.168.1.5', '100.64.0.2', '172.20.144.1']);
  });

  it('兼容 family 写成数字 4 的旧接口', () => {
    const out = collectLocalIPs({ eth0: [{ address: '10.1.2.3', family: 4, internal: false }] });
    expect(out).toEqual([{ iface: 'eth0', address: '10.1.2.3', type: 'lan' }]);
  });

  it('空输入 / 缺字段不抛错', () => {
    expect(collectLocalIPs({})).toEqual([]);
    expect(collectLocalIPs({ eth0: undefined })).toEqual([]);
    expect(
      collectLocalIPs({ eth0: [{ address: '  ', family: 'IPv4', internal: false }] })
    ).toEqual([]);
  });
});

describe('compareAddresses', () => {
  it('同档按地址数值升序，而不是字符串顺序', () => {
    const list = [
      addr('192.168.1.10', '以太网 2', 'lan'),
      addr('192.168.1.9', '以太网', 'lan'),
    ];
    expect([...list].sort(compareAddresses).map((i) => i.address)).toEqual([
      '192.168.1.9',
      '192.168.1.10',
    ]);
  });
});
