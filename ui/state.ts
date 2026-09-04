import { defaults } from '../src/index';
import type {
  BridgePort,
  Chassis,
  DeviceId,
  Link,
  RouterIface,
  Topology,
  VlanId,
} from '../src/index';
import { presetById } from './presets';

export interface EditorState {
  topology: Topology;
  seq: number;
  selected: DeviceId | null;
  pendingLink: { device: DeviceId; port: string } | null;
  notice: string | null;
}

export const initialState: EditorState = {
  topology: { devices: [], links: [], profiles: [] },
  seq: 0,
  selected: null,
  pendingLink: null,
  notice: null,
};

function deviceOf(
  topology: Topology,
  id: DeviceId,
): Chassis | undefined {
  return topology.devices.find((device) => device.id === id);
}

function bridgeOf(chassis: Chassis) {
  const fn = chassis.functions.find((item) => item.kind === 'bridging');
  return fn?.kind === 'bridging' ? fn : undefined;
}

export function bridgeMemberOf(
  chassis: Chassis,
  portId: string,
): BridgePort | undefined {
  return bridgeOf(chassis)?.members.find((member) => member.port === portId);
}

function isWirelessPort(chassis: Chassis, portId: string): boolean {
  const port = chassis.ports.find((item) => item.id === portId);
  if (!port) return false;
  return chassis.functions.some(
    (fn) => fn.kind === 'wireless' && fn.id === port.ownedBy,
  );
}

export function portOccupied(
  topology: Topology,
  deviceId: DeviceId,
  portId: string,
): boolean {
  return topology.links.some(
    (link) =>
      (link.a.device === deviceId && link.a.port === portId) ||
      (link.b.device === deviceId && link.b.port === portId),
  );
}

/** First port with no link attached; undefined when every port is used. */
export function freePort(
  topology: Topology,
  chassis: Chassis,
): string | undefined {
  return chassis.ports.find(
    (candidate) => !portOccupied(topology, chassis.id, candidate.id),
  )?.id;
}

export function freePorts(topology: Topology, chassis: Chassis): string[] {
  return chassis.ports
    .filter((candidate) => !portOccupied(topology, chassis.id, candidate.id))
    .map((candidate) => candidate.id);
}

function withChassis(
  state: EditorState,
  id: DeviceId,
  mutate: (chassis: Chassis) => Chassis,
): EditorState {
  return {
    ...state,
    topology: {
      ...state.topology,
      devices: state.topology.devices.map((device) =>
        device.id === id ? mutate(device) : device,
      ),
    },
  };
}

function withMember(
  state: EditorState,
  deviceId: DeviceId,
  portId: string,
  mutate: (member: BridgePort) => BridgePort,
): EditorState {
  return withChassis(state, deviceId, (chassis) => {
    const bridge = bridgeOf(chassis);
    if (!bridge) return chassis;
    const members = bridge.members.map((member) =>
      member.port === portId ? mutate(member) : member,
    );
    return {
      ...chassis,
      functions: chassis.functions.map((fn) =>
        fn.kind === 'bridging' && fn.id === bridge.id
          ? { ...fn, members }
          : fn,
      ),
    };
  });
}

export function addPreset(state: EditorState, presetId: string): EditorState {
  const preset = presetById(presetId);
  if (!preset) {
    return { ...state, notice: `Unknown preset: ${presetId}` };
  }
  const seq = state.seq + 1;
  const id = `${preset.id}-${seq}`;
  const chassis = preset.build(id, seq);
  return {
    ...state,
    seq,
    topology: {
      ...state.topology,
      devices: [...state.topology.devices, chassis],
    },
    selected: id,
    notice: null,
  };
}

export function startLink(
  state: EditorState,
  deviceId: DeviceId,
  portId?: string,
): EditorState {
  const chassis = deviceOf(state.topology, deviceId);
  if (!chassis) return state;
  const port = portId ?? freePort(state.topology, chassis);
  if (!port || !chassis.ports.some((item) => item.id === port)) {
    return {
      ...state,
      notice: `No free port on ${chassis.label} (${chassis.id})`,
      pendingLink: null,
    };
  }
  if (portOccupied(state.topology, deviceId, port)) {
    return {
      ...state,
      notice: `Port ${port} on ${chassis.label} (${chassis.id}) is occupied`,
      pendingLink: null,
    };
  }
  return { ...state, pendingLink: { device: deviceId, port }, notice: null };
}

