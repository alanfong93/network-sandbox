import { describe, expect, expectTypeOf, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import { defaults } from './defaults';
import {
  decideDhcp,
  findDhcpRelay,
  findDhcpServer,
  matchScope,
} from './dhcp';
import { format } from './format';
import type {
  BridgePort,
  Chassis,
  DhcpScope,
  Fn,
  Link,
  MacAddr,
  Route,
  RouterIface,
  Topology,
  VlanId,
} from './model';
import { createRunContext, getResolvedMac } from './run';
import { send, senderVlan, vlanOfIp } from './send';
import { observationAsFormatInput } from './walk';
import { resolveKey } from './host';

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
  addr: { mac: MacAddr; ip?: string; prefix?: number; gateway?: string },
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
  ifaces: RouterIface[],
  extra?: {
    routes?: Route[];
    firewall?: { from: VlanId; to: VlanId; action: 'allow' | 'deny' }[];
    scopes?: DhcpScope[];
    helper?: string;
  },
): Chassis {
  const functions: Fn[] = [
    {
      kind: 'routing',
      id: 'rt',
      ifaces,
      routes: extra?.routes ?? [],
      firewall: extra?.firewall ?? [],
    },
  ];
  if (extra?.scopes) {
    functions.push({ kind: 'dhcp-server', id: 'dhcp', scopes: extra.scopes });
  }
  if (extra?.helper) {
    functions.push({ kind: 'dhcp-relay', id: 'relay', helper: extra.helper });
  }
  return {
    id,
    label: id,
    ports: [...new Set(ifaces.map((iface) => iface.id))].map((port) => ({
      id: port,
      mtu: defaults.portMtu,
      ownedBy: 'rt',
    })),
    radios: [],
    functions,
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

function discover(from: string) {
  return {
    from,
    dstIp: '255.255.255.255',
    payload: { kind: 'dhcp' as const, dhcpType: 'discover' },
  };
}

const row3 = CATALOGUE.find((row) => row.id === 3);
const row8 = CATALOGUE.find((row) => row.id === 8);
const row11 = CATALOGUE.find((row) => row.id === 11);
const row14 = CATALOGUE.find((row) => row.id === 14);
const row23 = CATALOGUE.find((row) => row.id === 23);

const scopes10and20: DhcpScope[] = [
  {
    vlan: 10,
    poolStart: '192.168.10.50',
    poolEnd: '192.168.10.100',
    gateway: '192.168.10.1',
    resolver: '192.168.10.1',
  },
  {
    vlan: 20,
    poolStart: '192.168.20.51',
    poolEnd: '192.168.20.100',
    gateway: '192.168.20.1',
    resolver: '192.168.20.1',
  },
];

function wrongPvid(): Topology {
  return topo(
    [
      hostBox('H1', {
        mac: 'aa:00:00:00:00:10',
        gateway: '192.168.10.1',
      }),
      switchBox('SW1', [access('1', 20), trunk('2', [10, 20])]),
      routerBox(
        'R1',
        [
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
        { scopes: scopes10and20 },
      ),
    ],
    [
      link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
      link('b', { device: 'SW1', port: '2' }, { device: 'R1', port: '1' }),
    ],
  );
}

function noRelay(): Topology {
  return topo(
    [
      hostBox('H1', { mac: 'aa:00:00:00:00:30', ip: '192.168.30.10', prefix: 24 }),
      switchBox('SW1', [access('1', 30), trunk('2', [10, 30])]),
      routerBox(
        'R1',
        [
          {
            id: '1',
            vlan: 10,
            ip: '192.168.10.1',
            prefix: 24,
            mac: 'aa:00:00:00:00:01',
          },
        ],
        {
          scopes: [
            {
              vlan: 10,
              poolStart: '192.168.10.50',
              poolEnd: '192.168.10.100',
              gateway: '192.168.10.1',
              resolver: '192.168.10.1',
            },
          ],
        },
      ),
    ],
    [
      link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
      link('b', { device: 'SW1', port: '2' }, { device: 'R1', port: '1' }),
    ],
  );
}

function dualServer(): Topology {
  return topo(
    [
      hostBox('H1', { mac: 'aa:00:00:00:00:10', ip: '192.168.10.10', prefix: 24 }),
      switchBox('SW1', [
        access('1', 10),
        access('2', 10),
        access('3', 10),
      ]),
      routerBox(
        'R1',
        [
          {
            id: '1',
            ip: '192.168.10.1',
            prefix: 24,
            mac: 'aa:00:00:00:01:01',
          },
        ],
        {
          scopes: [
            {
              vlan: 10,
              poolStart: '192.168.10.50',
              poolEnd: '192.168.10.80',
              gateway: '192.168.10.1',
              resolver: '192.168.10.1',
            },
          ],
        },
      ),
      routerBox(
        'R2',
        [
          {
            id: '1',
            ip: '192.168.10.2',
            prefix: 24,
            mac: 'aa:00:00:00:02:01',
          },
        ],
        {
          scopes: [
            {
              vlan: 10,
              poolStart: '192.168.10.90',
              poolEnd: '192.168.10.100',
              gateway: '192.168.10.2',
              resolver: '192.168.10.2',
            },
          ],
        },
      ),
    ],
    [
      link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
      link('b', { device: 'SW1', port: '2' }, { device: 'R1', port: '1' }),
      link('c', { device: 'SW1', port: '3' }, { device: 'R2', port: '1' }),
    ],
  );
}

function brokenRelay(): Topology {
  return topo(
    [
      hostBox('H1', { mac: 'aa:00:00:00:00:30', ip: '192.168.30.10', prefix: 24 }),
      routerBox(
        'R3',
        [
          {
            id: '1',
            ip: '192.168.30.1',
            prefix: 24,
            mac: 'aa:00:00:00:03:01',
          },
          {
            id: '2',
            ip: '10.0.23.3',
            prefix: 24,
            mac: 'aa:00:00:00:03:02',
          },
        ],
        {
          helper: '10.0.23.2',
          routes: [{ dest: '0.0.0.0', prefix: 0, via: '10.0.23.2' }],
        },
      ),
      routerBox(
        'R2',
        [
          {
            id: '1',
            ip: '10.0.23.2',
            prefix: 24,
            mac: 'aa:00:00:00:02:01',
          },
          {
            id: '2',
            ip: '10.0.12.2',
            prefix: 24,
            mac: 'aa:00:00:00:02:02',
          },
        ],
        { routes: [{ dest: '0.0.0.0', prefix: 0, via: '10.0.12.1' }] },
      ),
      routerBox(
        'R1',
        [
          {
            id: '1',
            ip: '10.0.12.1',
            prefix: 24,
            mac: 'aa:00:00:00:01:01',
          },
        ],
        {
          scopes: [
            {
              vlan: 30,
              poolStart: '192.168.30.50',
              poolEnd: '192.168.30.100',
              gateway: '192.168.30.1',
              resolver: '192.168.10.1',
            },
          ],
        },
      ),
    ],
    [
      link('a', { device: 'H1', port: '1' }, { device: 'R3', port: '1' }),
      link('b', { device: 'R3', port: '2' }, { device: 'R2', port: '1' }),
      link('c', { device: 'R2', port: '2' }, { device: 'R1', port: '1' }),
    ],
  );
}

function unreachableResolver(): Topology {
  return topo(
    [
      hostBox('H1', {
        mac: 'aa:00:00:00:00:30',
        ip: '192.168.30.10',
        prefix: 24,
        gateway: '192.168.30.1',
      }),
      switchBox('SW1', [access('1', 30), trunk('2', [10, 30])]),
      routerBox(
        'R1',
        [
          {
            id: '1',
            vlan: 10,
            ip: '192.168.10.254',
            prefix: 24,
            mac: 'aa:00:00:00:00:01',
          },
          {
            id: '1',
            vlan: 30,
            ip: '192.168.30.1',
            prefix: 24,
            mac: 'aa:00:00:00:00:01',
          },
        ],
        {
          scopes: [
            {
              vlan: 30,
              poolStart: '192.168.30.50',
              poolEnd: '192.168.30.100',
              gateway: '192.168.30.1',
              resolver: '192.168.10.1',
            },
          ],
          firewall: [{ from: 30, to: 10, action: 'deny' }],
        },
      ),
    ],
    [
      link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
      link('b', { device: 'SW1', port: '2' }, { device: 'R1', port: '1' }),
    ],
  );
}

describe('dhcp types', () => {
  it('does not keep a lease record on the scope or the decision', () => {
    expectTypeOf<DhcpScope>().not.toHaveProperty('leaseTime');
    expectTypeOf<DhcpScope>().not.toHaveProperty('expiry');
    expectTypeOf<DhcpScope>().not.toHaveProperty('leases');
  });
});

describe('catalogue row 3', () => {
  const topology = wrongPvid();

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = send(ctx, discover('H1'));
    const offer = result.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'dhcp-server',
    );
    expect(offer?.fn).toBe('dhcp');
    expect(offer?.step).toBe('dhcp-server');
    expect(offer?.reasonCode).toBe('dhcp-server:forwarded');
    expect(offer?.action).toBe('forwarded');
    expect(offer?.vlan).toBe(20);
    expect(result.deliveredFrame?.payload.kind).toBe('dhcp');
    expect(result.deliveredFrame?.payload.dstIp).toBe('192.168.20.51');
    const obs = result.observations.find(
      (item) => item.observation === 'wrong-pvid-lease',
    );
    expect(obs?.facts.ip).toBe('192.168.20.51');
    expect(obs?.facts.expectedVlan).toBe(10);
    expect(senderVlan(topology, 'H1')).toBe(20);
    expect(vlanOfIp(topology, '192.168.10.1')).toBe(10);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row3).toBeDefined();
    const ctx = createRunContext(topology);
    const result = send(ctx, discover('H1'));
    const obs = result.observations.find(
      (item) => item.observation === 'wrong-pvid-lease',
    );
    expect(obs).toBeDefined();
    if (!obs || !row3) return;
    expect(format(observationAsFormatInput(obs))).toBe(row3.expected);
  });
});

