import { defaults, inSubnet } from '../src/index';
import type {
  BridgePort,
  Chassis,
  DeviceId,
  Link,
  RouterIface,
  Topology,
  VlanId,
} from '../src/index';
import { dropDevice, type Layout } from './layout';
import { nextDhcpServerIndex, presetById } from './presets';

export interface EditorState {
  topology: Topology;
  seq: number;
  selected: DeviceId | null;
  pendingLink: { device: DeviceId; port: string } | null;
  notice: string | null;
  layout: Layout | null;
}

export const initialState: EditorState = {
  topology: { devices: [], links: [], profiles: [] },
  seq: 0,
  selected: null,
  pendingLink: null,
  notice: null,
  layout: null,
};

function deviceOf(
  topology: Topology,
  id: DeviceId,
): Chassis | undefined {
  return topology.devices.find((device) => device.id === id);
}

/**
 * One ISP-handoff edit: mode and/or the required VLAN tag (#68). An
 * explicit `vlanTag: undefined` clears the tag (no tag requirement); a
 * patch without the key leaves it alone. The modem is the ISP's
 * requirement - the customer side matches it via the router's WAN VLAN
 * control (#61 Watch: no PPPoE-client function exists by design).
 */
export function setIspHandoff(
  state: EditorState,
  deviceId: DeviceId,
  patch: { mode?: 'pppoe' | 'dhcp' | 'static'; vlanTag?: VlanId },
): EditorState {
  // Runtime guard, not just the type: the setter is an exported API and
  // the onChange call site asserts its input (#68 review).
  const modeValid =
    patch.mode === undefined ||
    patch.mode === 'pppoe' ||
    patch.mode === 'dhcp' ||
    patch.mode === 'static';
  if (!modeValid) {
    return { ...state, notice: 'ISP mode invalid' };
  }
  const tagValid =
    patch.vlanTag === undefined ||
    (Number.isInteger(patch.vlanTag) &&
      patch.vlanTag >= 1 &&
      patch.vlanTag <= 4094);
  if (!tagValid) {
    return { ...state, notice: 'ISP VLAN tag invalid' };
  }
  return withChassis(state, deviceId, (chassis) => ({
    ...chassis,
    functions: chassis.functions.map((fn) => {
      if (fn.kind !== 'isp-handoff') return fn;
      const next = { ...fn };
      if (patch.mode !== undefined) next.mode = patch.mode;
      if ('vlanTag' in patch) {
        if (patch.vlanTag === undefined) delete next.vlanTag;
        else next.vlanTag = patch.vlanTag;
      }
      return next;
    }),
  }));
}

/**
 * The bridging function whose members include portId. First match in
 * functions[] order is canonical for member identity when an imported
 * port sits in two bridges (ADR 0028): the search covers EVERY bridging
 * function, matching the engine's own sviBridgeMember - palette presets
 * carry one bridge, but json import round-trips many (#89).
 */
export function owningBridgeOf(chassis: Chassis, portId: string) {
  const fn = chassis.functions.find(
    (item) =>
      item.kind === 'bridging' && item.members.some((m) => m.port === portId),
  );
  return fn?.kind === 'bridging' ? fn : undefined;
}

export function bridgeMemberOf(
  chassis: Chassis,
  portId: string,
): BridgePort | undefined {
  return owningBridgeOf(chassis, portId)?.members.find(
    (member) => member.port === portId,
  );
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
    (candidate) =>
      !isSviMemberPort(chassis, candidate.id) &&
      !portOccupied(topology, chassis.id, candidate.id),
  )?.id;
}

