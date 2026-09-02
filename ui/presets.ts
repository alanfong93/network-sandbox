import { defaults } from '../src/index';
import type { BridgePort, Chassis, DeviceId, VlanId } from '../src/index';

export interface PresetDef {
  id: string;
  label: string;
  build: (id: DeviceId, seq: number) => Chassis;
}

function mac(seq: number, suffix = 0): string {
  return `02:00:00:00:00:${(seq * 2 + suffix).toString(16).padStart(2, '0')}`;
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
];

export function presetById(id: string): PresetDef | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