export function completeLink(
  state: EditorState,
  deviceId: DeviceId,
  portId?: string,
): EditorState {
  const pending = state.pendingLink;
  if (!pending) {
    return { ...state, notice: 'Pick Start link on a device first' };
  }
  const chassis = deviceOf(state.topology, deviceId);
  if (!chassis) return { ...state, pendingLink: null };
  const port = portId ?? freePort(state.topology, chassis);
  if (!port || !chassis.ports.some((item) => item.id === port)) {
    return {
      ...state,
      notice: `No free port on ${chassis.label} (${chassis.id})`,
      pendingLink: null,
    };
  }
  if (portOccupied(state.topology, deviceId, port)) {
    return {
      ...state,
      notice: `Port ${port} on ${chassis.label} (${chassis.id}) is occupied`,
      pendingLink: null,
    };
  }
  const from = deviceOf(state.topology, pending.device);
  const medium: Link['medium'] =
    from && isWirelessPort(from, pending.port)
      ? 'wireless'
      : isWirelessPort(chassis, port)
        ? 'wireless'
        : 'wired';
  const link: Link = {
    id: `l${state.seq + 1}`,
    a: { device: pending.device, port: pending.port },
    b: { device: deviceId, port },
    medium,
  };
  return {
    ...state,
    seq: state.seq + 1,
    topology: {
      ...state.topology,
      links: [...state.topology.links, link],
    },
    pendingLink: null,
    notice: null,
  };
}

export function cancelLink(state: EditorState): EditorState {
  return { ...state, pendingLink: null };
}

export function select(state: EditorState, deviceId: DeviceId): EditorState {
  return { ...state, selected: deviceId, notice: null };
}

export function removeDevice(
  state: EditorState,
  deviceId: DeviceId,
): EditorState {
  return {
    ...state,
    topology: {
      devices: state.topology.devices.filter((device) => device.id !== deviceId),
      links: state.topology.links.filter(
        (link) => link.a.device !== deviceId && link.b.device !== deviceId,
      ),
      profiles: state.topology.profiles,
    },
    selected: state.selected === deviceId ? null : state.selected,
  };
}

export function setPvid(
  state: EditorState,
  deviceId: DeviceId,
  portId: string,
  vlan: VlanId,
): EditorState {
  // PVID is an ingress setting only; no control may write pvid and
  // untaggedVlans at once (ADR 0008).
  return withMember(state, deviceId, portId, (member) => ({
    ...member,
    pvid: vlan,
  }));
}

export function setUntaggedVlans(
  state: EditorState,
  deviceId: DeviceId,
  portId: string,
  vlans: VlanId[],
): EditorState {
  return withMember(state, deviceId, portId, (member) => ({
    ...member,
    untaggedVlans: new Set(vlans),
  }));
}

export function setTaggedVlans(
  state: EditorState,
  deviceId: DeviceId,
  portId: string,
  vlans: VlanId[],
): EditorState {
  return withMember(state, deviceId, portId, (member) => ({
    ...member,
    taggedVlans: new Set(vlans),
  }));
}

export function setPortMode(
  state: EditorState,
  deviceId: DeviceId,
  portId: string,
  mode: 'access' | 'trunk',
): EditorState {
  return withMember(state, deviceId, portId, (member) => ({
    ...member,
    mode,
  }));
}

/**
 * STP bridge priority lives on the stp function, not the chassis or the
 * port. A chassis with no stp function stays bare (#67) - the setter is a
 * no-op there, never inventing a function.
 */
