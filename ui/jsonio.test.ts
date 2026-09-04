import { describe, expect, it } from 'vitest';
import {
  SANDBOX_FORMAT,
  SANDBOX_VERSION,
  UnknownFunctionKindError,
  UnsupportedSandboxVersionError,
} from '../src/index';
import { addPreset, completeLink, initialState, setPvid, startLink } from './state';
import { divergentScopeWarning, exportSandbox, importSandbox } from './jsonio';

function builtTopology() {
  let state = initialState;
  state = addPreset(state, 'host');
  state = addPreset(state, 'switch');
  state = addPreset(state, 'host');
  const [h1, sw, h2] = state.topology.devices.map((d) => d.id);
  state = startLink(state, h1!);
  state = completeLink(state, sw!);
  state = startLink(state, sw!);
  state = completeLink(state, h2!);
  state = setPvid(state, sw!, '2', 20);
  return state.topology;
}

describe('sandbox JSON import/export (#57 envelope)', () => {
  it('export emits the version-1 envelope', () => {
    const text = exportSandbox(builtTopology());
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.format).toBe(SANDBOX_FORMAT);
    expect(parsed.version).toBe(SANDBOX_VERSION);
    expect(parsed.topology).toBeDefined();
  });

  it('export then import round-trips the topology', () => {
    const topology = builtTopology();
    const imported = importSandbox(exportSandbox(topology));
    expect(imported).toEqual(topology);
  });

  it('import rejects an unsupported version by name, not a bare SyntaxError', () => {
    expect(() =>
      importSandbox(JSON.stringify({ format: SANDBOX_FORMAT, version: 99 })),
    ).toThrow(UnsupportedSandboxVersionError);
  });

  it('import rejects an unknown function kind by name', () => {
    const text = exportSandbox(builtTopology());
    const parsed = JSON.parse(text) as {
      topology: { devices: { functions: { kind: string }[] }[] };
    };
    parsed.topology.devices[1]!.functions[0]!.kind = 'warp-drive';
    expect(() => importSandbox(JSON.stringify(parsed))).toThrow(
      UnknownFunctionKindError,
    );
  });

  it('import warns when a standalone dhcp-server carries divergent multi-scope VLANs (#86)', () => {
    // Import-only shape: the shipped palette builds one scope per dhcp-server
    // chassis. Two scopes on different VLANs are reachable only via import,
    // and the engine's standalone model is one identity, one VLAN
    // (src/dhcp.ts gates on chassis.vlan) - every scope but the
    // chassis.vlan one is stranded.
    let state = initialState;
    state = addPreset(state, 'dhcp-server');
    const srv = state.topology.devices[0]!;
    const server = srv.functions.find((fn) => fn.kind === 'dhcp-server');
    if (server?.kind !== 'dhcp-server') throw new Error('expected dhcp-server');
    const first = server.scopes[0]!;
    server.scopes = [
      first,
      { ...first, vlan: 20, poolStart: '192.168.20.100', poolEnd: '192.168.20.199', gateway: '192.168.20.1' },
    ];
    const warning = divergentScopeWarning(importSandbox(exportSandbox(state.topology)));
    expect(warning).toBe(
      'DHCP server dhcp-server-1 has scopes on VLANs 10, 20 - a standalone server answers on one VLAN only (chassis.vlan); the other scopes cannot answer.',
    );
  });

  it('import stays silent for a single-scope standalone dhcp-server (#86)', () => {
    let state = initialState;
    state = addPreset(state, 'dhcp-server');
    expect(divergentScopeWarning(importSandbox(exportSandbox(state.topology)))).toBeNull();
  });

  it('import stays silent when every scope sits on the same VLAN (#86)', () => {
    let state = initialState;
    state = addPreset(state, 'dhcp-server');
    const srv = state.topology.devices[0]!;
    const server = srv.functions.find((fn) => fn.kind === 'dhcp-server');
    if (server?.kind !== 'dhcp-server') throw new Error('expected dhcp-server');
    const first = server.scopes[0]!;
    server.scopes = [first, { ...first }];
    expect(divergentScopeWarning(importSandbox(exportSandbox(state.topology)))).toBeNull();
  });

  it('import stays silent for divergent scopes on a routing chassis - decideDhcp serves every scope (#86)', () => {
    // A dhcp-server sibling on a routing chassis never runs
    // standaloneDhcpDecision (src/walk.ts checks routing before the
    // fallback); decideDhcp matches scopes per routing iface, so divergent
    // scopes there are legal, not stranded.
    let state = initialState;
    state = addPreset(state, 'router');
    const rtr = state.topology.devices[0]!;
    const rt = rtr.functions.find((fn) => fn.kind === 'routing');
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    const scope10 = {
      vlan: 10,
      poolStart: '192.168.10.100',
      poolEnd: '192.168.10.199',
      gateway: '192.168.10.1',
      resolver: '192.168.10.1',
    };
    // Both VLANs are covered by routing ifaces - every scope answers
    // through decideDhcp. The lan iface carries VLAN 10 (the preset's
    // default pvid is 1, so pin it), the wan iface carries VLAN 20.
    const lan = rt.ifaces.find((iface) => iface.id === 'lan');
    if (lan) {
      lan.vlan = 10;
      lan.ip = '192.168.10.1';
    }
    const wan = rt.ifaces.find((iface) => iface.id === 'wan');
    if (wan) {
      wan.vlan = 20;
      wan.ip = '192.168.20.1';
    }
    rtr.functions = [
      ...rtr.functions,
      {
        kind: 'dhcp-server' as const,
        id: 'dhcp',
        scopes: [scope10, { ...scope10, vlan: 20, poolStart: '192.168.20.100', poolEnd: '192.168.20.199', gateway: '192.168.20.1' }],
      },
    ];
    expect(divergentScopeWarning(importSandbox(exportSandbox(state.topology)))).toBeNull();
  });

  it('import warns when a routing chassis scope VLAN has no routing iface - decideDhcp cannot reach it (#86)', () => {
    // Presence of a routing function is not coverage: decideDhcp's matchScope
    // finds a scope via scope.vlan === iface.vlan (or an iface-IP subnet
    // match). A scope on a VLAN no routing iface serves is stranded exactly
    // like the standalone case, so the import must warn.
    let state = initialState;
    state = addPreset(state, 'router');
    const rtr = state.topology.devices[0]!;
    const rt = rtr.functions.find((fn) => fn.kind === 'routing');
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    const scope10 = {
      vlan: 10,
      poolStart: '192.168.10.100',
      poolEnd: '192.168.10.199',
      gateway: '192.168.10.1',
      resolver: '192.168.10.1',
    };
    // Only the lan iface serves VLAN 10; the wan iface keeps VLAN 500 -
    // nothing routes VLAN 20.
    rtr.functions = [
      ...rtr.functions,
      {
        kind: 'dhcp-server' as const,
        id: 'dhcp',
        scopes: [scope10, { ...scope10, vlan: 20 }],
      },
    ];
    const warning = divergentScopeWarning(importSandbox(exportSandbox(state.topology)));
    expect(warning).toBe(
      'DHCP server router-1 has scopes on VLANs 10, 20 - a standalone server answers on one VLAN only (chassis.vlan); the other scopes cannot answer.',
    );
  });
});
