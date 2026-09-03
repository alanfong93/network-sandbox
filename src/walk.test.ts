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
import { createRunContext, getResolvedMac, learn, portState } from './run';
import { resolveKey } from './host';
import { observationAsFormatInput, walkFrame } from './walk';

function trunk(
  port: string,
  tagged: VlanId[],
  opts?: {
    pvid?: VlanId;
    untagged?: VlanId[];
    filtering?: boolean;
    frames?: BridgePort['acceptableFrameTypes'];
  },
): BridgePort {
  return {
    port,
    mode: 'trunk',
    pvid: opts?.pvid ?? 1,
    taggedVlans: new Set(tagged),
    untaggedVlans: new Set(opts?.untagged ?? []),
    acceptableFrameTypes: opts?.frames ?? 'all',
    ingressFiltering: opts?.filtering ?? true,
  };
}

function access(
  port: string,
  vlan: VlanId,
  opts?: { filtering?: boolean; frames?: BridgePort['acceptableFrameTypes'] },
): BridgePort {
  return {
    port,
    mode: 'access',
    pvid: vlan,
    taggedVlans: new Set(),
    untaggedVlans: new Set([vlan]),
    acceptableFrameTypes: opts?.frames ?? 'all',
    ingressFiltering: opts?.filtering ?? true,
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

function host(
  id: string,
  opts?: { mac?: MacAddr; ip?: string; vlan?: VlanId },
): Chassis {
  const chassis: Chassis = {
    id,
    label: id,
    ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'none' }],
    radios: [],
    functions: [],
    internal: [],
  };
  if (opts?.mac !== undefined) chassis.mac = opts.mac;
  if (opts?.ip !== undefined) chassis.ip = opts.ip;
  if (opts?.vlan !== undefined) chassis.vlan = opts.vlan;
  return chassis;
}

function link(
  id: string,
  a: { device: string; port: string },
  b: { device: string; port: string },
  medium: Link['medium'] = 'wired',
): Link {
  return { id, a, b, medium };
}

