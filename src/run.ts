import { builtinProfile, defaults, type EngineProfile } from './defaults';
import type { WarningInput } from './format';
import type {
  DeviceId,
  Frame,
  MacAddr,
  StpPortState,
  Topology,
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
