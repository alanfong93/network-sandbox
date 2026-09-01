import { defaults } from './defaults';
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

function ontBox(
  id: string,
  vlanTag: VlanId | undefined,
  mode: 'pppoe' | 'static' = 'pppoe',
): Chassis {
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
        mode,
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

/** SPEC.md §9 reference scenario, including AP, mesh, and both WANs. */
export function referenceScenario(opts?: {
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
  const wan2Iface: RouterIface = {
    id: 'wan2',
    ip: '198.51.100.2',
    prefix: 24,
    mac: 'aa:00:00:00:01:03',
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
          wan2Iface,
        ],
        {
          routes: [
            { dest: '0.0.0.0', prefix: 0, via: '192.0.2.1' },
            { dest: '0.0.0.0', prefix: 0, via: '198.51.100.1' },
          ],
          nat: true,
        },
      ),
      ontBox('ONT', 500),
      ontBox('ISP2', undefined, 'static'),
      hostBox('NET', {
        mac: 'aa:00:00:00:00:ee',
        ip: '192.0.2.1',
        prefix: 24,
      }),
      hostBox('NET2', {
        mac: 'aa:00:00:00:00:f2',
        ip: '198.51.100.1',
        prefix: 24,
      }),
    ],
    [
      link('h', { device: 'H10', port: '1' }, { device: 'USW', port: '2' }),
      link('u', { device: 'USW', port: '1' }, { device: 'MSW', port: '2' }),
      link('t', { device: 'MSW', port: '1' }, { device: 'RTR', port: 'lan' }),
      link('w', { device: 'RTR', port: 'wan' }, { device: 'ONT', port: '1' }),
      link('i', { device: 'ONT', port: '2' }, { device: 'NET', port: '1' }),
      link('w2', { device: 'RTR', port: 'wan2' }, { device: 'ISP2', port: '1' }),
      link('i2', { device: 'ISP2', port: '2' }, { device: 'NET2', port: '1' }),
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
