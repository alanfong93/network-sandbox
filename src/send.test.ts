import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import { defaults } from './defaults';
import { format } from './format';
import type {
  BridgePort,
  Chassis,
  FramePayload,
  Link,
  MacAddr,
  Topology,
  VlanId,
} from './model';
import { handleHost } from './host';
import { createRunContext, getResolvedMac } from './run';
import { needsArp, send } from './send';
import { observationAsFormatInput, walkFrame } from './walk';

function trunk(port: string, tagged: VlanId[]): BridgePort {
  return {
    port,
    mode: 'trunk',
    pvid: 1,
    taggedVlans: new Set(tagged),
    untaggedVlans: new Set(),
    acceptableFrameTypes: 'all',
    ingressFiltering: true,
  };
}

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

function switchBox(id: string, members: BridgePort[]): Chassis {
  return {
    id,
    label: id,
    ports: members.map((member) => ({
      id: member.port,
      mtu: defaults.portMtu,
      ownedBy: 'br',
    })),
    radios: [],
    functions: [
      {
        kind: 'bridging',
        id: 'br',
        vlanAware: true,
        members,
        fdb: new Map(),
      },
    ],
    internal: [],
  };
}

function hostBox(
  id: string,
  addr: { mac: MacAddr; ip: string; prefix: number; gateway?: string },
): Chassis {
  return {
    id,
    label: id,
    ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'none' }],
    radios: [],
    functions: [],
    internal: [],
    mac: addr.mac,
    ip: addr.ip,
    prefix: addr.prefix,
    gateway: addr.gateway,
  };
}

function routerBox(
  id: string,
  ifaces: { vlan: VlanId; ip: string; mac: MacAddr }[],
): Chassis {
  return {
    id,
    label: id,
    ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'rt' }],
    radios: [],
    functions: [
      {
        kind: 'routing',
        id: 'rt',
        ifaces: ifaces.map((iface) => ({
          id: '1',
          vlan: iface.vlan,
          ip: iface.ip,
          prefix: 24,
          mac: iface.mac,
        })),
        routes: [],
        firewall: [],
      },
    ],
    internal: [],
  };
}

function link(
  id: string,
  a: { device: string; port: string },
  b: { device: string; port: string },
): Link {
  return { id, a, b, medium: 'wired' };
}

function topo(devices: Chassis[], links: Link[]): Topology {
  return { devices, links, profiles: [] };
}

const row7 = CATALOGUE.find((row) => row.id === 7);

const wrongVlan = topo(
  [
    hostBox('H1', {
      mac: 'aa:00:00:00:00:10',
      ip: '192.168.10.10',
      prefix: 24,
      gateway: '192.168.10.1',
    }),
    switchBox('SW1', [access('1', 10), trunk('2', [10, 20])]),
    routerBox('R1', [
      { vlan: 20, ip: '192.168.10.1', mac: 'aa:00:00:00:00:01' },
    ]),
  ],
  [
    link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
    link('b', { device: 'SW1', port: '2' }, { device: 'R1', port: '1' }),
  ],
);

const rightVlan = topo(
  [
    hostBox('H1', {
      mac: 'aa:00:00:00:00:10',
      ip: '192.168.10.10',
      prefix: 24,
      gateway: '192.168.10.1',
    }),
    switchBox('SW1', [access('1', 10), trunk('2', [10, 20])]),
    routerBox('R1', [
      { vlan: 10, ip: '192.168.10.1', mac: 'aa:00:00:00:00:01' },
    ]),
  ],
  [
    link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
    link('b', { device: 'SW1', port: '2' }, { device: 'R1', port: '1' }),
  ],
);

describe('origin hop (#123)', () => {
  it('records the sending chassis as hop 0, before the walk hops', () => {
    // The same-LAN shape: H1 - USW - H2. Before #123 the first hop named
    // the switch - the walk starts at the neighbor, so the sender never
    // appeared and the trace read as if the switch originated the frame.
    const topology = topo(
      [
        hostBox('H1', {
          mac: 'aa:00:00:00:00:10',
          ip: '192.168.10.10',
          prefix: 24,
          gateway: '192.168.10.1',
        }),
        hostBox('H2', {
          mac: 'aa:00:00:00:00:20',
          ip: '192.168.10.20',
          prefix: 24,
          gateway: '192.168.10.1',
        }),
        switchBox('SW1', [access('1', 10), access('2', 10)]),
      ],
      [
        link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
        link('b', { device: 'SW1', port: '2' }, { device: 'H2', port: '1' }),
      ],
    );
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H1',
      dstIp: '192.168.10.20',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.10.20' },
    });
    expect(result.hops[0]?.device).toBe('H1');
    expect(result.hops[0]?.step).toBe('origin');
    expect(result.hops[0]?.reasonCode).toBe('origin:forwarded');
    expect(result.hops[0]?.reason).toBe('sent from H1 port 1');
    expect(result.hops[0]?.outPort).toBe('1');
    // The walk hops follow, shifted by one - not dropped or reordered.
    expect(result.hops[1]?.device).toBe('SW1');
    expect(
      result.hops.some((hop) => hop.step === 'delivery' && hop.action === 'delivered'),
    ).toBe(true);
  });

  it('leads with the origin hop even when only the ARP walk ran', () => {
    // Cold ARP with no reply: the sender still originated the request, so
    // the trace names the sender first and the ARP flood second.
    const topology = topo(
      [
        hostBox('H1', {
          mac: 'aa:00:00:00:00:10',
          ip: '192.168.10.10',
          prefix: 24,
          gateway: '192.168.10.1',
        }),
        switchBox('SW1', [access('1', 10), access('2', 10)]),
      ],
      [link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' })],
    );
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H1',
      dstIp: '192.168.10.20',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.10.20' },
    });
    expect(result.hops[0]?.device).toBe('H1');
    expect(result.hops[0]?.reasonCode).toBe('origin:forwarded');
    expect(result.hops[1]?.device).toBe('SW1');
  });

  it('records no origin hop when nothing was sent', () => {
    // No port, no frame: an origin hop with nothing after it would claim a
    // send that never happened.
    const topology = topo(
      [
        {
          ...hostBox('H1', {
            mac: 'aa:00:00:00:00:10',
            ip: '192.168.10.10',
            prefix: 24,
          }),
          ports: [],
        },
      ],
      [],
    );
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H1',
      dstIp: '192.168.10.20',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.10.20' },
    });
    expect(result.hops).toEqual([]);
  });
});