describe('catalogue row 8', () => {
  const topology = noRelay();

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = send(ctx, discover('H1'));
    expect(
      result.hops.some((hop) => hop.step === 'dhcp-server'),
    ).toBe(false);
    expect(
      result.hops.some((hop) => hop.step === 'dhcp-relay'),
    ).toBe(false);
    const flood = result.hops.find(
      (hop) => hop.device === 'SW1' && hop.action === 'flooded',
    );
    expect(flood?.fn).toBe('br');
    expect(flood?.vlan).toBe(30);
    expect(flood?.action).toBe('flooded');
    const obs = result.observations.find(
      (item) => item.observation === 'dhcp-no-server',
    );
    expect(obs?.facts.fromVlan).toBe(30);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row8).toBeDefined();
    const ctx = createRunContext(topology);
    const result = send(ctx, discover('H1'));
    const obs = result.observations.find(
      (item) => item.observation === 'dhcp-no-server',
    );
    expect(obs).toBeDefined();
    if (!obs || !row8) return;
    expect(format(observationAsFormatInput(obs))).toBe(row8.expected);
  });
});

describe('catalogue row 11', () => {
  const topology = dualServer();

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = send(ctx, discover('H1'));
    const offers = result.hops.filter((hop) => hop.step === 'dhcp-server');
    expect(offers.map((hop) => hop.device).sort()).toEqual(['R1', 'R2']);
    expect(offers.every((hop) => hop.fn === 'dhcp')).toBe(true);
    expect(offers.every((hop) => hop.reasonCode === 'dhcp-server:forwarded')).toBe(
      true,
    );
    expect(offers.every((hop) => hop.action === 'forwarded')).toBe(true);
    const obs = result.observations.find(
      (item) => item.observation === 'dual-offer',
    );
    expect(obs?.facts.devices).toEqual(['R1', 'R2']);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row11).toBeDefined();
    const ctx = createRunContext(topology);
    const result = send(ctx, discover('H1'));
    const obs = result.observations.find(
      (item) => item.observation === 'dual-offer',
    );
    expect(obs).toBeDefined();
    if (!obs || !row11) return;
    expect(format(observationAsFormatInput(obs))).toBe(row11.expected);
  });
});

