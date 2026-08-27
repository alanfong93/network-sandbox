import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import { defaults } from './defaults';
import { format } from './format';
import type {
  BridgePort,
  Chassis,
  Frame,
  Link,
  MacAddr,
  Topology,
  VlanId,
} from './model';
import { createRunContext, learn, portState } from './run';
import { observationAsFormatInput, walkFrame } from './walk';

function trunk(
  port: string,
  tagged: VlanId[],
  opts?: { pvid?: VlanId; untagged?: VlanId[] },
): BridgePort {
  return {
    port,
    mode: 'trunk',
    pvid: opts?.pvid ?? 1,
    taggedVlans: new Set(tagged),
    untaggedVlans: new Set(opts?.untagged ?? []),
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

function switchBox(
  id: string,
  members: BridgePort[],
  opts?: { vlanAware?: boolean; stp?: boolean; mac?: MacAddr; priority?: number },
): Chassis {
  const vlanAware = opts?.vlanAware ?? true;
  const functions: Chassis['functions'] = [
    {
      kind: 'bridging',
      id: 'br',
      vlanAware,
      members,
      fdb: new Map(),
    },
  ];
  if (opts?.stp) {
    functions.push({
      kind: 'stp',
      id: 'stp',
      bridge: 'br',
      priority: opts.priority ?? defaults.stp.priority,
      baseMac: opts.mac ?? 'aa:00:00:00:00:01',
      state: new Map(),
    });
  }
  return {
    id,
    label: id,
    ports: members.map((member) => ({
      id: member.port,
      mtu: defaults.portMtu,
      ownedBy: 'br',
    })),
    radios: [],
    functions,
    internal: [],
  };
}

function host(id: string): Chassis {
  return {
    id,
    label: id,
    ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'none' }],
    radios: [],
    functions: [],
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

function topo(devices: Chassis[], links: Link[] = []): Topology {
  return { devices, links, profiles: [] };
}

function frame(partial: {
  src?: MacAddr;
  dst?: MacAddr;
  vlan?: VlanId | null;
}): Frame {
  const vlan = partial.vlan === undefined ? 10 : partial.vlan;
  return {
    srcMac: partial.src ?? 'aa:00:00:00:00:10',
    dstMac: partial.dst ?? defaults.broadcastMac,
    vlan,
    size: 128,
    encapsulation: vlan === null ? ['ethernet'] : ['ethernet', 'vlan-tag'],
    payload: { kind: 'icmp' },
    hops: [],
  };
}

const row2 = CATALOGUE.find((row) => row.id === 2);
const row5 = CATALOGUE.find((row) => row.id === 5);
const row6 = CATALOGUE.find((row) => row.id === 6);
const row16 = CATALOGUE.find((row) => row.id === 16);
const row17 = CATALOGUE.find((row) => row.id === 17);

describe('topology walk', () => {
  it('dispatches on Port.ownedBy, not a device kind', () => {
    const sw = switchBox('SW1', [access('1', 10), access('2', 10)]);
    sw.functions.push({
      kind: 'routing',
      id: 'rt',
      ifaces: [],
      routes: [],
      firewall: [],
    });
    const ctx = createRunContext(topo([sw]));
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: null }),
    });
    expect(result.hops[0]?.fn).toBe('br');
    expect(result.hops[0]?.device).toBe('SW1');
  });

  it('does not call a bridging executor when ownedBy is not a bridging function', () => {
    const box = host('H1');
    const ctx = createRunContext(topo([box]));
    const result = walkFrame(ctx, {
      device: 'H1',
      inPort: '1',
      frame: frame({ vlan: null }),
    });
    expect(result.hops[0]?.device).toBe('H1');
    expect(result.hops[0]?.fn).toBeUndefined();
    expect(result.hops[0]?.step).toBe('delivery');
    expect(result.hops[0]?.action).toBe('dropped');
    expect(ctx.hopsLeft).toBe(defaults.maxHops);
  });

  it('names the arrival on a host-linked port instead of swallowing the frame', () => {
    const sw = switchBox('SW1', [access('1', 10), access('2', 10)]);
    const ctx = createRunContext(
      topo(
        [sw, host('H1')],
        [link('h', { device: 'SW1', port: '2' }, { device: 'H1', port: '1' })],
      ),
    );
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: null, dst: defaults.broadcastMac }),
    });
    expect(result.hops[0]?.device).toBe('SW1');
    const arrived = result.hops.find((hop) => hop.device === 'H1');
    expect(arrived?.device).toBe('H1');
    expect(arrived?.step).toBe('delivery');
    expect(arrived?.fn).toBeUndefined();
  });

  it('spends the hop budget across every flood branch, not per path', () => {
    const hubMembers = ['0', '1', '2', '3', '4', '5'].map((port) =>
      access(port, 1),
    );
    const hub = switchBox('HUB', hubMembers, { vlanAware: false });
    const leaves = [1, 2, 3, 4, 5].map((n) =>
      switchBox(`L${n}`, [access('1', 1), access('2', 1)], { vlanAware: false }),
    );
    const links = [1, 2, 3, 4, 5].map((n) =>
      link(`h${n}`, { device: 'HUB', port: String(n) }, { device: `L${n}`, port: '1' }),
    );
    const ctx = createRunContext(topo([hub, ...leaves], links));
    ctx.hopsLeft = 4;
    const result = walkFrame(ctx, {
      device: 'HUB',
      inPort: '0',
      frame: frame({ vlan: null, dst: defaults.broadcastMac }),
    });
    const bridged = result.hops.filter((hop) => hop.step !== 'hop-budget');
    expect(bridged).toHaveLength(4);
    expect(result.hops.some((hop) => hop.step === 'hop-budget')).toBe(true);
    expect(ctx.hopsLeft).toBe(0);
    const leafHops = bridged.filter((hop) => hop.device.startsWith('L'));
    expect(leafHops.length).toBeLessThan(5);
    expect(result.observations.some((obs) => obs.observation === 'loop')).toBe(
      false,
    );
  });

  it('does not name hop-budget on a chassis that has no bridging function', () => {
    const hub = switchBox(
      'HUB',
      [access('0', 1), access('1', 1), access('2', 1)],
      { vlanAware: false },
    );
    const leaf = switchBox('L1', [access('1', 1), access('2', 1)], {
      vlanAware: false,
    });
    const ctx = createRunContext(
      topo(
        [hub, leaf, host('H1')],
        [
          link('h', { device: 'HUB', port: '1' }, { device: 'H1', port: '1' }),
          link('l', { device: 'HUB', port: '2' }, { device: 'L1', port: '1' }),
        ],
      ),
    );
    ctx.hopsLeft = 1;
    const result = walkFrame(ctx, {
      device: 'HUB',
      inPort: '0',
      frame: frame({ vlan: null, dst: defaults.broadcastMac }),
    });
    const budget = result.hops.find((hop) => hop.step === 'hop-budget');
    expect(budget?.device).toBe('L1');
    expect(budget?.device).not.toBe('H1');
  });
});

