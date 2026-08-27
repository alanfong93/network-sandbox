import { describe, expect, it } from 'vitest';
import { inSubnet, longestPrefixMatch, parseIpv4 } from './ip';

describe('ip', () => {
  it('parses dotted IPv4', () => {
    expect(parseIpv4('192.168.10.1')).toBe(3232238081);
    expect(parseIpv4('10.0.0.1')).toBe(167772161);
    expect(parseIpv4('192.168.10')).toBeUndefined();
    expect(parseIpv4('192.168.10.256')).toBeUndefined();
  });

  it('tests subnet membership on the masked prefix', () => {
    expect(inSubnet('192.168.10.50', '192.168.10.1', 24)).toBe(true);
    expect(inSubnet('192.168.11.50', '192.168.10.1', 24)).toBe(false);
    expect(inSubnet('10.0.0.1', '10.0.0.0', 8)).toBe(true);
  });

  it('picks the longest matching prefix', () => {
    const hit = longestPrefixMatch('192.168.10.50', [
      { dest: '0.0.0.0', prefix: 0, value: 'default' },
      { dest: '192.168.10.1', prefix: 24, value: 'lan' },
      { dest: '192.168.0.0', prefix: 16, value: 'supernet' },
    ]);
    expect(hit).toBe('lan');
  });
});