describe('catalogue row 14', () => {
  const topology = brokenRelay();

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = send(ctx, discover('H1'));
    const relay = result.hops.find(
      (hop) => hop.device === 'R3' && hop.step === 'dhcp-relay',
    );
    expect(relay?.fn).toBe('relay');
    expect(relay?.step).toBe('dhcp-relay');
    expect(relay?.reasonCode).toBe('dhcp-relay:relayed');
    expect(relay?.action).toBe('forwarded');
    expect(
      result.hops.some(
        (hop) => hop.device === 'R2' && hop.step === 'dhcp-relay',
      ),
    ).toBe(false);
    expect(
      result.hops.some((hop) => hop.step === 'dhcp-server'),
    ).toBe(false);
    const stopped = result.hops.find(
      (hop) => hop.device === 'R2' && hop.step === 'delivery',
    );
    expect(stopped?.action).toBe('delivered');
    const obs = result.observations.find(
      (item) => item.observation === 'relay-chain',
    );
    expect(obs?.facts.path).toEqual(['R3', 'R2']);
    expect(obs?.facts.devices).toEqual(['R2']);
    expect(obs?.facts.toward).toBe('R1');
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row14).toBeDefined();
    const ctx = createRunContext(topology);
    const result = send(ctx, discover('H1'));
    const obs = result.observations.find(
      (item) => item.observation === 'relay-chain',
    );
    expect(obs).toBeDefined();
    if (!obs || !row14) return;
    expect(format(observationAsFormatInput(obs))).toBe(row14.expected);
  });
});

