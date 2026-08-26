import type { Bytes, Encapsulation } from './model';

/**
 * Every tunable the engine reads. Behavioural numbers are not inlined at use
 * sites. This object is itself the built-in profile (ADR 0012).
 */
export const builtinProfile = {
  id: 'ieee-defaults',
  version: '1',
} as const;

export const defaults = {
  maxHops: 100,
  pvid: 1,
  portMtu: 1500,
  encapsulationOverhead: {
    ethernet: 0,
    'vlan-tag': 4,
    pppoe: 8,
  },
  stp: {
    priority: 32768,
    pathCost: 20000,
  },
  natOn: true,
  acceptableFrameTypes: 'all' as const,
  ingressFiltering: true,
  broadcastMac: 'ff:ff:ff:ff:ff:ff',
} as const;

export function usableMtu(
  portMtu: Bytes,
  encapsulation: readonly Encapsulation[],
): Bytes {
  let mtu = portMtu;
  for (const layer of encapsulation) {
    mtu -= defaults.encapsulationOverhead[layer];
  }
  return mtu;
}