function accessPoint(
  id: string,
  opts: { ssid: string; vlan: VlanId; uplink: BridgePort },
): Chassis {
  const wifi = access('wifi', opts.vlan);
  return {
    id,
    label: id,
    ports: [
      { id: 'wifi', mtu: defaults.portMtu, ownedBy: 'wlan' },
      { id: opts.uplink.port, mtu: defaults.portMtu, ownedBy: 'br' },
    ],
    radios: [{ id: 'radio0', band: '5' }],
    functions: [
      {
        kind: 'wireless',
        id: 'wlan',
        radio: 'radio0',
        mode: 'ap',
        ssid: opts.ssid,
        vlan: opts.vlan,
      },
      {
        kind: 'bridging',
        id: 'br',
        vlanAware: true,
        members: [wifi, opts.uplink],
        fdb: new Map(),
      },
    ],
    internal: [{ from: 'wlan', to: 'br' }],
  };
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

const row1 = CATALOGUE.find((row) => row.id === 1);
const row2 = CATALOGUE.find((row) => row.id === 2);
const row4 = CATALOGUE.find((row) => row.id === 4);
const row5 = CATALOGUE.find((row) => row.id === 5);
const row6 = CATALOGUE.find((row) => row.id === 6);
const row16 = CATALOGUE.find((row) => row.id === 16);
const row17 = CATALOGUE.find((row) => row.id === 17);
const row18 = CATALOGUE.find((row) => row.id === 18);

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

describe('wireless dispatch', () => {
  it('classifies a client on an SSID then hops on the chassis bridge', () => {
    const ap = accessPoint('AP1', {
      ssid: 'guest',
      vlan: 30,
      uplink: access('1', 30),
    });
    const ctx = createRunContext(
      topo(
        [ap, host('C1')],
        [
          link(
            'w',
            { device: 'C1', port: '1' },
            { device: 'AP1', port: 'wifi' },
            'wireless',
          ),
        ],
      ),
    );
    const result = walkFrame(ctx, {
      device: 'AP1',
      inPort: 'wifi',
      frame: frame({ vlan: null, dst: defaults.broadcastMac }),
      arrivedFrom: 'C1',
    });
    expect(result.hops[0]?.device).toBe('AP1');
    expect(result.hops[0]?.fn).toBe('wlan');
    expect(result.hops[0]?.inPort).toBe('wifi');
    expect(result.hops[0]?.step).toBe('ssid-vlan');
    expect(result.hops[0]?.reasonCode).toBe('ssid-vlan:classified');
    expect(result.hops[0]?.vlan).toBe(30);
    expect(result.hops[0]?.action).toBe('forwarded');
    expect(result.hops[1]?.device).toBe('AP1');
    expect(result.hops[1]?.fn).toBe('br');
  });

  it('names an unknown ownedBy even when a wireless function is present', () => {
    const ap = accessPoint('AP1', {
      ssid: 'guest',
      vlan: 30,
      uplink: access('1', 30),
    });
    ap.ports.push({ id: 'x', mtu: defaults.portMtu, ownedBy: 'ghost' });
    const ctx = createRunContext(topo([ap]));
    const result = walkFrame(ctx, {
      device: 'AP1',
      inPort: 'x',
      frame: frame({ vlan: null }),
    });
    expect(result.hops[0]?.device).toBe('AP1');
    expect(result.hops[0]?.fn).toBeUndefined();
    expect(result.hops[0]?.step).toBe('delivery');
    expect(result.hops[0]?.action).toBe('dropped');
    expect(ctx.hopsLeft).toBe(defaults.maxHops);
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
    [trunk('1', [10]), trunk('2', [10]), access('3', 10), access('4', 10)],
    { stp: true, mac: 'aa:00:00:00:00:01' },
  );
  const sw3 = switchBox(
    'SW3',
    [trunk('1', [10]), trunk('2', [10])],
    { stp: true, mac: 'aa:00:00:00:00:03', priority: 4096 },
  );
  const sw4 = switchBox('SW4', [access('1', 10), access('2', 10)]);
  const topology = topo(
    [sw1, sw2, sw3, sw4, host('H1'), host('H2')],
    [
      link('12', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' }),
      link('13', { device: 'SW1', port: '2' }, { device: 'SW3', port: '1' }),
      link('23', { device: 'SW2', port: '2' }, { device: 'SW3', port: '2' }),
      link('h1', { device: 'SW1', port: '3' }, { device: 'H1', port: '1' }),
      link('h2', { device: 'SW2', port: '3' }, { device: 'H2', port: '1' }),
      link('24', { device: 'SW2', port: '4' }, { device: 'SW4', port: '1' }),
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

  it('names stp-root on a cold FDB, not only a pre-learned path', () => {
    const ctx = createRunContext(topology);
    expect(portState(ctx, 'SW1', '1')).toBe('blocking');
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '3',
      frame: frame({ vlan: null, dst: dest }),
    });
    const root = result.observations.find((obs) => obs.observation === 'stp-root');
    expect(root?.facts.devices).toEqual(['SW3']);
    expect(root?.facts.priority).toBe(4096);
    expect(root?.facts.path).toEqual(['SW1', 'SW2']);
  });
});

describe('catalogue row 1', () => {
  // Two managed switches; VLAN 20 is missing from SW2's egress membership on
  // port 3, so a known-unicast VLAN 20 frame drops at egress-membership.
  const dest: MacAddr = 'aa:00:00:00:00:20';
  const sw1 = switchBox('SW1', [
    access('1', 20),
    trunk('2', [10, 20]),
  ]);
  const sw2 = switchBox('SW2', [
    trunk('1', [10, 20]),
    trunk('3', [10]),
  ]);
  const topology = topo(
    [sw1, sw2],
    [link('t', { device: 'SW1', port: '2' }, { device: 'SW2', port: '1' })],
  );

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    learn(ctx, 20, dest, 'SW2', '3');
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: null, dst: dest }),
    });
    const hop = result.hops.find((hop) => hop.device === 'SW2');
    expect(hop?.device).toBe('SW2');
    expect(hop?.fn).toBe('br');
    expect(hop?.inPort).toBe('1');
    expect(hop?.outPort).toBe('3');
    expect(hop?.vlan).toBe(20);
    expect(hop?.action).toBe('dropped');
    expect(hop?.step).toBe('egress-membership');
    expect(hop?.reasonCode).toBe('egress-membership:dropped');
    // The drop survives a wording-only change: nothing else in the trace
    // pretends the frame was forwarded or delivered.
    expect(
      result.hops.some((hop) => hop.device === 'SW2' && hop.action !== 'dropped'),
    ).toBe(false);
    expect(result.observations).toEqual([]);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row1).toBeDefined();
    const ctx = createRunContext(topology);
    learn(ctx, 20, dest, 'SW2', '3');
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: null, dst: dest }),
    });
    const hop = result.hops.find(
      (hop) =>
        hop.device === 'SW2' &&
        hop.step === 'egress-membership' &&
        hop.action === 'dropped',
    );
    expect(hop).toBeDefined();
    if (!hop || !row1) return;
    expect(hop.reason).toBe(row1.expected);
  });
});

