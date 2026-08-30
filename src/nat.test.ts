import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import { defaults } from './defaults';
import { format } from './format';
import { flowObservationAsFormatInput, runFlow } from './flow';
import type {
  Chassis,
  Fn,
  Frame,
  FramePayload,
  Link,
  MacAddr,
  PortForward,
  Route,
  RouterIface,
  Topology,
  VlanId,
} from './model';
import { createRunContext, type NatSession } from './run';
import { matchSession, matchSessionDetail } from './nat';
import { send } from './send';
import { observationAsFormatInput } from './walk';

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
  ifaces: RouterIface[],
  extra?: {
    routes?: Route[];
    firewall?: { from: VlanId; to: VlanId; action: 'allow' | 'deny' }[];
    nat?: true | PortForward[];
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
  if (extra?.nat !== undefined) {
    functions.push({
      kind: 'nat',
      id: 'nat',
      on: 'rt',
      portForwards: extra.nat === true ? [] : extra.nat,
    });
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

/** Overlapping LAN with a tier above — catalogue row 10. */
function overlapping(): Topology {
  return topo(
    [
      hostBox('H2', {
        mac: 'aa:00:00:00:00:20',
        ip: '192.168.1.10',
        prefix: 24,
        gateway: '192.168.1.1',
      }),
      hostBox('H1', {
        mac: 'aa:00:00:00:00:50',
        ip: '192.168.1.50',
        prefix: 24,
        gateway: '192.168.1.1',
      }),
      routerBox(
        'R2',
        [
          { id: '1', ip: '192.168.1.1', prefix: 24, mac: 'aa:00:00:00:02:01' },
          { id: '2', ip: '10.1.1.2', prefix: 24, mac: 'aa:00:00:00:02:02' },
        ],
        { routes: [{ dest: '0.0.0.0', prefix: 0, via: '10.1.1.1' }] },
      ),
      routerBox('R1', [
        { id: '1', ip: '10.1.1.1', prefix: 24, mac: 'aa:00:00:00:01:01' },
        { id: '2', ip: '192.168.1.1', prefix: 24, mac: 'aa:00:00:00:01:02' },
      ]),
    ],
    [
      link('h2', { device: 'H2', port: '1' }, { device: 'R2', port: '1' }),
      link('up', { device: 'R2', port: '2' }, { device: 'R1', port: '1' }),
      link('h1', { device: 'H1', port: '1' }, { device: 'R1', port: '2' }),
    ],
  );
}

/**
 * H2 -- R2 -- R1 -- H1. NAT on both routers is double NAT (row 12).
 * NAT off on R2 is the missing return route (row 13).
 */
function tiers(nat: { r1: boolean; r2: boolean }): Topology {
  return topo(
    [
      hostBox('H2', {
        mac: 'aa:00:00:00:00:20',
        ip: '192.168.50.10',
        prefix: 24,
        gateway: '192.168.50.1',
      }),
      hostBox('H1', {
        mac: 'aa:00:00:00:00:05',
        ip: '10.20.0.5',
        prefix: 24,
        gateway: '10.20.0.1',
      }),
      routerBox(
        'R2',
        [
          { id: '1', ip: '192.168.50.1', prefix: 24, mac: 'aa:00:00:00:02:01' },
          { id: '2', ip: '192.168.1.2', prefix: 24, mac: 'aa:00:00:00:02:02' },
        ],
        {
          routes: [{ dest: '0.0.0.0', prefix: 0, via: '192.168.1.1' }],
          nat: nat.r2 ? true : undefined,
        },
      ),
      routerBox(
        'R1',
        [
          { id: '1', ip: '192.168.1.1', prefix: 24, mac: 'aa:00:00:00:01:01' },
          { id: '2', ip: '10.20.0.1', prefix: 24, mac: 'aa:00:00:00:01:02' },
        ],
        {
          routes: nat.r1
            ? [{ dest: '0.0.0.0', prefix: 0, via: '10.20.0.5' }]
            : [],
          nat: nat.r1 ? true : undefined,
        },
      ),
    ],
    [
      link('h2', { device: 'H2', port: '1' }, { device: 'R2', port: '1' }),
      link('12', { device: 'R2', port: '2' }, { device: 'R1', port: '1' }),
      link('h1', { device: 'H1', port: '1' }, { device: 'R1', port: '2' }),
    ],
  );
}

/** Inbound to R1 WAN; R2 holds the only port forward (row 21). */
function innerForwardOnly(): Topology {
  return topo(
    [
      hostBox('EXT', {
        mac: 'aa:00:00:00:00:ee',
        ip: '10.20.0.5',
        prefix: 24,
        gateway: '10.20.0.1',
      }),
      hostBox('H2', {
        mac: 'aa:00:00:00:00:20',
        ip: '192.168.50.10',
        prefix: 24,
        gateway: '192.168.50.1',
      }),
      routerBox(
        'R1',
        [
          { id: '1', ip: '10.20.0.1', prefix: 24, mac: 'aa:00:00:00:01:01' },
          { id: '2', ip: '192.168.1.1', prefix: 24, mac: 'aa:00:00:00:01:02' },
        ],
        {
          routes: [{ dest: '0.0.0.0', prefix: 0, via: '10.20.0.5' }],
          nat: true,
        },
      ),
      routerBox(
        'R2',
        [
          { id: '1', ip: '192.168.1.2', prefix: 24, mac: 'aa:00:00:00:02:01' },
          { id: '2', ip: '192.168.50.1', prefix: 24, mac: 'aa:00:00:00:02:02' },
        ],
        {
          routes: [{ dest: '0.0.0.0', prefix: 0, via: '192.168.1.1' }],
          nat: [
            {
              proto: 'tcp',
              outsidePort: 443,
              toIp: '192.168.50.10',
              toPort: 443,
            },
          ],
        },
      ),
    ],
    [
      link('ext', { device: 'EXT', port: '1' }, { device: 'R1', port: '1' }),
      link('12', { device: 'R1', port: '2' }, { device: 'R2', port: '1' }),
      link('h2', { device: 'R2', port: '2' }, { device: 'H2', port: '1' }),
    ],
  );
}

/** Port forward to a subnet R1 has no iface on (row 22). */
function unreachableForward(): Topology {
  return topo(
    [
      hostBox('EXT', {
        mac: 'aa:00:00:00:00:ee',
        ip: '10.20.0.5',
        prefix: 24,
        gateway: '10.20.0.1',
      }),
      routerBox(
        'R1',
        [
          { id: '1', ip: '10.20.0.1', prefix: 24, mac: 'aa:00:00:00:01:01' },
          { id: '2', ip: '192.168.1.1', prefix: 24, mac: 'aa:00:00:00:01:02' },
        ],
        {
          routes: [{ dest: '0.0.0.0', prefix: 0, via: '10.20.0.5' }],
          nat: [
            {
              proto: 'tcp',
              outsidePort: 443,
              toIp: '10.99.0.10',
              toPort: 443,
            },
          ],
        },
      ),
    ],
    [link('ext', { device: 'EXT', port: '1' }, { device: 'R1', port: '1' })],
  );
}

const row10 = CATALOGUE.find((row) => row.id === 10);
const row12 = CATALOGUE.find((row) => row.id === 12);
const row13 = CATALOGUE.find((row) => row.id === 13);
const row21 = CATALOGUE.find((row) => row.id === 21);
const row22 = CATALOGUE.find((row) => row.id === 22);

describe('catalogue row 10', () => {
  const topology = overlapping();

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H2',
      dstIp: '192.168.1.50',
      payload: { kind: 'icmp', srcIp: '192.168.1.10', dstIp: '192.168.1.50' },
    });
    const delivered = result.hops.find(
      (hop) => hop.device === 'H1' && hop.step === 'delivery',
    );
    expect(delivered).toBeUndefined();
    const upstream = result.hops.find(
      (hop) => hop.device === 'R1' || hop.outPort === '2',
    );
    expect(upstream).toBeUndefined();
    const obs = result.observations.find(
      (item) => item.observation === 'local-subnet',
    );
    expect(obs?.facts.ip).toBe('192.168.1.50');
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row10).toBeDefined();
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H2',
      dstIp: '192.168.1.50',
      payload: { kind: 'icmp', srcIp: '192.168.1.10', dstIp: '192.168.1.50' },
    });
    const obs = result.observations.find(
      (item) => item.observation === 'local-subnet',
    );
    expect(obs).toBeDefined();
    if (!obs || !row10) return;
    expect(format(observationAsFormatInput(obs))).toBe(row10.expected);
  });
});

