import { describe, expect, it } from 'vitest';
import { nextDhcpServerIndex, PRESETS } from './presets';
import type { Chassis } from '../src/index';

const FN_KINDS = [
  'bridging',
  'stp',
  'routing',
  'nat',
  'dhcp-server',
  'dhcp-relay',
  'wireless',
  'isp-handoff',
  'resolver',
] as const;

describe('presets', () => {
  it('every palette entry writes functions, not a device kind (ADR 0013)', () => {
    for (const preset of PRESETS) {
      const chassis = preset.build(`${preset.id}-1`, 1);
      expect(
        chassis,
        `${preset.id} must not carry a device kind`,
      ).not.toHaveProperty('kind');
      for (const fn of chassis.functions) {
        expect(
          FN_KINDS,
          `${preset.id} wrote unknown function kind ${String(
            (fn as { kind: unknown }).kind,
          )}`,
        ).toContain(fn.kind);
      }
    }
  });

  it('host is a chassis with no functions and one port', () => {
    const chassis = PRESETS.find((p) => p.id === 'host')?.build('h1', 1);
    expect(chassis).toBeDefined();
    expect(chassis?.functions).toEqual([]);
    expect(chassis?.internal).toEqual([]);
    expect(chassis?.ports).toHaveLength(1);
    expect(chassis?.ports[0]?.ownedBy).toBe('none');
    expect(chassis?.mac).toBeDefined();
    expect(chassis?.ip).toBeDefined();
    expect(chassis?.gateway).toBeDefined();
  });

  it('host ships the advertised resolver as an address, the gateway default (#126)', () => {
    const chassis = PRESETS.find((p) => p.id === 'host')?.build('h1', 1);
    expect(chassis?.resolver).toBe('192.168.1.1');
  });

  it('resolver box is host-like, carries the resolver function and a shipped record (#126, ADR 0030)', () => {
    const chassis = PRESETS.find((p) => p.id === 'resolver')?.build('res1', 1);
    expect(chassis).toBeDefined();
    expect(chassis?.mac).toBeDefined();
    expect(chassis?.ip).toBe('192.168.1.10');
    expect(chassis?.ports).toHaveLength(1);
    const fn = chassis?.functions.find((f) => f.kind === 'resolver');
    expect(fn && fn.kind === 'resolver' ? fn.records : []).toEqual([
      { name: 'google.com', ip: '192.0.2.1' },
    ]);
    // The field is resolver, never dns (CONTEXT).
    expect(JSON.stringify(chassis)).not.toMatch(/"dns"/i);
  });

  it('internet is a bare host chassis at 192.0.2.1 that answers ICMP (ADR 0030)', () => {
    const chassis = PRESETS.find((p) => p.id === 'internet')?.build('net1', 1);
    expect(chassis).toBeDefined();
    expect(chassis?.functions).toEqual([]);
    expect(chassis?.ip).toBe('192.0.2.1');
    expect(chassis?.prefix).toBe(24);
    expect(chassis?.gateway).toBeUndefined();
    expect(chassis?.mac).toBeDefined();
  });

  it('managed switch writes bridging and stp, members match ports', () => {
    const chassis = PRESETS.find((p) => p.id === 'switch')?.build('sw1', 1);
    expect(chassis).toBeDefined();
    const bridge = chassis?.functions.find((fn) => fn.kind === 'bridging');
    expect(bridge).toBeDefined();
    const stp = chassis?.functions.find((fn) => fn.kind === 'stp');
    expect(stp).toBeDefined();
    expect(chassis?.ports).toHaveLength(8);
    expect(bridge && bridge.kind === 'bridging' ? bridge.members : []).toEqual(
      chassis?.ports.map((port) => expect.objectContaining({ port: port.id })),
    );
    for (const member of bridge && bridge.kind === 'bridging' ? bridge.members : []) {
      expect(member.untaggedVlans).toEqual(new Set([member.pvid]));
    }
  });

  it('unmanaged switch is vlan-blind and has no stp (ADR 0007)', () => {
    const chassis = PRESETS.find((p) => p.id === 'unmanaged-switch')?.build(
      'usw1',
      1,
    );
    const bridge = chassis?.functions.find((fn) => fn.kind === 'bridging');
    expect(bridge && bridge.kind === 'bridging' ? bridge.vlanAware : null).toBe(
      false,
    );
    expect(chassis?.functions.some((fn) => fn.kind === 'stp')).toBe(false);
    expect(chassis?.ports).toHaveLength(5);
  });

  it('router writes routing plus nat', () => {
    const chassis = PRESETS.find((p) => p.id === 'router')?.build('rtr1', 1);
    const routing = chassis?.functions.find((fn) => fn.kind === 'routing');
    expect(routing && routing.kind === 'routing' ? routing.ifaces : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lan-svi' }),
        expect.objectContaining({ id: 'wan', vlan: 500 }),
      ]),
    );
    expect(chassis?.functions.some((fn) => fn.kind === 'nat')).toBe(true);
  });

  it('router LAN is a bridge plus one SVI - extra jacks stay one network (#124)', () => {
    const chassis = PRESETS.find((p) => p.id === 'router')?.build('rtr1', 1);
    expect(chassis?.ports.find((p) => p.id === 'lan')?.ownedBy).toBe('br');
    expect(chassis?.ports.find((p) => p.id === 'lan-svi')?.ownedBy).toBe('rt');
    expect(chassis?.ports.find((p) => p.id === 'wan')?.ownedBy).toBe('rt');
    const bridge = chassis?.functions.find((fn) => fn.kind === 'bridging');
    const members = bridge?.kind === 'bridging' ? bridge.members : [];
    expect(members.map((m) => m.port).sort()).toEqual(['lan', 'lan-svi']);
    const routing = chassis?.functions.find((fn) => fn.kind === 'routing');
    const ifaces = routing?.kind === 'routing' ? routing.ifaces : [];
    expect(ifaces.map((i) => i.id).sort()).toEqual(['lan-svi', 'wan']);
    expect(chassis?.internal).toEqual([{ from: 'rt', to: 'br' }]);
    expect(chassis?.functions.some((fn) => fn.kind === 'nat')).toBe(true);
  });

  it('mesh node writes mesh wireless, canTag false, VLAN 10 untagged (#148)', () => {
    const chassis = PRESETS.find((p) => p.id === 'mesh-node')?.build('mesh1', 1);
    expect(chassis).toBeDefined();
    const wlan = chassis?.functions.find((fn) => fn.kind === 'wireless');
    expect(wlan && wlan.kind === 'wireless' ? wlan.mode : null).toBe('mesh');
    expect(wlan && wlan.kind === 'wireless' ? wlan.vlan : null).toBe(10);
    const br = chassis?.functions.find((fn) => fn.kind === 'bridging');
    expect(br && br.kind === 'bridging' ? br.canTag : undefined).toBe(false);
    const wifi = br && br.kind === 'bridging'
      ? br.members.find((m) => m.port === 'wifi')
      : undefined;
    expect(wifi?.pvid).toBe(10);
    expect(wifi ? [...wifi.untaggedVlans] : []).toEqual([10]);
    expect(JSON.stringify(chassis)).not.toMatch(/throughput|phyRate|airtime|coverage/i);
  });

  it('extender writes ap+client wireless functions on one radio (#149)', () => {
    const chassis = PRESETS.find((p) => p.id === 'extender')?.build('ext1', 1);
    expect(chassis).toBeDefined();
    const wireless = (chassis?.functions ?? []).filter((fn) => fn.kind === 'wireless');
    expect(wireless).toHaveLength(2);
    const modes = wireless
      .map((fn) => (fn.kind === 'wireless' ? fn.mode : null))
      .sort();
    expect(modes).toEqual(['ap', 'client']);
    const radios = new Set(
      wireless.map((fn) => (fn.kind === 'wireless' ? fn.radio : '')),
    );
    expect(radios.size).toBe(1);
    expect(chassis?.radios).toHaveLength(1);
    expect(chassis?.radios[0]?.id).toBe([...radios][0]);
    expect(JSON.stringify(chassis)).not.toMatch(/throughput|phyRate|airtime|coverage/i);
  });

  it('access point writes a radio, a wireless function, and a bridge', () => {
    const chassis = PRESETS.find((p) => p.id === 'access-point')?.build(
      'ap1',
      1,
    );
    expect(chassis?.radios).toHaveLength(1);
    const wlan = chassis?.functions.find((fn) => fn.kind === 'wireless');
    expect(wlan && wlan.kind === 'wireless' ? wlan.mode : null).toBe('ap');
    expect(chassis?.functions.some((fn) => fn.kind === 'bridging')).toBe(true);
  });

  it('modem writes an isp-handoff', () => {
    const chassis = PRESETS.find((p) => p.id === 'modem')?.build('ont1', 1);
    const isp = chassis?.functions.find((fn) => fn.kind === 'isp-handoff');
    expect(isp && isp.kind === 'isp-handoff' ? isp.mode : null).toBe('pppoe');
    expect(isp && isp.kind === 'isp-handoff' ? isp.vlanTag : null).toBe(500);
  });

  it('l3-switch writes bridging + stp + routing with SVI-shaped ifaces (#71 composition)', () => {
    const chassis = PRESETS.find((p) => p.id === 'l3-switch')?.build('l3s1', 1);
    expect(chassis).toBeDefined();
    const bridge = chassis?.functions.find((fn) => fn.kind === 'bridging');
    expect(bridge && bridge.kind === 'bridging' ? bridge.vlanAware : null).toBe(
      true,
    );
    expect(chassis?.functions.some((fn) => fn.kind === 'stp')).toBe(true);
    const routing = chassis?.functions.find((fn) => fn.kind === 'routing');
    expect(routing).toBeDefined();
    if (routing?.kind !== 'routing') return;
    // Every routing iface is an SVI: an rt-owned port that is also a bridging
    // member of its VLAN (#71's composition shape).
    for (const iface of routing.ifaces) {
      expect(chassis?.ports.some((p) => p.id === iface.id && p.ownedBy === 'rt'))
        .toBe(true);
      expect(
        bridge &&
          bridge.kind === 'bridging' &&
          bridge.members.some((m) => m.port === iface.id),
      ).toBe(true);
    }
    // The rt->br InternalEdge carries routed egress back into the bridge.
    expect(
      chassis?.internal.some((edge) => edge.from === 'rt' && edge.to === 'br'),
    ).toBe(true);
  });

  it('dhcp-server writes a host-like chassis with one default scope', () => {
    const chassis = PRESETS.find((p) => p.id === 'dhcp-server')?.build(
      'srv1',
      1,
      1,
    );
    expect(chassis).toBeDefined();
    // Host-like addressing: its own identity answers the OFFER (#72).
    expect(chassis?.mac).toBeDefined();
    expect(chassis?.ip).toBeDefined();
    expect(chassis?.prefix).toBeDefined();
    expect(chassis?.vlan).toBe(10);
    const server = chassis?.functions.find((fn) => fn.kind === 'dhcp-server');
    expect(server && server.kind === 'dhcp-server' ? server.scopes : []).toEqual(
      [
        expect.objectContaining({
          vlan: 10,
          poolStart: '192.168.10.100',
          poolEnd: '192.168.10.199',
          gateway: '192.168.10.1',
          resolver: '192.168.10.1',
        }),
      ],
    );
    // The field is resolver, never dns (CONTEXT).
    expect(JSON.stringify(chassis)).not.toMatch(/"dns"/i);
  });

  it('two placed dhcp-servers carry distinct chassis IPs - the first keeps the shipped .2 (#85)', () => {
    const first = PRESETS.find((p) => p.id === 'dhcp-server')?.build(
      'srv-1',
      1,
      1,
    );
    const second = PRESETS.find((p) => p.id === 'dhcp-server')?.build(
      'srv-2',
      2,
      2,
    );
    expect(first?.ip).toBe('192.168.10.2');
    expect(second?.ip).toBe('192.168.10.3');
    // Both stay clear of the pool (.100-.199) and the gateway (.1).
    for (const ip of [first?.ip, second?.ip]) {
      expect(ip).toMatch(/^192\.168\.10\.(?:[2-9]|[1-9][0-9])$/);
    }
  });

  it('dhcp-server chassis IP skips its own pool and the broadcast at every ordinal within the /24 static range (#92)', () => {
    const build = (index: number) =>
      PRESETS.find((p) => p.id === 'dhcp-server')?.build(
        `srv-${index}`,
        index,
        index,
      )?.ip;
    // The first two servers keep the shipped .2/.3 (#85).
    expect(build(1)).toBe('192.168.10.2');
    expect(build(2)).toBe('192.168.10.3');
    // The pool jump: ordinal 98 is the last low-band address (.2-.99),
    // ordinal 99 jumps over the pool to .200. The global-seq derivation
    // claimed .100 here - the bottom of the server's own pool.
    expect(build(98)).toBe('192.168.10.99');
    expect(build(99)).toBe('192.168.10.200');
    expect(build(100)).toBe('192.168.10.201');
    // The high band ends at .254 (the /24 broadcast is .255): ordinal 153
    // is the last valid server - the static range holds 153 servers
    // (98 low + 55 high).
    expect(build(153)).toBe('192.168.10.254');
    // Injective across the whole capacity, and never gateway, pool, or
    // broadcast for any ordinal the static range can serve.
    const ips = Array.from({ length: 153 }, (_, i) => build(i + 1)!);
    expect(new Set(ips).size).toBe(153);
    for (const ip of ips) {
      const host = Number(ip.split('.')[3]);
      expect(host).not.toBe(1);
      expect(host).not.toBe(255);
      expect((host >= 2 && host <= 99) || (host >= 200 && host <= 254)).toBe(
        true,
      );
    }
  });

  it('for any placement sequence, every chassis MAC and routing-iface MAC is pairwise distinct (#85)', () => {
    // The property is the contract, not any particular formula: place a
    // generated sequence of presets (any order, any repeats - placements
    // carry incrementing seq) and collect every identity MAC in the
    // topology: chassis MACs, stp baseMac, and every routing iface MAC.
    // Two identities sharing a MAC is an L2 namespace collision the user
    // did not choose - the #85 SVI20/next-host trace proved it can break
    // the gateway path silently (FDB learns the host's port as the
    // gateway's MAC), so the derivation must be injective, not policed.
    const seen = new Set<string>();
    const colliding: string[] = [];
    // Deterministic pseudo-random sequences: 32 rounds, each placing a
    // pseudo-random preset, seq 1..N - covers repeats and every order.
    let seed = 85;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let seq = 0;
    for (let round = 0; round < 32; round++) {
      const preset = PRESETS[Math.floor(rand() * PRESETS.length)]!;
      seq += 1;
      const chassis = preset.build(`${preset.id}-${seq}`, seq);
      const macs = [chassis.mac, ...collectIfacesMacs(chassis), ...collectStpBaseMacs(chassis)];
      for (const mac of macs) {
        if (mac === undefined) continue;
        if (seen.has(mac)) colliding.push(mac);
        seen.add(mac);
      }
    }
    expect(colliding, `duplicate MACs: ${[...new Set(colliding)].join(', ')}`).toEqual([]);
  });

  it('every MAC the derivation can produce is a valid EUI-48 and pairwise distinct, past the old single-byte wrap (#85)', () => {
    // The single-byte form (02:00:00:00:00:xx) stopped being a valid EUI-48
    // at seq 64 - the value wrapped into a 3-hex-digit last field. The
    // contract covers every slot the derivation can hand out, so this
    // sweeps the raw namespace far past that boundary (1024 seqs x 4
    // suffixes), asserting both the six-octet shape and injectivity.
    const seen = new Set<string>();
    const colliding: string[] = [];
    for (let seq = 1; seq <= 1024; seq++) {
      for (const mac of [
        ...presetMac(seq, 0),
        ...presetMac(seq, 1),
        ...presetMac(seq, 2),
        ...presetMac(seq, 3),
      ]) {
        if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
          throw new Error(`invalid EUI-48 at seq ${seq}: ${mac}`);
        }
        if (seen.has(mac)) colliding.push(mac);
        seen.add(mac);
      }
    }
    expect(colliding, `duplicate MACs: ${[...new Set(colliding)].join(', ')}`).toEqual([]);
  });

  it('the place-L3-switch-then-host workflow has no MAC self-collision (#85, the traced failure)', () => {
    // The exact workflow #85 traced: L3 switch at seq 1, then the host to
    // cable at seq 2. The old derivation made svi20's iface MAC equal the
    // host's chassis MAC (02:00:00:00:00:04), so the host's gateway ARP
    // resolved to its own port.
    const l3s = PRESETS.find((p) => p.id === 'l3-switch')?.build('l3s-1', 1);
    const host = PRESETS.find((p) => p.id === 'host')?.build('host-2', 2);
    const l3sMacs = new Set([
      l3s?.mac,
      ...collectIfacesMacs(l3s!),
      ...collectStpBaseMacs(l3s!),
    ].filter((m): m is string => m !== undefined));
    expect(l3sMacs.has(host?.mac!)).toBe(false);
  });
});

