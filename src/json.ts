import type {
  BridgePort,
  Chassis,
  DhcpScope,
  Fn,
  NameRecord,
  InternalEdge,
  Link,
  Port,
  PortForward,
  Radio,
  Route,
  RouterIface,
  Topology,
  VlanId,
} from './model';

export const SANDBOX_FORMAT = 'network-sandbox';
export const SANDBOX_VERSION = 1;

export type BridgePortJson = Omit<BridgePort, 'taggedVlans' | 'untaggedVlans'> & {
  taggedVlans: VlanId[];
  untaggedVlans: VlanId[];
};

export type BridgingFnJson = Omit<
  Extract<Fn, { kind: 'bridging' }>,
  'fdb' | 'members'
> & {
  members: BridgePortJson[];
};

export type StpFnJson = Omit<Extract<Fn, { kind: 'stp' }>, 'state'>;

export type FnJson =
  | BridgingFnJson
  | StpFnJson
  | Exclude<Fn, { kind: 'bridging' } | { kind: 'stp' }>;

export type ChassisJson = Omit<Chassis, 'functions'> & {
  functions: FnJson[];
};

export type TopologyJson = {
  devices: ChassisJson[];
  links: Link[];
  profiles: string[];
};

export interface SandboxEnvelope {
  format: typeof SANDBOX_FORMAT;
  version: typeof SANDBOX_VERSION;
  topology: TopologyJson;
}

export class UnknownFunctionKindError extends Error {
  override readonly name = 'UnknownFunctionKindError';
  readonly kind: unknown;

  constructor(kind: unknown) {
    super(`unknown function kind: ${String(kind)}`);
    this.kind = kind;
  }
}

export class UnsupportedSandboxVersionError extends Error {
  override readonly name = 'UnsupportedSandboxVersionError';
  readonly version: unknown;

  constructor(version: unknown) {
    super(`unsupported sandbox version: ${String(version)}`);
    this.version = version;
  }
}

export function toJson(topology: Topology): SandboxEnvelope {
  return {
    format: SANDBOX_FORMAT,
    version: SANDBOX_VERSION,
    topology: encodeTopology(topology),
  };
}

export function fromJson(input: unknown): Topology {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (typeof value !== 'object' || value === null) {
    throw new UnsupportedSandboxVersionError(undefined);
  }
  const rec = value as Record<string, unknown>;
  if (rec.format !== SANDBOX_FORMAT || rec.version !== SANDBOX_VERSION) {
    throw new UnsupportedSandboxVersionError(rec.version);
  }
  return decodeTopology(rec.topology);
}

function encodeTopology(topology: Topology): TopologyJson {
  return {
    devices: topology.devices.map(encodeChassis),
    links: topology.links.map(encodeLink),
    profiles: [...topology.profiles],
  };
}

function encodeChassis(chassis: Chassis): ChassisJson {
  const out: ChassisJson = {
    id: chassis.id,
    label: chassis.label,
    ports: chassis.ports.map(encodePort),
    radios: chassis.radios.map(encodeRadio),
    functions: chassis.functions.map(encodeFn),
    internal: chassis.internal.map(encodeEdge),
  };
  if (chassis.preset !== undefined) out.preset = chassis.preset;
  if (chassis.mac !== undefined) out.mac = chassis.mac;
  if (chassis.ip !== undefined) out.ip = chassis.ip;
  if (chassis.prefix !== undefined) out.prefix = chassis.prefix;
  if (chassis.gateway !== undefined) out.gateway = chassis.gateway;
  if (chassis.resolver !== undefined) out.resolver = chassis.resolver;
  if (chassis.vlan !== undefined) out.vlan = chassis.vlan;
  return out;
}

function encodePort(port: Port): Port {
  return { id: port.id, mtu: port.mtu, ownedBy: port.ownedBy };
}

function encodeRadio(radio: Radio): Radio {
  const out: Radio = { id: radio.id, band: radio.band };
  if (radio.channel !== undefined) out.channel = radio.channel;
  return out;
}

function encodeEdge(edge: InternalEdge): InternalEdge {
  return { from: edge.from, to: edge.to };
}

function encodeLink(link: Link): Link {
  const out: Link = {
    id: link.id,
    a: { device: link.a.device, port: link.a.port },
    b: { device: link.b.device, port: link.b.port },
    medium: link.medium,
  };
  if (link.up !== undefined) out.up = link.up;
  return out;
}