describe('catalogue row 2', () => {
  const sw1 = switchBox('SW1', [
    access('1', 10),
    trunk('2', [], { pvid: 10, untagged: [10] }),
  ]);
  const sw2 = switchBox('SW2', [
    trunk('1', [], { pvid: 20, untagged: [20] }),
    access('2', 20),
  ]);
  const topology = topo(
    [sw1, sw2],
    [link('t', { device: 'SW1', port: '2' }, { device: 'SW2', port: '1' })],
  );

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: null }),
    });
    const leak = result.observations.find((obs) => obs.observation === 'vlan-leak');
    expect(result.hops[0]?.device).toBe('SW1');
    expect(result.hops[0]?.fn).toBe('br');
    expect(result.hops[0]?.vlan).toBe(10);
    expect(result.hops[1]?.device).toBe('SW2');
    expect(result.hops[1]?.vlan).toBe(20);
    expect(leak?.facts.fromVlan).toBe(10);
    expect(leak?.facts.toVlan).toBe(20);
    expect(leak?.facts.devices).toEqual(['SW1', 'SW2']);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row2).toBeDefined();
    const ctx = createRunContext(topology);
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: null }),
    });
    const leak = result.observations.find((obs) => obs.observation === 'vlan-leak');
    expect(leak).toBeDefined();
    if (!leak || !row2) return;
    expect(format(observationAsFormatInput(leak))).toBe(row2.expected);
  });

  it('keeps both vlan-leak observations when two mismatches sit on the path', () => {
    const sw1 = switchBox('SW1', [
      access('1', 10),
      trunk('2', [], { pvid: 10, untagged: [10] }),
    ]);
    const sw2 = switchBox('SW2', [
      trunk('1', [], { pvid: 20, untagged: [20] }),
      trunk('2', [], { pvid: 20, untagged: [20] }),
    ]);
    const sw3 = switchBox('SW3', [
      trunk('1', [], { pvid: 30, untagged: [30] }),
      access('2', 30),
    ]);
    const ctx = createRunContext(
      topo(
        [sw1, sw2, sw3],
        [
          link('a', { device: 'SW1', port: '2' }, { device: 'SW2', port: '1' }),
          link('b', { device: 'SW2', port: '2' }, { device: 'SW3', port: '1' }),
        ],
      ),
    );
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: null, dst: defaults.broadcastMac }),
    });
    const leaks = result.observations.filter((obs) => obs.observation === 'vlan-leak');
    expect(leaks).toHaveLength(2);
    expect(leaks[0]?.facts).toEqual({
      fromVlan: 10,
      toVlan: 20,
      devices: ['SW1', 'SW2'],
    });
    expect(leaks[1]?.facts).toEqual({
      fromVlan: 20,
      toVlan: 30,
      devices: ['SW2', 'SW3'],
    });
  });
});