describe('catalogue row 23', () => {
  const topology = unreachableResolver();

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    send(ctx, discover('H1'));
    const result = send(ctx, {
      from: 'H1',
      dstIp: '192.168.10.1',
      payload: {
        kind: 'service',
        proto: 'udp',
        dstPort: 53,
        srcIp: '192.168.30.10',
        dstIp: '192.168.10.1',
      },
    });
    const drop = result.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'firewall',
    );
    expect(drop?.fn).toBe('rt');
    expect(drop?.step).toBe('firewall');
    expect(drop?.reasonCode).toBe('firewall:dropped');
    expect(drop?.action).toBe('dropped');
    expect(drop?.vlan).toBe(30);
    expect(drop?.reason).toBe(row23?.expected);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row23).toBeDefined();
    const ctx = createRunContext(topology);
    send(ctx, discover('H1'));
    const result = send(ctx, {
      from: 'H1',
      dstIp: '192.168.10.1',
      payload: {
        kind: 'service',
        proto: 'udp',
        dstPort: 53,
        srcIp: '192.168.30.10',
        dstIp: '192.168.10.1',
      },
    });
    const drop = result.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'firewall',
    );
    expect(drop).toBeDefined();
    if (!drop || !row23) return;
    expect(drop.reason).toBe(row23.expected);
  });
});

function localServer(): Topology {
  return topo(
    [
      hostBox('H1', {
        mac: 'aa:00:00:00:00:10',
        ip: '192.168.10.10',
        prefix: 24,
        gateway: '192.168.10.1',
      }),
      switchBox('SW1', [access('1', 10), trunk('2', [10])]),
      routerBox(
        'R1',
        [
          {
            id: '1',
            vlan: 10,
            ip: '192.168.10.1',
            prefix: 24,
            mac: 'aa:00:00:00:00:01',
          },
        ],
        {
          scopes: [
            {
              vlan: 10,
              poolStart: '192.168.10.50',
              poolEnd: '192.168.10.100',
              gateway: '192.168.10.1',
              resolver: '192.168.10.1',
            },
          ],
        },
      ),
    ],
    [
      link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
      link('b', { device: 'SW1', port: '2' }, { device: 'R1', port: '1' }),
    ],
  );
}

describe('DHCP unicast phase uses the same-run MAC', () => {
  it('does not ARP a REQUEST after an OFFER in the same run', () => {
    const ctx = createRunContext(localServer());
    send(ctx, discover('H1'));
    expect(getResolvedMac(ctx, resolveKey('H1', '192.168.10.1'))).toBe(
      'aa:00:00:00:00:01',
    );
    const result = send(ctx, {
      from: 'H1',
      dstIp: '192.168.10.1',
      payload: { kind: 'dhcp', dhcpType: 'request' },
    });
    expect(result.hops.some((hop) => hop.step === 'arp')).toBe(false);
    const ack = result.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'dhcp-server',
    );
    expect(ack?.reasonCode).toBe('dhcp-server:forwarded');
    expect(result.deliveredFrame?.payload.kind).toBe('dhcp');
    expect(
      result.deliveredFrame?.payload.kind === 'dhcp'
        ? result.deliveredFrame.payload.dhcpType
        : undefined,
    ).toBe('ack');
  });

  it('ARPs a REQUEST on a cold run', () => {
    const ctx = createRunContext(localServer());
    const result = send(ctx, {
      from: 'H1',
      dstIp: '192.168.10.1',
      payload: { kind: 'dhcp', dhcpType: 'request' },
    });
    expect(result.hops.some((hop) => hop.step === 'arp')).toBe(true);
  });
});