describe('catalogue row 4', () => {
  // Access port with ingress filtering disabled, tagged VLAN 20 frame
  // arriving; the hop records ingress-filtering:admitted, not a silent
  // classify, and the frame is delivered on the VLAN 20 trunk.
  const dest: MacAddr = 'aa:00:00:00:00:20';
  const sw1 = switchBox('SW1', [
    access('1', 10, { filtering: false }),
    trunk('2', [10, 20]),
  ]);
  const topology = topo(
    [sw1, host('H20', { mac: dest, ip: '192.168.20.20', vlan: 20 })],
    [
      link(
        'h',
        { device: 'SW1', port: '2' },
        { device: 'H20', port: '1' },
      ),
    ],
  );

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    learn(ctx, 20, dest, 'SW1', '2');
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: 20, dst: dest }),
    });
    const admitted = result.hops.find(
      (hop) =>
        hop.device === 'SW1' &&
        hop.step === 'ingress-filtering' &&
        hop.action === 'forwarded',
    );
    expect(admitted?.fn).toBe('br');
    expect(admitted?.inPort).toBe('1');
    expect(admitted?.outPort).toBe('2');
    expect(admitted?.vlan).toBe(20);
    expect(admitted?.reasonCode).toBe('ingress-filtering:admitted');
    const delivered = result.hops.find(
      (hop) =>
        hop.device === 'H20' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(delivered?.reasonCode).toBe('delivery:delivered');
    expect(result.deliveredFrame?.vlan).toBe(20);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row4).toBeDefined();
    const ctx = createRunContext(topology);
    learn(ctx, 20, dest, 'SW1', '2');
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: 20, dst: dest }),
    });
    const admitted = result.hops.find(
      (hop) =>
        hop.device === 'SW1' &&
        hop.step === 'ingress-filtering' &&
        hop.action === 'forwarded',
    );
    expect(admitted).toBeDefined();
    if (!admitted || !row4) return;
    expect(admitted.reason).toBe(row4.expected);
  });
});

describe('catalogue row 18', () => {
  // Trunk tagged-only on SW1 port 2, SW2 sends an untagged frame from its
  // access port; the untagged frame is dropped at SW1's ingress on
  // acceptable-frame-types.
  const sw1 = switchBox('SW1', [
    trunk('1', [10, 20]),
    trunk('2', [10, 20], { frames: 'tagged-only', untagged: [] }),
  ]);
  const sw2 = switchBox('SW2', [
    access('1', 10),
    trunk('2', [10, 20], { untagged: [10] }),
  ]);
  const topology = topo(
    [sw1, sw2],
    [link('t', { device: 'SW1', port: '2' }, { device: 'SW2', port: '2' })],
  );

  function sendFromSw2(ctx: ReturnType<typeof createRunContext>) {
    return walkFrame(ctx, {
      device: 'SW2',
      inPort: '1',
      frame: frame({ vlan: null, dst: 'aa:00:00:00:00:20' }),
    });
  }

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = sendFromSw2(ctx);
    const drop = result.hops.find(
      (hop) => hop.device === 'SW1' && hop.step === 'acceptable-frame-types',
    );
    expect(drop?.device).toBe('SW1');
    expect(drop?.fn).toBe('br');
    expect(drop?.inPort).toBe('2');
    expect(drop?.action).toBe('dropped');
    expect(drop?.reasonCode).toBe('acceptable-frame-types:dropped');
    // The untagged frame never traverses: SW1's other port never emits it
    // and no observation fires.
    expect(
      result.hops.some((hop) => hop.device === 'SW1' && hop.action !== 'dropped'),
    ).toBe(false);
    expect(result.observations).toEqual([]);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row18).toBeDefined();
    const ctx = createRunContext(topology);
    const result = sendFromSw2(ctx);
    const drop = result.hops.find(
      (hop) =>
        hop.device === 'SW1' &&
        hop.step === 'acceptable-frame-types' &&
        hop.action === 'dropped',
    );
    expect(drop).toBeDefined();
    if (!drop || !row18) return;
    expect(drop.reason).toBe(row18.expected);
  });
});

