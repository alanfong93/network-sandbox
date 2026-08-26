import { describe, expect, it, expectTypeOf } from 'vitest';
import {
  carriedVlans,
  nativeVlanOf,
  type BridgePort,
  type DhcpScope,
  type FramePayload,
  type PortForward,
} from './model';

describe('model', () => {
  it('does not store a nativeVlan field', () => {
    expectTypeOf<BridgePort>().not.toHaveProperty('nativeVlan');
    const port: BridgePort = {
      port: '1',
      mode: 'trunk',
      pvid: 1,
      taggedVlans: new Set([10, 20]),
      untaggedVlans: new Set([1]),
      acceptableFrameTypes: 'all',
      ingressFiltering: true,
    };
    expect(nativeVlanOf(port)).toBe(1);
    expect(
      nativeVlanOf({ ...port, untaggedVlans: new Set() }),
    ).toBeUndefined();
    expect([...carriedVlans(port)].sort()).toEqual([1, 10, 20]);
  });

  it('narrows a port-forward proto so a service frame can match it', () => {
    expectTypeOf<PortForward['proto']>().toEqualTypeOf<'udp' | 'tcp'>();
    const payload: FramePayload = {
      kind: 'service',
      proto: 'tcp',
      dstPort: 443,
    };
    const forward: PortForward = {
      proto: 'tcp',
      outsidePort: 443,
      toIp: '10.0.0.8',
      toPort: 443,
    };
    expect(payload.proto).toBe(forward.proto);
    expect(payload.dstPort).toBe(forward.outsidePort);
  });

  it('names the DHCP scope resolver field without implying name resolution', () => {
    expectTypeOf<DhcpScope>().toHaveProperty('resolver');
    expectTypeOf<DhcpScope>().not.toHaveProperty('dns');
  });
});