function collectIfacesMacs(chassis: { functions: unknown[] }): string[] {
  const macs: string[] = [];
  for (const fn of chassis.functions) {
    if (
      typeof fn === 'object' &&
      fn !== null &&
      'kind' in fn &&
      (fn as { kind: unknown }).kind === 'routing' &&
      'ifaces' in fn
    ) {
      for (const iface of (fn as { ifaces: { mac?: string }[] }).ifaces) {
        if (iface.mac !== undefined) macs.push(iface.mac);
      }
    }
  }
  return macs;
}

function collectStpBaseMacs(chassis: { functions: unknown[] }): string[] {
  const macs: string[] = [];
  for (const fn of chassis.functions) {
    if (
      typeof fn === 'object' &&
      fn !== null &&
      'kind' in fn &&
      (fn as { kind: unknown }).kind === 'stp' &&
      'baseMac' in fn
    ) {
      const base = (fn as { baseMac?: string }).baseMac;
      if (base !== undefined) macs.push(base);
    }
  }
  return macs;
}

/**
 * Reaches the derivation's raw namespace directly: the presets only ask
 * for suffixes 0-2 today, but the band reserves 0-3 and the contract
 * covers every slot the formula can hand out.
 */
function presetMac(seq: number, suffix: number): string[] {
  const n = seq * 4 + suffix;
  const hex = (value: number): string => value.toString(16).padStart(2, '0');
  return [
    `02:${hex((n >> 24) & 0xff)}:${hex((n >> 16) & 0xff)}:${hex((n >> 8) & 0xff)}:${hex(n & 0xff)}:00`,
  ];
}

