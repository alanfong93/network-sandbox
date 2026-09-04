import { fromJson, inSubnet, toJson } from '../src/index';
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
 * A scope that some routing iface actually serves is NOT stranded: a
 * routing chassis runs decideDhcp (src/walk.ts checks routing before the
 * standalone fallback), whose matchScope finds the scope through
 * scope.vlan === iface.vlan or an iface-IP subnet match. Presence of a
 * routing function alone is not coverage - a scope VLAN no routing iface
 * serves strands exactly like the standalone case.
 */
export function divergentScopeWarning(topology: Topology): string | null {
  for (const chassis of topology.devices) {
    const server = chassis.functions.find((fn) => fn.kind === 'dhcp-server');
    if (server?.kind !== 'dhcp-server') continue;
    const vlans = [...new Set(server.scopes.map((scope) => scope.vlan))];
    if (vlans.length < 2) continue;
    const covered = new Set(
      chassis.functions.flatMap((fn) => {
        if (fn.kind !== 'routing') return [];
        return fn.ifaces.flatMap((iface) => {
          const served: number[] = [];
          if (iface.vlan !== undefined) served.push(iface.vlan);
          for (const scope of server.scopes) {
            if (
              inSubnet(iface.ip, scope.gateway, 24) ||
              inSubnet(iface.ip, scope.poolStart, 24)
            ) {
              served.push(scope.vlan);
            }
          }
          return served;
        });
      }),
    );
    if (vlans.every((vlan) => covered.has(vlan))) continue;
    const named = vlans.sort((a, b) => a - b).join(', ');
    return (
      `DHCP server ${chassis.id} has scopes on VLANs ${named} - ` +
      'a standalone server answers on one VLAN only (chassis.vlan); ' +
      'the other scopes cannot answer.'
    );
  }
  return null;
}
