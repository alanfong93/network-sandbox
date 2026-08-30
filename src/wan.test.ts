import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import {
  builtinProfile,
  defaults,
  usableMtu,
  type EngineProfile,
} from './defaults';
import { format } from './format';
import type {
  BridgePort,
  Chassis,
  Fn,
  Link,
  MacAddr,
  Route,
  RouterIface,
  Topology,
  VlanId,
} from './model';
import { createRunContext } from './run';
import { send } from './send';
import { observationAsFormatInput, walkFrame } from './walk';

function trunk(
  port: string,
  tagged: VlanId[],
  opts?: { pvid?: VlanId },
): BridgePort {
  return {
    port,
    mode: 'trunk',
    pvid: opts?.pvid ?? defaults.pvid,
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

function switchBox(
  id: string,
  members: BridgePort[],
  opts?: { vlanAware?: boolean; stp?: boolean; mac?: MacAddr },
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
      priority: defaults.stp.priority,
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

function routerBox(
  id: string,
  ifaces: RouterIface[],
  extra?: { routes?: Route[]; nat?: boolean },
): Chassis {
  const functions: Fn[] = [
    {
      kind: 'routing',
      id: 'rt',
      ifaces,
      routes: extra?.routes ?? [],
      firewall: [],
    },
  ];
  if (extra?.nat) {
    functions.push({
      kind: 'nat',
      id: 'nat',
      on: 'rt',
      portForwards: [],
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

function ontBox(id: string, vlanTag: VlanId | undefined): Chassis {
  return {
    id,
    label: id,
    ports: [
      { id: '1', mtu: defaults.portMtu, ownedBy: 'isp' },
      { id: '2', mtu: defaults.portMtu, ownedBy: 'isp' },
    ],
    radios: [],
    functions: [
      {
        kind: 'isp-handoff',
        id: 'isp',
        port: '1',
        mode: 'pppoe',
        vlanTag,
      },
    ],
    internal: [],
  };
}

function link(
  id: string,
  a: { device: string; port: string },
  b: { device: string; port: string },
  medium: Link['medium'] = 'wired',
): Link {
  return { id, a, b, medium };
}

function accessPoint(id: string): Chassis {
  const ssids = [
    { fn: 'wlan10', port: 'wifi10', ssid: 'main', vlan: 10 as VlanId },
    { fn: 'wlan20', port: 'wifi20', ssid: 'iot', vlan: 20 as VlanId },
    { fn: 'wlan30', port: 'wifi30', ssid: 'guest', vlan: 30 as VlanId },
  ];
  return {
    id,
    label: id,
    ports: [
      ...ssids.map((item) => ({
        id: item.port,
        mtu: defaults.portMtu,
        ownedBy: item.fn,
      })),
      { id: '1', mtu: defaults.portMtu, ownedBy: 'br' },
    ],
    radios: [{ id: 'radio0', band: '5' }],
    functions: [
      ...ssids.map((item) => ({
        kind: 'wireless' as const,
        id: item.fn,
        radio: 'radio0',
        mode: 'ap' as const,
        ssid: item.ssid,
        vlan: item.vlan,
      })),
      {
        kind: 'bridging',
        id: 'br',
        vlanAware: true,
        members: [
          ...ssids.map((item) => access(item.port, item.vlan)),
          trunk('1', [10, 20, 30]),
        ],
        fdb: new Map(),
      },
    ],
    internal: ssids.map((item) => ({ from: item.fn, to: 'br' })),
  };
}

function meshNode(id: string, ssidVlan: VlanId): Chassis {
  const wifi = access('wifi', ssidVlan);
  return {
    id,
    label: id,
    preset: 'consumer-mesh',
    ports: [
      { id: 'wifi', mtu: defaults.portMtu, ownedBy: 'wlan' },
      { id: '1', mtu: defaults.portMtu, ownedBy: 'br' },
      { id: 'bh', mtu: defaults.portMtu, ownedBy: 'br' },
    ],
    radios: [{ id: 'radio0', band: '5' }],
    functions: [
      {
        kind: 'wireless',
        id: 'wlan',
        radio: 'radio0',
        mode: 'mesh',
        ssid: 'mesh',
        vlan: ssidVlan,
      },
      {
        kind: 'bridging',
        id: 'br',
        vlanAware: true,
        canTag: false,
        members: [
          wifi,
          trunk('1', [10, 20, 30], { pvid: 10 }),
          access('bh', 10),
        ],
        fdb: new Map(),
      },
    ],
    internal: [{ from: 'wlan', to: 'br' }],
  };
}

function topo(devices: Chassis[], links: Link[]): Topology {
  return { devices, links, profiles: [] };
}

/** SPEC.md §9 reference scenario, including AP and mesh. */
function referenceScenario(opts?: {
  wanVlan?: VlanId | null;
  meshSsidVlan?: VlanId;
}): Topology {
  const wanVlan = opts?.wanVlan === undefined ? 500 : opts.wanVlan;
  const meshSsidVlan = opts?.meshSsidVlan ?? 10;
  const wanIface: RouterIface = {
    id: 'wan',
    vlan: wanVlan === null ? undefined : wanVlan,
    ip: '192.0.2.2',
    prefix: 24,
    mac: 'aa:00:00:00:01:02',
  };
  return topo(
    [
      hostBox('H10', {
        mac: 'aa:00:00:00:00:10',
        ip: '192.168.10.10',
        prefix: 24,
        gateway: '192.168.10.1',
      }),
      hostBox('H30', {
        mac: 'aa:00:00:00:00:30',
        ip: '192.168.30.20',
        prefix: 24,
        gateway: '192.168.30.1',
      }),
      hostBox('C30', {
        mac: 'aa:00:00:00:00:31',
        ip: '192.168.30.10',
        prefix: 24,
        gateway: '192.168.30.1',
      }),
      hostBox('CMESH', {
        mac: 'aa:00:00:00:00:12',
        ip: '192.168.10.20',
        prefix: 24,
        gateway: '192.168.10.1',
      }),
      switchBox(
        'USW',
        [
          access('1', 10),
          access('2', 10),
          access('3', 10),
          access('4', 10),
          access('5', 10),
        ],
        { vlanAware: false },
      ),
      switchBox(
        'MSW',
        [
          trunk('1', [10, 20, 30]),
          access('2', 10),
          trunk('3', [10, 20, 30]),
          access('4', 10),
          access('5', 30),
        ],
        { stp: true, mac: 'aa:00:00:00:00:02' },
      ),
      accessPoint('AP'),
      meshNode('MESH1', meshSsidVlan),
      meshNode('MESH2', meshSsidVlan),
      routerBox(
        'RTR',
        [
          {
            id: 'lan',
            vlan: 10,
            ip: '192.168.10.1',
            prefix: 24,
            mac: 'aa:00:00:00:01:01',
          },
          wanIface,
        ],
        {
          routes: [{ dest: '0.0.0.0', prefix: 0, via: '192.0.2.1' }],
          nat: true,
        },
      ),
      ontBox('ONT', 500),
      hostBox('NET', {
        mac: 'aa:00:00:00:00:ee',
        ip: '192.0.2.1',
        prefix: 24,
      }),
    ],
    [
      link('h', { device: 'H10', port: '1' }, { device: 'USW', port: '2' }),
      link('u', { device: 'USW', port: '1' }, { device: 'MSW', port: '2' }),
      link('t', { device: 'MSW', port: '1' }, { device: 'RTR', port: 'lan' }),
      link('w', { device: 'RTR', port: 'wan' }, { device: 'ONT', port: '1' }),
      link('i', { device: 'ONT', port: '2' }, { device: 'NET', port: '1' }),
      link('ap', { device: 'MSW', port: '3' }, { device: 'AP', port: '1' }),
      link('m1', { device: 'MSW', port: '4' }, { device: 'MESH1', port: '1' }),
      link(
        'bh',
        { device: 'MESH1', port: 'bh' },
        { device: 'MESH2', port: 'bh' },
        'wireless',
      ),
      link(
        'g',
        { device: 'C30', port: '1' },
        { device: 'AP', port: 'wifi30' },
        'wireless',
      ),
      link(
        'mc',
        { device: 'CMESH', port: '1' },
        { device: 'MESH2', port: 'wifi' },
        'wireless',
      ),
      link('h30', { device: 'MSW', port: '5' }, { device: 'H30', port: '1' }),
    ],
  );
}

/**
 * The reference scenario with a second WAN attached. Failover is two runs of
 * one topology (ADR 0003): flip `up: false` on the WAN1 link, re-run.
 */
function failoverScenario(opts?: {
  wan1Down?: boolean;
  wan2Default?: boolean;
  policyVlan30?: boolean;
}): Topology {
  const topology = referenceScenario();
  const rtr = topology.devices.find((device) => device.id === 'RTR');
  const rt = rtr?.functions.find((fn) => fn.kind === 'routing');
  if (!rtr || rt?.kind !== 'routing') throw new Error('fixture: RTR routing missing');
  rtr.ports.push({ id: 'wan2', mtu: defaults.portMtu, ownedBy: 'rt' });
  rt.ifaces.push({
    id: 'wan2',
    ip: '198.51.100.2',
    prefix: 24,
    mac: 'aa:00:00:00:01:03',
  });
  topology.devices.push(
    hostBox('ISP2', {
      mac: 'aa:00:00:00:00:f2',
      ip: '198.51.100.1',
      prefix: 24,
    }),
  );
  topology.links.push(
    link('w2', { device: 'RTR', port: 'wan2' }, { device: 'ISP2', port: '1' }),
  );
  if (opts?.wan2Default ?? true) {
    rt.routes.push({ dest: '0.0.0.0', prefix: 0, via: '198.51.100.1' });
  }
  if (opts?.policyVlan30) {
    rt.ifaces.push({
      id: 'lan',
      vlan: 30,
      ip: '192.168.30.1',
      prefix: 24,
      mac: 'aa:00:00:00:01:04',
    });
    rt.routes.push({ dest: '0.0.0.0', prefix: 0, via: '192.0.2.1', fromVlan: 30 });
  }
  if (opts?.wan1Down) {
    const w = topology.links.find((item) => item.id === 'w');
    if (!w) throw new Error('fixture: WAN1 link missing');
    w.up = false;
  }
  return topology;
}

const stripProfile: EngineProfile = {
  id: 'cheap-silicon',
  version: '1',
  unmanagedTag: 'strip',
};

const row5 = CATALOGUE.find((row) => row.id === 5);
const row20 = CATALOGUE.find((row) => row.id === 20);
const row25 = CATALOGUE.find((row) => row.id === 25);

describe('reference scenario (wired subset)', () => {
  it('a VLAN 10 host reaches the internet via PPPoE over tagged VLAN 500', () => {
    const ctx = createRunContext(referenceScenario());
    const result = send(ctx, {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' },
    });
    const delivery = result.hops.find(
      (hop) => hop.device === 'NET' && hop.step === 'delivery' && hop.action === 'delivered',
    );
    expect(delivery?.device).toBe('NET');
    expect(delivery?.reasonCode).toBe('delivery:delivered');
    const wan = result.hops.find(
      (hop) => hop.device === 'RTR' && hop.outPort === 'wan' && hop.action === 'forwarded',
    );
    expect(wan?.fn).toBe('rt');
    const onWire = result.deliveredFrame;
    expect(onWire?.vlan).toBe(500);
    expect(onWire?.encapsulation).toContain('vlan-tag');
    expect(onWire?.encapsulation).toContain('pppoe');
  });

  it('removing VLAN 500 from the uplink kills it at a named hop', () => {
    const ctx = createRunContext(referenceScenario({ wanVlan: null }));
    const result = send(ctx, {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' },
    });
    const delivery = result.hops.find(
      (hop) => hop.step === 'delivery' && hop.action === 'delivered' && hop.device === 'NET',
    );
    expect(delivery).toBeUndefined();
    const drop = result.hops.find(
      (hop) =>
        hop.device === 'ONT' &&
        hop.fn === 'isp' &&
        hop.step === 'isp-handoff' &&
        hop.action === 'dropped',
    );
    expect(drop?.reasonCode).toBe('isp-handoff:dropped');
    expect(drop?.inPort).toBe('1');
  });

  it('row 5 reproduces inside the same fixture via the unmanaged switch on an access port', () => {
    expect(row5).toBeDefined();
    const ctx = createRunContext(referenceScenario());
    const result = walkFrame(ctx, {
      device: 'USW',
      inPort: '2',
      frame: {
        srcMac: 'aa:00:00:00:00:10',
        dstMac: defaults.broadcastMac,
        vlan: null,
        size: 64,
        encapsulation: ['ethernet'],
        payload: { kind: 'icmp' },
        hops: [],
      },
    });
    expect(result.hops[0]?.device).toBe('USW');
    expect(result.hops[0]?.fn).toBe('br');
    expect(result.hops[0]?.action).toBe('flooded');
    expect(result.hops[0]?.step).toBe('egress-tagging');
    const flood = result.observations.find(
      (obs) => obs.observation === 'unmanaged-flood',
    );
    expect(flood?.facts.portCount).toBe(5);
    if (!flood || !row5) return;
    expect(format(observationAsFormatInput(flood))).toBe(row5.expected);
  });
});

describe('reference scenario (access point and mesh)', () => {
  it('a client on the AP guest SSID is delivered in VLAN 30', () => {
    const ctx = createRunContext(referenceScenario());
    const result = send(ctx, {
      from: 'C30',
      dstIp: '192.168.30.20',
      payload: { kind: 'icmp', srcIp: '192.168.30.10', dstIp: '192.168.30.20' },
    });
    const classify = result.hops.find(
      (hop) => hop.device === 'AP' && hop.fn === 'wlan30',
    );
    expect(classify?.step).toBe('ssid-vlan');
    expect(classify?.reasonCode).toBe('ssid-vlan:classified');
    expect(classify?.vlan).toBe(30);
    expect(classify?.action).toBe('forwarded');
    const uplink = result.hops.find(
      (hop) => hop.device === 'AP' && hop.fn === 'br' && hop.outPort === '1',
    );
    expect(uplink?.vlan).toBe(30);
    expect(uplink?.action).toBe('forwarded');
    expect(uplink?.step).toBe('egress-tagging');
    const dest = result.hops.find(
      (hop) =>
        hop.device === 'H30' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(dest?.device).toBe('H30');
    expect(dest?.reasonCode).toBe('delivery:delivered');
  });

  it('a client on the mesh is delivered in VLAN 10', () => {
    const ctx = createRunContext(referenceScenario());
    const result = send(ctx, {
      from: 'CMESH',
      dstIp: '192.168.10.10',
      payload: { kind: 'icmp', srcIp: '192.168.10.20', dstIp: '192.168.10.10' },
    });
    const classify = result.hops.find(
      (hop) => hop.device === 'MESH2' && hop.step === 'ssid-vlan',
    );
    expect(classify?.fn).toBe('wlan');
    expect(classify?.vlan).toBe(10);
    expect(classify?.reasonCode).toBe('ssid-vlan:classified');
    const bridged = result.hops.find(
      (hop) => hop.device === 'MESH2' && hop.fn === 'br',
    );
    expect(bridged?.vlan).toBe(10);
    const dest = result.hops.find(
      (hop) =>
        hop.device === 'H10' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(dest?.device).toBe('H10');
    expect(dest?.reasonCode).toBe('delivery:delivered');
  });

  it('row 20 reproduces inside the same fixture', () => {
    expect(row20).toBeDefined();
    const ctx = createRunContext(referenceScenario({ meshSsidVlan: 30 }));
    const result = walkFrame(ctx, {
      device: 'MESH1',
      inPort: 'wifi',
      frame: {
        srcMac: 'aa:00:00:00:00:31',
        dstMac: defaults.broadcastMac,
        vlan: null,
        size: 64,
        encapsulation: ['ethernet'],
        payload: { kind: 'icmp' },
        hops: [],
      },
      arrivedFrom: 'C30',
    });
    const classify = result.hops.find(
      (hop) => hop.device === 'MESH1' && hop.step === 'ssid-vlan',
    );
    expect(classify?.fn).toBe('wlan');
    expect(classify?.vlan).toBe(30);
    expect(classify?.action).toBe('forwarded');
    expect(classify?.reasonCode).toBe('ssid-vlan:classified');
    const landed = result.hops.find((hop) => hop.device === 'MSW');
    expect(landed?.fn).toBe('br');
    expect(landed?.vlan).toBe(10);
    const untagged = result.observations.find(
      (obs) => obs.observation === 'ssid-untagged',
    );
    expect(untagged?.facts.mappedVlan).toBe(30);
    expect(untagged?.facts.landedVlan).toBe(10);
    if (!untagged || !row20) return;
    expect(format(observationAsFormatInput(untagged))).toBe(row20.expected);
  });
});

describe('profile seam', () => {
  const tagged = {
    srcMac: 'aa:00:00:00:00:10' as MacAddr,
    dstMac: 'aa:00:00:00:00:20' as MacAddr,
    vlan: 20 as VlanId,
    size: 64,
    encapsulation: ['ethernet', 'vlan-tag'] as const,
    payload: { kind: 'icmp' as const },
    hops: [],
  };

  it('the built-in profile leaves a tag intact on an unmanaged switch', () => {
    const topology = referenceScenario();
    const ctx = createRunContext(topology, builtinProfile);
    const result = walkFrame(ctx, {
      device: 'USW',
      inPort: '2',
      frame: { ...tagged, encapsulation: [...tagged.encapsulation] },
    });
    const out = result.hops[0];
    expect(out?.provenance).toBeUndefined();
    const ctx2 = createRunContext(topology);
    const bridged = walkFrame(ctx2, {
      device: 'USW',
      inPort: '2',
      frame: { ...tagged, encapsulation: [...tagged.encapsulation] },
    });
    expect(
      bridged.hops.some((hop) => hop.device === 'MSW' && hop.vlan === 20),
    ).toBe(true);
  });

  it('a fixture profile that strips tags changes the trace and populates Hop.provenance', () => {
    const topology = referenceScenario();
    topology.profiles = [stripProfile.id];
    const ctx = createRunContext(topology, stripProfile);
    const result = walkFrame(ctx, {
      device: 'USW',
      inPort: '2',
      frame: { ...tagged, encapsulation: [...tagged.encapsulation] },
    });
    const usw = result.hops.find((hop) => hop.device === 'USW' && hop.fn === 'br');
    expect(usw?.provenance).toEqual({
      profile: stripProfile.id,
      version: stripProfile.version,
      fields: ['unmanagedTag'],
    });
    expect(
      result.hops.some((hop) => hop.device === 'MSW' && hop.vlan === 20),
    ).toBe(false);
  });
});

describe('usable MTU', () => {
  it('drops an oversized frame at egress after computing from the encapsulation stack', () => {
    const size = usableMtu(defaults.portMtu, ['ethernet', 'vlan-tag']);
    const onWire = usableMtu(defaults.portMtu, ['ethernet', 'vlan-tag', 'pppoe']);
    expect(size).toBeGreaterThan(onWire);
    const ctx = createRunContext(referenceScenario());
    const result = send(ctx, {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' },
      size,
    });
    const mtu = result.hops.find(
      (hop) => hop.step === 'mtu' && hop.action === 'dropped',
    );
    expect(mtu?.device).toBe('RTR');
    expect(mtu?.outPort).toBe('wan');
    expect(mtu?.reasonCode).toBe('mtu:dropped');
    expect(
      result.hops.some(
        (hop) => hop.device === 'NET' && hop.step === 'delivery',
      ),
    ).toBe(false);
  });
});

describe('Link.up and failover as two runs', () => {
  it('an omitted Link.up is up', () => {
    const topology = referenceScenario();
    expect(topology.links.every((item) => item.up === undefined)).toBe(true);
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' },
    });
    const delivery = result.hops.find(
      (hop) =>
        hop.device === 'NET' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(delivery?.reasonCode).toBe('delivery:delivered');
  });

  it('a down inter-switch copper link is not traversed', () => {
    const topology = referenceScenario();
    const u = topology.links.find((item) => item.id === 'u');
    if (!u) throw new Error('fixture: inter-switch link missing');
    u.up = false;
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' },
    });
    const flooded = result.hops.find(
      (hop) => hop.device === 'USW' && hop.action === 'flooded',
    );
    expect(flooded?.fn).toBe('br');
    expect(result.hops.some((hop) => hop.device === 'MSW')).toBe(false);
    expect(
      result.hops.some(
        (hop) =>
          hop.device === 'NET' &&
          hop.step === 'delivery' &&
          hop.action === 'delivered',
      ),
    ).toBe(false);
  });

  it('WAN1 down with no second default drops at route-lookup — row 25 structurally and verbatim', () => {
    expect(row25).toBeDefined();
    const ctx = createRunContext(
      failoverScenario({ wan1Down: true, wan2Default: false }),
    );
    const result = send(ctx, {
      from: 'H10',
      dstIp: '203.0.113.1',
      payload: { kind: 'icmp' },
    });
    const drop = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.fn === 'rt' &&
        hop.step === 'route-lookup' &&
        hop.action === 'dropped',
    );
    expect(drop?.reasonCode).toBe('route-lookup:dropped');
    expect(
      result.hops.some(
        (hop) => hop.outPort === 'wan' && hop.action === 'forwarded',
      ),
    ).toBe(false);
    if (!drop || !row25) return;
    expect(drop.reason).toBe(row25.expected);
  });

  it('WAN1 down with a WAN2 default takes WAN2', () => {
    const ctx = createRunContext(
      failoverScenario({ wan1Down: true, wan2Default: true }),
    );
    const result = send(ctx, {
      from: 'H10',
      dstIp: '203.0.113.1',
      payload: { kind: 'icmp' },
    });
    const pick = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.fn === 'rt' &&
        hop.step === 'route-lookup' &&
        hop.action === 'forwarded',
    );
    expect(pick?.outPort).toBe('wan2');
    const nat = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.step === 'nat' &&
        hop.action === 'forwarded' &&
        hop.outPort === 'wan2',
    );
    expect(nat?.reasonCode).toBe('nat:translated');
    const delivered = result.hops.find(
      (hop) =>
        hop.device === 'ISP2' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(delivered?.reasonCode).toBe('delivery:delivered');
  });

  it('does not name a down default from another VLAN as this frame\'s skipped route', () => {
    const topology = failoverScenario({
      wan1Down: true,
      wan2Default: false,
      policyVlan30: true,
    });
    const rtr = topology.devices.find((device) => device.id === 'RTR');
    const rt = rtr?.functions.find((fn) => fn.kind === 'routing');
    if (rt?.kind !== 'routing') throw new Error('fixture: RTR routing missing');
    rt.routes = rt.routes.filter((route) => route.fromVlan !== undefined);
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H10',
      dstIp: '203.0.113.1',
      payload: { kind: 'icmp' },
    });
    const drop = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.fn === 'rt' &&
        hop.inPort === 'lan' &&
        hop.step === 'route-lookup' &&
        hop.action === 'dropped',
    );
    expect(drop?.reasonCode).toBe('route-lookup:dropped');
    expect(drop?.reason).toBe('dropped at RTR port lan (route-lookup)');
  });

  it('a selector default targeting the down WAN is not used', () => {
    const ctx = createRunContext(
      failoverScenario({ wan1Down: true, wan2Default: true, policyVlan30: true }),
    );
    const result = send(ctx, {
      from: 'H30',
      dstIp: '203.0.113.1',
      payload: { kind: 'icmp' },
    });
    const pick = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.fn === 'rt' &&
        hop.step === 'route-lookup' &&
        hop.action === 'forwarded',
    );
    expect(pick?.outPort).toBe('wan2');
    expect(
      result.hops.some(
        (hop) => hop.outPort === 'wan' && hop.action === 'forwarded',
      ),
    ).toBe(false);
    const delivered = result.hops.find(
      (hop) =>
        hop.device === 'ISP2' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(delivered?.reasonCode).toBe('delivery:delivered');
  });
});