describe('nextDhcpServerIndex', () => {
  // Imported-shape helper: a real dhcp-server chassis with the ip and
  // preset stamp overridden, so these tests exercise literal chassis
  // objects the way json import would hand them over.
  const srv = (ip?: string, ordinal?: number): Chassis => {
    const built = PRESETS.find((p) => p.id === 'dhcp-server')!.build(
      `srv-${ordinal ?? 0}`,
      ordinal ?? 1,
      ordinal ?? 1,
    );
    return { ...built, preset: undefined, ip };
  };

  it('an empty or server-free topology offers the first ordinal', () => {
    expect(nextDhcpServerIndex([])).toBe(1);
    expect(nextDhcpServerIndex([srv(undefined)])).toBe(1);
    expect(nextDhcpServerIndex([srv('192.168.10.150')])).toBe(1);
    expect(nextDhcpServerIndex([srv('192.168.10.999')])).toBe(1);
  });

  it('fills the lowest unclaimed ordinal, so a lone .254 does not push to broadcast (#92 cycle 2)', () => {
    expect(nextDhcpServerIndex([srv('192.168.10.254')])).toBe(1);
    expect(nextDhcpServerIndex([srv('192.168.10.2'), srv('192.168.10.254')])).toBe(2);
  });

  it('inverts derived addresses on imported chassis, duplicates collapse', () => {
    expect(nextDhcpServerIndex([srv('192.168.10.2', 1)])).toBe(2);
    // Lowest-free, not max+1: ordinal 99 is claimed (.200), ordinals
    // 1-98 are not, so the next server takes ordinal 1 (.2).
    expect(nextDhcpServerIndex([srv('192.168.10.200', 99)])).toBe(1);
    expect(nextDhcpServerIndex([srv('192.168.10.2', 1), srv('192.168.10.2', 1)])).toBe(2);
  });

  it('returns null only when all 153 ordinals are claimed', () => {
    const all = Array.from({ length: 153 }, (_, i) =>
      srv(PRESETS.find((p) => p.id === 'dhcp-server')!.build(`s${i}`, i + 1, i + 1).ip, i + 1),
    );
    expect(nextDhcpServerIndex(all)).toBeNull();
    // One freed ordinal reopens the range.
    const withGap = all.slice(1);
    expect(nextDhcpServerIndex(withGap)).toBe(1);
  });
});