describe('bridge-to-SVI composition (the L3 switch)', () => {
  // SPEC sections 2-3: one chassis, bridging + stp + routing, hosts on
  // access VLANs 10 and 20, and the routing function reachable from the
  // bridging ports through switch virtual interfaces (RouterIface.vlan).
  function l3Switch(id: string, members: BridgePort[]): Chassis {
    // SVIs are bridging members of their VLAN — the bridge's internal
    // interface to the route processor. Each SVI port is owned by the
    // routing function (RouterIface.id is the SVI port id, the sub-interface
    // shape), and an InternalEdge hands routed egress back to the bridge so
    // a routed frame re-enters its destination VLAN exactly as an externally
    // forwarded frame would.
    const svi10: BridgePort = {
      port: 'svi10',
      mode: 'access',
      pvid: 10,
      taggedVlans: new Set<VlanId>(),
      untaggedVlans: new Set<VlanId>([10]),
      acceptableFrameTypes: 'all',
      ingressFiltering: true,
    };
    const svi20: BridgePort = {
      port: 'svi20',
      mode: 'access',
      pvid: 20,
      taggedVlans: new Set<VlanId>(),
      untaggedVlans: new Set<VlanId>([20]),
      acceptableFrameTypes: 'all',
      ingressFiltering: true,
    };
    const chassis = switchBox(id, [...members, svi10, svi20], { stp: true });
    // SVI ports are owned by the routing function, not the bridge — the
    // bridge carries them as members, routing owns the port.
    for (const port of chassis.ports) {
      if (port.id === 'svi10' || port.id === 'svi20') port.ownedBy = 'rt';
    }
    chassis.internal.push({ from: 'rt', to: 'br' });
    chassis.functions.push({
      kind: 'routing',
      id: 'rt',
      ifaces: [
        {
          id: 'svi10',
          vlan: 10,
          ip: '192.168.10.1',
          prefix: 24,
          mac: 'aa:00:00:00:10:01',
        },
        {
          id: 'svi20',
          vlan: 20,
          ip: '192.168.20.1',
          prefix: 24,
          mac: 'aa:00:00:00:20:01',
        },
      ],
      routes: [],
      firewall: [],
    });
    return chassis;
  }

  function l3Topology(opts?: { hostVlans?: [VlanId, VlanId] }): Topology {
    const [vlanA, vlanB] = opts?.hostVlans ?? [10, 20];
    const sw = l3Switch('SW1', [access('1', 10), access('2', 20)]);
    const h1 = host('H10', {
      mac: 'aa:00:00:00:00:10',
      ip: `192.168.${vlanA}.10`,
      vlan: vlanA,
    });
    const h2 = host('H20', {
      mac: 'aa:00:00:00:00:20',
      ip: `192.168.${vlanB}.20`,
      vlan: vlanB,
    });
    return topo(
      [sw, h1, h2],
      [
        link('a', { device: 'SW1', port: '1' }, { device: 'H10', port: '1' }),
        link('b', { device: 'SW1', port: '2' }, { device: 'H20', port: '1' }),
      ],
    );
  }

  it('answers ARP for the VLAN-10 SVI gateway from the bridging port', () => {
    const ctx = createRunContext(l3Topology());
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:10',
        dstMac: defaults.broadcastMac,
        vlan: 10,
        size: 64,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: { kind: 'arp', srcIp: '192.168.10.10', dstIp: '192.168.10.1' },
        hops: [],
      },
    });
    const reply = result.hops.find(
      (hop) => hop.device === 'SW1' && hop.step === 'arp',
    );
    expect(reply?.fn).toBe('rt');
    expect(reply?.action).toBe('delivered');
    expect(reply?.reasonCode).toBe('arp:delivered');
    // The ARP reply carries the SVI's MAC and returns to the host that asked.
    const atHost = result.hops.find(
      (hop) => hop.device === 'H10' && hop.step === 'arp',
    );
    expect(atHost?.action).toBe('delivered');
    const arpReply = result.hops.some(
      (hop) => hop.device === 'H10' && hop.step === 'arp' && hop.action === 'delivered',
    );
    expect(arpReply).toBe(true);
  });

  it('routes a VLAN-10 frame to VLAN 20 through the chassis, once', () => {
    const ctx = createRunContext(l3Topology());
    // Resolve the gateway MAC first (same-run ARP, ADR 0010).
    const arp = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:10',
        dstMac: defaults.broadcastMac,
        vlan: 10,
        size: 64,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: { kind: 'arp', srcIp: '192.168.10.10', dstIp: '192.168.10.1' },
        hops: [],
      },
    });
    expect(arp.deliveredFrame).toBeUndefined();
    expect(
      arp.hops.some(
        (hop) => hop.device === 'SW1' && hop.step === 'arp' && hop.action === 'delivered',
      ),
    ).toBe(true);
    const gatewayMac = getResolvedMac(ctx, resolveKey('H10', '192.168.10.1'));
    expect(gatewayMac).toBe('aa:00:00:00:10:01');
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:10',
        dstMac: gatewayMac,
        vlan: 10,
        size: 128,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp: '192.168.20.20' },
        hops: [],
      },
    });
    const routeHop = result.hops.find(
      (hop) => hop.device === 'SW1' && hop.step === 'route-lookup',
    );
    expect(routeHop?.fn).toBe('rt');
    expect(routeHop?.action).toBe('forwarded');
    expect(routeHop?.reasonCode).toBe('route-lookup:forwarded');
    const delivered = result.hops.find(
      (hop) => hop.device === 'H20' && hop.step === 'delivery',
    );
    expect(delivered?.action).toBe('delivered');
    expect(result.deliveredFrame?.payload).toMatchObject({
      kind: 'icmp',
      srcIp: '192.168.10.10',
      dstIp: '192.168.20.20',
    });
    // Routed exactly once: no second route-lookup hop on the chassis.
    expect(
      result.hops.filter(
        (hop) => hop.device === 'SW1' && hop.step === 'route-lookup',
      ).length,
    ).toBe(1);
    // The original VLAN-10 frame is not also bridged out another VLAN-10
    // port: the only egress-tagging forwards on SW1 carry the routed
    // VLAN-20 frame out the destination port, never the VLAN-10 original.
    expect(
      result.hops.some(
        (hop) =>
          hop.device === 'SW1' &&
          hop.step === 'egress-tagging' &&
          hop.action !== 'dropped' &&
          hop.vlan === 10,
      ),
    ).toBe(false);
  });

  it('does not bypass spanning tree: a blocking bridging port never reaches the SVI', () => {
    // Two parallel trunks between SW1 (the L3 switch) and SW2: STP blocks
    // one, so an SVI ARP arriving on the blocking port dies at stp-ingress
    // before the routing function is ever consulted.
    const sw1 = l3Switch('SW1', [
      access('3', 10),
      trunk('1', [10, 20]),
      trunk('2', [10, 20]),
    ]);
    const sw2 = switchBox('SW2', [trunk('1', [10, 20]), trunk('2', [10, 20])], {
      stp: true,
      mac: 'aa:00:00:00:00:02',
      priority: 4096,
    });
    const topology = topo(
      [sw1, sw2],
      [
        link('t1', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' }),
        link('t2', { device: 'SW1', port: '2' }, { device: 'SW2', port: '2' }),
      ],
    );
    const ctx = createRunContext(topology);
    const blockedPort =
      portState(ctx, 'SW1', '1') === 'blocking' ? '1' : '2';
    expect(portState(ctx, 'SW1', blockedPort)).toBe('blocking');
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: blockedPort,
      frame: {
        srcMac: 'aa:00:00:00:00:10',
        dstMac: defaults.broadcastMac,
        vlan: 10,
        size: 64,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: { kind: 'arp', srcIp: '192.168.10.10', dstIp: '192.168.10.1' },
        hops: [],
      },
    });
    const drop = result.hops.find(
      (hop) => hop.device === 'SW1' && hop.step === 'stp-ingress',
    );
    expect(drop?.action).toBe('dropped');
    expect(drop?.reasonCode).toBe('stp-ingress:dropped');
    expect(
      result.hops.some((hop) => hop.device === 'SW1' && hop.step === 'arp'),
    ).toBe(false);
  });

  it('does not steal a frame arriving on a different bridge of the same chassis', () => {
    // A chassis may carry more than one bridging function. The SVI belongs
    // to bridge brA; a frame arriving on brB's port for VLAN 10 addressed to
    // the SVI MAC is brB's traffic and must bridge, never route.
    const svi10: BridgePort = {
      port: 'svi10',
      mode: 'access',
      pvid: 10,
      taggedVlans: new Set<VlanId>(),
      untaggedVlans: new Set<VlanId>([10]),
      acceptableFrameTypes: 'all',
      ingressFiltering: true,
    };
    const sw = switchBox('SW1', [access('p', 10)], { stp: true });
    // Second bridge on the same chassis: its member port q is VLAN 10 too.
    sw.functions.push({
      kind: 'bridging',
      id: 'brB',
      vlanAware: true,
      members: [
        access('q', 10),
        { ...svi10, port: 'q2' },
      ],
      fdb: new Map(),
    });
    sw.ports.push({ id: 'q', mtu: defaults.portMtu, ownedBy: 'brB' });
    sw.ports.push({ id: 'q2', mtu: defaults.portMtu, ownedBy: 'brB' });
    // SVI on brA only.
    sw.functions.push({
      kind: 'bridging',
      id: 'brA',
      vlanAware: true,
      members: [access('p', 10), svi10],
      fdb: new Map(),
    });
    for (const port of sw.ports) {
      if (port.id === 'svi10') port.ownedBy = 'rt';
    }
    sw.internal.push({ from: 'rt', to: 'brA' });
    sw.functions.push({
      kind: 'routing',
      id: 'rt',
      ifaces: [
        { id: 'svi10', vlan: 10, ip: '192.168.10.1', prefix: 24, mac: 'aa:00:00:00:10:01' },
      ],
      routes: [],
      firewall: [],
    });
    const ctx = createRunContext(topo([sw]));
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: 'q',
      frame: {
        srcMac: 'aa:00:00:00:00:99',
        dstMac: 'aa:00:00:00:10:01',
        vlan: 10,
        size: 64,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: { kind: 'icmp', srcIp: '192.168.10.99', dstIp: '192.168.20.20' },
        hops: [],
      },
    });
    expect(
      result.hops.some(
        (hop) => hop.device === 'SW1' && hop.step === 'route-lookup',
      ),
    ).toBe(false);
    // brB bridges its own member ports; the frame never enters rt.
    expect(
      result.hops.some((hop) => hop.fn === 'brB'),
    ).toBe(true);
  });

  it('answers the SVI on the second bridge of a multi-edge chassis', () => {
    // rt is SVI-attached to two bridges; the FIRST internal edge points at
    // brA, but this SVI port is a member of brB. The lookup must consider
    // every rt->fn edge, not just the first drawn.
    const svi30: BridgePort = {
      port: 'svi30',
      mode: 'access',
      pvid: 30,
      taggedVlans: new Set<VlanId>(),
      untaggedVlans: new Set<VlanId>([30]),
      acceptableFrameTypes: 'all',
      ingressFiltering: true,
    };
    const sw = switchBox('SW1', [access('p', 30)], { stp: true });
    sw.functions.push({
      kind: 'bridging',
      id: 'brA',
      vlanAware: true,
      members: [access('a1', 99)],
      fdb: new Map(),
    });
    sw.functions.push({
      kind: 'bridging',
      id: 'brB',
      vlanAware: true,
      members: [access('q', 30), svi30],
      fdb: new Map(),
    });
    sw.ports.push({ id: 'q', mtu: defaults.portMtu, ownedBy: 'brB' });
    sw.ports.push({ id: 'a1', mtu: defaults.portMtu, ownedBy: 'brA' });
    sw.ports.push({ id: 'svi30', mtu: defaults.portMtu, ownedBy: 'rt' });
    // brA edge FIRST — the lookup must not stop at it.
    sw.internal.push({ from: 'rt', to: 'brA' });
    sw.internal.push({ from: 'rt', to: 'brB' });
    sw.functions.push({
      kind: 'routing',
      id: 'rt',
      ifaces: [
        { id: 'svi30', vlan: 30, ip: '192.168.30.1', prefix: 24, mac: 'aa:00:00:00:30:01' },
      ],
      routes: [],
      firewall: [],
    });
    const ctx = createRunContext(topo([sw]));
    const result = walkFrame(ctx, {
      device: 'SW1',
      inPort: 'q',
      frame: {
        srcMac: 'aa:00:00:00:00:30',
        dstMac: defaults.broadcastMac,
        vlan: 30,
        size: 64,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: { kind: 'arp', srcIp: '192.168.30.10', dstIp: '192.168.30.1' },
        hops: [],
      },
    });
    const reply = result.hops.find(
      (hop) => hop.device === 'SW1' && hop.step === 'arp',
    );
    expect(reply?.fn).toBe('rt');
    expect(reply?.action).toBe('delivered');
    expect(reply?.reasonCode).toBe('arp:delivered');
  });
});
