import { describe, expect, it } from 'vitest';
import { builtinProfile, defaults, usableMtu } from './defaults';

describe('defaults', () => {
  it('is a named built-in profile', () => {
    expect(builtinProfile.id).toBe('ieee-defaults');
    expect(builtinProfile.version).toBe('1');
  });

  it('turns NAT on for a newly placed router', () => {
    expect(defaults.natOn).toBe(true);
  });

  it('caps a storm at maxHops across the whole tree', () => {
    expect(defaults.maxHops).toBe(100);
  });

  it('computes usable MTU from the encapsulation stack', () => {
    const mtu = defaults.portMtu;
    expect(usableMtu(mtu, ['ethernet'])).toBe(mtu);
    expect(usableMtu(mtu, ['ethernet', 'vlan-tag'])).toBe(
      mtu - defaults.encapsulationOverhead['vlan-tag'],
    );
    expect(usableMtu(mtu, ['ethernet', 'vlan-tag', 'pppoe'])).toBe(
      mtu -
        defaults.encapsulationOverhead['vlan-tag'] -
        defaults.encapsulationOverhead.pppoe,
    );
  });
});