describe('catalogue row 5', () => {
  const usw = switchBox(
    'USW',
    [access('1', 1), access('2', 1), access('3', 1), access('4', 1), access('5', 1)],
    { vlanAware: false },
  );

  it('is green structurally', () => {
    const ctx = createRunContext(topo([usw]));
    const result = walkFrame(ctx, {
      device: 'USW',
      inPort: '1',
      frame: frame({ vlan: null, dst: defaults.broadcastMac }),
    });
    expect(result.hops[0]?.device).toBe('USW');
    expect(result.hops[0]?.fn).toBe('br');
    expect(result.hops[0]?.action).toBe('flooded');
    expect(result.hops[0]?.step).toBe('egress-tagging');
    const flood = result.observations.find(
      (obs) => obs.observation === 'unmanaged-flood',
    );
    expect(flood?.facts.portCount).toBe(5);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row5).toBeDefined();
    const ctx = createRunContext(topo([usw]));
    const result = walkFrame(ctx, {
      device: 'USW',
      inPort: '1',
      frame: frame({ vlan: null, dst: defaults.broadcastMac }),
    });
    const flood = result.observations.find(
      (obs) => obs.observation === 'unmanaged-flood',
    );
    expect(flood).toBeDefined();
    if (!flood || !row5) return;
    expect(format(observationAsFormatInput(flood))).toBe(row5.expected);
  });
});

