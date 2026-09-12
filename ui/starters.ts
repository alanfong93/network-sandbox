import { defaults, type Topology } from '../src/index';
import type { BridgePort, Chassis, DeviceId, Port } from '../src/index';

export function missingReturnRoute(): Topology {
  return {
    devices: [
      {
        id: 'H2',
        label: 'H2',
        ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'none' }],
        radios: [],
        functions: [],
        internal: [],
        mac: 'aa:00:00:00:00:20',
        ip: '192.168.50.10',
        prefix: 24,
        gateway: '192.168.50.1',
      },
      {
        id: 'R2',
        label: 'R2',
        ports: [
          { id: '1', mtu: defaults.portMtu, ownedBy: 'rt' },
          { id: '2', mtu: defaults.portMtu, ownedBy: 'rt' },
        ],
        radios: [],
        functions: [
          {
            kind: 'routing',
            id: 'rt',
            ifaces: [
              { id: '1', ip: '192.168.50.1', prefix: 24, mac: 'aa:00:00:00:02:01' },
              { id: '2', ip: '192.168.1.2', prefix: 24, mac: 'aa:00:00:00:02:02' },
            ],
            routes: [{ dest: '0.0.0.0', prefix: 0, via: '192.168.1.1' }],
            firewall: [],
          },
        ],
        internal: [],
      },
      {
        id: 'R1',
        label: 'R1',
        ports: [
          { id: '1', mtu: defaults.portMtu, ownedBy: 'rt' },
          { id: '2', mtu: defaults.portMtu, ownedBy: 'rt' },
        ],
        radios: [],
        functions: [
          {
            kind: 'routing',
            id: 'rt',
            ifaces: [
              { id: '1', ip: '192.168.1.1', prefix: 24, mac: 'aa:00:00:00:01:01' },
              { id: '2', ip: '10.20.0.1', prefix: 24, mac: 'aa:00:00:00:01:02' },
            ],
            routes: [],
            firewall: [],
          },
        ],
        internal: [],
      },
      {
        id: 'H1',
        label: 'H1',
        ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'none' }],
        radios: [],
        functions: [],
        internal: [],
        mac: 'aa:00:00:00:00:05',
        ip: '10.20.0.5',
        prefix: 24,
        gateway: '10.20.0.1',
      },
    ],
    links: [
      {
        id: 'h2',
        a: { device: 'H2', port: '1' },
        b: { device: 'R2', port: '1' },
        medium: 'wired',
      },
      {
        id: '12',
        a: { device: 'R2', port: '2' },
        b: { device: 'R1', port: '1' },
        medium: 'wired',
      },
      {
        id: 'h1',
        a: { device: 'H1', port: '1' },
        b: { device: 'R1', port: '2' },
        medium: 'wired',
      },
    ],
    profiles: [],
  };
}

/** One shipped sample the Starters picker loads (#164). */
export interface StarterDef {
  id: string;
  label: string;
  load: () => Topology;
}

function starterPort(id: string, ownedBy: string): Port {
  return { id, mtu: defaults.portMtu, ownedBy };
}

function starterAccess(portId: string, vlan: number): BridgePort {
  return {
    port: portId,
    mode: 'access',
    pvid: vlan,
    taggedVlans: new Set(),
    untaggedVlans: new Set([vlan]),
    acceptableFrameTypes: defaults.acceptableFrameTypes,
    ingressFiltering: defaults.ingressFiltering,
  };
}

function starterChassis(
  id: DeviceId,
  label: string,
  preset: string,
  functions: Chassis['functions'],
  ports: Port[],
  extra?: Partial<Chassis>,
): Chassis {
  return {
    id,
    label,
    preset,
    ports,
    radios: [],
    functions,
    internal: [],
    ...extra,
  };
}

/**
 * The first-look sample (#164): `1 ISP modem -> 1 router (1 WAN, 4 LAN
 * jacks) -> 2 hosts`, hand-built on the palette's own compositions — the
 * router mirrors the router preset grown to four LAN jacks (ADR 0031: one
 * bridge, one subnet), the modem mirrors the modem preset in dhcp mode
 * (no fake credentials in a shipped file, #65 hygiene). H1 leads
 * devices[] so the send form's default From is H1, and H2 sits at
 * 192.168.1.11 — the form's shipped default destination — so a fresh
 * visitor presses Send unchanged and reads H1 pinging H2. Send itself is
 * never auto-called (PRODUCT job 3).
 */