export function setStpPriority(
  state: EditorState,
  deviceId: DeviceId,
  priority: number,
): EditorState {
  // 802.1D bridge priority: 0..61440 in steps of 4096 (the priority field
  // occupies the top 4 bits of the bridge id). 0 is legal - it is the
  // value that guarantees root - and non-multiples are not bridge ids.
  const valid =
    Number.isInteger(priority) &&
    priority >= 0 &&
    priority <= 61440 &&
    priority % 4096 === 0;
  if (!valid) {
    return {
      ...state,
      notice: 'STP priority must be 0..61440 in steps of 4096',
    };
  }
  return withChassis(state, deviceId, (chassis) => ({
    ...chassis,
    functions: chassis.functions.map((fn) =>
      fn.kind === 'stp' ? { ...fn, priority } : fn,
    ),
  }));
}

/** The per-port admission rule bridge.ts enforces at ingress. */
export function setPortAcceptable(
  state: EditorState,
  deviceId: DeviceId,
  portId: string,
  acceptableFrameTypes: 'all' | 'tagged-only' | 'untagged-only',
): EditorState {
  return withMember(state, deviceId, portId, (member) => ({
    ...member,
    acceptableFrameTypes,
  }));
}

/** The 802.1Q ingress-filtering flag on the bridge port. */
export function setPortIngressFiltering(
  state: EditorState,
  deviceId: DeviceId,
  portId: string,
  ingressFiltering: boolean,
): EditorState {
  return withMember(state, deviceId, portId, (member) => ({
    ...member,
    ingressFiltering,
  }));
}

export function setHostAddress(
  state: EditorState,
  deviceId: DeviceId,
  addr: { ip?: string; prefix?: number; gateway?: string },
): EditorState {
  return withChassis(state, deviceId, (chassis) => ({ ...chassis, ...addr }));
}

export function setRouterIfaceVlan(
  state: EditorState,
  deviceId: DeviceId,
  ifaceId: string,
  vlan: VlanId | undefined,
): EditorState {
  return withChassis(state, deviceId, (chassis) => ({
    ...chassis,
    functions: chassis.functions.map((fn) => {
      if (fn.kind !== 'routing') return fn;
      const ifaces: RouterIface[] = fn.ifaces.map((iface) => {
        if (iface.id !== ifaceId) return iface;
        const next: RouterIface = {
          id: iface.id,
          ip: iface.ip,
          prefix: iface.prefix,
          mac: iface.mac,
        };
        if (vlan !== undefined) next.vlan = vlan;
        return next;
      });
      return { ...fn, ifaces };
    }),
  }));
}

export interface DhcpScopePatch {
  vlan?: number;
  poolStart?: string;
  poolEnd?: string;
  gateway?: string;
  resolver?: string;
}

/**
 * Touch only the named scope; siblings are preserved. Validation mirrors the
 * engine's own honesty: vlan is an integer 1..4094 and the address fields are
 * non-empty strings — no IP-format claim the engine cannot back.
 */
export function setDhcpScope(
  state: EditorState,
  deviceId: DeviceId,
  index: number,
  patch: DhcpScopePatch,
): EditorState {
  const vlanValid =
    patch.vlan === undefined ||
    (Number.isInteger(patch.vlan) && patch.vlan >= 1 && patch.vlan <= 4094);
  const stringsValid = (
    ['poolStart', 'poolEnd', 'gateway', 'resolver'] as const
  ).every((field) => {
    const value = patch[field];
    return value === undefined || (typeof value === 'string' && value.trim() !== '');
  });
  if (!vlanValid || !stringsValid) {
    return { ...state, notice: 'Scope fields invalid' };
  }
  return withChassis(state, deviceId, (chassis) => ({
    ...chassis,
    // The engine's standalone answer gates on chassis.vlan (src/dhcp.ts):
    // a scope vlan that drifts from it can never answer. A vlan patch moves
    // the service VLAN with the scope so the edit cannot silently disable
    // the server (#84).
    ...(patch.vlan !== undefined ? { vlan: patch.vlan } : {}),
    functions: chassis.functions.map((fn) => {
      if (fn.kind !== 'dhcp-server') return fn;
      const scopes = fn.scopes.map((scope, i) =>
        i === index ? { ...scope, ...patch } : scope,
      );
      return { ...fn, scopes };
    }),
  }));
}
