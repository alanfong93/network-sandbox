import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  SANDBOX_FORMAT,
  SANDBOX_VERSION,
  UnknownFunctionKindError,
  UnsupportedSandboxVersionError,
  fromJson,
  toJson,
  type BridgingFnJson,
  type ChassisJson,
  type SandboxEnvelope,
  type StpFnJson,
  type TopologyJson,
} from './json';
import type { Chassis, Fn, Hop, Topology } from './model';
import { createRunContext } from './run';
import { send } from './send';
import { referenceScenario } from './wan.fixture';

function roundTrip(topology: Topology): Topology {
  return fromJson(JSON.parse(JSON.stringify(toJson(topology))) as unknown);
}

function hopSnap(hops: Hop[]) {
  return hops.map((hop) => ({
    device: hop.device,
    fn: hop.fn,
    inPort: hop.inPort,
    outPort: hop.outPort,
    vlan: hop.vlan,
    action: hop.action,
    step: hop.step,
    reasonCode: hop.reasonCode,
  }));
}

function vlanMembership(topology: Topology): string[] {
  const rows: string[] = [];
  for (const chassis of topology.devices) {
    for (const fn of chassis.functions) {
      if (fn.kind !== 'bridging') continue;
      for (const member of fn.members) {
        const tagged = [...member.taggedVlans].sort((a, b) => a - b).join(',');
        const untagged = [...member.untaggedVlans].sort((a, b) => a - b).join(',');
        rows.push(`${chassis.id}/${fn.id}/${member.port}:t=${tagged};u=${untagged}`);
      }
    }
  }
  return rows.sort();
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pickVlans(rng: () => number, max: number): Set<number> {
  const count = Math.floor(rng() * (max + 1));
  const out = new Set<number>();
  while (out.size < count) {
    out.add(1 + Math.floor(rng() * 4094));
  }
  return out;
}

function generatedTopology(seed: number): Topology {
  const rng = mulberry32(seed);
  const tagged = pickVlans(rng, 8);
  const untagged = pickVlans(rng, 4);
  const canTag = rng() < 0.5 ? false : undefined;
  const up = rng() < 0.3 ? false : undefined;
  const channel = rng() < 0.5 ? 1 + Math.floor(rng() * 165) : undefined;
  const bridging: Extract<Fn, { kind: 'bridging' }> = {
    kind: 'bridging',
    id: 'br',
    vlanAware: rng() < 0.8,
    ...(canTag !== undefined ? { canTag } : {}),
    members: [
      {
        port: '1',
        mode: 'trunk',
        pvid: 1,
        taggedVlans: tagged,
        untaggedVlans: untagged,
        acceptableFrameTypes: 'all',
        ingressFiltering: true,
      },
    ],
    fdb: new Map([['10:aa:00:00:00:00:01', '1']]),
  };
  const stp: Extract<Fn, { kind: 'stp' }> = {
    kind: 'stp',
    id: 'stp',
    bridge: 'br',
    priority: 32768,
    baseMac: 'aa:00:00:00:00:01',
    state: new Map([['1', new Map([['1', 'blocking']])]]),
  };
  const switchBox: Chassis = {
    id: 'sw',
    label: 'sw',
    ports: [{ id: '1', mtu: 1500, ownedBy: 'br' }],
    radios: [{ id: 'radio0', band: '5', ...(channel !== undefined ? { channel } : {}) }],
    functions: [
      bridging,
      stp,
      {
        kind: 'routing',
        id: 'rt',
        ifaces: [{ id: 'lan', vlan: 10, ip: '10.0.0.1', prefix: 24, mac: 'aa:00:00:00:01:01' }],
        routes: [{ dest: '0.0.0.0', prefix: 0, via: '10.0.0.2', fromVlan: 10 }],
        firewall: [{ from: 10, to: 20, action: 'deny' }],
      },
      {
        kind: 'nat',
        id: 'nat',
        on: 'rt',
        portForwards: [{ proto: 'tcp', outsidePort: 443, toIp: '10.0.0.8', toPort: 443 }],
      },
      {
        kind: 'dhcp-server',
        id: 'dhcp',
        scopes: [
          {
            vlan: 10,
            poolStart: '10.0.0.10',
            poolEnd: '10.0.0.20',
            gateway: '10.0.0.1',
            resolver: '10.0.0.1',
          },
        ],
      },
      { kind: 'dhcp-relay', id: 'relay', helper: '10.0.0.2' },
      {
        kind: 'wireless',
        id: 'wlan',
        radio: 'radio0',
        mode: 'ap',
        ssid: 'main',
        vlan: 10,
      },
      {
        kind: 'isp-handoff',
        id: 'isp',
        port: '1',
        mode: 'pppoe',
        vlanTag: 500,
        credentials: { user: `user-${seed}`, pass: `pass-${seed}` },
        ip: '192.0.2.2',
        prefix: 24,
      },
    ],
    internal: [{ from: 'wlan', to: 'br' }],
  };
  const host: Chassis = {
    id: 'h',
    label: 'h',
    ports: [{ id: '1', mtu: 1500, ownedBy: 'none' }],
    radios: [],
    functions: [
      {
        kind: 'resolver',
        id: 'resolver',
        records: [
          { name: 'google.com', ip: '192.0.2.1' },
          { name: 'nas.home', ip: '10.0.0.10' },
        ],
      },
    ],
    internal: [],
    mac: 'aa:00:00:00:00:10',
    ip: '10.0.0.10',
    prefix: 24,
    resolver: '10.0.0.1',
  };
  return {
    devices: [switchBox, host],
    links: [
      {
        id: 'l',
        a: { device: 'sw', port: '1' },
        b: { device: 'h', port: '1' },
        medium: 'wired',
        ...(up !== undefined ? { up } : {}),
      },
    ],
    profiles: rng() < 0.5 ? ['ieee-defaults'] : [],
  };
}

describe('sandbox JSON contract', () => {
  it('is the version-1 envelope {format, version, topology}', () => {
    const envelope = toJson({ devices: [], links: [], profiles: [] });
    expect(envelope).toEqual({
      format: SANDBOX_FORMAT,
      version: SANDBOX_VERSION,
      topology: { devices: [], links: [], profiles: [] },
    });
    expectTypeOf<SandboxEnvelope>().toHaveProperty('format');
    expectTypeOf<SandboxEnvelope>().toHaveProperty('version');
    expectTypeOf<SandboxEnvelope>().toHaveProperty('topology');
    expectTypeOf<SandboxEnvelope>().not.toHaveProperty('layout');
    expectTypeOf<TopologyJson>().not.toHaveProperty('x');
    expectTypeOf<TopologyJson>().not.toHaveProperty('y');
    expectTypeOf<ChassisJson>().not.toHaveProperty('x');
    expectTypeOf<BridgingFnJson>().not.toHaveProperty('fdb');
    expectTypeOf<StpFnJson>().not.toHaveProperty('state');
  });

  it('encodes VLAN Sets as number arrays, not $set markers', () => {
    const topology: Topology = {
      devices: [
        {
          id: 'sw',
          label: 'sw',
          ports: [{ id: '1', mtu: 1500, ownedBy: 'br' }],
          radios: [],
          functions: [
            {
              kind: 'bridging',
              id: 'br',
              vlanAware: true,
              members: [
                {
                  port: '1',
                  mode: 'trunk',
                  pvid: 1,
                  taggedVlans: new Set([20, 10]),
                  untaggedVlans: new Set([1]),
                  acceptableFrameTypes: 'all',
                  ingressFiltering: true,
                },
              ],
              fdb: new Map(),
            },
          ],
          internal: [],
        },
      ],
      links: [],
      profiles: [],
    };
    const json = JSON.stringify(toJson(topology));
    expect(json).not.toMatch(/\$set/);
    const envelope = JSON.parse(json) as SandboxEnvelope;
    const fn = envelope.topology.devices[0]?.functions[0];
    expect(fn?.kind).toBe('bridging');
    if (fn?.kind !== 'bridging') return;
    expect(fn.members[0]?.taggedVlans).toEqual([10, 20]);
    expect(fn.members[0]?.untaggedVlans).toEqual([1]);
  });

  it('omits fdb and stp.state on write and restores empty Maps on parse', () => {
    const topology = generatedTopology(1);
    const bridging = topology.devices[0]?.functions.find((fn) => fn.kind === 'bridging');
    const stp = topology.devices[0]?.functions.find((fn) => fn.kind === 'stp');
    expect(bridging?.kind === 'bridging' ? bridging.fdb.size : -1).toBe(1);
    expect(stp?.kind === 'stp' ? stp.state.size : -1).toBe(1);

    const envelope = toJson(topology);
    const json = JSON.stringify(envelope);
    expect(json).not.toMatch(/"fdb"/);
    expect(json).not.toMatch(/"state"/);
    expect(bridging?.kind === 'bridging' ? bridging.fdb.size : -1).toBe(1);
    expect(stp?.kind === 'stp' ? stp.state.size : -1).toBe(1);

    const parsed = fromJson(envelope);
    const parsedBr = parsed.devices[0]?.functions.find((fn) => fn.kind === 'bridging');
    const parsedStp = parsed.devices[0]?.functions.find((fn) => fn.kind === 'stp');
    expect(parsedBr?.kind === 'bridging' ? parsedBr.fdb.size : -1).toBe(0);
    expect(parsedStp?.kind === 'stp' ? parsedStp.state.size : -1).toBe(0);
  });

  it('keeps isp-handoff credentials', () => {
    const topology = generatedTopology(7);
    const parsed = roundTrip(topology);
    const isp = parsed.devices[0]?.functions.find((fn) => fn.kind === 'isp-handoff');
    expect(isp?.kind === 'isp-handoff' ? isp.credentials : undefined).toEqual({
      user: 'user-7',
      pass: 'pass-7',
    });
  });

  it('rejects an unsupported version by name, not SyntaxError', () => {
    const envelope = { format: SANDBOX_FORMAT, version: 2, topology: { devices: [], links: [], profiles: [] } };
    expect(() => fromJson(envelope)).toThrow(UnsupportedSandboxVersionError);
    try {
      fromJson(envelope);
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedSandboxVersionError);
      expect(err).not.toBeInstanceOf(SyntaxError);
      expect((err as UnsupportedSandboxVersionError).name).toBe(
        'UnsupportedSandboxVersionError',
      );
      expect((err as UnsupportedSandboxVersionError).version).toBe(2);
    }
  });

  it('rejects an unknown function kind by name, not SyntaxError', () => {
    const envelope = toJson({ devices: [], links: [], profiles: [] });
    envelope.topology.devices.push({
      id: 'x',
      label: 'x',
      ports: [],
      radios: [],
      functions: [{ kind: 'load-balancer', id: 'lb' } as never],
      internal: [],
    });
    expect(() => fromJson(envelope)).toThrow(UnknownFunctionKindError);
    try {
      fromJson(envelope);
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownFunctionKindError);
      expect(err).not.toBeInstanceOf(SyntaxError);
      expect((err as UnknownFunctionKindError).name).toBe('UnknownFunctionKindError');
      expect((err as UnknownFunctionKindError).kind).toBe('load-balancer');
    }
  });
});