describe('catalogue row 12', () => {
  const topology = tiers({ r1: true, r2: true });

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H2',
      dstIp: '10.20.0.5',
      payload: { kind: 'icmp', srcIp: '192.168.50.10', dstIp: '10.20.0.5' },
    });
    const translations = result.hops.filter(
      (hop) => hop.step === 'nat' && hop.reasonCode === 'nat:translated',
    );
    expect(translations).toHaveLength(2);
    expect(translations[0]?.fn).toBe('nat');
    expect(translations[0]?.device).toBe('R2');
    expect(translations[0]?.action).toBe('forwarded');
    expect(translations[1]?.fn).toBe('nat');
    expect(translations[1]?.device).toBe('R1');
    expect(translations[1]?.action).toBe('forwarded');
    const obs = result.observations.find(
      (item) => item.observation === 'double-nat',
    );
    expect(obs).toBeDefined();
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row12).toBeDefined();
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H2',
      dstIp: '10.20.0.5',
      payload: { kind: 'icmp', srcIp: '192.168.50.10', dstIp: '10.20.0.5' },
    });
    const obs = result.observations.find(
      (item) => item.observation === 'double-nat',
    );
    expect(obs).toBeDefined();
    if (!obs || !row12) return;
    expect(format(observationAsFormatInput(obs))).toBe(row12.expected);
  });
});

