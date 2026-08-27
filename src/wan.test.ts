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

function trunk(port: string, tagged: VlanId[]): BridgePort {
  return {
    port,
    mode: 'trunk',
    pvid: defaults.pvid,
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
): Link {
  return { id, a, b, medium: 'wired' };
}

function topo(devices: Chassis[], links: Link[]): Topology {
  return { devices, links, profiles: [] };
}

/** SPEC.md §9 wired subset. AP and mesh are Stage 2. */
function referenceScenario(opts?: { wanVlan?: VlanId | null }): Topology {
  const wanVlan = opts?.wanVlan === undefined ? 500 : opts.wanVlan;
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
        [trunk('1', [10, 20, 30]), access('2', 10)],
        { stp: true, mac: 'aa:00:00:00:00:02' },
      ),
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
    ],
  );
}

const stripProfile: EngineProfile = {
  id: 'cheap-silicon',
  version: '1',
  unmanagedTag: 'strip',
};

const row5 = CATALOGUE.find((row) => row.id === 5);

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
