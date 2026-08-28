import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import { defaults } from './defaults';
import { format } from './format';
import type { BridgePort, Chassis, Frame, Link, Topology, VlanId } from './model';
import { createRunContext } from './run';
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

function meshNode(
  id: string,
  opts: { canTag: boolean; preset?: string },
): Chassis {
  const wifi = access('wifi', 30);
  const uplink = trunk('1', [10, 20, 30]);
  return {
    id,
    label: id,
    preset: opts.preset,
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
        mode: 'mesh',
        ssid: 'guest',
        vlan: 30,
      },
      {
        kind: 'bridging',
        id: 'br',
        vlanAware: true,
        canTag: opts.canTag,
        members: [wifi, uplink],
        fdb: new Map(),
      },
    ],
    internal: [{ from: 'wlan', to: 'br' }],
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

function topo(devices: Chassis[], links: Link[]): Topology {
  return { devices, links, profiles: [] };
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

const row20 = CATALOGUE.find((row) => row.id === 20);

function guestOnMesh(canTag: boolean): Topology {
  return topo(
    [
      host('C1'),
      meshNode('MESH1', { canTag, preset: canTag ? undefined : 'consumer-mesh' }),
      switchBox('SW1', [access('1', 10), access('2', 10)]),
      host('H10'),
    ],
    [
      link(
        'w',
        { device: 'C1', port: '1' },
        { device: 'MESH1', port: 'wifi' },
        'wireless',
      ),
      link('u', { device: 'MESH1', port: '1' }, { device: 'SW1', port: '1' }),
      link('h', { device: 'SW1', port: '2' }, { device: 'H10', port: '1' }),
    ],
  );
}

describe('catalogue row 20', () => {
  const topology = guestOnMesh(false);

  it('is green structurally', () => {
    const ctx = createRunContext(topology);
    const result = walkFrame(ctx, {
      device: 'MESH1',
      inPort: 'wifi',
      frame: frame(),
      arrivedFrom: 'C1',
    });
    const classify = result.hops.find(
      (hop) => hop.device === 'MESH1' && hop.step === 'ssid-vlan',
    );
    expect(classify?.fn).toBe('wlan');
    expect(classify?.vlan).toBe(30);
    expect(classify?.action).toBe('forwarded');
    expect(classify?.reasonCode).toBe('ssid-vlan:classified');
    const bridged = result.hops.find(
      (hop) => hop.device === 'MESH1' && hop.fn === 'br',
    );
    expect(bridged?.vlan).toBe(30);
    expect(bridged?.step).toBe('egress-tagging');
    const landed = result.hops.find((hop) => hop.device === 'SW1');
    expect(landed?.fn).toBe('br');
    expect(landed?.vlan).toBe(10);
    const untagged = result.observations.find(
      (obs) => obs.observation === 'ssid-untagged',
    );
    expect(untagged?.facts.mappedVlan).toBe(30);
    expect(untagged?.facts.landedVlan).toBe(10);
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row20).toBeDefined();
    const ctx = createRunContext(topology);
    const result = walkFrame(ctx, {
      device: 'MESH1',
      inPort: 'wifi',
      frame: frame(),
      arrivedFrom: 'C1',
    });
    const untagged = result.observations.find(
      (obs) => obs.observation === 'ssid-untagged',
    );
    expect(untagged).toBeDefined();
    if (!untagged || !row20) return;
    expect(format(observationAsFormatInput(untagged))).toBe(row20.expected);
  });
});

describe('tagged-capable contrast', () => {
  it('lands the same SSID in VLAN 30 when the node can tag', () => {
    const topology = topo(
      [
        host('C1'),
        meshNode('AP1', { canTag: true }),
        switchBox('SW1', [trunk('1', [10, 20, 30]), access('2', 30)]),
        host('H30'),
      ],
      [
        link(
          'w',
          { device: 'C1', port: '1' },
          { device: 'AP1', port: 'wifi' },
          'wireless',
        ),
        link('u', { device: 'AP1', port: '1' }, { device: 'SW1', port: '1' }),
        link('h', { device: 'SW1', port: '2' }, { device: 'H30', port: '1' }),
      ],
    );
    const ctx = createRunContext(topology);
    const result = walkFrame(ctx, {
      device: 'AP1',
      inPort: 'wifi',
      frame: frame(),
      arrivedFrom: 'C1',
    });
    const classify = result.hops.find(
      (hop) => hop.device === 'AP1' && hop.step === 'ssid-vlan',
    );
    expect(classify?.vlan).toBe(30);
    const landed = result.hops.find((hop) => hop.device === 'SW1');
    expect(landed?.vlan).toBe(30);
    expect(
      result.observations.some((obs) => obs.observation === 'ssid-untagged'),
    ).toBe(false);
  });
});

describe('untagged-only capability', () => {
  it('is selected on the bridging function by preset data', () => {
    const mesh = meshNode('MESH1', { canTag: false, preset: 'consumer-mesh' });
    const ap = meshNode('AP1', { canTag: true });
    const meshBr = mesh.functions.find((fn) => fn.kind === 'bridging');
    const apBr = ap.functions.find((fn) => fn.kind === 'bridging');
    expect(mesh.preset).toBe('consumer-mesh');
    expect(meshBr?.kind === 'bridging' && meshBr.canTag).toBe(false);
    expect(ap.preset).toBeUndefined();
    expect(apBr?.kind === 'bridging' && apBr.canTag).toBe(true);
  });
});