describe('catalogue row 13', () => {
  const topology = tiers({ r1: false, r2: false });

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, {
      from: 'H2',
      dstIp: '10.20.0.5',
      payload: { kind: 'icmp', srcIp: '192.168.50.10', dstIp: '10.20.0.5' },
    });
    expect(result.flow.outcome).toBe('reply-failed');
    const reached = result.flow.request.hops.find(
      (hop) => hop.device === 'H1' && hop.step === 'delivery',
    );
    expect(reached?.step).toBe('delivery');
    expect(reached?.reasonCode).toBe('delivery:delivered');
    expect(reached?.action).toBe('delivered');
    const drop = result.flow.reply?.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'route-lookup',
    );
    expect(drop?.fn).toBe('rt');
    expect(drop?.device).toBe('R1');
    expect(drop?.step).toBe('route-lookup');
    expect(drop?.reasonCode).toBe('route-lookup:dropped');
    expect(drop?.action).toBe('dropped');
    const obs = result.observations.find(
      (item) => item.observation === 'missing-return-route',
    );
    expect(obs?.facts.otherIp).toBe('10.20.0.5');
    expect(obs?.facts.via).toBe('R2');
    expect(obs?.facts.ip).toBe('192.168.50.10');
    expect(obs?.facts.devices).toEqual(['R1']);
    expect(obs?.facts.prefix).toBe('192.168.50.0/24');
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row13).toBeDefined();
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, {
      from: 'H2',
      dstIp: '10.20.0.5',
      payload: { kind: 'icmp', srcIp: '192.168.50.10', dstIp: '10.20.0.5' },
    });
    const obs = result.observations.find(
      (item) => item.observation === 'missing-return-route',
    );
    expect(obs).toBeDefined();
    if (!obs || !row13) return;
    expect(format(flowObservationAsFormatInput(obs))).toBe(row13.expected);
  });
});

describe('NAT on hides the inside address', () => {
  it('round-trips without a return route on the upstream router', () => {
    const topology = tiers({ r1: false, r2: true });
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, {
      from: 'H2',
      dstIp: '10.20.0.5',
      payload: { kind: 'icmp', srcIp: '192.168.50.10', dstIp: '10.20.0.5' },
    });
    expect(result.flow.outcome).toBe('round-trip');
    const snat = result.flow.request.hops.find(
      (hop) => hop.device === 'R2' && hop.step === 'nat',
    );
    expect(snat?.fn).toBe('nat');
    expect(snat?.reasonCode).toBe('nat:translated');
    expect(snat?.action).toBe('forwarded');
    const back = result.flow.reply?.hops.find(
      (hop) => hop.device === 'H2' && hop.step === 'delivery',
    );
    expect(back?.step).toBe('delivery');
    expect(back?.reasonCode).toBe('delivery:delivered');
    expect(back?.action).toBe('delivered');
  });
});

describe('catalogue row 21', () => {
  const topology = innerForwardOnly();

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'EXT',
      dstIp: '10.20.0.1',
      payload: { kind: 'service', proto: 'tcp', dstPort: 443 },
    });
    const drop = result.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'port-forward',
    );
    expect(drop?.fn).toBe('nat');
    expect(drop?.device).toBe('R1');
    expect(drop?.step).toBe('port-forward');
    expect(drop?.reasonCode).toBe('port-forward:dropped');
    expect(drop?.action).toBe('dropped');
    const inner = result.hops.find((hop) => hop.device === 'R2');
    expect(inner).toBeUndefined();
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row21).toBeDefined();
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'EXT',
      dstIp: '10.20.0.1',
      payload: { kind: 'service', proto: 'tcp', dstPort: 443 },
    });
    const drop = result.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'port-forward',
    );
    expect(drop).toBeDefined();
    if (!drop || !row21) return;
    expect(drop.reason).toBe(row21.expected);
  });
});

