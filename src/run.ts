import { builtinProfile, defaults, type EngineProfile } from './defaults';
import type { WarningInput } from './format';
import type {
  DeviceId,
  Frame,
  MacAddr,
  StpPortState,
  Topology,
  TransportProto,
  VlanId,
} from './model';
import {
  computeStp,
  detectSingleInstanceWarnings,
  type StpStateMap,
  type StpWarning,
} from './stp';

export interface FdbEntry {
  device: DeviceId;
  port: string;
}

export interface PendingSend {
  device: DeviceId;
  outPort: string;
  nextHopIp: string;
  frame: Frame;
}

export interface NatSession {
  device: DeviceId;
  insideIp: string;
  outsideIp: string;
  remoteIp: string;
  /**
   * Hairpin only: the public destination the inside client originally sent
   * to. The return leg restores it as the reply's source, so the client sees
   * the reply from the address it contacted (ADR 0022). Undefined for plain
   * masquerade sessions, whose returns need no source rewrite.
   */
  origDstIp?: string;
  /**
   * Port identity (ADR 0023): present only for sessions created from a
   * service payload. A return leg that carries ports matches the session
   * exactly on this tuple; a portless frame (ICMP-style) never matches a
   * port-carrying session, so management frames to the router's own IP
   * reach the router while service sessions live.
   */
  proto?: TransportProto;
  /**
   * Port-forward DNAT only: the public port the client contacted. The
   * return leg's source port is restored to it - the port analogue of the
   * `origDstIp` restore.
   */
  outsidePort?: number;
  /**
   * The server-side port: `toPort` of the forward for a DNAT session, the
   * remote's service port for plain masquerade. Return legs arrive with
   * this as their source port.
   */
  toPort?: number;
  /** The client's ephemeral source port; return legs carry it as dstPort. */
  clientPort?: number;
}

export interface RunContext {
  readonly topology: Topology;
  readonly profile: EngineProfile;
  hopsLeft: number;
  fdb: Map<VlanId, Map<MacAddr, FdbEntry>>;
  resolvedMacs: Map<string, MacAddr>;
  pendingSends: PendingSend[];
  natSessions: NatSession[];
  stp: StpStateMap;
  warnings: StpWarning[];
}

/**
 * One run — a later `walkFrame` or `runFlow` — creates one context. Discard it
 * when the run ends. Nothing here is stored on the module. `hopsLeft` is spent
 * by the walk across the whole flood tree.
 */
export function createRunContext(
  topology: Topology,
  profile: EngineProfile = builtinProfile,
): RunContext {
  const stp = computeStp(topology);
  return {
    topology,
    profile,
    hopsLeft: defaults.maxHops,
    fdb: new Map(),
    resolvedMacs: new Map(),
    pendingSends: [],
    natSessions: [],
    stp,
    warnings: detectSingleInstanceWarnings(topology, stp),
  };
}

/** Missing STP state means forwarding: no stp function computed a block. */
export function portState(
  ctx: RunContext,
  device: DeviceId,
  port: string,
): StpPortState {
  return ctx.stp.get(device)?.get(port) ?? 'forwarding';
}

/**
 * True when the port has links and every one of them is down (`up: false`).
 * Omitted `up` is up. A port carrying several links is down only when all are:
 * `peerOf` crosses the first up link, and the two must agree (ADR 0020).
 */
export function portLinkDown(
  topology: Topology,
  device: DeviceId,
  port: string,
): boolean {
  const onPort = topology.links.filter(
    (link) =>
      (link.a.device === device && link.a.port === port) ||
      (link.b.device === device && link.b.port === port),
  );
  return onPort.length > 0 && onPort.every((link) => link.up === false);
}

export function learn(
  ctx: RunContext,
  vlan: VlanId,
  mac: MacAddr,
  device: DeviceId,
  port: string,
): void {
  let table = ctx.fdb.get(vlan);
  if (!table) {
    table = new Map();
    ctx.fdb.set(vlan, table);
  }
  table.set(mac, { device, port });
}

export function lookup(
  ctx: RunContext,
  vlan: VlanId,
  mac: MacAddr,
): FdbEntry | undefined {
  return ctx.fdb.get(vlan)?.get(mac);
}

export function setResolvedMac(
  ctx: RunContext,
  key: string,
  mac: MacAddr,
): void {
  ctx.resolvedMacs.set(key, mac);
}

export function getResolvedMac(
  ctx: RunContext,
  key: string,
): MacAddr | undefined {
  return ctx.resolvedMacs.get(key);
}

export function warningAsFormatInput(warning: StpWarning): WarningInput {
  return {
    kind: 'warning',
    observation: warning.observation,
    facts: warning.facts,
  };
}
