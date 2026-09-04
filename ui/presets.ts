import { defaults } from '../src/index';
import type { BridgePort, Chassis, DeviceId, VlanId } from '../src/index';

export interface PresetDef {
  id: string;
  label: string;
  build: (id: DeviceId, seq: number) => Chassis;
}

/**
 * Identity MACs are a flat namespace across the whole topology: a chassis
 * at seq N and an iface at seq M, suffix S must never collide, in any
 * placement order. Bands of four per seq keep chassis identity (suffix 0)
 * and ifaces (suffixes 1-3) disjoint across every seq (#85) - the
 * property test in presets.test.ts is the contract, not this formula.
 */
function mac(seq: number, suffix = 0): string {
  return `02:00:00:00:00:${(seq * 4 + suffix).toString(16).padStart(2, '0')}`;
}

function port(id: string, ownedBy: string): Chassis['ports'][number] {
  return { id, mtu: defaults.portMtu, ownedBy };
}

function access(portId: string, vlan: VlanId): BridgePort {
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

function trunk(portId: string, tagged: VlanId[]): BridgePort {
  return {
    port: portId,
    mode: 'trunk',
    pvid: defaults.pvid,
    taggedVlans: new Set(tagged),
    untaggedVlans: new Set(),
    acceptableFrameTypes: defaults.acceptableFrameTypes,
    ingressFiltering: defaults.ingressFiltering,
  };
}

function base(
  id: DeviceId,
  label: string,
  preset: string,
  seq: number,
  ports: Chassis['ports'],
  functions: Chassis['functions'],
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

const SWITCH_PORTS = ['1', '2', '3', '4'];

/**
 * The palette shows boxes, not functions (ADR 0013): every entry writes a
 * chassis plus the engine's functions. There is no device kind anywhere.
 */
export const PRESETS: PresetDef[] = [
  {
    id: 'host',
    label: 'Host',
    build: (id, seq) =>
      base(id, `Host ${seq}`, 'host', seq, [port('1', 'none')], [], {
        mac: mac(seq),
        ip: `192.168.1.${9 + seq}`,
        prefix: 24,
        gateway: '192.168.1.1',
      }),
  },
  {
    id: 'switch',
    label: 'Managed switch',
    build: (id, seq) => {
      const members = SWITCH_PORTS.map((p) => access(p, defaults.pvid));
      return base(
        id,
        `Switch ${seq}`,
        'switch',
        seq,
        SWITCH_PORTS.map((p) => port(p, 'br')),
        [
          {
            kind: 'bridging',
            id: 'br',
            vlanAware: true,
            members,
            fdb: new Map(),
          },
          {
            kind: 'stp',
            id: 'stp',
            bridge: 'br',
            priority: defaults.stp.priority,
            baseMac: mac(seq),
            state: new Map(),
          },
        ],
      );
    },
  },
  {
    id: 'unmanaged-switch',
    label: 'Unmanaged switch',
    build: (id, seq) =>
      base(
        id,
        `Unmanaged ${seq}`,
        'unmanaged-switch',
        seq,
        SWITCH_PORTS.map((p) => port(p, 'br')),
        [
          {
            kind: 'bridging',
            id: 'br',
            vlanAware: false,
            members: SWITCH_PORTS.map((p) => access(p, defaults.pvid)),
            fdb: new Map(),
          },
        ],
      ),
  },
  {
    id: 'router',
    label: 'Router',
    build: (id, seq) =>
      base(
        id,
        `Router ${seq}`,
        'router',
        seq,
        [port('lan', 'rt'), port('wan', 'rt')],
        [
          {
            kind: 'routing',
            id: 'rt',
            ifaces: [
              {
                id: 'lan',
                vlan: defaults.pvid,
                ip: '192.168.1.1',
                prefix: 24,
                mac: mac(seq, 1),
              },
              {
                id: 'wan',
                vlan: 500,
                ip: '203.0.113.2',
                prefix: 24,
                mac: mac(seq, 2),
              },
            ],
            routes: [{ dest: '0.0.0.0', prefix: 0, via: '203.0.113.1' }],
            firewall: [],
          },
          { kind: 'nat', id: 'nat', on: 'rt', portForwards: [] },
        ],
      ),
  },
  {
    id: 'access-point',
    label: 'Access point',
    build: (id, seq) =>
      base(
        id,
        `AP ${seq}`,
        'access-point',
        seq,
        [port('wifi', 'wlan'), port('up', 'br')],
        [
          {
            kind: 'wireless',
            id: 'wlan',
            radio: 'radio0',
            mode: 'ap',
            ssid: 'main',
            vlan: 10,
          },
          {
            kind: 'bridging',
            id: 'br',
            vlanAware: true,
            members: [access('wifi', 10), trunk('up', [10])],
            fdb: new Map(),
          },
        ],
        {
          radios: [{ id: 'radio0', band: '5' }],
          internal: [{ from: 'wlan', to: 'br' }],
        },
      ),
  },
  {
    id: 'modem',
    label: 'ISP modem',
    build: (id, seq) =>
      base(
        id,
        `Modem ${seq}`,
        'modem',
        seq,
        [port('1', 'isp'), port('2', 'isp')],
        [
          {
            kind: 'isp-handoff',
            id: 'isp',
            port: '1',
            mode: 'pppoe',
            vlanTag: 500,
          },
        ],
      ),
  },
  {
    id: 'l3-switch',
    label: 'L3 switch',
    build: (id, seq) => {
      const members = SWITCH_PORTS.map((p) => access(p, defaults.pvid));
      // SVIs: rt-owned ports that are bridging members of their VLAN — the
      // #71 composition. SVI10/20 give the switch a gateway IP on each VLAN.
      const svi10 = { ...access('svi10', 10) };
      const svi20 = { ...access('svi20', 20) };
      return base(
        id,
        `L3 switch ${seq}`,
        'l3-switch',
        seq,
        [
          ...SWITCH_PORTS.map((p) => port(p, 'br')),
          port('svi10', 'rt'),
          port('svi20', 'rt'),
        ],
        [
          {
            kind: 'bridging',
            id: 'br',
            vlanAware: true,
            members: [...members, svi10, svi20],
            fdb: new Map(),
          },
          {
            kind: 'stp',
            id: 'stp',
            bridge: 'br',
            priority: defaults.stp.priority,
            baseMac: mac(seq),
            state: new Map(),
          },
          {
            kind: 'routing',
            id: 'rt',
            ifaces: [
              {
                id: 'svi10',
                vlan: 10,
                ip: '192.168.10.1',
                prefix: 24,
                mac: mac(seq, 1),
              },
              {
                id: 'svi20',
                vlan: 20,
                ip: '192.168.20.1',
                prefix: 24,
                mac: mac(seq, 2),
              },
            ],
            routes: [],
            firewall: [],
          },
        ],
        { internal: [{ from: 'rt', to: 'br' }] },
      );
    },
  },
  {
    id: 'dhcp-server',
    label: 'DHCP server',
    build: (id, seq) =>
      base(
        id,
        `DHCP server ${seq}`,
        'dhcp-server',
        seq,
        [port('1', 'none')],
        [
          {
            kind: 'dhcp-server',
            id: 'dhcp',
            scopes: [
              {
                vlan: 10,
                poolStart: '192.168.10.100',
                poolEnd: '192.168.10.199',
                gateway: '192.168.10.1',
                resolver: '192.168.10.1',
              },
            ],
          },
        ],
        {
          // The server answers from its own identity (#72): host-like
          // addressing on the service VLAN. The IP derives from seq so
          // two placed servers never share one address (.2 was the
          // every-placement constant) and stays clear of the pool and
          // gateway (#85).
          mac: mac(seq),
          ip: `192.168.10.${seq + 1}`,
          prefix: 24,
          vlan: 10,
        },
      ),
  },
];

export function presetById(id: string): PresetDef | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
