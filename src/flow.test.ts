import { describe, expect, expectTypeOf, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import { defaults } from './defaults';
import { format } from './format';
import {
  flowObservationAsFormatInput,
  runFlow,
  type FlowResult,
} from './flow';
import type {
  BridgePort,
  Chassis,
  Flow,
  Link,
  MacAddr,
  Route,
  RouterIface,
  Topology,
  VlanId,
} from './model';
import { createRunContext, lookup } from './run';
import { send } from './send';
import { referenceScenario } from './wan.fixture';

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
  ifaces: RouterIface[],
  extra?: { routes?: Route[]; firewall?: { from: VlanId; to: VlanId; action: 'allow' | 'deny' }[] },
): Chassis {
  return {
    id,
    label: id,
    ports: [...new Set(ifaces.map((iface) => iface.id))].map((port) => ({
      id: port,
      mtu: defaults.portMtu,
      ownedBy: 'rt',
    })),
    radios: [],
    functions: [
      {
        kind: 'routing',
        id: 'rt',
        ifaces,
        routes: extra?.routes ?? [],
        firewall: extra?.firewall ?? [],
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

function vlanRouter(): Chassis {
  return routerBox('R1', [
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
  ]);
}

function interVlan(
  firewall: { from: VlanId; to: VlanId; action: 'allow' | 'deny' }[],
): Topology {
  const r1 = vlanRouter();
  const rt = r1.functions[0];
  if (rt?.kind === 'routing') rt.firewall = firewall;
  return topo(
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
      r1,
    ],
    [
      link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
      link('b', { device: 'H2', port: '1' }, { device: 'SW1', port: '2' }),
      link('c', { device: 'SW1', port: '3' }, { device: 'R1', port: '1' }),
    ],
  );
}

function sameLan(): Topology {
  return topo(
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
}

function asymmetric(): Topology {
  return topo(
    [
      hostBox('H1', {
        mac: 'aa:00:00:00:00:10',
        ip: '192.168.10.10',
        prefix: 24,
        gateway: '192.168.10.1',
      }),
      hostBox('H2', {
        mac: 'aa:00:00:00:00:40',
        ip: '192.168.40.10',
        prefix: 24,
        gateway: '192.168.40.1',
      }),
      routerBox(
        'R1',
        [
          { id: '1', ip: '192.168.10.1', prefix: 24, mac: 'aa:00:00:00:01:01' },
          { id: '2', ip: '10.1.12.1', prefix: 24, mac: 'aa:00:00:00:01:02' },
          { id: '3', ip: '10.1.13.1', prefix: 24, mac: 'aa:00:00:00:01:03' },
        ],
        { routes: [{ dest: '192.168.40.0', prefix: 24, via: '10.1.12.2' }] },
      ),
      routerBox(
        'R2',
        [
          { id: '1', ip: '10.1.12.2', prefix: 24, mac: 'aa:00:00:00:02:01' },
          { id: '2', ip: '10.1.24.2', prefix: 24, mac: 'aa:00:00:00:02:02' },
        ],
        {
          routes: [
            { dest: '192.168.40.0', prefix: 24, via: '10.1.24.4' },
            { dest: '192.168.10.0', prefix: 24, via: '10.1.12.1' },
          ],
        },
      ),
      routerBox(
        'R3',
        [
          { id: '1', ip: '10.1.13.3', prefix: 24, mac: 'aa:00:00:00:03:01' },
          { id: '2', ip: '10.1.34.3', prefix: 24, mac: 'aa:00:00:00:03:02' },
        ],
        {
          routes: [
            { dest: '192.168.10.0', prefix: 24, via: '10.1.13.1' },
            { dest: '192.168.40.0', prefix: 24, via: '10.1.34.4' },
          ],
        },
      ),
      routerBox(
        'R4',
        [
          { id: '1', ip: '10.1.24.4', prefix: 24, mac: 'aa:00:00:00:04:01' },
          { id: '2', ip: '192.168.40.1', prefix: 24, mac: 'aa:00:00:00:04:02' },
          { id: '3', ip: '10.1.34.4', prefix: 24, mac: 'aa:00:00:00:04:03' },
        ],
        { routes: [{ dest: '192.168.10.0', prefix: 24, via: '10.1.34.3' }] },
      ),
    ],
    [
      link('h1', { device: 'H1', port: '1' }, { device: 'R1', port: '1' }),
      link('h2', { device: 'H2', port: '1' }, { device: 'R4', port: '2' }),
      link('12', { device: 'R1', port: '2' }, { device: 'R2', port: '1' }),
      link('24', { device: 'R2', port: '2' }, { device: 'R4', port: '1' }),
      link('13', { device: 'R1', port: '3' }, { device: 'R3', port: '1' }),
      link('34', { device: 'R3', port: '2' }, { device: 'R4', port: '3' }),
    ],
  );
}

const row9 = CATALOGUE.find((row) => row.id === 9);
const row15 = CATALOGUE.find((row) => row.id === 15);

describe('Flow return type', () => {
  it('has no pass/fail field', () => {
    expectTypeOf<Flow>().not.toHaveProperty('pass');
    expectTypeOf<Flow>().not.toHaveProperty('fail');
    expectTypeOf<Flow>().not.toHaveProperty('passed');
    expectTypeOf<Flow>().not.toHaveProperty('failed');
    expectTypeOf<Flow>().not.toHaveProperty('success');
    expectTypeOf<Flow>().not.toHaveProperty('ok');
    expectTypeOf<Flow['outcome']>().toEqualTypeOf<
      'round-trip' | 'request-failed' | 'reply-failed'
    >();
    expectTypeOf<FlowResult>().not.toHaveProperty('pass');
    expectTypeOf<FlowResult>().not.toHaveProperty('fail');
    expectTypeOf<FlowResult>().toHaveProperty('flow');
    expectTypeOf<FlowResult>().toHaveProperty('observations');
  });
});


describe('walk observations flow through runFlow (#63)', () => {
  // Row 2's two-switch PVID-mismatch: the hosts sit in ONE subnet while
  // the two access VLANs differ - the frame leaves SW1 in VLAN 10 and
  // arrives at SW2 in VLAN 20.
  function pvidMismatch(): Topology {
    return topo(
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
        switchBox('SW2', [access('1', 20), access('2', 20)]),
      ],
      [
        link('a', { device: 'H1', port: '1' }, { device: 'SW1', port: '1' }),
        link('b', { device: 'SW1', port: '2' }, { device: 'SW2', port: '1' }),
        link('c', { device: 'SW2', port: '2' }, { device: 'H2', port: '1' }),
      ],
    );
  }

  const icmp = {
    from: 'H1',
    dstIp: '192.168.10.20',
    payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.10.20' },
  } as const;

  it('the request walk emits the row-2 vlan-leak observation, phased request (#63)', () => {
    const ctx = createRunContext(pvidMismatch());
    const result = runFlow(ctx, icmp);
    const leak = result.observations.find(
      (item) =>
        item.kind === 'walk' && item.observation.observation === 'vlan-leak',
    );
    expect(leak).toBeDefined();
    expect(leak?.phase).toBe('request');
    if (leak?.kind !== 'walk') return;
    expect(leak.observation.facts.fromVlan).toBe(10);
    expect(leak.observation.facts.toVlan).toBe(20);
    expect(leak.observation.facts.devices).toEqual(['SW1', 'SW2']);
  });

  it('observations are ordered request, then reply, then flow (#63 ordering contract)', () => {
    // The reply walk crosses the same mismatch in reverse (20 -> 10), so
    // both walk phases carry observations in this shape.
    const ctx = createRunContext(pvidMismatch());
    const result = runFlow(ctx, icmp);
    const rank = { request: 0, reply: 1, flow: 2 } as const;
    const ranks = result.observations.map((item) => rank[item.phase]);
    expect(ranks).toContain(0);
    expect(ranks).toContain(1);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // Exact sequence, not just phase grouping: walk-internal order is
    // part of the contract (#63 review cycle 1). send() crosses the
    // mismatch on three sub-walks per direction (ARP request, ARP reply,
    // ICMP) and note() dedups within a walk, not across them - six
    // entries, deterministic for this fixture.
    expect(
      result.observations.map((item) => [
        item.phase,
        item.observation.observation,
      ]),
    ).toEqual([
      ['request', 'vlan-leak'],
      ['request', 'vlan-leak'],
      ['request', 'vlan-leak'],
      ['reply', 'vlan-leak'],
      ['reply', 'vlan-leak'],
      ['reply', 'vlan-leak'],
    ]);
  });

  it('the reply walk emits the mirrored leak observation, phased reply (#63)', () => {
    const ctx = createRunContext(pvidMismatch());
    const result = runFlow(ctx, icmp);
    const replyLeak = result.observations.find(
      (item) =>
        item.phase === 'reply' &&
        item.kind === 'walk' &&
        item.observation.observation === 'vlan-leak',
    );
    expect(replyLeak).toBeDefined();
    if (replyLeak?.kind !== 'walk') return;
    expect(replyLeak.observation.facts.fromVlan).toBe(20);
    expect(replyLeak.observation.facts.toVlan).toBe(10);
  });
});
describe('catalogue row 9', () => {
  const topology = interVlan([{ from: 20, to: 10, action: 'deny' }]);

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, {
      from: 'H1',
      dstIp: '192.168.20.20',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.20.20' },
    });
    expect(result.flow.outcome).toBe('reply-failed');
    const reached = result.flow.request.hops.find(
      (hop) => hop.device === 'H2' && hop.step === 'delivery',
    );
    expect(reached?.fn).toBeUndefined();
    expect(reached?.step).toBe('delivery');
    expect(reached?.reasonCode).toBe('delivery:delivered');
    expect(reached?.action).toBe('delivered');
    const drop = result.flow.reply?.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'firewall',
    );
    expect(drop?.fn).toBe('rt');
    expect(drop?.device).toBe('R1');
    expect(drop?.step).toBe('firewall');
    expect(drop?.reasonCode).toBe('firewall:dropped');
    expect(drop?.action).toBe('dropped');
    expect(drop?.vlan).toBe(20);
    const obs = result.observations.find(
      (item) =>
        item.kind === 'flow' &&
        item.observation.observation === 'firewall-reply',
    );
    expect(obs?.observation.facts.reachedVlan).toBe(20);
    expect(obs?.observation.facts.fromVlan).toBe(20);
    expect(obs?.observation.facts.toVlan).toBe(10);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row9).toBeDefined();
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, {
      from: 'H1',
      dstIp: '192.168.20.20',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.20.20' },
    });
    const entry = result.observations.find(
      (item) =>
        item.kind === 'flow' &&
        item.observation.observation === 'firewall-reply',
    );
    expect(entry).toBeDefined();
    if (!entry || !row9) return;
    expect(format(flowObservationAsFormatInput(entry.observation))).toBe(
      row9.expected,
    );
  });
});

