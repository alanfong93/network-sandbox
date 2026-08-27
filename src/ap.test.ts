import { describe, expect, it } from 'vitest';
import { defaults } from './defaults';
import type {
  BridgePort,
  Chassis,
  Link,
  MacAddr,
  Topology,
  VlanId,
} from './model';
import { PIPELINE_STEPS } from './reasons';
import { createRunContext } from './run';
import { send } from './send';
import { walkFrame } from './walk';

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

function taggedAp(
  id: string,
  opts?: { trunkTagged?: VlanId[] },
): Chassis {
  const tagged = opts?.trunkTagged ?? [10, 20, 30, 99];
  const wifi = access('wifi', 30);
  const uplink = trunk('1', tagged);
  return {
    id,
    label: id,
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
        mode: 'ap',
        ssid: 'guest',
        vlan: 30,
      },
      {
        kind: 'bridging',
        id: 'br',
        vlanAware: true,
        members: [wifi, uplink],
        fdb: new Map(),
      },
    ],
    internal: [{ from: 'wlan', to: 'br' }],
    mac: 'aa:00:00:00:00:a1',
    ip: '192.168.99.2',
    prefix: 24,
    vlan: 99,
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

function guestOnTaggedAp(
  opts?: { swTagged?: VlanId[]; apTagged?: VlanId[] },
): Topology {
  const swTagged = opts?.swTagged ?? [10, 20, 30, 99];
  const apTagged = opts?.apTagged ?? [10, 20, 30, 99];
  return topo(
    [
      hostBox('C1', {
        mac: 'aa:00:00:00:00:10',
        ip: '192.168.30.10',
        prefix: 24,
        gateway: '192.168.30.1',
      }),
      taggedAp('AP1', { trunkTagged: apTagged }),
      switchBox('SW1', [
        trunk('1', swTagged),
        access('2', 30),
        access('3', 99),
      ]),
      hostBox('H30', {
        mac: 'aa:00:00:00:00:30',
        ip: '192.168.30.20',
        prefix: 24,
        gateway: '192.168.30.1',
      }),
      hostBox('H99', {
        mac: 'aa:00:00:00:00:99',
        ip: '192.168.99.10',
        prefix: 24,
        gateway: '192.168.99.1',
      }),
    ],
    [
      link(
        'w',
        { device: 'C1', port: '1' },
        { device: 'AP1', port: 'wifi' },
        'wireless',
      ),
      link('t', { device: 'AP1', port: '1' }, { device: 'SW1', port: '1' }),
      link('g', { device: 'SW1', port: '2' }, { device: 'H30', port: '1' }),
      link('m', { device: 'SW1', port: '3' }, { device: 'H99', port: '1' }),
    ],
  );
}

describe('tagged AP uplink', () => {
  it('delivers a guest client in VLAN 30 with the uplink tagged', () => {
    const ctx = createRunContext(guestOnTaggedAp());
    const result = send(ctx, {
      from: 'C1',
      dstIp: '192.168.30.20',
      payload: { kind: 'icmp', srcIp: '192.168.30.10', dstIp: '192.168.30.20' },
    });
    const classify = result.hops.find(
      (hop) => hop.device === 'AP1' && hop.fn === 'wlan',
    );
    expect(classify?.step).toBe('ssid-vlan');
    expect(classify?.reasonCode).toBe('ssid-vlan:classified');
    expect(classify?.vlan).toBe(30);
    expect(classify?.action).toBe('forwarded');
    const uplink = result.hops.find(
      (hop) =>
        hop.device === 'AP1' && hop.fn === 'br' && hop.outPort === '1',
    );
    expect(uplink?.vlan).toBe(30);
    expect(uplink?.action).toBe('forwarded');
    expect(uplink?.step).toBe('egress-tagging');
    expect(uplink?.reasonCode).toBe('egress-tagging:forwarded');
    const dest = result.hops.find(
      (hop) =>
        hop.device === 'H30' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(dest?.device).toBe('H30');
    expect(dest?.reasonCode).toBe('delivery:delivered');
  });
});

describe('AP management VLAN', () => {
  it('reaches the AP management address only on VLAN 99', () => {
    const ctx = createRunContext(guestOnTaggedAp());
    const result = send(ctx, {
      from: 'H99',
      dstIp: '192.168.99.2',
      payload: { kind: 'icmp', srcIp: '192.168.99.10', dstIp: '192.168.99.2' },
    });
    const delivered = result.hops.find(
      (hop) =>
        hop.device === 'AP1' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(delivered?.vlan).toBe(99);
    expect(delivered?.reasonCode).toBe('delivery:delivered');
    expect(delivered?.fn).toBeUndefined();
    expect(result.hops.some((hop) => hop.step === 'ssid-vlan')).toBe(false);
  });

  it('does not deliver management on the guest VLAN', () => {
    const ctx = createRunContext(guestOnTaggedAp());
    const result = walkFrame(ctx, {
      device: 'AP1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:30',
        dstMac: 'aa:00:00:00:00:a1',
        vlan: 30,
        size: 64,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: {
          kind: 'icmp',
          srcIp: '192.168.30.20',
          dstIp: '192.168.99.2',
        },
        hops: [],
      },
    });
    expect(
      result.hops.some(
        (hop) => hop.device === 'AP1' && hop.action === 'delivered',
      ),
    ).toBe(false);
  });

  it('names the hop when the trunk omits the management VLAN', () => {
    const ctx = createRunContext(
      guestOnTaggedAp({ apTagged: [10, 20, 30], swTagged: [10, 20, 30, 99] }),
    );
    const result = send(ctx, {
      from: 'H99',
      dstIp: '192.168.99.2',
      payload: { kind: 'icmp', srcIp: '192.168.99.10', dstIp: '192.168.99.2' },
    });
    const drop = result.hops.find(
      (hop) => hop.device === 'AP1' && hop.action === 'dropped' && hop.vlan === 99,
    );
    expect(drop?.fn).toBe('br');
    expect(drop?.inPort).toBe('1');
    expect(drop?.step).toBe('ingress-filtering');
    expect(drop?.reasonCode).toBe('ingress-filtering:dropped');
    expect(
      result.hops.some(
        (hop) => hop.device === 'AP1' && hop.action === 'delivered',
      ),
    ).toBe(false);
  });

  it('does not add a management pipeline step', () => {
    expect(PIPELINE_STEPS).not.toContain('management');
    const ctx = createRunContext(guestOnTaggedAp());
    const result = send(ctx, {
      from: 'H99',
      dstIp: '192.168.99.2',
      payload: { kind: 'icmp', srcIp: '192.168.99.10', dstIp: '192.168.99.2' },
    });
    expect(result.hops.every((hop) => hop.step !== 'management')).toBe(true);
  });
});
