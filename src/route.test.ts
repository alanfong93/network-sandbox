import { describe, expect, it } from 'vitest';
import { defaults } from './defaults';
import type { Chassis, Frame, Topology } from './model';
import { createRunContext } from './run';
import { routeFrame } from './route';

function router(): Chassis {
  return {
    id: 'R1',
    label: 'R1',
    ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'rt' }],
    radios: [],
    functions: [
      {
        kind: 'routing',
        id: 'rt',
        ifaces: [
          {
            id: '1',
            vlan: 10,
            ip: '192.168.10.1',
            prefix: 24,
            mac: 'aa:00:00:00:00:01',
          },
          {
            id: '1',
            vlan: 20,
            ip: '192.168.20.1',
            prefix: 24,
            mac: 'aa:00:00:00:00:01',
          },
        ],
        routes: [],
        firewall: [],
      },
    ],
    internal: [],
  };
}

function topo(devices: Chassis[]): Topology {
  return { devices, links: [], profiles: [] };
}

function ipFrame(dstIp: string, vlan = 10): Frame {
  return {
    srcMac: 'aa:00:00:00:00:10',
    dstMac: 'aa:00:00:00:00:01',
    vlan,
    size: 128,
    encapsulation: ['ethernet', 'vlan-tag'],
    payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp },
    hops: [],
  };
}

describe('routeFrame', () => {
  it('matches a tagged sub-interface by port and vlan', () => {
    const box = router();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('192.168.10.1', 10),
    });
    expect(result.hops[0]?.fn).toBe('rt');
    expect(result.hops[0]?.device).toBe('R1');
    expect(result.hops[0]?.step).toBe('delivery');
    expect(result.hops[0]?.reasonCode).toBe('delivery:delivered');
    expect(result.hops[0]?.action).toBe('delivered');
    expect(result.hops[0]?.vlan).toBe(10);
  });

  it('drops at route-lookup when no connected iface or route matches', () => {
    const box = router();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('8.8.8.8', 10),
    });
    expect(result.hops[0]?.fn).toBe('rt');
    expect(result.hops[0]?.step).toBe('route-lookup');
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:dropped');
    expect(result.hops[0]?.action).toBe('dropped');
    expect(result.transmissions).toEqual([]);
  });

  it('prefers the longest prefix among connected ifaces then routes', () => {
    const box = router();
    const rt = box.functions[0];
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    rt.routes.push({ dest: '0.0.0.0', prefix: 0, via: '192.168.20.2' });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('192.168.10.50', 10),
    });
    expect(result.hops[0]?.step).toBe('route-lookup');
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:forwarded');
    expect(result.hops.some((hop) => hop.step === 'arp')).toBe(true);
    expect(result.transmissions[0]?.frame.payload.kind).toBe('arp');
    expect(result.transmissions[0]?.frame.payload.dstIp).toBe('192.168.10.50');
  });

  it('drops at firewall on the first matching deny', () => {
    const box = router();
    const rt = box.functions[0];
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    rt.firewall.push({ from: 10, to: 20, action: 'deny' });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('192.168.20.10', 10),
    });
    expect(result.hops[0]?.device).toBe('R1');
    expect(result.hops[0]?.fn).toBe('rt');
    expect(result.hops[0]?.step).toBe('firewall');
    expect(result.hops[0]?.reasonCode).toBe('firewall:dropped');
    expect(result.hops[0]?.action).toBe('dropped');
    expect(result.hops[0]?.vlan).toBe(10);
    expect(result.transmissions).toEqual([]);
  });

  it('does not answer a broadcast ARP for a different IP on a matching iface', () => {
    const box = router();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:10',
        dstMac: defaults.broadcastMac,
        vlan: 10,
        size: 64,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: {
          kind: 'arp',
          srcIp: '192.168.10.10',
          dstIp: '192.168.10.99',
        },
        hops: [],
      },
    });
    expect(result.hops).toEqual([]);
    expect(result.transmissions).toEqual([]);
  });

  it('drops a unicast IP to an iface MAC when no sub-interface matches the VLAN', () => {
    const box = router();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('192.168.10.1', 30),
    });
    expect(result.hops[0]?.device).toBe('R1');
    expect(result.hops[0]?.fn).toBe('rt');
    expect(result.hops[0]?.step).toBe('route-lookup');
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:dropped');
    expect(result.hops[0]?.action).toBe('dropped');
    expect(result.hops[0]?.vlan).toBe(30);
    expect(result.hops[0]?.inPort).toBe('1');
    expect(result.transmissions).toEqual([]);
  });

  it('allows inter-VLAN when no rule matches', () => {
    const box = router();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('192.168.20.10', 10),
    });
    expect(result.hops[0]?.step).toBe('route-lookup');
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:forwarded');
    expect(result.hops[0]?.action).toBe('forwarded');
  });
});