export function freePorts(topology: Topology, chassis: Chassis): string[] {
  return chassis.ports
    .filter(
      (candidate) =>
        !isSviMemberPort(chassis, candidate.id) &&
        !portOccupied(topology, chassis.id, candidate.id),
    )
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
    // Port-scoped, not first-bridge: edits land in the bridge that
    // actually carries the port (ADR 0028).
    const bridge = owningBridgeOf(chassis, portId);
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

export function setLayoutPoint(
  state: EditorState,
  deviceId: DeviceId,
  pos: { x: number; y: number },
): EditorState {
  if (!state.topology.devices.some((device) => device.id === deviceId)) {
    return state;
  }
  return {
    ...state,
    layout: { ...(state.layout ?? {}), [deviceId]: pos },
  };
}

export function placePreset(
  state: EditorState,
  presetId: string,
  pos: { x: number; y: number },
): EditorState {
  const next = addPreset(state, presetId);
  const id = next.selected;
  if (!id) return next;
  return setLayoutPoint(next, id, pos);
}

export function moveDevice(
  state: EditorState,
  deviceId: DeviceId,
  pos: { x: number; y: number },
): EditorState {
  return setLayoutPoint(state, deviceId, pos);
}

export function addPreset(state: EditorState, presetId: string): EditorState {
  const preset = presetById(presetId);
  if (!preset) {
    return { ...state, notice: `Unknown preset: ${presetId}` };
  }
  const seq = state.seq + 1;
  const id = `${preset.id}-${seq}`;
  // The dhcp-server preset keys its chassis IP to the SERVER ordinal
  // (lowest unclaimed), never the global seq - unrelated placements
  // must not shift server addressing (#92). null = static range
  // exhausted: the server ships no IP and the notice says why (a
  // broadcast or in-pool address would be a false affordance). Other
  // presets ignore the ordinal.
  const serverIndex = nextDhcpServerIndex(state.topology.devices);
  const chassis = preset.build(id, seq, serverIndex ?? undefined);
  const exhausted = preset.id === 'dhcp-server' && serverIndex === null;
  return {
    ...state,
    seq,
    topology: {
      ...state.topology,
      devices: [...state.topology.devices, chassis],
    },
    selected: id,
    notice: exhausted
      ? 'DHCP server static range exhausted (153 servers on VLAN 10) - set the chassis IP manually.'
      : null,
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
  if (pending.device === deviceId && pending.port === port) {
    return state;
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
    layout: state.layout ? dropDevice(state.layout, deviceId) : null,
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
  addr: { ip?: string; prefix?: number; gateway?: string; resolver?: string },
): EditorState {
  return withChassis(state, deviceId, (chassis) => ({ ...chassis, ...addr }));
}

/**
 * Touch only the named record of the resolver function (ADR 0030). No
 * sibling moves; a chassis with no resolver function is a no-op, never an
 * invented function.
 */
export function setResolverRecord(
  state: EditorState,
  deviceId: DeviceId,
  index: number,
  patch: { name?: string; ip?: string },
): EditorState {
  return withChassis(state, deviceId, (chassis) => ({
    ...chassis,
    functions: chassis.functions.map((fn) => {
      if (fn.kind !== 'resolver') return fn;
      const records = fn.records.map((record, i) =>
        i === index ? { ...record, ...patch } : record,
      );
      return { ...fn, records };
    }),
  }));
}

export function addResolverRecord(
  state: EditorState,
  deviceId: DeviceId,
): EditorState {
  return withChassis(state, deviceId, (chassis) => ({
    ...chassis,
    functions: chassis.functions.map((fn) =>
      fn.kind === 'resolver'
        ? { ...fn, records: [...fn.records, { name: '', ip: '' }] }
        : fn,
    ),
  }));
}

export function removeResolverRecord(
  state: EditorState,
  deviceId: DeviceId,
  index: number,
): EditorState {
  return withChassis(state, deviceId, (chassis) => ({
    ...chassis,
    functions: chassis.functions.map((fn) =>
      fn.kind === 'resolver'
        ? { ...fn, records: fn.records.filter((_, i) => i !== index) }
        : fn,
    ),
  }));
}

/** The market SKUs a switch port count may take (#125). No 7-port switches. */
export const SWITCH_PORT_SKUS = [5, 8, 16, 24, 48] as const;

function accessMember(portId: string, vlan: VlanId): BridgePort {
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

/**
 * Resize a pure switch's port count to a market SKU (#125). Growth appends
 * numbered ports and matching access members at the defaults; shrink keeps
 * the first count and refuses - with a notice, never a silent unlink - when
 * any dropped port carries a link. Refused outside pure switches: an L3
 * switch's rt-owned SVI ports are part of the #71 composition, and resizing
 * around them would wreck it. There is no device kind anywhere - this edits
 * one chassis' ports and its bridging members (ADR 0013).
 */
export function setSwitchPortCount(
  state: EditorState,
  deviceId: DeviceId,
  count: number,
): EditorState {
  const chassis = deviceOf(state.topology, deviceId);
  if (!chassis) return state;
  const bridge = chassis.functions.find((fn) => fn.kind === 'bridging');
  if (!bridge || bridge.kind !== 'bridging') {
    return { ...state, notice: 'Only a switch has a port count' };
  }
  if (!chassis.ports.every((port) => port.ownedBy === bridge.id)) {
    return {
      ...state,
      notice: 'This switch mixes bridge and routed ports - the port count is fixed',
    };
  }
  if (!(SWITCH_PORT_SKUS as readonly number[]).includes(count)) {
    return { ...state, notice: 'Port count must be 5, 8, 16, 24 or 48' };
  }
  const current = chassis.ports.length;
  if (count === current) return state;
  if (count < current) {
    const dropped = chassis.ports.slice(count).map((port) => port.id);
    if (
      state.pendingLink?.device === deviceId &&
      dropped.includes(state.pendingLink.port)
    ) {
      return {
        ...state,
        notice: `Port ${state.pendingLink.port} is waiting for a link - cancel it first`,
      };
    }
    const linked = dropped.filter((portId) =>
      portOccupied(state.topology, deviceId, portId),
    );
    if (linked.length > 0) {
      return {
        ...state,
        notice: `Port${linked.length > 1 ? 's' : ''} ${linked.join(', ')} ${
          linked.length > 1 ? 'have' : 'has'
        } links - unlink them first`,
      };
    }
    const keep = new Set(chassis.ports.slice(0, count).map((port) => port.id));
    return withChassis(state, deviceId, (c) => ({
      ...c,
      ports: c.ports.slice(0, count),
      functions: c.functions.map((fn) =>
        fn.kind === 'bridging' && fn.id === bridge.id
          ? { ...fn, members: fn.members.filter((m) => keep.has(m.port)) }
          : fn,
      ),
    }));
  }
  return withChassis(state, deviceId, (c) => {
    const ports = [...c.ports];
    const nextBridge = c.functions.find(
      (fn) => fn.kind === 'bridging' && fn.id === bridge.id,
    );
    if (!nextBridge || nextBridge.kind !== 'bridging') return c;
    const members = [...nextBridge.members];
    for (let i = current + 1; i <= count; i++) {
      ports.push({ id: String(i), mtu: defaults.portMtu, ownedBy: bridge.id });
      members.push(accessMember(String(i), defaults.pvid));
    }
    return {
      ...c,
      ports,
      functions: c.functions.map((fn) =>
        fn.kind === 'bridging' && fn.id === bridge.id ? { ...fn, members } : fn,
      ),
    };
  });
}

/**
 * True when the port is internal wiring, not a jack: owned by a routing
 * function and also a bridging member (the SVI composition, #71). Such a
 * port never carries a link - cabling it is a false affordance, so neither
 * the inspector nor the canvas offers it.
 */
export function isSviMemberPort(chassis: Chassis, portId: string): boolean {
  const port = chassis.ports.find((item) => item.id === portId);
  if (!port) return false;
  const rtOwned = chassis.functions.some(
    (fn) => fn.kind === 'routing' && fn.id === port.ownedBy,
  );
  if (!rtOwned) return false;
  return chassis.functions.some(
    (fn) => fn.kind === 'bridging' && fn.members.some((m) => m.port === portId),
  );
}

/**
 * A routing chassis shaped like the router preset: a routing function, a
 * LAN-side bridge, and physical `lan`/`lanN` plus `wan`/`wanN` ports. The
 * predicate is the data shape, never the preset id (ADR 0013) - the L3
 * switch carries no such port names and never matches.
 */
export function isRouterShape(chassis: Chassis): boolean {
  const rt = chassis.functions.find((fn) => fn.kind === 'routing');
  if (!rt || rt.kind !== 'routing') return false;
  const bridge = chassis.functions.find((fn) => fn.kind === 'bridging');
  if (!bridge || bridge.kind !== 'bridging') return false;
  return (
    chassis.ports.some((p) => routerPortNumber(p.id, 'lan') !== undefined) &&
    chassis.ports.some((p) => routerPortNumber(p.id, 'wan') !== undefined)
  );
}

export function routerPortNumber(id: string, stem: 'lan' | 'wan'): number | undefined {
  if (id === stem) return 1;
  const match = new RegExp(`^${stem}(\\d+)$`).exec(id);
  return match ? Number(match[1]) : undefined;
}

function allMacsInUse(topology: Topology): Set<string> {
  const used = new Set<string>();
  for (const device of topology.devices) {
    if (device.mac !== undefined) used.add(device.mac);
    for (const fn of device.functions) {
      if (fn.kind === 'routing') {
        for (const iface of fn.ifaces) used.add(iface.mac);
      }
      if (fn.kind === 'stp') used.add(fn.baseMac);
    }
  }
  return used;
}

/**
 * The next free MAC for a grown WAN iface, derived from the seed by walking
 * the last octet up. Preset-derived identities always end :00, so a bumped
 * last octet never collides with a placed box; the used-set check also
 * covers hand-edited imports.
 */
function nextFreeIfaceMac(topology: Topology, seed: string): string {
  const used = allMacsInUse(topology);
  const parts = seed.split(':');
  if (parts.length !== 6) parts.splice(0, parts.length, ...'02:00:00:00:00:00'.split(':'));
  for (let last = 1; last <= 255; last++) {
    const candidate = [...parts.slice(0, 5), last.toString(16).padStart(2, '0')].join(':');
    if (!used.has(candidate)) return candidate;
  }
  return seed;
}

/**
 * Resize the router's physical LAN or WAN set (#124). LAN ports join the
 * one LAN bridge - `lan-svi` stays the sole LAN routing iface, so an extra
 * jack can never become a second subnet. Extra WANs are routed uplinks on
 * the engine's second-WAN pattern: an untagged iface and a second default
 * route, both removed again on shrink. Cabled and pending ports are refused,
 * never silently unlinked.
 */
export function setRouterPortCount(
  state: EditorState,
  deviceId: DeviceId,
  side: 'lan' | 'wan',
  count: number,
): EditorState {
  const max = side === 'lan' ? 8 : 2;
  if (!Number.isInteger(count) || count < 1 || count > max) {
    return {
      ...state,
      notice: `Router ${side.toUpperCase()} count must be 1 to ${max}`,
    };
  }
  const chassis = deviceOf(state.topology, deviceId);
  if (!chassis) return state;
  if (!isRouterShape(chassis)) {
    return { ...state, notice: 'Only a router has LAN and WAN counts' };
  }
  const rt = chassis.functions.find(
    (fn) => fn.kind === 'routing' && fn.id !== undefined,
  );
  const bridge = chassis.functions.find((fn) => fn.kind === 'bridging');
  if (!rt || rt.kind !== 'routing' || !bridge || bridge.kind !== 'bridging') {
    return { ...state, notice: 'Router port count needs the LAN bridge and routing functions' };
  }
  const physical = chassis.ports
    .filter((port) => routerPortNumber(port.id, side) !== undefined)
    .sort((a, b) => routerPortNumber(a.id, side)! - routerPortNumber(b.id, side)!);
  const current = physical.length;
  if (count === current) return state;
  if (count < current) {
    const removed = physical.slice(count).map((port) => port.id);
    const pending = state.pendingLink;
    if (pending?.device === deviceId && removed.includes(pending.port)) {
      return { ...state, notice: `Port ${pending.port} is waiting for a link - cancel it first` };
    }
    const linked = removed.filter((port) => portOccupied(state.topology, deviceId, port));
    if (linked.length > 0) {
      return { ...state, notice: `Port ${linked.join(', ')} has links - unlink it first` };
    }
    const removedSet = new Set(removed);
    // WAN shrink also drops the default route the removed WAN carried: a
    // route whose via sits in the dead iface's subnet is not a candidate
    // (ADR 0020's reachability filter) - leaving it is stale data.
    const deadSubnets =
      side === 'wan'
        ? rt.ifaces
            .filter((iface) => removedSet.has(iface.id))
            .map((iface) => ({ ip: iface.ip, prefix: iface.prefix }))
        : [];
    return withChassis(state, deviceId, (c) => ({
      ...c,
      ports: c.ports.filter((port) => !removedSet.has(port.id)),
      functions: c.functions.map((fn) => {
        if (side === 'lan' && fn.kind === 'bridging' && fn.id === bridge.id) {
          return { ...fn, members: fn.members.filter((member) => !removedSet.has(member.port)) };
        }
        if (side === 'wan' && fn.kind === 'routing' && fn.id === rt.id) {
          return {
            ...fn,
            ifaces: fn.ifaces.filter((iface) => !removedSet.has(iface.id)),
            routes: fn.routes.filter(
              (route) =>
                !deadSubnets.some((net) => inSubnet(route.via, net.ip, net.prefix)),
            ),
          };
        }
        return fn;
      }),
    }));
  }
  return withChassis(state, deviceId, (c) => {
    const ports = [...c.ports];
    const bridgeMembers = [...bridge.members];
    const ifaces = [...rt.ifaces];
    const routes = [...rt.routes];
    // A grown LAN jack joins the network the existing jacks are on: the
    // first LAN member's PVID, not blindly the defaults (#124: one network).
    const lanMember = bridge.members.find((member) => routerPortNumber(member.port, 'lan') === 1);
    const lanPvid = lanMember?.pvid ?? defaults.pvid;
    for (let n = current + 1; n <= count; n++) {
      const id = `${side}${n}`;
      if (side === 'lan') {
        ports.push({ id, mtu: defaults.portMtu, ownedBy: bridge.id });
        bridgeMembers.push(accessMember(id, lanPvid));
      } else {
        // The engine's second-WAN pattern (wan.fixture): an untagged routed
        // iface on the other documentation /24 plus its own default route.
        const ip = `198.51.100.2`;
        ports.push({ id, mtu: defaults.portMtu, ownedBy: rt.id });
        ifaces.push({
          id,
          vlan: undefined,
          ip,
          prefix: 24,
          mac: nextFreeIfaceMac(
            state.topology,
            rt.ifaces.find((iface) => iface.id === 'wan')?.mac ??
              rt.ifaces[0]?.mac ??
              '02:00:00:00:00:00',
          ),
        });
        routes.push({ dest: '0.0.0.0', prefix: 0, via: '198.51.100.1' });
      }
    }
    return {
      ...c,
      ports,
      functions: c.functions.map((fn) => {
        if (side === 'lan' && fn.kind === 'bridging' && fn.id === bridge.id) {
          return { ...fn, members: bridgeMembers };
        }
        if (side === 'wan' && fn.kind === 'routing' && fn.id === rt.id) {
          return { ...fn, ifaces, routes };
        }
        return fn;
      }),
    };
  });
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
