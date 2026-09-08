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
    expect(imported.topology).toEqual(topology);
    expect(imported.layout).toBeNull();
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
      const warning = divergentScopeWarning(importSandbox(exportSandbox(state.topology)).topology);
    expect(warning).toBe(
      'DHCP server dhcp-server-1 has scopes on VLANs 10, 20 - a standalone server answers on one VLAN only (chassis.vlan); the other scopes cannot answer.',
    );
  });

  it('import stays silent for a single-scope standalone dhcp-server (#86)', () => {
    let state = initialState;
    state = addPreset(state, 'dhcp-server');
    expect(divergentScopeWarning(importSandbox(exportSandbox(state.topology)).topology)).toBeNull();
  });

  it('import stays silent when every scope sits on the same VLAN (#86)', () => {
    let state = initialState;
    state = addPreset(state, 'dhcp-server');
    const srv = state.topology.devices[0]!;
    const server = srv.functions.find((fn) => fn.kind === 'dhcp-server');
    if (server?.kind !== 'dhcp-server') throw new Error('expected dhcp-server');
    const first = server.scopes[0]!;
    server.scopes = [first, { ...first }];
    expect(divergentScopeWarning(importSandbox(exportSandbox(state.topology)).topology)).toBeNull();
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
    const lan = rt.ifaces.find((iface) => iface.id === 'lan-svi');
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
    expect(divergentScopeWarning(importSandbox(exportSandbox(state.topology)).topology)).toBeNull();
  });

  it('a vlan-tagged iface whose IP sits in another scope subnet does not cover that scope (#86)', () => {
    // matchScope's local branch is exclusive (src/dhcp.ts): a tagged iface
    // matches scopes by VLAN only, never by subnet - the subnet leg belongs
    // to untagged ifaces. So a VLAN-10 iface holding 192.168.20.1 cannot
    // serve the VLAN-20 scope; counting it covered would false-silence the
    // warning for a genuinely stranded scope.
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
    const lan = rt.ifaces.find((iface) => iface.id === 'lan-svi');
    if (lan) {
      lan.vlan = 10;
      // Tagged VLAN 10, but the IP lives in the VLAN-20 scope's /24.
      lan.ip = '192.168.20.1';
    }
    const wan = rt.ifaces.find((iface) => iface.id === 'wan');
    if (wan) wan.vlan = 500;
    rtr.functions = [
      ...rtr.functions,
      {
        kind: 'dhcp-server' as const,
        id: 'dhcp',
        scopes: [scope10, { ...scope10, vlan: 20 }],
      },
    ];
      const warning = divergentScopeWarning(importSandbox(exportSandbox(state.topology)).topology);
    expect(warning).toBe(
      'DHCP server router-1 has scopes on VLANs 10, 20 - a standalone server answers on one VLAN only (chassis.vlan); the other scopes cannot answer.',
    );
  });

  it('an untagged iface matching two scopes in one subnet covers only the first match (#86)', () => {
    // matchScope uses find, not a loop: an untagged iface whose IP is in
    // the same /24 as scopes on two VLANs serves only the first match -
    // the second is stranded and the import must say so.
    let state = initialState;
    state = addPreset(state, 'router');
    const rtr = state.topology.devices[0]!;
    const rt = rtr.functions.find((fn) => fn.kind === 'routing');
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    const lan = rt.ifaces.find((iface) => iface.id === 'lan-svi');
    if (lan) {
      delete lan.vlan;
      lan.ip = '192.168.10.1';
    }
    const wan = rt.ifaces.find((iface) => iface.id === 'wan');
    if (wan) wan.vlan = 500;
    rtr.functions = [
      ...rtr.functions,
      {
        kind: 'dhcp-server' as const,
        id: 'dhcp',
        scopes: [
          { vlan: 10, poolStart: '192.168.10.100', poolEnd: '192.168.10.199', gateway: '192.168.10.1', resolver: '192.168.10.1' },
          { vlan: 20, poolStart: '192.168.10.150', poolEnd: '192.168.10.199', gateway: '192.168.10.1', resolver: '192.168.10.1' },
        ],
      },
    ];
      const warning = divergentScopeWarning(importSandbox(exportSandbox(state.topology)).topology);
    expect(warning).toBe(
      'DHCP server router-1 has scopes on VLANs 10, 20 - a standalone server answers on one VLAN only (chassis.vlan); the other scopes cannot answer.',
    );
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
      const warning = divergentScopeWarning(importSandbox(exportSandbox(state.topology)).topology);
    expect(warning).toBe(
      'DHCP server router-1 has scopes on VLANs 10, 20 - a standalone server answers on one VLAN only (chassis.vlan); the other scopes cannot answer.',
    );
  });
});

