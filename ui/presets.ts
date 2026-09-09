import { defaults } from '../src/index';
import type { BridgePort, Chassis, DeviceId, VlanId } from '../src/index';

export interface PresetDef {
  id: string;
  label: string;
  /**
   * serverIndex is supplied only by addPreset and consumed only by the
   * dhcp-server preset; every other builder ignores it, so it stays
   * optional and existing 2-arg call sites keep compiling. undefined
   * means the static range is exhausted - the build ships no IP.
   */
  build: (id: DeviceId, seq: number, serverIndex?: number) => Chassis;
}

/**
 * Identity MACs are a flat namespace across the whole topology: a chassis
 * at seq N and an iface at seq M, suffix S must never collide, in any
 * placement order. The identity integer is banded (seq*4 + suffix: chassis
 * identity at suffix 0, ifaces at 1-3) and spread across the last three
 * octets so it stays a valid EUI-48 for every seq the UI can produce - the
 * single-byte form wrapped into 3-hex-digit fields at seq 64 (#85). The
 * property test in presets.test.ts is the contract, not this formula.
 */
function mac(seq: number, suffix = 0): string {
  const n = seq * 4 + suffix;
  const o0 = n & 0xff;
  const o1 = (n >> 8) & 0xff;
  const o2 = (n >> 16) & 0xff;
  const o3 = (n >> 24) & 0xff;
  const hex = (value: number): string => value.toString(16).padStart(2, '0');
  return `02:${hex(o3)}:${hex(o2)}:${hex(o1)}:${hex(o0)}:00`;
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
const MANAGED_SWITCH_PORTS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const UNMANAGED_SWITCH_PORTS = ['1', '2', '3', '4', '5'];

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
        // The advertised resolver is just an address (ADR 0030): the shipped
        // gateway, the home-gateway default. Point it at a LAN resolver box
        // to walk the query on the LAN.
        resolver: '192.168.1.1',
      }),
  },
  {
    id: 'switch',
    label: 'Managed switch',
    build: (id, seq) => {
      const members = MANAGED_SWITCH_PORTS.map((p) => access(p, defaults.pvid));
      return base(
        id,
        `Switch ${seq}`,
        'switch',
        seq,
        MANAGED_SWITCH_PORTS.map((p) => port(p, 'br')),
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
        UNMANAGED_SWITCH_PORTS.map((p) => port(p, 'br')),
        [
          {
            kind: 'bridging',
            id: 'br',
            vlanAware: false,
            members: UNMANAGED_SWITCH_PORTS.map((p) => access(p, defaults.pvid)),
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
        [port('lan', 'br'), port('lan-svi', 'rt'), port('wan', 'rt')],
        [
          {
            kind: 'bridging',
            id: 'br',
            vlanAware: true,
            members: [access('lan', defaults.pvid), access('lan-svi', defaults.pvid)],
            fdb: new Map(),
          },
          {
            kind: 'routing',
            id: 'rt',
            ifaces: [
              {
                id: 'lan-svi',
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
          {
            kind: 'dhcp-server',
            id: 'dhcp',
            scopes: [
              {
                vlan: defaults.pvid,
                poolStart: '192.168.1.100',
                poolEnd: '192.168.1.199',
                gateway: '192.168.1.1',
                resolver: '192.168.1.1',
              },
            ],
          },
        ],
        {
          internal: [{ from: 'rt', to: 'br' }],
          mac: mac(seq),
          ip: '192.168.1.1',
          prefix: 24,
          vlan: defaults.pvid,
        },
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
    id: 'extender',
    label: 'Extender',
    build: (id, seq) =>
      base(
        id,
        `Extender ${seq}`,
        'extender',
        seq,
        [port('wifi', 'wlan-ap'), port('up', 'wlan-sta')],
        [
          {
            kind: 'wireless',
            id: 'wlan-ap',
            radio: 'radio0',
            mode: 'ap',
            ssid: 'main',
            vlan: 10,
          },
          {
            kind: 'wireless',
            id: 'wlan-sta',
            radio: 'radio0',
            mode: 'client',
            ssid: 'main',
            vlan: 10,
          },
          {
            kind: 'bridging',
            id: 'br',
            vlanAware: true,
            members: [access('wifi', 10), access('up', 10)],
            fdb: new Map(),
          },
        ],
        {
          radios: [{ id: 'radio0', band: '5' }],
          internal: [
            { from: 'wlan-ap', to: 'br' },
            { from: 'wlan-sta', to: 'br' },
          ],
        },
      ),
  },
  {
    id: 'mesh-node',
    label: 'Mesh node',
    build: (id, seq) =>
      base(
        id,
        `Mesh node ${seq}`,
        'mesh-node',
        seq,
        [port('wifi', 'wlan'), port('bh', 'wlan')],
        [
          {
            kind: 'wireless',
            id: 'wlan',
            radio: 'radio0',
            mode: 'mesh',
            ssid: 'mesh',
            vlan: 10,
          },
          {
            kind: 'bridging',
            id: 'br',
            vlanAware: true,
            canTag: false,
            members: [access('wifi', 10), access('bh', 10)],
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
    id: 'resolver',
    label: 'DNS server',
    build: (id, seq) =>
      base(
        id,
        `DNS server ${seq}`,
        'resolver',
        seq,
        [port('1', 'none')],
        [
          {
            kind: 'resolver',
            id: 'resolver',
            // One shipped record so the first name query has something to
            // answer with; records are editable in the inspector (ADR 0030).
            records: [{ name: 'google.com', ip: '192.0.2.1' }],
          },
        ],
        {
          mac: mac(seq),
          ip: `192.168.1.${9 + seq}`,
          prefix: 24,
          gateway: '192.168.1.1',
        },
      ),
  },
  {
    id: 'internet',
    label: 'Internet',
    // The reference scenario's NET box: a host chassis at 192.0.2.1 that
    // answers ICMP for its address once the frame arrives through WAN/NAT
    // (ADR 0030). It is a palette box, not a second engine.
    build: (id, seq) =>
      base(id, `Internet ${seq}`, 'internet', seq, [port('1', 'none')], [], {
        mac: mac(seq),
        ip: '192.0.2.1',
        prefix: 24,
      }),
  },
  {
    id: 'dhcp-server',
    label: 'DHCP server',
    build: (id, seq, serverIndex) =>
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
          // addressing on the service VLAN. The IP derives from the
          // SERVER ordinal, not the global placement seq - unrelated
          // placements must never push the server into its own pool or
          // off the shipped .2/.3 (#92, the issue's named root cause).
          // Two placed servers never share one address (#85), and the
          // address stays clear of the pool, gateway, and broadcast at
          // every ordinal within the /24 static range.
          mac: mac(seq),
          // addPreset supplies the lowest unclaimed ordinal; undefined
          // means the static range is exhausted - ship no IP rather
          // than a broadcast or in-pool address (#92 review cycle 2).
          ip: serverIndex !== undefined ? dhcpServerIp(serverIndex) : undefined,
          prefix: 24,
          vlan: 10,
        },
      ),
  },
];

/**
 * Static host bands of the default /24 scope: .2-.99 and .200-.254.
 * Contract: serverIndex is an integer 1..153 - addPreset guarantees it
 * via nextDhcpServerIndex; other values are outside the derivation.
 */
function dhcpServerIp(serverIndex: number): string {
  const LOW_MAX = 99; // .2-.99 serves ordinals 1-98 (shipped .2/.3 stay).
  const HIGH_MIN = 200; // .200-.254 serves ordinals 99-153 (.255 broadcast).
  const host =
    serverIndex + 1 <= LOW_MAX
      ? serverIndex + 1
      : HIGH_MIN + (serverIndex - LOW_MAX);
  return `192.168.10.${host}`;
}

/**
 * The lowest SERVER ordinal no live dhcp-server chassis claims, or null
 * when all 153 are taken. Lowest-free, not count or max+1: a lone
 * imported .254 must not push the next server to the broadcast while
 * .2-.99 sit free, and deleting a server legitimately frees its
 * ordinal - a new server may take it, never one a survivor still holds
 * (#92 review cycle 2). The ordinal is inverted from the chassis IP, so
 * it works on imported topologies; hand-set addresses outside the
 * static bands are not derivation ordinals and are ignored.
 */
export function nextDhcpServerIndex(devices: Chassis[]): number | null {
  const claimed = new Set<number>();
  for (const device of devices) {
    const isServer = device.functions.some((fn) => fn.kind === 'dhcp-server');
    if (!isServer || device.ip === undefined) continue;
    const host = Number(device.ip.split('.')[3]);
    const ordinal =
      host >= 2 && host <= 99
        ? host - 1
        : host >= 200 && host <= 254
          ? host - 101
          : NaN;
    if (Number.isFinite(ordinal)) claimed.add(ordinal);
  }
  for (let ordinal = 1; ordinal <= 153; ordinal++) {
    if (!claimed.has(ordinal)) return ordinal;
  }
  return null;
}

export function presetById(id: string): PresetDef | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