describe('catalogue row 15', () => {
  const topology = asymmetric();

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, {
      from: 'H1',
      dstIp: '192.168.40.10',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.40.10' },
    });
    expect(result.flow.outcome).toBe('round-trip');
    expect(result.flow.asymmetric).toBe(true);
    const delivered = result.flow.reply?.hops.find(
      (hop) => hop.device === 'H1' && hop.step === 'delivery',
    );
    expect(delivered?.step).toBe('delivery');
    expect(delivered?.reasonCode).toBe('delivery:delivered');
    expect(delivered?.action).toBe('delivered');
    const obs = result.observations.find(
      (item) =>
        item.kind === 'flow' &&
        item.observation.observation === 'asymmetric-path',
    );
    expect(obs?.observation.facts.path).toEqual(['R1', 'R2', 'R4']);
    expect(obs?.observation.facts.returnPath).toEqual(['R4', 'R3', 'R1']);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row15).toBeDefined();
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, {
      from: 'H1',
      dstIp: '192.168.40.10',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.40.10' },
    });
    const entry = result.observations.find(
      (item) =>
        item.kind === 'flow' &&
        item.observation.observation === 'asymmetric-path',
    );
    expect(entry).toBeDefined();
    if (!entry || !row15) return;
    expect(format(flowObservationAsFormatInput(entry.observation))).toBe(
      row15.expected,
    );
  });
});