describe('catalogue row 6', () => {
  const usw1 = switchBox(
    'USW1',
    [access('1', 1), access('2', 1)],
    { vlanAware: false },
  );
  const usw2 = switchBox(
    'USW2',
    [access('1', 1), access('2', 1)],
    { vlanAware: false },
  );
  const topology = topo(
    [usw1, usw2],
    [
      link('a', { device: 'USW1', port: '1' }, { device: 'USW2', port: '1' }),
      link('b', { device: 'USW1', port: '2' }, { device: 'USW2', port: '2' }),
    ],
  );

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    expect(ctx.stp.has('USW1')).toBe(false);
    expect(ctx.stp.has('USW2')).toBe(false);
    expect(portState(ctx, 'USW1', '1')).toBe('forwarding');
    expect(portState(ctx, 'USW2', '1')).toBe('forwarding');
    const result = walkFrame(ctx, {
      device: 'USW1',
      inPort: '1',
      frame: frame({ vlan: null, dst: defaults.broadcastMac }),
    });
    const budget = result.hops.find((hop) => hop.step === 'hop-budget');
    expect(budget?.reasonCode).toBe('hop-budget:dropped');
    expect(budget?.action).toBe('dropped');
    expect(ctx.hopsLeft).toBe(0);
    const loop = result.observations.find((obs) => obs.observation === 'loop');
    expect(loop?.facts.count).toBe(50);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row6).toBeDefined();
    const ctx = createRunContext(topology);
    const result = walkFrame(ctx, {
      device: 'USW1',
      inPort: '1',
      frame: frame({ vlan: null, dst: defaults.broadcastMac }),
    });
    const loop = result.observations.find((obs) => obs.observation === 'loop');
    expect(loop).toBeDefined();
    if (!loop || !row6) return;
    expect(format(observationAsFormatInput(loop))).toBe(row6.expected);
  });

  it('exhausts the budget because neither chassis has an stp function', () => {
    const ctx = createRunContext(topology);
    expect(usw1.functions.some((fn) => fn.kind === 'stp')).toBe(false);
    expect(usw2.functions.some((fn) => fn.kind === 'stp')).toBe(false);
    const result = walkFrame(ctx, {
      device: 'USW1',
      inPort: '1',
      frame: frame({ vlan: null, dst: defaults.broadcastMac }),
    });
    expect(result.hops.some((hop) => hop.step === 'hop-budget')).toBe(true);
    expect(result.observations.some((obs) => obs.observation === 'loop')).toBe(
      true,
    );
  });

  it('names a loop on the cycling unmanaged pair even if the walk entered from STP', () => {
    const msw = switchBox(
      'MSW',
      [access('1', 1), access('2', 1)],
      { stp: true, mac: 'aa:00:00:00:00:99' },
    );
    const a = switchBox(
      'USW-A',
      [access('1', 1), access('2', 1), access('3', 1)],
      { vlanAware: false },
    );
    const b = switchBox(
      'USW-B',
      [access('1', 1), access('2', 1)],
      { vlanAware: false },
    );
    const ctx = createRunContext(
      topo(
        [msw, a, b, host('H1')],
        [
          link('h', { device: 'MSW', port: '1' }, { device: 'H1', port: '1' }),
          link('m', { device: 'MSW', port: '2' }, { device: 'USW-A', port: '1' }),
          link('x', { device: 'USW-A', port: '2' }, { device: 'USW-B', port: '1' }),
          link('y', { device: 'USW-A', port: '3' }, { device: 'USW-B', port: '2' }),
        ],
      ),
    );
    expect(portState(ctx, 'MSW', '1')).toBe('forwarding');
    const result = walkFrame(ctx, {
      device: 'MSW',
      inPort: '1',
      frame: frame({ vlan: null, dst: defaults.broadcastMac }),
    });
    const loop = result.observations.find((obs) => obs.observation === 'loop');
    expect(loop?.observation).toBe('loop');
    expect(loop?.facts.count).toBeGreaterThan(1);
  });
});