function encodeFn(fn: Fn): FnJson {
  switch (fn.kind) {
    case 'bridging':
      return {
        kind: 'bridging',
        id: fn.id,
        vlanAware: fn.vlanAware,
        ...(fn.canTag !== undefined ? { canTag: fn.canTag } : {}),
        members: fn.members.map(encodeBridgePort),
      };
    case 'stp':
      return {
        kind: 'stp',
        id: fn.id,
        bridge: fn.bridge,
        priority: fn.priority,
        baseMac: fn.baseMac,
      };
    case 'routing':
      return {
        kind: 'routing',
        id: fn.id,
        ifaces: fn.ifaces.map(encodeIface),
        routes: fn.routes.map(encodeRoute),
        firewall: fn.firewall.map((rule) => ({ ...rule })),
      };
    case 'nat':
      return {
        kind: 'nat',
        id: fn.id,
        on: fn.on,
        portForwards: fn.portForwards.map(encodeForward),
      };
    case 'dhcp-server':
      return {
        kind: 'dhcp-server',
        id: fn.id,
        scopes: fn.scopes.map(encodeScope),
      };
    case 'dhcp-relay':
      return { kind: 'dhcp-relay', id: fn.id, helper: fn.helper };
    case 'wireless':
      return {
        kind: 'wireless',
        id: fn.id,
        radio: fn.radio,
        mode: fn.mode,
        ssid: fn.ssid,
        ...(fn.vlan !== undefined ? { vlan: fn.vlan } : {}),
      };
    case 'isp-handoff': {
      const out: Extract<FnJson, { kind: 'isp-handoff' }> = {
        kind: 'isp-handoff',
        id: fn.id,
        port: fn.port,
        mode: fn.mode,
      };
      if (fn.vlanTag !== undefined) out.vlanTag = fn.vlanTag;
      if (fn.credentials !== undefined) {
        out.credentials = { user: fn.credentials.user, pass: fn.credentials.pass };
      }
      if (fn.ip !== undefined) out.ip = fn.ip;
      if (fn.prefix !== undefined) out.prefix = fn.prefix;
      return out;
    }
    case 'resolver':
      return {
        kind: 'resolver',
        id: fn.id,
        records: fn.records.map(encodeRecord),
      };
    default: {
      const never: never = fn;
      throw new UnknownFunctionKindError(never);
    }
  }
}

function encodeBridgePort(port: BridgePort): BridgePortJson {
  return {
    port: port.port,
    mode: port.mode,
    pvid: port.pvid,
    taggedVlans: sortedVlans(port.taggedVlans),
    untaggedVlans: sortedVlans(port.untaggedVlans),
    acceptableFrameTypes: port.acceptableFrameTypes,
    ingressFiltering: port.ingressFiltering,
  };
}

function encodeIface(iface: RouterIface): RouterIface {
  const out: RouterIface = {
    id: iface.id,
    ip: iface.ip,
    prefix: iface.prefix,
    mac: iface.mac,
  };
  if (iface.vlan !== undefined) out.vlan = iface.vlan;
  return out;
}

function encodeRoute(route: Route): Route {
  const out: Route = { dest: route.dest, prefix: route.prefix, via: route.via };
  if (route.fromVlan !== undefined) out.fromVlan = route.fromVlan;
  return out;
}

function encodeForward(forward: PortForward): PortForward {
  return {
    proto: forward.proto,
    outsidePort: forward.outsidePort,
    toIp: forward.toIp,
    toPort: forward.toPort,
  };
}

function encodeRecord(record: NameRecord): NameRecord {
  return { name: record.name, ip: record.ip };
}

function encodeScope(scope: DhcpScope): DhcpScope {
  return {
    vlan: scope.vlan,
    poolStart: scope.poolStart,
    poolEnd: scope.poolEnd,
    gateway: scope.gateway,
    resolver: scope.resolver,
  };
}

function sortedVlans(vlans: Set<VlanId>): VlanId[] {
  return [...vlans].sort((a, b) => a - b);
}