describe('needsArp', () => {
  it('is false for an ARP frame, a DHCP DISCOVER, and a supplied destination MAC', () => {
    expect(needsArp({ kind: 'arp', dstIp: '192.168.10.1' })).toBe(false);
    expect(needsArp({ kind: 'dhcp', dhcpType: 'discover' })).toBe(false);
    expect(
      needsArp({ kind: 'icmp', dstIp: '8.8.8.8' }, 'aa:00:00:00:00:01'),
    ).toBe(false);
    expect(needsArp({ kind: 'icmp', dstIp: '8.8.8.8' }, defaults.broadcastMac)).toBe(
      false,
    );
  });

  it('is true when a unicast IPv4 sender has no next-hop MAC', () => {
    expect(needsArp({ kind: 'icmp', dstIp: '8.8.8.8' })).toBe(true);
  });
});

describe('catalogue row 7', () => {
  it('is green structurally', () => {
    const ctx = createRunContext(wrongVlan);
    const result = send(ctx, {
      from: 'H1',
      dstIp: '8.8.8.8',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '8.8.8.8' },
    });
    const miss = result.observations.find(
      (obs) => obs.observation === 'arp-no-reply',
    );
    expect(miss?.facts.ip).toBe('192.168.10.1');
    expect(miss?.facts.fromVlan).toBe(10);
    expect(miss?.facts.otherVlan).toBe(20);
    const flood = result.hops.find(
      (hop) => hop.device === 'SW1' && hop.action === 'flooded',
    );
    expect(flood?.fn).toBe('br');
    expect(flood?.vlan).toBe(10);
    expect(flood?.step).toBe('egress-tagging');
    expect(flood?.reasonCode).toBe('egress-tagging:flooded');
    expect(flood?.inPort).toBe('1');
    expect(flood?.action).toBe('flooded');
    expect(
      result.hops.some((hop) => hop.step === 'arp' && hop.action === 'delivered'),
    ).toBe(false);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row7).toBeDefined();
    const ctx = createRunContext(wrongVlan);
    const result = send(ctx, {
      from: 'H1',
      dstIp: '8.8.8.8',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '8.8.8.8' },
    });
    const miss = result.observations.find(
      (obs) => obs.observation === 'arp-no-reply',
    );
    expect(miss).toBeDefined();
    if (!miss || !row7) return;
    expect(format(observationAsFormatInput(miss))).toBe(row7.expected);
  });
});