describe('the reply shares the run context', () => {
  it('forwards the reply from the FDB the request learned', () => {
    const topology = sameLan();
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, {
      from: 'H1',
      dstIp: '192.168.10.20',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.10.20' },
    });
    expect(result.flow.outcome).toBe('round-trip');
    expect(lookup(ctx, 10, 'aa:00:00:00:00:10')).toEqual({
      device: 'SW1',
      port: '1',
    });
    const replyForward = [...(result.flow.reply?.hops ?? [])]
      .reverse()
      .find(
        (hop) =>
          hop.device === 'SW1' &&
          hop.action === 'forwarded' &&
          hop.step === 'egress-tagging',
      );
    expect(replyForward?.fn).toBe('br');
    expect(replyForward?.device).toBe('SW1');
    expect(replyForward?.inPort).toBe('2');
    expect(replyForward?.outPort).toBe('1');
    expect(replyForward?.vlan).toBe(10);
    expect(replyForward?.action).toBe('forwarded');
    expect(replyForward?.step).toBe('egress-tagging');
    expect(replyForward?.reasonCode).toBe('egress-tagging:forwarded');
  });

  it('floods a reply traced against a fresh context', () => {
    const topology = sameLan();
    const requestCtx = createRunContext(topology);
    send(requestCtx, {
      from: 'H1',
      dstIp: '192.168.10.20',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.10.20' },
    });
    const cold = createRunContext(topology);
    const reply = send(cold, {
      from: 'H2',
      dstIp: '192.168.10.10',
      payload: { kind: 'icmp', srcIp: '192.168.10.20', dstIp: '192.168.10.10' },
    });
    const flood = reply.hops.find(
      (hop) => hop.device === 'SW1' && hop.action === 'flooded',
    );
    expect(flood?.fn).toBe('br');
    expect(flood?.device).toBe('SW1');
    expect(flood?.action).toBe('flooded');
    expect(flood?.vlan).toBe(10);
  });
});