function decodeTopology(value: unknown): Topology {
  const rec = asRecord(value);
  const devices = Array.isArray(rec.devices) ? rec.devices : [];
  const links = Array.isArray(rec.links) ? rec.links : [];
  const profiles = Array.isArray(rec.profiles) ? rec.profiles : [];
  return {
    devices: devices.map(decodeChassis),
    links: links.map(decodeLink),
    profiles: profiles.map((item) => String(item)),
  };
}

function decodeChassis(value: unknown): Chassis {
  const rec = asRecord(value);
  const functions = Array.isArray(rec.functions) ? rec.functions : [];
  const chassis: Chassis = {
    id: String(rec.id),
    label: String(rec.label),
    ports: Array.isArray(rec.ports) ? rec.ports.map(decodePort) : [],
    radios: Array.isArray(rec.radios) ? rec.radios.map(decodeRadio) : [],
    functions: functions.map(decodeFn),
    internal: Array.isArray(rec.internal) ? rec.internal.map(decodeEdge) : [],
  };
  if (typeof rec.preset === 'string') chassis.preset = rec.preset;
  if (typeof rec.mac === 'string') chassis.mac = rec.mac;
  if (typeof rec.ip === 'string') chassis.ip = rec.ip;
  if (typeof rec.prefix === 'number') chassis.prefix = rec.prefix;
  if (typeof rec.gateway === 'string') chassis.gateway = rec.gateway;
  if (typeof rec.resolver === 'string') chassis.resolver = rec.resolver;
  if (typeof rec.vlan === 'number') chassis.vlan = rec.vlan;
  return chassis;
}

function decodePort(value: unknown): Port {
  const rec = asRecord(value);
  return {
    id: String(rec.id),
    mtu: Number(rec.mtu),
    ownedBy: String(rec.ownedBy),
  };
}

function decodeRadio(value: unknown): Radio {
  const rec = asRecord(value);
  const band = rec.band === '2.4' || rec.band === '5' || rec.band === '6' ? rec.band : '5';
  const out: Radio = { id: String(rec.id), band };
  if (typeof rec.channel === 'number') out.channel = rec.channel;
  return out;
}

function decodeEdge(value: unknown): InternalEdge {
  const rec = asRecord(value);
  return { from: String(rec.from), to: String(rec.to) };
}

function decodeLink(value: unknown): Link {
  const rec = asRecord(value);
  const a = asRecord(rec.a);
  const b = asRecord(rec.b);
  const medium = rec.medium === 'wireless' ? 'wireless' : 'wired';
  const out: Link = {
    id: String(rec.id),
    a: { device: String(a.device), port: String(a.port) },
    b: { device: String(b.device), port: String(b.port) },
    medium,
  };
  if (typeof rec.up === 'boolean') out.up = rec.up;
  return out;
}

function decodeFn(value: unknown): Fn {
  const rec = asRecord(value);
  switch (rec.kind) {
    case 'bridging':
      return {
        kind: 'bridging',
        id: String(rec.id),
        vlanAware: Boolean(rec.vlanAware),
        ...(typeof rec.canTag === 'boolean' ? { canTag: rec.canTag } : {}),
        members: Array.isArray(rec.members)
          ? rec.members.map(decodeBridgePort)
          : [],
        fdb: new Map(),
      };
    case 'stp':
      return {
        kind: 'stp',
        id: String(rec.id),
        bridge: String(rec.bridge),
        priority: Number(rec.priority),
        baseMac: String(rec.baseMac),
        state: new Map(),
      };
    case 'routing':
      return {
        kind: 'routing',
        id: String(rec.id),
        ifaces: Array.isArray(rec.ifaces) ? rec.ifaces.map(decodeIface) : [],
        routes: Array.isArray(rec.routes) ? rec.routes.map(decodeRoute) : [],
        firewall: Array.isArray(rec.firewall)
          ? rec.firewall.map(decodeFirewall)
          : [],
      };
    case 'nat':
      return {
        kind: 'nat',
        id: String(rec.id),
        on: String(rec.on),
        portForwards: Array.isArray(rec.portForwards)
          ? rec.portForwards.map(decodeForward)
          : [],
      };
    case 'dhcp-server':
      return {
        kind: 'dhcp-server',
        id: String(rec.id),
        scopes: Array.isArray(rec.scopes) ? rec.scopes.map(decodeScope) : [],
      };
    case 'dhcp-relay':
      return {
        kind: 'dhcp-relay',
        id: String(rec.id),
        helper: String(rec.helper),
      };
    case 'wireless':
      return {
        kind: 'wireless',
        id: String(rec.id),
        radio: String(rec.radio),
        mode: rec.mode === 'client' || rec.mode === 'mesh' ? rec.mode : 'ap',
        ssid: String(rec.ssid),
        ...(typeof rec.vlan === 'number' ? { vlan: rec.vlan } : {}),
      };
    case 'isp-handoff': {
      const mode =
        rec.mode === 'dhcp' || rec.mode === 'static' ? rec.mode : 'pppoe';
      const out: Extract<Fn, { kind: 'isp-handoff' }> = {
        kind: 'isp-handoff',
        id: String(rec.id),
        port: String(rec.port),
        mode,
      };
      if (typeof rec.vlanTag === 'number') out.vlanTag = rec.vlanTag;
      if (isCredentials(rec.credentials)) {
        out.credentials = {
          user: rec.credentials.user,
          pass: rec.credentials.pass,
        };
      }
      if (typeof rec.ip === 'string') out.ip = rec.ip;
      if (typeof rec.prefix === 'number') out.prefix = rec.prefix;
      return out;
    }
    case 'resolver':
      return {
        kind: 'resolver',
        id: String(rec.id),
        records: Array.isArray(rec.records)
          ? rec.records.map(decodeRecord)
          : [],
      };
    default:
      throw new UnknownFunctionKindError(rec.kind);
  }
}