describe('catalogue row 22', () => {
  const topology = unreachableForward();

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'EXT',
      dstIp: '10.20.0.1',
      payload: { kind: 'service', proto: 'tcp', dstPort: 443 },
    });
    const drop = result.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'port-forward',
    );
    expect(drop?.fn).toBe('nat');
    expect(drop?.device).toBe('R1');
    expect(drop?.step).toBe('port-forward');
    expect(drop?.reasonCode).toBe('port-forward:dropped');
    expect(drop?.action).toBe('dropped');
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row22).toBeDefined();
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'EXT',
      dstIp: '10.20.0.1',
      payload: { kind: 'service', proto: 'tcp', dstPort: 443 },
    });
    const drop = result.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'port-forward',
    );
    expect(drop).toBeDefined();
    if (!drop || !row22) return;
    expect(drop.reason).toBe(row22.expected);
  });
});

describe('port-forward match', () => {
  it('matches proto and outsidePort, not toPort', () => {
    const topology = unreachableForward();
    const tcp = createRunContext(topology);
    const hit = send(tcp, {
      from: 'EXT',
      dstIp: '10.20.0.1',
      payload: { kind: 'service', proto: 'tcp', dstPort: 443 },
    });
    expect(
      hit.hops.some(
        (hop) => hop.step === 'port-forward' && hop.action === 'dropped',
      ),
    ).toBe(true);

    const udp = createRunContext(topology);
    const missProto = send(udp, {
      from: 'EXT',
      dstIp: '10.20.0.1',
      payload: { kind: 'service', proto: 'udp', dstPort: 443 },
    });
    const udpDrop = missProto.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'port-forward',
    );
    expect(udpDrop?.reasonCode).toBe('port-forward:dropped');
    expect(udpDrop?.reason).not.toBe(row22?.expected);

    const otherPort = createRunContext(topology);
    const missPort = send(otherPort, {
      from: 'EXT',
      dstIp: '10.20.0.1',
      payload: { kind: 'service', proto: 'tcp', dstPort: 80 },
    });
    const portDrop = missPort.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'port-forward',
    );
    expect(portDrop?.reasonCode).toBe('port-forward:dropped');
    expect(portDrop?.reason).not.toBe(row22?.expected);
  });
});

describe('matchSession port-keyed returns', () => {
  const ctx = createRunContext(unreachableForward());
  const twin = (
    insideIp: string,
    ports: Partial<
      Pick<NatSession, 'proto' | 'outsidePort' | 'toPort' | 'clientPort'>
    > = {},
  ): NatSession => ({
    device: 'R1',
    insideIp,
    outsideIp: '192.168.30.1',
    remoteIp: '192.168.30.50',
    ...ports,
  });
  const frameOf = (payload: FramePayload): Frame => ({
    srcMac: 'aa:00:00:00:00:50',
    dstMac: 'aa:00:00:00:00:01',
    vlan: 30,
    size: 128,
    encapsulation: ['ethernet', 'vlan-tag'],
    payload,
    hops: [],
  });

  it('a ported return matches the session its tuple names, not the first address twin', () => {
    ctx.natSessions.push(
      twin('192.168.30.10', {
        proto: 'tcp',
        outsidePort: 443,
        toPort: 443,
        clientPort: 40000,
      }),
      twin('192.168.30.11', {
        proto: 'tcp',
        outsidePort: 443,
        toPort: 443,
        clientPort: 40001,
      }),
    );
    const frame = frameOf({
      kind: 'service',
      proto: 'tcp',
      srcIp: '192.168.30.50',
      dstIp: '192.168.30.1',
      dstPort: 40001,
      srcPort: 443,
    });
    expect(matchSession(ctx, 'R1', frame)?.insideIp).toBe('192.168.30.11');
    const detail = matchSessionDetail(ctx, 'R1', frame);
    expect(detail.ambiguous).toBe(false);
  });

  it('a portless return never matches a port-carrying session', () => {
    const frame = frameOf({
      kind: 'icmp',
      srcIp: '192.168.30.50',
      dstIp: '192.168.30.1',
    });
    expect(matchSession(ctx, 'R1', frame)).toBeUndefined();
    expect(matchSessionDetail(ctx, 'R1', frame).ambiguous).toBe(false);
  });

  it('a portless return still matches a portless session', () => {
    ctx.natSessions.push(twin('192.168.30.12'));
    const frame = frameOf({
      kind: 'icmp',
      srcIp: '192.168.30.50',
      dstIp: '192.168.30.1',
    });
    expect(matchSession(ctx, 'R1', frame)?.insideIp).toBe('192.168.30.12');
  });
});
