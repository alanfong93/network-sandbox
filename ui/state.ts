import { defaults } from '../src/index';
import type {
  BridgePort,
  Chassis,
  DeviceId,
  Link,
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

/** First port with no link attached; undefined when every port is used. */
export function freePort(
  topology: Topology,
  chassis: Chassis,
): string | undefined {
  return chassis.ports.find(
    (candidate) =>
      !topology.links.some(
        (link) =>
          (link.a.device === chassis.id && link.a.port === candidate.id) ||
          (link.b.device === chassis.id && link.b.port === candidate.id),
      ),
  )?.id;
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
): EditorState {
  const chassis = deviceOf(state.topology, deviceId);
  if (!chassis) return state;
  const port = freePort(state.topology, chassis);
  if (!port) {
    return {
      ...state,
      notice: `No free port on ${chassis.label} (${chassis.id})`,
      pendingLink: null,
    };
  }
  return { ...state, pendingLink: { device: deviceId, port }, notice: null };
}

export function completeLink(
  state: EditorState,
  deviceId: DeviceId,
): EditorState {
  const pending = state.pendingLink;
  if (!pending) {
    return { ...state, notice: 'Pick Start link on a device first' };
  }
  const chassis = deviceOf(state.topology, deviceId);
  if (!chassis) return { ...state, pendingLink: null };
  const port = freePort(state.topology, chassis);
  if (!port) {
    return {
      ...state,
      notice: `No free port on ${chassis.label} (${chassis.id})`,
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

export function setHostAddress(
  state: EditorState,
  deviceId: DeviceId,
  addr: { ip?: string; prefix?: number; gateway?: string },
): EditorState {
  return withChassis(state, deviceId, (chassis) => ({ ...chassis, ...addr }));
}
