import os from 'os';
import type { IpType, NetworkInterface } from '../../types';

/**
 * 本机地址枚举（沿用旧启动器的「局域网地址」思路，但更保守）：
 * 旧实现只按网段判断，172.16/12 里的 Hyper-V / WSL / Docker 虚拟交换机会被
 * 当成「VPN 联机」地址展示，用户复制过去根本连不上。这里改成
 * 「网卡名优先、网段兜底」，并单独分出 virtual 一档，由界面决定是否展示。
 */

/** 只用到这三个字段，抽出来便于单测注入，不依赖真实网卡 */
export interface RawAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

export type RawInterfaces = Record<string, RawAddress[] | undefined>;

/** 组网工具（ZeroTier / Tailscale）的网段特征 */
const VPN_RANGES: RegExp[] = [
  /^26\./,
  // Tailscale 使用 CGNAT 100.64.0.0/10
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** 虚拟机 / 容器 / 隧道类网卡的默认网段 */
const VIRTUAL_RANGES: RegExp[] = [/^172\.(1[6-9]|2\d|3[01])\./];

/** 网卡名识别：中英文系统都可能出现英文关键字，命中即优先于网段判断 */
const NAME_HINTS: Array<[IpType, RegExp]> = [
  [
    'vpn',
    /(zerotier|tailscale|radmin|hamachi|wireguard|nordlynx|openvpn|easyconnect|^vpn\b|\bvpn\b|tun\d|tap[-_ ]?windows|wintun|utun)/i,
  ],
  [
    'virtual',
    /(vmware|virtualbox|vbox|hyper-?v|vethernet|docker|wsl|loopback|bluetooth|virtual|pseudo|npcap)/i,
  ],
];

/** 按网卡名判断类型；识别不出返回 null（交给网段判断） */
export function classifyIface(iface: string): IpType | null {
  const name = String(iface ?? '');
  for (const [type, re] of NAME_HINTS) {
    if (re.test(name)) return type;
  }
  return null;
}

/** 地址分类：网卡名优先，其次网段，最后默认 lan */
export function classifyIp(address: string, iface = ''): IpType {
  const byName = classifyIface(iface);
  if (byName) return byName;
  const ip = String(address ?? '');
  for (const re of VPN_RANGES) {
    if (re.test(ip)) return 'vpn';
  }
  for (const re of VIRTUAL_RANGES) {
    if (re.test(ip)) return 'virtual';
  }
  return 'lan';
}

const TYPE_ORDER: Record<IpType, number> = { lan: 0, vpn: 1, virtual: 2 };

/** 169.254.x.x 是没拿到 DHCP 时的自动地址，复制给别人也连不上 */
function isLinkLocal(ip: string): boolean {
  return /^169\.254\./.test(ip);
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return Number.MAX_SAFE_INTEGER;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return Number.MAX_SAFE_INTEGER;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

/** 真实局域网排前面，虚拟网卡排最后；同档按地址数值排 */
export function compareAddresses(a: NetworkInterface, b: NetworkInterface): number {
  const byType = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
  if (byType !== 0) return byType;
  const ai = ipv4ToInt(a.address);
  const bi = ipv4ToInt(b.address);
  if (ai !== bi) return ai - bi;
  return a.iface.localeCompare(b.iface, 'zh-CN');
}

/** 纯函数：从网卡快照里挑出可用 IPv4 地址（去回环、去重、排序） */
export function collectLocalIPs(nets: RawInterfaces): NetworkInterface[] {
  const out: NetworkInterface[] = [];
  const seen = new Set<string>();
  for (const [iface, addrs] of Object.entries(nets ?? {})) {
    if (!Array.isArray(addrs)) continue;
    for (const net of addrs) {
      if (!net || net.internal) continue;
      // 现行 Node 返回 'IPv4'；极老的接口用数字 4，一并容忍
      const family = String(net.family);
      if (family !== 'IPv4' && family !== '4') continue;
      const address = String(net.address ?? '').trim();
      if (!address || seen.has(address)) continue;
      if (isLinkLocal(address)) continue;
      seen.add(address);
      out.push({ iface, address, type: classifyIp(address, iface) });
    }
  }
  return out.sort(compareAddresses);
}

/** 枚举本机可用于对外访问的 IPv4 地址 */
export function getLocalIPs(): NetworkInterface[] {
  return collectLocalIPs(os.networkInterfaces() as unknown as RawInterfaces);
}