function decodeBridgePort(value: unknown): BridgePort {
  const rec = asRecord(value);
  const mode = rec.mode === 'trunk' ? 'trunk' : 'access';
  const acceptable =
    rec.acceptableFrameTypes === 'tagged-only' ||
    rec.acceptableFrameTypes === 'untagged-only'
      ? rec.acceptableFrameTypes
      : 'all';
  return {
    port: String(rec.port),
    mode,
    pvid: Number(rec.pvid),
    taggedVlans: asVlanSet(rec.taggedVlans),
    untaggedVlans: asVlanSet(rec.untaggedVlans),
    acceptableFrameTypes: acceptable,
    ingressFiltering: Boolean(rec.ingressFiltering),
  };
}

function decodeIface(value: unknown): RouterIface {
  const rec = asRecord(value);
  const out: RouterIface = {
    id: String(rec.id),
    ip: String(rec.ip),
    prefix: Number(rec.prefix),
    mac: String(rec.mac),
  };
  if (typeof rec.vlan === 'number') out.vlan = rec.vlan;
  return out;
}

function decodeRoute(value: unknown): Route {
  const rec = asRecord(value);
  const out: Route = {
    dest: String(rec.dest),
    prefix: Number(rec.prefix),
    via: String(rec.via),
  };
  if (typeof rec.fromVlan === 'number') out.fromVlan = rec.fromVlan;
  return out;
}

function decodeFirewall(
  value: unknown,
): Extract<Fn, { kind: 'routing' }>['firewall'][number] {
  const rec = asRecord(value);
  return {
    from: Number(rec.from),
    to: Number(rec.to),
    action: rec.action === 'deny' ? 'deny' : 'allow',
  };
}

function decodeForward(value: unknown): PortForward {
  const rec = asRecord(value);
  return {
    proto: rec.proto === 'udp' ? 'udp' : 'tcp',
    outsidePort: Number(rec.outsidePort),
    toIp: String(rec.toIp),
    toPort: Number(rec.toPort),
  };
}

function decodeRecord(value: unknown): NameRecord {
  const rec = asRecord(value);
  return { name: String(rec.name), ip: String(rec.ip) };
}

function decodeScope(value: unknown): DhcpScope {
  const rec = asRecord(value);
  return {
    vlan: Number(rec.vlan),
    poolStart: String(rec.poolStart),
    poolEnd: String(rec.poolEnd),
    gateway: String(rec.gateway),
    resolver: String(rec.resolver),
  };
}

function asVlanSet(value: unknown): Set<VlanId> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is number => typeof item === 'number'));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('sandbox JSON expected an object');
  }
  return value as Record<string, unknown>;
}

function isCredentials(
  value: unknown,
): value is { user: string; pass: string } {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.user === 'string' && typeof rec.pass === 'string';
}
