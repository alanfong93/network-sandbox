export function parseIpv4(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return undefined;
    n = (n << 8) + octet;
  }
  return n >>> 0;
}

export function prefixMask(prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

export function inSubnet(ip: string, network: string, prefix: number): boolean {
  const address = parseIpv4(ip);
  const net = parseIpv4(network);
  if (address === undefined || net === undefined) return false;
  const mask = prefixMask(prefix);
  return (address & mask) === (net & mask);
}

export interface PrefixCandidate<T> {
  dest: string;
  prefix: number;
  value: T;
}

export function networkAddress(ip: string, prefix: number): string | undefined {
  const n = parseIpv4(ip);
  if (n === undefined) return undefined;
  const net = (n & prefixMask(prefix)) >>> 0;
  return [
    (net >>> 24) & 255,
    (net >>> 16) & 255,
    (net >>> 8) & 255,
    net & 255,
  ].join('.');
}

export function formatPrefix(ip: string, prefix: number): string | undefined {
  const net = networkAddress(ip, prefix);
  if (net === undefined) return undefined;
  return `${net}/${prefix}`;
}

export function longestPrefixMatch<T>(
  ip: string,
  candidates: readonly PrefixCandidate<T>[],
): T | undefined {
  let best: { prefix: number; value: T } | undefined;
  for (const candidate of candidates) {
    if (!inSubnet(ip, candidate.dest, candidate.prefix)) continue;
    if (!best || candidate.prefix > best.prefix) {
      best = { prefix: candidate.prefix, value: candidate.value };
    }
  }
  return best?.value;
}