describe('layout envelope sibling (#104)', () => {
  it('present layout round-trips; absent layout is null; extra ids dropped', () => {
    const topology = builtTopology();
    const [a, b] = topology.devices.map((d) => d.id);
    const layout = {
      [a!]: { x: 40, y: 80 },
      [b!]: { x: 120, y: 80 },
      ghost: { x: 1, y: 2 },
    };
    const imported = importSandbox(exportSandbox(topology, layout));
    expect(imported.topology).toEqual(topology);
    expect(imported.layout).toEqual({
      [a!]: { x: 40, y: 80 },
      [b!]: { x: 120, y: 80 },
    });
  });

  it('omits the layout key when null or empty after prune', () => {
    const topology = builtTopology();
    const none = JSON.parse(exportSandbox(topology)) as Record<string, unknown>;
    expect(none).not.toHaveProperty('layout');
    const empty = JSON.parse(exportSandbox(topology, {})) as Record<string, unknown>;
    expect(empty).not.toHaveProperty('layout');
    const ghostOnly = JSON.parse(
      exportSandbox(topology, { ghost: { x: 1, y: 2 } }),
    ) as Record<string, unknown>;
    expect(ghostOnly).not.toHaveProperty('layout');
    expect(importSandbox(exportSandbox(topology)).layout).toBeNull();
  });

  it('does not auto-place missing ids into the file', () => {
    const topology = builtTopology();
    const [a] = topology.devices.map((d) => d.id);
    const parsed = JSON.parse(
      exportSandbox(topology, { [a!]: { x: 5, y: 6 } }),
    ) as { layout: Record<string, unknown> };
    expect(Object.keys(parsed.layout)).toEqual([a]);
  });

  it('a foreign envelope sibling still imports', () => {
    const topology = builtTopology();
    const envelope = JSON.parse(exportSandbox(topology)) as Record<string, unknown>;
    envelope.notes = 'keep me';
    envelope.layout = {
      [topology.devices[0]!.id]: { x: 9, y: 10 },
    };
    const imported = importSandbox(JSON.stringify(envelope));
    expect(imported.topology).toEqual(topology);
    expect(imported.layout).toEqual({
      [topology.devices[0]!.id]: { x: 9, y: 10 },
    });
  });

  it('export never writes x/y onto a chassis (ADR 0026 tripwire)', () => {
    const topology = builtTopology();
    const [a] = topology.devices.map((d) => d.id);
    const parsed = JSON.parse(
      exportSandbox(topology, { [a!]: { x: 11, y: 12 } }),
    ) as { topology: { devices: Record<string, unknown>[] } };
    for (const chassis of parsed.topology.devices) {
      expect(chassis).not.toHaveProperty('x');
      expect(chassis).not.toHaveProperty('y');
    }
  });

  it('does not strip ISP credentials when a layout sibling is present (#65)', () => {
    let state = initialState;
    state = addPreset(state, 'modem');
    const topology = state.topology;
    const id = topology.devices[0]!.id;
    const imported = importSandbox(
      exportSandbox(topology, { [id]: { x: 0, y: 0 } }),
    );
    const modem = imported.topology.devices[0]!;
    const handoff = modem.functions.find((fn) => fn.kind === 'isp-handoff');
    expect(handoff?.kind).toBe('isp-handoff');
    if (handoff?.kind === 'isp-handoff') {
      expect(handoff.mode).toBeDefined();
    }
  });

  it('for generated layouts, export then import equals prune', () => {
    for (let seed = 0; seed < 32; seed++) {
      let state = initialState;
      const count = 1 + (seed % 3);
      for (let i = 0; i < count; i++) state = addPreset(state, 'host');
      const topology = state.topology;
      const raw: Record<string, { x: number; y: number }> = {};
      for (const [i, device] of topology.devices.entries()) {
        if ((seed + i) % 2 === 0) raw[device.id] = { x: seed * 10 + i, y: i * 7 };
      }
      raw[`ghost-${seed}`] = { x: 1, y: 2 };
      const imported = importSandbox(exportSandbox(topology, raw));
      expect(imported.topology, `seed ${seed}`).toEqual(topology);
      const expectedKeys = topology.devices
        .map((d) => d.id)
        .filter((id) => raw[id] !== undefined);
      if (expectedKeys.length === 0) {
        expect(imported.layout, `seed ${seed}`).toBeNull();
      } else {
        expect(imported.layout, `seed ${seed}`).toEqual(
          Object.fromEntries(expectedKeys.map((id) => [id, raw[id]!])),
        );
      }
    }
  });
});