describe('flow outcomes', () => {
  it('is request-failed when the request is dropped at the firewall', () => {
    const topology = interVlan([{ from: 10, to: 20, action: 'deny' }]);
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, {
      from: 'H1',
      dstIp: '192.168.20.20',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.20.20' },
    });
    expect(result.flow.outcome).toBe('request-failed');
    expect(result.flow.reply).toBeUndefined();
    const drop = result.flow.request.hops.find(
      (hop) => hop.device === 'R1' && hop.step === 'firewall',
    );
    expect(drop?.fn).toBe('rt');
    expect(drop?.step).toBe('firewall');
    expect(drop?.reasonCode).toBe('firewall:dropped');
    expect(drop?.action).toBe('dropped');
  });

  it('is round-trip when both directions are delivered', () => {
    const topology = interVlan([]);
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, {
      from: 'H1',
      dstIp: '192.168.20.20',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.20.20' },
    });
    expect(result.flow.outcome).toBe('round-trip');
    expect(result.flow.asymmetric).toBeUndefined();
    const back = result.flow.reply?.hops.find(
      (hop) => hop.device === 'H1' && hop.step === 'delivery',
    );
    expect(back?.step).toBe('delivery');
    expect(back?.reasonCode).toBe('delivery:delivered');
    expect(back?.action).toBe('delivered');
  });
});