describe('catalogue row 16', () => {
  const sw1 = switchBox('SW1', [
    access('1', 10),
    access('2', 10),
    access('3', 10),
  ]);
  const sw2 = switchBox('SW2', [
    access('1', 10),
    access('2', 10),
    access('3', 10),
  ]);
  const topology = topo(
    [sw1, sw2],
    [
      link('a', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' }),
      link('b', { device: 'SW1', port: '2' }, { device: 'SW2', port: '2' }),
    ],
  );
  const src: MacAddr = 'aa:bb:cc:dd:ee:01';

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    expect(ctx.stp.has('SW1')).toBe(false);
    expect(ctx.stp.has('SW2')).toBe(false);
    const result = walkFrame(ctx, {
      device: 'SW2',
      inPort: '3',
      frame: frame({ src, vlan: null, dst: defaults.broadcastMac }),
    });
    const flap = result.observations.find((obs) => obs.observation === 'mac-flap');
    expect(flap?.facts.mac).toBe(src);
    expect(flap?.facts.port).toBe('1');
    expect(flap?.facts.otherPort).toBe('2');
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row16).toBeDefined();
    const ctx = createRunContext(topology);
    const result = walkFrame(ctx, {
      device: 'SW2',
      inPort: '3',
      frame: frame({ src, vlan: null, dst: defaults.broadcastMac }),
    });
    const flap = result.observations.find((obs) => obs.observation === 'mac-flap');
    expect(flap).toBeDefined();
    if (!flap || !row16) return;
    expect(format(observationAsFormatInput(flap))).toBe(row16.expected);
  });
});

describe('catalogue row 17', () => {
  const sw1 = switchBox(
    'SW1',
    [trunk('1', [10]), trunk('2', [10]), access('3', 10)],
    { stp: true, mac: 'aa:00:00:00:00:02' },
  );
  const sw2 = switchBox(
    'SW2',
    [trunk('1', [10]), trunk('2', [10]), access('3', 10)],
    { stp: true, mac: 'aa:00:00:00:00:01' },
  );
  const sw3 = switchBox(
    'SW3',
    [trunk('1', [10]), trunk('2', [10])],
    { stp: true, mac: 'aa:00:00:00:00:03', priority: 4096 },
  );
  const topology = topo(
    [sw1, sw2, sw3, host('H1'), host('H2')],
    [
      link('12', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' }),
      link('13', { device: 'SW1', port: '2' }, { device: 'SW3', port: '1' }),
      link('23', { device: 'SW2', port: '2' }, { device: 'SW3', port: '2' }),
      link('h1', { device: 'SW1', port: '3' }, { device: 'H1', port: '1' }),
      link('h2', { device: 'SW2', port: '3' }, { device: 'H2', port: '1' }),
    ],
  );
  const dest: MacAddr = 'aa:00:00:00:00:20';

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    expect(portState(ctx, 'SW1', '1')).toBe('blocking');
    learn(ctx, 10, dest, 'SW1', '2');
    learn(ctx, 10, dest, 'SW3', '2');
    learn(ctx, 10, dest, 'SW2', '3');
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '3',
      frame: frame({ vlan: null, dst: dest }),
    });
    const forwarded = result.hops.filter((hop) => hop.action !== 'dropped');
    expect(forwarded.map((hop) => hop.device)).toEqual(['SW1', 'SW3', 'SW2']);
    const root = result.observations.find((obs) => obs.observation === 'stp-root');
    expect(root?.facts.devices).toEqual(['SW3']);
    expect(root?.facts.priority).toBe(4096);
    expect(root?.facts.path).toEqual(['SW1', 'SW2']);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row17).toBeDefined();
    const ctx = createRunContext(topology);
    learn(ctx, 10, dest, 'SW1', '2');
    learn(ctx, 10, dest, 'SW3', '2');
    learn(ctx, 10, dest, 'SW2', '3');
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '3',
      frame: frame({ vlan: null, dst: dest }),
    });
    const root = result.observations.find((obs) => obs.observation === 'stp-root');
    expect(root).toBeDefined();
    if (!root || !row17) return;
    expect(format(observationAsFormatInput(root))).toBe(row17.expected);
  });
});
