import { describe, expect, it } from 'vitest';
import { defaults } from './defaults';
import type { BridgePort, Chassis, Frame, Topology, VlanId } from './model';
import { createRunContext } from './run';
import { classifyWireless, wirelessWouldHandle } from './wireless';

function access(port: string, vlan: VlanId): BridgePort {
  return {
    port,
    mode: 'access',
    pvid: vlan,
    taggedVlans: new Set(),
    untaggedVlans: new Set([vlan]),
    acceptableFrameTypes: 'all',
    ingressFiltering: true,
  };
}

function ap(): Chassis {
  return {
    id: 'AP1',
    label: 'AP1',
    ports: [
      { id: 'wifi', mtu: defaults.portMtu, ownedBy: 'wlan' },
      { id: '1', mtu: defaults.portMtu, ownedBy: 'br' },
    ],
    radios: [{ id: 'radio0', band: '5' }],
    functions: [
      {
        kind: 'wireless',
        id: 'wlan',
        radio: 'radio0',
        mode: 'ap',
        ssid: 'guest',
        vlan: 30,
      },
      {
        kind: 'bridging',
        id: 'br',
        vlanAware: true,
        members: [access('wifi', 30), access('1', 30)],
        fdb: new Map(),
      },
    ],
    internal: [{ from: 'wlan', to: 'br' }],
  };
}

function topo(devices: Chassis[]): Topology {
  return { devices, links: [], profiles: [] };
}

function frame(): Frame {
  return {
    srcMac: 'aa:00:00:00:00:10',
    dstMac: defaults.broadcastMac,
    vlan: null,
    size: 128,
    encapsulation: ['ethernet'],
    payload: { kind: 'icmp' },
    hops: [],
  };
}

describe('wireless classify', () => {
  it('would handle a wireless function', () => {
    const fn = ap().functions[0];
    expect(fn?.kind).toBe('wireless');
    if (fn?.kind !== 'wireless') return;
    expect(wirelessWouldHandle(fn)).toBe(true);
  });

  it('names the wireless function and hands the classified frame to the bridge', () => {
    const ctx = createRunContext(topo([ap()]));
    const result = classifyWireless(ctx, {
      device: 'AP1',
      inPort: 'wifi',
      frame: frame(),
    });
    expect(result.hops[0]?.device).toBe('AP1');
    expect(result.hops[0]?.fn).toBe('wlan');
    expect(result.hops[0]?.step).toBe('ssid-vlan');
    expect(result.hops[0]?.reasonCode).toBe('ssid-vlan:classified');
    expect(result.hops[0]?.vlan).toBe(30);
    expect(result.hops[0]?.action).toBe('forwarded');
    expect(result.internal?.fn).toBe('br');
    expect(result.internal?.frame.vlan).toBe(30);
    expect(result.transmissions).toEqual([]);
  });
});