describe('send by name: the table answers after arrival (#126, ADR 0030)', () => {
  // The reference scenario's WAN leg (H10 - USW - MSW - RTR - ONT - NET)
  // plus a LAN resolver box and a NAS for the local-name case.
  function nameScenario(): Topology {
    const topology = referenceScenario();
    const devices = topology.devices.map((device) =>
      device.id === 'H10' ? { ...device, resolver: '192.168.10.53' } : device,
    );
    const dns = hostBox('DNS1', {
      mac: 'aa:00:00:00:00:53',
      ip: '192.168.10.53',
      prefix: 24,
      gateway: '192.168.10.1',
    });
    const dnsBox: Chassis = {
      ...dns,
      functions: [
        {
          kind: 'resolver',
          id: 'resolver',
          records: [
            { name: 'google.com', ip: '192.0.2.1' },
            { name: 'nas.home', ip: '192.168.10.50' },
          ],
        },
      ],
    };
    const nas = hostBox('NAS', {
      mac: 'aa:00:00:00:00:50',
      ip: '192.168.10.50',
      prefix: 24,
      gateway: '192.168.10.1',
    });
    return {
      ...topology,
      devices: [...devices, dnsBox, nas],
      links: [
        ...topology.links,
        link('dns', { device: 'DNS1', port: '1' }, { device: 'USW', port: '3' }),
        link('nas', { device: 'NAS', port: '1' }, { device: 'USW', port: '4' }),
      ],
    };
  }

  const nameSend = {
    from: 'H10',
    dstIp: '',
    dstName: 'google.com',
    payload: { kind: 'icmp' },
  } as const;

  it('walks udp/53 to the advertised resolver, then pings the resolved IP', () => {
    const ctx = createRunContext(nameScenario());
    const result = runFlow(ctx, nameSend);
    expect(result.flow.outcome).toBe('round-trip');
    expect(result.flow.id).toBe('H10:google.com');
    // The query frame is carried separately and delivered at the resolver box.
    const queryDelivery = result.flow.query?.hops.find(
      (hop) => hop.step === 'delivery' && hop.action === 'delivered',
    );
    expect(queryDelivery?.device).toBe('DNS1');
    expect(queryDelivery?.reason).toBe('Query for google.com delivered at DNS1');
    // The echo leg lands on the Internet box; the reply returns to the sender.
    const echoDelivery = result.flow.request.hops.find(
      (hop) => hop.step === 'delivery' && hop.action === 'delivered',
    );
    expect(echoDelivery?.device).toBe('NET');
    const replyDelivery = result.flow.reply?.hops.find(
      (hop) => hop.step === 'delivery' && hop.action === 'delivered',
    );
    expect(replyDelivery?.device).toBe('H10');
  });

  it('keeps the ordering contract: query walk, echo walk, reply (#63)', () => {
    const ctx = createRunContext(nameScenario());
    const result = runFlow(ctx, nameSend);
    const rank = { request: 0, reply: 1, flow: 2 } as const;
    const ranks = result.observations.map((item) => rank[item.phase]);
    expect(ranks).toContain(0);
    expect(ranks).toContain(1);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('a local name never leaves the house', () => {
    const ctx = createRunContext(nameScenario());
    const result = runFlow(ctx, {
      from: 'H10',
      dstIp: '',
      dstName: 'nas.home',
      payload: { kind: 'icmp' },
    });
    expect(result.flow.outcome).toBe('round-trip');
    const echoDelivery = result.flow.request.hops.find(
      (hop) => hop.step === 'delivery' && hop.action === 'delivered',
    );
    expect(echoDelivery?.device).toBe('NAS');
    // The LAN flood legitimately brushes the router's port; the walk must
    // not cross the WAN (done-when: "no WAN").
    const legs = [...result.flow.request.hops, ...(result.flow.reply?.hops ?? [])];
    const legDevices = new Set(legs.map((hop) => hop.device));
    expect(legDevices.has('ONT')).toBe(false);
    expect(legDevices.has('NET')).toBe(false);
  });

  it('stops at the query when the resolver is unreachable; ping-by-IP still works', () => {
    const down = nameScenario();
    down.links = down.links.filter((l) => l.id !== 'dns');
    const ctx = createRunContext(down);
    const result = runFlow(ctx, nameSend);
    expect(result.flow.outcome).toBe('request-failed');
    expect(result.flow.reply).toBeUndefined();
    // No echo walk happened: the request is the query frame alone. Hosts
    // that cannot answer the flooded query emit delivery:dropped hops —
    // only a delivered hop would mean the query landed.
    expect(result.flow.query).toBeUndefined();
    expect(
      result.flow.request.hops.some(
        (hop) => hop.step === 'delivery' && hop.action === 'delivered',
      ),
    ).toBe(false);
    const byIp = runFlow(createRunContext(nameScenario()), {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' },
    });
    expect(byIp.flow.outcome).toBe('round-trip');
  });

  it('names the missing resolver when the sender advertises none', () => {
    const topology = nameScenario();
    topology.devices = topology.devices.map((device) =>
      device.id === 'H10' ? { ...device, resolver: undefined } : device,
    );
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, nameSend);
    expect(result.flow.outcome).toBe('request-failed');
    const obs = result.observations.find(
      (item) =>
        item.kind === 'flow' &&
        item.observation.observation === 'no-resolver',
    );
    expect(obs).toBeDefined();
  });

  it('names the box whose table lacked the record', () => {
    const topology = nameScenario();
    topology.devices = topology.devices.map((device) => {
      if (device.id !== 'DNS1') return device;
      const fn = device.functions[0];
      return fn?.kind === 'resolver' ? { ...device, functions: [{ ...fn, records: [] }] } : device;
    });
    const ctx = createRunContext(topology);
    const result = runFlow(ctx, nameSend);
    expect(result.flow.outcome).toBe('request-failed');
    const obs = result.observations.find(
      (item) =>
        item.kind === 'flow' && item.observation.observation === 'no-record',
    );
    expect(obs).toBeDefined();
    expect(obs?.observation.facts.devices).toEqual(['DNS1']);
  });
});

describe('a reply from a routing chassis (#129)', () => {
  it('round-trips a ping to the router LAN address (done-when)', () => {
    const ctx = createRunContext(referenceScenario());
    const result = runFlow(ctx, {
      from: 'H10',
      dstIp: '192.168.10.1',
      payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.10.1' },
    });
    expect(result.flow.outcome).toBe('round-trip');
    const requestDelivery = result.flow.request.hops.find(
      (hop) => hop.step === 'delivery' && hop.action === 'delivered',
    );
    expect(requestDelivery?.device).toBe('RTR');
    const replyDelivery = result.flow.reply?.hops.find(
      (hop) => hop.step === 'delivery' && hop.action === 'delivered',
    );
    expect(replyDelivery?.device).toBe('H10');
    // The reply walked the router's own routing pipeline, not a host send.
    expect(
      result.flow.reply?.hops.some(
        (hop) => hop.device === 'RTR' && hop.step === 'route-lookup' && hop.action === 'forwarded',
      ),
    ).toBe(true);
  });

  it('round-trips a WAN-side ping to the router WAN address', () => {
    const ctx = createRunContext(referenceScenario());
    const result = runFlow(ctx, {
      from: 'NET',
      dstIp: '192.0.2.2',
      payload: { kind: 'icmp', srcIp: '192.0.2.1', dstIp: '192.0.2.2' },
    });
    expect(result.flow.outcome).toBe('round-trip');
    const requestDelivery = result.flow.request.hops.find(
      (hop) => hop.step === 'delivery' && hop.action === 'delivered',
    );
    expect(requestDelivery?.device).toBe('RTR');
    const replyDelivery = result.flow.reply?.hops.find(
      (hop) => hop.step === 'delivery' && hop.action === 'delivered',
    );
    expect(replyDelivery?.device).toBe('NET');
  });
});