describe('ARP is conditional', () => {
  it('does not emit an ARP request when the destination MAC is supplied', () => {
    const ctx = createRunContext(wrongVlan);
    const result = send(ctx, {
      from: 'H1',
      dstIp: '8.8.8.8',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '8.8.8.8' },
      dstMac: 'aa:00:00:00:00:01',
    });
    expect(result.hops.some((hop) => hop.step === 'arp')).toBe(false);
    expect(
      result.observations.some((obs) => obs.observation === 'arp-no-reply'),
    ).toBe(false);
  });

  it('does not ARP a DHCP DISCOVER', () => {
    const ctx = createRunContext(wrongVlan);
    const result = send(ctx, {
      from: 'H1',
      dstIp: '255.255.255.255',
      payload: { kind: 'dhcp', dhcpType: 'discover' },
    });
    expect(result.hops.some((hop) => hop.step === 'arp')).toBe(false);
    expect(
      result.hops.some(
        (hop) => hop.device === 'SW1' && hop.action === 'flooded' && hop.vlan === 10,
      ),
    ).toBe(true);
  });

  it('does not ARP when walkFrame is given a broadcast frame', () => {
    const ctx = createRunContext(wrongVlan);
    const payload: FramePayload = { kind: 'icmp' };
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:10',
        dstMac: defaults.broadcastMac,
        vlan: null,
        size: 64,
        encapsulation: ['ethernet'],
        payload,
        hops: [],
      },
      arrivedFrom: 'H1',
    });
    expect(result.hops.some((hop) => hop.step === 'arp')).toBe(false);
  });

  it('resolves once per sender in a run and not across runs', () => {
    const ctx = createRunContext(rightVlan);
    const first = send(ctx, {
      from: 'H1',
      dstIp: '8.8.8.8',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '8.8.8.8' },
    });
    expect(
      first.hops.filter((hop) => hop.step === 'arp' && hop.action === 'delivered')
        .length,
    ).toBeGreaterThan(0);
    expect(getResolvedMac(ctx, 'H1|192.168.10.1')).toBe('aa:00:00:00:00:01');

    const second = send(ctx, {
      from: 'H1',
      dstIp: '1.1.1.1',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '1.1.1.1' },
    });
    expect(second.hops.some((hop) => hop.step === 'arp')).toBe(false);

    const again = createRunContext(rightVlan);
    expect(getResolvedMac(again, 'H1|192.168.10.1')).toBeUndefined();
    const third = send(again, {
      from: 'H1',
      dstIp: '8.8.8.8',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '8.8.8.8' },
    });
    expect(third.hops.some((hop) => hop.step === 'arp')).toBe(true);
  });

  it('ARPs an on-subnet destination, not the gateway', () => {
    const topology = topo(
      [
        hostBox('H1', {
          mac: 'aa:00:00:00:00:10',
          ip: '192.168.10.10',
          prefix: 24,
          gateway: '192.168.10.1',
        }),
        hostBox('H2', {
          mac: 'aa:00:00:00:00:20',
          ip: '192.168.10.20',
          prefix: 24,
          gateway: '192.168.10.1',
        }),
        switchBox('SW1', [access('1', 10), access('2', 10)]),
      ],
      [
        link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
        link('b', { device: 'H2', port: '1' }, { device: 'SW1', port: '2' }),
      ],
    );
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H1',
      dstIp: '192.168.10.20',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.10.20' },
    });
    const arp = result.hops.find(
      (hop) => hop.step === 'arp' && hop.action === 'delivered' && hop.device === 'H2',
    );
    expect(arp?.device).toBe('H2');
    expect(getResolvedMac(ctx, 'H1|192.168.10.20')).toBe('aa:00:00:00:00:20');
    expect(getResolvedMac(ctx, 'H1|192.168.10.1')).toBeUndefined();
    const delivered = result.hops.find(
      (hop) => hop.device === 'H2' && hop.step === 'delivery',
    );
    expect(delivered?.action).toBe('delivered');
    expect(delivered?.reasonCode).toBe('delivery:delivered');
  });

  it('does not deliver IP to a host when dstMac is another unicast', () => {
    const topology = topo(
      [
        hostBox('H1', {
          mac: 'aa:00:00:00:00:10',
          ip: '192.168.10.10',
          prefix: 24,
        }),
      ],
      [],
    );
    const ctx = createRunContext(topology);
    const result = handleHost(ctx, {
      device: 'H1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:99',
        dstMac: 'aa:00:00:00:00:20',
        vlan: null,
        size: 64,
        encapsulation: ['ethernet'],
        payload: { kind: 'icmp', dstIp: '192.168.10.10' },
        hops: [],
      },
    });
    expect(result).toBeUndefined();
  });
});

describe('inter-VLAN send', () => {
  it('forwards ICMP after both ARPs when the firewall allows', () => {
    const topology = topo(
      [
        hostBox('H1', {
          mac: 'aa:00:00:00:00:10',
          ip: '192.168.10.10',
          prefix: 24,
          gateway: '192.168.10.1',
        }),
        hostBox('H2', {
          mac: 'aa:00:00:00:00:20',
          ip: '192.168.20.20',
          prefix: 24,
          gateway: '192.168.20.1',
        }),
        switchBox('SW1', [
          access('1', 10),
          access('2', 20),
          trunk('3', [10, 20]),
        ]),
        routerBox('R1', [
          { vlan: 10, ip: '192.168.10.1', mac: 'aa:00:00:00:00:01' },
          { vlan: 20, ip: '192.168.20.1', mac: 'aa:00:00:00:00:01' },
        ]),
      ],
      [
        link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
        link('b', { device: 'H2', port: '1' }, { device: 'SW1', port: '2' }),
        link('c', { device: 'SW1', port: '3' }, { device: 'R1', port: '1' }),
      ],
    );
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H1',
      dstIp: '192.168.20.20',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.20.20' },
    });
    const delivered = result.hops.find(
      (hop) => hop.device === 'H2' && hop.step === 'delivery',
    );
    expect(delivered?.fn).toBeUndefined();
    expect(delivered?.step).toBe('delivery');
    expect(delivered?.reasonCode).toBe('delivery:delivered');
    expect(delivered?.action).toBe('delivered');
    expect(
      result.hops.some(
        (hop) => hop.device === 'R1' && hop.step === 'route-lookup' && hop.action === 'forwarded',
      ),
    ).toBe(true);
  });
});
