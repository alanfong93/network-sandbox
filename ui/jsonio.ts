import { fromJson, toJson } from '../src/index';
import type { Topology } from '../src/index';

/** The sandbox envelope from #57 is the format of record (ADR 0015). */
export function exportSandbox(topology: Topology): string {
  return JSON.stringify(toJson(topology), null, 2);
}

/** Throws the engine's named errors on an unknown version or function kind. */
export function importSandbox(text: string): Topology {
  return fromJson(text);
}

/**
 * The engine's standalone DHCP model is one identity, one VLAN (src/dhcp.ts
 * gates the answer on chassis.vlan, RFC 2131 s4.3.1 - one address means one
 * VLAN). An imported chassis with 2+ scopes whose VLANs diverge can still
 * run, degraded: only the scope matching chassis.vlan can answer. The
 * topology is legal, so import warns rather than rejects (#86) - and only
 * on import; there is no runtime nag.
 *
 * Standalone only: a dhcp-server sibling on a routing chassis is served by
 * the routing path's decideDhcp (src/walk.ts checks routing before this
 * fallback), where every scope can answer through its own iface - warning
 * there would be a false positive.
 */
export function divergentScopeWarning(topology: Topology): string | null {
  for (const chassis of topology.devices) {
    // Standalone only: a routing chassis runs its own decideDhcp branch
    // (src/walk.ts checks routing before the standalone fallback), where
    // every scope answers through its routing iface.
    const isRouting = chassis.functions.some((fn) => fn.kind === 'routing');
    if (isRouting) continue;
    const server = chassis.functions.find((fn) => fn.kind === 'dhcp-server');
    if (server?.kind !== 'dhcp-server') continue;
    const vlans = [...new Set(server.scopes.map((scope) => scope.vlan))];
    if (vlans.length < 2) continue;
    const named = vlans.sort((a, b) => a - b).join(', ');
    return (
      `DHCP server ${chassis.id} has scopes on VLANs ${named} - ` +
      'a standalone server answers on one VLAN only (chassis.vlan); ' +
      'the other scopes cannot answer.'
    );
  }
  return null;
}
