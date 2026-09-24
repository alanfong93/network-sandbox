import { fromJson, inSubnet, toJson } from '../src/index';
import type { Topology } from '../src/index';
import { pruneLayout, type Layout } from './layout';

export type SandboxFile = {
  topology: Topology;
  layout: Layout | null;
  /** True only when the envelope carries the exact #168 share marker. */
  shareStripped?: boolean;
};

/** The share-export intent lives here in the UI, never in the engine (#168). */
export interface ExportSandboxOptions {
  shareSafe?: boolean;
}

/** The sandbox envelope from #57 is the format of record (ADR 0015, ADR 0029). */
export function exportSandbox(
  topology: Topology,
  layout?: Layout | null,
  options?: ExportSandboxOptions,
): string {
  const envelope: Record<string, unknown> = {
    ...toJson(
      topology,
      options?.shareSafe ? { omitCredentials: true } : undefined,
    ),
  };
  const pruned = layout ? pruneLayout(layout, topology) : {};
  if (Object.keys(pruned).length >= 1) envelope.layout = pruned;
  if (options?.shareSafe) envelope.sharing = { credentials: 'stripped' };
  return JSON.stringify(envelope, null, 2);
}

/** Throws the engine's named errors on an unknown version or function kind. */
export function importSandbox(text: string): SandboxFile {
  const value: unknown = JSON.parse(text);
  const topology = fromJson(value);
  const rec =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const pruned = pruneLayout(rec.layout, topology);
  // The marker is read only on its exact value; every other `sharing`
  // shape - string, array, wrong case, wrong field - is inert data.
  const sharing = rec.sharing;
  const shareStripped =
    typeof sharing === 'object' &&
    sharing !== null &&
    !Array.isArray(sharing) &&
    (sharing as Record<string, unknown>).credentials === 'stripped';
  return {
    topology,
    layout: Object.keys(pruned).length >= 1 ? pruned : null,
    ...(shareStripped ? { shareStripped: true } : {}),
  };
}

/**
 * The share marker's honest counterpart (#168, #65: import stays honest
 * about what a loaded file lacks). Fires only on the exact marker, only
 * at import, exactly once - the #86 pattern: never a runtime nag.
 */
export function shareStrippedWarning(file: SandboxFile): string | null {
  return file.shareStripped === true
    ? 'Share copy - the exporter stripped the isp-handoff credentials for sharing; the PPPoE user/pass are not in this file, and everything else round-trips.'
    : null;
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
    // Covered mirrors matchScope's own local branch (src/dhcp.ts): a
    // vlan-tagged iface matches scopes by VLAN only - the subnet leg
    // belongs exclusively to untagged ifaces, and find returns the first
    // match, never every match. Counting more than matchScope can reach
    // would false-silence the warning for a stranded scope.
    const covered = new Set(
      chassis.functions.flatMap((fn) => {
        if (fn.kind !== 'routing') return [];
        return fn.ifaces.flatMap((iface) => {
          const local =
            iface.vlan !== undefined
              ? server.scopes.find((scope) => scope.vlan === iface.vlan)
              : server.scopes.find(
                  (scope) =>
                    inSubnet(iface.ip, scope.gateway, 24) ||
                    inSubnet(iface.ip, scope.poolStart, 24),
                );
          return local ? [local.vlan] : [];
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