describe('sandbox JSON properties', () => {
  it('preserves VLAN Set membership for generated topologies', () => {
    for (let seed = 0; seed < 64; seed++) {
      const topology = generatedTopology(seed);
      expect(vlanMembership(roundTrip(topology)), `seed ${seed}`).toEqual(
        vlanMembership(topology),
      );
    }
  });

  it('omits Maps on write and yields empty Maps on parse for generated topologies', () => {
    for (let seed = 0; seed < 64; seed++) {
      const topology = generatedTopology(seed);
      const json = JSON.stringify(toJson(topology));
      expect(json, `seed ${seed}`).not.toMatch(/"fdb"/);
      expect(json, `seed ${seed}`).not.toMatch(/"state"/);
      const parsed = fromJson(json);
      for (const chassis of parsed.devices) {
        for (const fn of chassis.functions) {
          if (fn.kind === 'bridging') expect(fn.fdb.size, `seed ${seed}`).toBe(0);
          if (fn.kind === 'stp') expect(fn.state.size, `seed ${seed}`).toBe(0);
        }
      }
    }
  });

  it('rejects generated unknown kinds by name', () => {
    const kinds = ['foo', 'bridge', 'STP', '', 'vlan', 123, null];
    for (const [i, kind] of kinds.entries()) {
      const envelope = toJson(generatedTopology(i));
      const chassis = envelope.topology.devices[0];
      if (!chassis) throw new Error('generated chassis missing');
      chassis.functions.push({ kind, id: 'x' } as never);
      expect(() => fromJson(envelope), `kind ${String(kind)}`).toThrow(
        UnknownFunctionKindError,
      );
    }
  });
});

describe('sandbox JSON golden', () => {
  it('the §9 fixture send hops match after parse', () => {
    const topology = referenceScenario();
    const args = {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' as const },
    };
    const original = send(createRunContext(topology), args);
    const parsed = roundTrip(topology);
    const after = send(createRunContext(parsed), args);
    expect(hopSnap(after.hops)).toEqual(hopSnap(original.hops));
    expect(after.deliveredFrame?.vlan).toBe(original.deliveredFrame?.vlan);
    expect(after.deliveredFrame?.encapsulation).toEqual(
      original.deliveredFrame?.encapsulation,
    );
  });
});
