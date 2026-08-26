import { defaults } from './defaults';
import type { WarningInput } from './format';
import type {
  DeviceId,
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

export interface RunContext {
  readonly topology: Topology;
  hopsLeft: number;
  fdb: Map<VlanId, Map<MacAddr, FdbEntry>>;
  resolvedMacs: Map<string, MacAddr>;
  stp: StpStateMap;
  warnings: StpWarning[];
}

/**
 * One run — a later `trace` or `runFlow` — creates one context. Discard it
 * when the run ends. Nothing here is stored on the module.
 */
export function createRunContext(topology: Topology): RunContext {
  const stp = computeStp(topology);
  return {
    topology,
    hopsLeft: defaults.maxHops,
    fdb: new Map(),
    resolvedMacs: new Map(),
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