export function homeNetwork(): Topology {
  const pvid = defaults.pvid;
  return {
    devices: [
      starterChassis('H1', 'Host 1', 'host', [], [starterPort('1', 'none')], {
        mac: 'aa:00:00:00:00:01',
        ip: '192.168.1.10',
        prefix: 24,
        gateway: '192.168.1.1',
        resolver: '192.168.1.1',
      }),
      starterChassis('H2', 'Host 2', 'host', [], [starterPort('1', 'none')], {
        mac: 'aa:00:00:00:00:02',
        ip: '192.168.1.11',
        prefix: 24,
        gateway: '192.168.1.1',
        resolver: '192.168.1.1',
      }),
      starterChassis(
        'R1',
        'Router 1',
        'router',
        [
          {
            kind: 'bridging',
            id: 'br',
            vlanAware: true,
            members: ['lan', 'lan2', 'lan3', 'lan4', 'lan-svi'].map((portId) =>
              starterAccess(portId, pvid),
            ),
            fdb: new Map(),
          },
          {
            kind: 'routing',
            id: 'rt',
            ifaces: [
              {
                id: 'lan-svi',
                vlan: pvid,
                ip: '192.168.1.1',
                prefix: 24,
                mac: 'aa:00:00:00:00:05',
              },
              {
                id: 'wan',
                vlan: 500,
                ip: '203.0.113.2',
                prefix: 24,
                mac: 'aa:00:00:00:00:06',
              },
            ],
            routes: [{ dest: '0.0.0.0', prefix: 0, via: '203.0.113.1' }],
            firewall: [],
          },
          { kind: 'nat', id: 'nat', on: 'rt', portForwards: [] },
          {
            kind: 'dhcp-server',
            id: 'dhcp',
            scopes: [
              {
                vlan: pvid,
                poolStart: '192.168.1.100',
                poolEnd: '192.168.1.199',
                gateway: '192.168.1.1',
                resolver: '192.168.1.1',
              },
            ],
          },
        ],
        [
          starterPort('lan', 'br'),
          starterPort('lan2', 'br'),
          starterPort('lan3', 'br'),
          starterPort('lan4', 'br'),
          starterPort('lan-svi', 'rt'),
          starterPort('wan', 'rt'),
        ],
        {
          internal: [{ from: 'rt', to: 'br' }],
          mac: 'aa:00:00:00:00:04',
          ip: '192.168.1.1',
          prefix: 24,
          vlan: pvid,
        },
      ),
      starterChassis(
        'M1',
        'ISP modem',
        'modem',
        [
          {
            kind: 'isp-handoff',
            id: 'isp',
            port: '1',
            mode: 'dhcp',
            vlanTag: 500,
          },
        ],
        [starterPort('1', 'isp'), starterPort('2', 'isp')],
      ),
    ],
    links: [
      {
        id: 'wan',
        a: { device: 'M1', port: '1' },
        b: { device: 'R1', port: 'wan' },
        medium: 'wired',
      },
      {
        id: 'h1',
        a: { device: 'H1', port: '1' },
        b: { device: 'R1', port: 'lan' },
        medium: 'wired',
      },
      {
        id: 'h2',
        a: { device: 'H2', port: '1' },
        b: { device: 'R1', port: 'lan2' },
        medium: 'wired',
      },
    ],
    profiles: [],
  };
}

export const STARTERS: StarterDef[] = [
  {
    id: 'home-network',
    label: 'Home network — modem, router (1 WAN, 4 LAN), two hosts',
    load: homeNetwork,
  },
  {
    id: 'missing-return-route',
    label: 'Missing return route — catalogue row 13',
    load: missingReturnRoute,
  },
];

export function starterById(id: string): StarterDef | undefined {
  return STARTERS.find((starter) => starter.id === id);
}