describe('decideDhcp helpers', () => {
  it('matches a local scope by ingress VLAN', () => {
    const chassis = routerBox(
      'R1',
      [
        {
          id: '1',
          vlan: 20,
          ip: '192.168.20.1',
          prefix: 24,
          mac: 'aa:00:00:00:00:01',
        },
      ],
      { scopes: scopes10and20 },
    );
    const server = findDhcpServer(chassis);
    const iface = chassis.functions[0];
    if (iface?.kind !== 'routing') throw new Error('expected routing');
    const scope = matchScope(server, iface.ifaces[0]!, {
      srcMac: 'aa:00:00:00:00:10',
      dstMac: defaults.broadcastMac,
      vlan: 20,
      size: 64,
      encapsulation: ['ethernet'],
      payload: { kind: 'dhcp', dhcpType: 'discover' },
      hops: [],
    });
    expect(scope?.poolStart).toBe('192.168.20.51');
    expect(findDhcpRelay(chassis)).toBeUndefined();
  });

  it('drops a DISCOVER when this router has no server and no relay', () => {
    const chassis = routerBox('R1', [
      {
        id: '1',
        vlan: 30,
        ip: '192.168.30.1',
        prefix: 24,
        mac: 'aa:00:00:00:00:01',
      },
    ]);
    const fn = chassis.functions[0];
    if (fn?.kind !== 'routing') throw new Error('expected routing');
    const decision = decideDhcp({
      device: 'R1',
      chassis,
      fn,
      iface: fn.ifaces[0]!,
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:30',
        dstMac: defaults.broadcastMac,
        vlan: 30,
        size: 64,
        encapsulation: ['ethernet'],
        payload: { kind: 'dhcp', dhcpType: 'discover' },
        hops: [],
      },
    });
    expect(decision.action).toBe('drop');
  });
});

function standaloneServer(): Topology {
  return topo(
    [
      hostBox('H1', {
        mac: 'aa:00:00:00:00:10',
        gateway: '192.168.10.1',
      }),
      switchBox('SW1', [access('1', 10), access('2', 10)]),
      {
        id: 'SRV',
        label: 'SRV',
        ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'none' }],
        radios: [],
        functions: [
          {
            kind: 'dhcp-server',
            id: 'dhcp',
            scopes: [
              {
                vlan: 10,
                poolStart: '192.168.10.50',
                poolEnd: '192.168.10.100',
                gateway: '192.168.10.1',
                resolver: '192.168.10.1',
              },
            ],
          },
        ],
        internal: [],
        vlan: 10,
      },
    ],
    [
      link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
      link('b', { device: 'SW1', port: '2' }, { device: 'SRV', port: '1' }),
    ],
  );
}

describe('standalone DHCP server dispatch', () => {
  it('offers poolStart to a DISCOVER on a non-routing chassis', () => {
    const ctx = createRunContext(standaloneServer());
    const result = send(ctx, discover('H1'));
    const offer = result.hops.find(
      (hop) => hop.device === 'SRV' && hop.step === 'dhcp-server',
    );
    expect(offer?.fn).toBe('dhcp');
    expect(offer?.inPort).toBe('1');
    expect(offer?.outPort).toBe('1');
    expect(offer?.action).toBe('forwarded');
    expect(offer?.reasonCode).toBe('dhcp-server:forwarded');
    expect(result.deliveredFrame?.payload.kind).toBe('dhcp');
    expect(
      result.deliveredFrame?.payload.kind === 'dhcp'
        ? result.deliveredFrame.payload.dhcpType
        : undefined,
    ).toBe('offer');
    expect(
      result.deliveredFrame?.payload.kind === 'dhcp'
        ? result.deliveredFrame.payload.dstIp
        : undefined,
    ).toBe('192.168.10.50');
  });

  it('drops a DISCOVER when no scope matches the VLAN', () => {
    const topology = standaloneServer();
    const srv = topology.devices.find((item) => item.id === 'SRV');
    const fn = srv?.functions.find((item) => item.kind === 'dhcp-server');
    if (fn?.kind !== 'dhcp-server') throw new Error('expected dhcp-server');
    fn.scopes = [
      {
        vlan: 20,
        poolStart: '192.168.20.50',
        poolEnd: '192.168.20.100',
        gateway: '192.168.20.1',
        resolver: '192.168.20.1',
      },
    ];
    const ctx = createRunContext(topology);
    const result = send(ctx, discover('H1'));
    expect(
      result.hops.some((hop) => hop.step === 'dhcp-server'),
    ).toBe(false);
  });

  it('keeps the router-mounted path unchanged', () => {
    const ctx = createRunContext(localServer());
    const result = send(ctx, discover('H1'));
    const offer = result.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'dhcp-server',
    );
    expect(offer?.fn).toBe('dhcp');
    expect(offer?.reasonCode).toBe('dhcp-server:forwarded');
    expect(result.deliveredFrame?.payload.kind).toBe('dhcp');
  });
});
