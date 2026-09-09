import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import { builtinProfile, defaults, usableMtu } from './defaults';
import { format } from './format';
import type { MacAddr, Topology, VlanId } from './model';
import { createProfileRegistry, fromProfileJson } from './profile';
import { createRunContext } from './run';
import { send } from './send';
import { observationAsFormatInput, walkFrame } from './walk';
import { referenceScenario } from './wan.fixture';

/**
 * The reference scenario with one multi-WAN mistake applied. Failover is two
 * runs of one topology (ADR 0003): flip `up: false` on the WAN1 link, re-run.
 * `wan2Default: false` removes WAN2's default (row 25's mistake); the ECMP
 * opt replaces the defaults with two VLAN 10 selectors (row 26).
 */
function failoverScenario(opts?: {
  wan1Down?: boolean;
  wan2Default?: boolean;
  policyVlan30Via?: 'wan1' | 'wan2';
  ecmpVlan10?: boolean;
}): Topology {
  const topology = referenceScenario();
  const rtr = topology.devices.find((device) => device.id === 'RTR');
  const rt = rtr?.functions.find((fn) => fn.kind === 'routing');
  if (!rtr || rt?.kind !== 'routing') throw new Error('fixture: RTR routing missing');
  if (opts?.ecmpVlan10) {
    rt.routes = [
      { dest: '0.0.0.0', prefix: 0, via: '192.0.2.1', fromVlan: 10 },
      { dest: '0.0.0.0', prefix: 0, via: '198.51.100.1', fromVlan: 10 },
    ];
    return topology;
  }
  if (opts?.wan2Default === false) {
    rt.routes = rt.routes.filter((route) => route.via !== '198.51.100.1');
  }
  if (opts?.policyVlan30Via) {
    rt.ifaces.push({
      id: 'lan',
      vlan: 30,
      ip: '192.168.30.1',
      prefix: 24,
      mac: 'aa:00:00:00:01:04',
    });
    rt.routes.push({
      dest: '0.0.0.0',
      prefix: 0,
      via: opts.policyVlan30Via === 'wan2' ? '198.51.100.1' : '192.0.2.1',
      fromVlan: 30,
    });
  }
  if (opts?.wan1Down) {
    const w = topology.links.find((item) => item.id === 'w');
    if (!w) throw new Error('fixture: WAN1 link missing');
    w.up = false;
  }
  return topology;
}

const stripProfile = fromProfileJson(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'profiles', 'cheap-silicon.json'),
    'utf8',
  ),
);

const row5 = CATALOGUE.find((row) => row.id === 5);
const row20 = CATALOGUE.find((row) => row.id === 20);
const row25 = CATALOGUE.find((row) => row.id === 25);
const row26 = CATALOGUE.find((row) => row.id === 26);

describe('reference scenario (wired subset)', () => {
  it('a VLAN 10 host reaches the internet via PPPoE over tagged VLAN 500', () => {
    const ctx = createRunContext(referenceScenario());
    const result = send(ctx, {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' },
    });
    const delivery = result.hops.find(
      (hop) => hop.device === 'NET' && hop.step === 'delivery' && hop.action === 'delivered',
    );
    expect(delivery?.device).toBe('NET');
    expect(delivery?.reasonCode).toBe('delivery:delivered');
    const wan = result.hops.find(
      (hop) => hop.device === 'RTR' && hop.outPort === 'wan' && hop.action === 'forwarded',
    );
    expect(wan?.fn).toBe('rt');
    const onWire = result.deliveredFrame;
    expect(onWire?.vlan).toBe(500);
    expect(onWire?.encapsulation).toContain('vlan-tag');
    expect(onWire?.encapsulation).toContain('pppoe');
  });

  it('removing VLAN 500 from the uplink kills it at a named hop', () => {
    const ctx = createRunContext(referenceScenario({ wanVlan: null }));
    const result = send(ctx, {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' },
    });
    const delivery = result.hops.find(
      (hop) => hop.step === 'delivery' && hop.action === 'delivered' && hop.device === 'NET',
    );
    expect(delivery).toBeUndefined();
    const drop = result.hops.find(
      (hop) =>
        hop.device === 'ONT' &&
        hop.fn === 'isp' &&
        hop.step === 'isp-handoff' &&
        hop.action === 'dropped',
    );
    expect(drop?.reasonCode).toBe('isp-handoff:dropped');
    expect(drop?.inPort).toBe('1');
  });

  it('row 5 reproduces inside the same fixture via the unmanaged switch on an access port', () => {
    expect(row5).toBeDefined();
    const ctx = createRunContext(referenceScenario());
    const result = walkFrame(ctx, {
      device: 'USW',
      inPort: '2',
      frame: {
        srcMac: 'aa:00:00:00:00:10',
        dstMac: defaults.broadcastMac,
        vlan: null,
        size: 64,
        encapsulation: ['ethernet'],
        payload: { kind: 'icmp' },
        hops: [],
      },
    });
    expect(result.hops[0]?.device).toBe('USW');
    expect(result.hops[0]?.fn).toBe('br');
    expect(result.hops[0]?.action).toBe('flooded');
    expect(result.hops[0]?.step).toBe('egress-tagging');
    const flood = result.observations.find(
      (obs) => obs.observation === 'unmanaged-flood',
    );
    expect(flood?.facts.portCount).toBe(5);
    if (!flood || !row5) return;
    expect(format(observationAsFormatInput(flood))).toBe(row5.expected);
  });
});

describe('reference scenario (access point and mesh)', () => {
  it('a client on the AP guest SSID is delivered in VLAN 30', () => {
    const ctx = createRunContext(referenceScenario());
    const result = send(ctx, {
      from: 'C30',
      dstIp: '192.168.30.20',
      payload: { kind: 'icmp', srcIp: '192.168.30.10', dstIp: '192.168.30.20' },
    });
    const classify = result.hops.find(
      (hop) => hop.device === 'AP' && hop.fn === 'wlan30',
    );
    expect(classify?.step).toBe('ssid-vlan');
    expect(classify?.reasonCode).toBe('ssid-vlan:classified');
    expect(classify?.vlan).toBe(30);
    expect(classify?.action).toBe('forwarded');
    const uplink = result.hops.find(
      (hop) => hop.device === 'AP' && hop.fn === 'br' && hop.outPort === '1',
    );
    expect(uplink?.vlan).toBe(30);
    expect(uplink?.action).toBe('forwarded');
    expect(uplink?.step).toBe('egress-tagging');
    const dest = result.hops.find(
      (hop) =>
        hop.device === 'H30' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(dest?.device).toBe('H30');
    expect(dest?.reasonCode).toBe('delivery:delivered');
  });

  it('a client on the mesh is delivered in VLAN 10', () => {
    const ctx = createRunContext(referenceScenario());
    const result = send(ctx, {
      from: 'CMESH',
      dstIp: '192.168.10.10',
      payload: { kind: 'icmp', srcIp: '192.168.10.20', dstIp: '192.168.10.10' },
    });
    const classify = result.hops.find(
      (hop) => hop.device === 'MESH2' && hop.step === 'ssid-vlan',
    );
    expect(classify?.fn).toBe('wlan');
    expect(classify?.vlan).toBe(10);
    expect(classify?.reasonCode).toBe('ssid-vlan:classified');
    const bridged = result.hops.find(
      (hop) => hop.device === 'MESH2' && hop.fn === 'br',
    );
    expect(bridged?.vlan).toBe(10);
    const dest = result.hops.find(
      (hop) =>
        hop.device === 'H10' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(dest?.device).toBe('H10');
    expect(dest?.reasonCode).toBe('delivery:delivered');
  });

  it('row 20 reproduces inside the same fixture', () => {
    expect(row20).toBeDefined();
    const ctx = createRunContext(referenceScenario({ meshSsidVlan: 30 }));
    const result = walkFrame(ctx, {
      device: 'MESH1',
      inPort: 'wifi',
      frame: {
        srcMac: 'aa:00:00:00:00:31',
        dstMac: defaults.broadcastMac,
        vlan: null,
        size: 64,
        encapsulation: ['ethernet'],
        payload: { kind: 'icmp' },
        hops: [],
      },
      arrivedFrom: 'C30',
    });
    const classify = result.hops.find(
      (hop) => hop.device === 'MESH1' && hop.step === 'ssid-vlan',
    );
    expect(classify?.fn).toBe('wlan');
    expect(classify?.vlan).toBe(30);
    expect(classify?.action).toBe('forwarded');
    expect(classify?.reasonCode).toBe('ssid-vlan:classified');
    const landed = result.hops.find((hop) => hop.device === 'MSW');
    expect(landed?.fn).toBe('br');
    expect(landed?.vlan).toBe(10);
    const untagged = result.observations.find(
      (obs) => obs.observation === 'ssid-untagged',
    );
    expect(untagged?.facts.mappedVlan).toBe(30);
    expect(untagged?.facts.landedVlan).toBe(10);
    if (!untagged || !row20) return;
    expect(format(observationAsFormatInput(untagged))).toBe(row20.expected);
  });
});

describe('profile seam', () => {
  const tagged = {
    srcMac: 'aa:00:00:00:00:10' as MacAddr,
    dstMac: 'aa:00:00:00:00:20' as MacAddr,
    vlan: 20 as VlanId,
    size: 64,
    encapsulation: ['ethernet', 'vlan-tag'] as const,
    payload: { kind: 'icmp' as const },
    hops: [],
  };

  it('the built-in profile leaves a tag intact on an unmanaged switch', () => {
    const topology = referenceScenario();
    const ctx = createRunContext(topology, builtinProfile);
    const result = walkFrame(ctx, {
      device: 'USW',
      inPort: '2',
      frame: { ...tagged, encapsulation: [...tagged.encapsulation] },
    });
    const out = result.hops[0];
    expect(out?.provenance).toBeUndefined();
    const ctx2 = createRunContext(topology);
    const bridged = walkFrame(ctx2, {
      device: 'USW',
      inPort: '2',
      frame: { ...tagged, encapsulation: [...tagged.encapsulation] },
    });
    expect(
      bridged.hops.some((hop) => hop.device === 'MSW' && hop.vlan === 20),
    ).toBe(true);
  });

  it('a fixture profile that strips tags changes the trace and populates Hop.provenance', () => {
    const topology = referenceScenario();
    topology.profiles = [stripProfile.id];
    const ctx = createRunContext(
      topology,
      undefined,
      createProfileRegistry([stripProfile]),
    );
    const result = walkFrame(ctx, {
      device: 'USW',
      inPort: '2',
      frame: { ...tagged, encapsulation: [...tagged.encapsulation] },
    });
    const usw = result.hops.find((hop) => hop.device === 'USW' && hop.fn === 'br');
    expect(usw?.provenance).toEqual({
      profile: stripProfile.id,
      version: stripProfile.version,
      fields: ['unmanagedTag'],
    });
    expect(
      result.hops.some((hop) => hop.device === 'MSW' && hop.vlan === 20),
    ).toBe(false);
  });
});

describe('usable MTU', () => {
  it('drops an oversized frame at egress after computing from the encapsulation stack', () => {
    const size = usableMtu(defaults.portMtu, ['ethernet', 'vlan-tag']);
    const onWire = usableMtu(defaults.portMtu, ['ethernet', 'vlan-tag', 'pppoe']);
    expect(size).toBeGreaterThan(onWire);
    const ctx = createRunContext(referenceScenario());
    const result = send(ctx, {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' },
      size,
    });
    const mtu = result.hops.find(
      (hop) => hop.step === 'mtu' && hop.action === 'dropped',
    );
    expect(mtu?.device).toBe('RTR');
    expect(mtu?.outPort).toBe('wan');
    expect(mtu?.reasonCode).toBe('mtu:dropped');
    expect(
      result.hops.some(
        (hop) => hop.device === 'NET' && hop.step === 'delivery',
      ),
    ).toBe(false);
  });
});

describe('Link.up and failover as two runs', () => {
  it('an omitted Link.up is up', () => {
    const topology = referenceScenario();
    expect(topology.links.every((item) => item.up === undefined)).toBe(true);
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' },
    });
    const delivery = result.hops.find(
      (hop) =>
        hop.device === 'NET' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(delivery?.reasonCode).toBe('delivery:delivered');
  });

  it('a down inter-switch copper link is not traversed', () => {
    const topology = referenceScenario();
    const u = topology.links.find((item) => item.id === 'u');
    if (!u) throw new Error('fixture: inter-switch link missing');
    u.up = false;
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H10',
      dstIp: '192.0.2.1',
      payload: { kind: 'icmp' },
    });
    const flooded = result.hops.find(
      (hop) => hop.device === 'USW' && hop.action === 'flooded',
    );
    expect(flooded?.fn).toBe('br');
    expect(result.hops.some((hop) => hop.device === 'MSW')).toBe(false);
    expect(
      result.hops.some(
        (hop) =>
          hop.device === 'NET' &&
          hop.step === 'delivery' &&
          hop.action === 'delivered',
      ),
    ).toBe(false);
  });

  it('WAN1 down with no second default drops at route-lookup — row 25 structurally and verbatim', () => {
    expect(row25).toBeDefined();
    const ctx = createRunContext(
      failoverScenario({ wan1Down: true, wan2Default: false }),
    );
    const result = send(ctx, {
      from: 'H10',
      dstIp: '203.0.113.1',
      payload: { kind: 'icmp' },
    });
    const drop = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.fn === 'rt' &&
        hop.step === 'route-lookup' &&
        hop.action === 'dropped',
    );
    expect(drop?.reasonCode).toBe('route-lookup:dropped');
    expect(
      result.hops.some(
        (hop) => hop.outPort === 'wan' && hop.action === 'forwarded',
      ),
    ).toBe(false);
    if (!drop || !row25) return;
    expect(drop.reason).toBe(row25.expected);
  });

  it('WAN1 down with a WAN2 default takes WAN2', () => {
    const ctx = createRunContext(
      failoverScenario({ wan1Down: true, wan2Default: true }),
    );
    const result = send(ctx, {
      from: 'H10',
      dstIp: '203.0.113.1',
      payload: { kind: 'icmp' },
    });
    const pick = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.fn === 'rt' &&
        hop.step === 'route-lookup' &&
        hop.action === 'forwarded',
    );
    expect(pick?.outPort).toBe('wan2');
    const nat = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.step === 'nat' &&
        hop.action === 'forwarded' &&
        hop.outPort === 'wan2',
    );
    expect(nat?.reasonCode).toBe('nat:translated');
    const handoff = result.hops.find(
      (hop) =>
        hop.device === 'ISP2' &&
        hop.fn === 'isp' &&
        hop.step === 'isp-handoff' &&
        hop.action === 'forwarded',
    );
    expect(handoff?.inPort).toBe('1');
    const delivered = result.hops.find(
      (hop) =>
        hop.device === 'NET2' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(delivered?.reasonCode).toBe('delivery:delivered');
  });

  it('does not name a down default from another VLAN as this frame\'s skipped route', () => {
    const topology = failoverScenario({
      wan1Down: true,
      wan2Default: false,
      policyVlan30Via: 'wan1',
    });
    const rtr = topology.devices.find((device) => device.id === 'RTR');
    const rt = rtr?.functions.find((fn) => fn.kind === 'routing');
    if (rt?.kind !== 'routing') throw new Error('fixture: RTR routing missing');
    rt.routes = rt.routes.filter((route) => route.fromVlan !== undefined);
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H10',
      dstIp: '203.0.113.1',
      payload: { kind: 'icmp' },
    });
    const drop = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.fn === 'rt' &&
        hop.inPort === 'lan' &&
        hop.step === 'route-lookup' &&
        hop.action === 'dropped',
    );
    expect(drop?.reasonCode).toBe('route-lookup:dropped');
    expect(drop?.reason).toBe('dropped at RTR port lan (route-lookup)');
  });

  it('a selector default targeting the down WAN is not used', () => {
    const ctx = createRunContext(
      failoverScenario({ wan1Down: true, wan2Default: true, policyVlan30Via: 'wan1' }),
    );
    const result = send(ctx, {
      from: 'H30',
      dstIp: '203.0.113.1',
      payload: { kind: 'icmp' },
    });
    const pick = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.fn === 'rt' &&
        hop.step === 'route-lookup' &&
        hop.action === 'forwarded',
    );
    expect(pick?.outPort).toBe('wan2');
    expect(
      result.hops.some(
        (hop) => hop.outPort === 'wan' && hop.action === 'forwarded',
      ),
    ).toBe(false);
    const delivered = result.hops.find(
      (hop) =>
        hop.device === 'NET2' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(delivered?.reasonCode).toBe('delivery:delivered');
  });
});

describe('reference scenario (second WAN)', () => {
  it('a VLAN 30 selector route forwards guest traffic out WAN2 with WAN1 up', () => {
    const ctx = createRunContext(
      failoverScenario({ policyVlan30Via: 'wan2' }),
    );
    const result = send(ctx, {
      from: 'H30',
      dstIp: '203.0.113.1',
      payload: { kind: 'icmp' },
    });
    const pick = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.fn === 'rt' &&
        hop.step === 'route-lookup' &&
        hop.action === 'forwarded',
    );
    expect(pick?.outPort).toBe('wan2');
    expect(pick?.reasonCode).toBe('route-lookup:forwarded');
    expect(pick?.facts).toBeUndefined();
    const nat = result.hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.step === 'nat' &&
        hop.action === 'forwarded' &&
        hop.outPort === 'wan2',
    );
    expect(nat?.reasonCode).toBe('nat:translated');
    const handoff = result.hops.find(
      (hop) =>
        hop.device === 'ISP2' &&
        hop.fn === 'isp' &&
        hop.step === 'isp-handoff' &&
        hop.action === 'forwarded',
    );
    expect(handoff?.inPort).toBe('1');
    const delivered = result.hops.find(
      (hop) =>
        hop.device === 'NET2' &&
        hop.step === 'delivery' &&
        hop.action === 'delivered',
    );
    expect(delivered?.reasonCode).toBe('delivery:delivered');
    expect(
      result.hops.some(
        (hop) => hop.outPort === 'wan' && hop.action === 'forwarded',
      ),
    ).toBe(false);
  });
});

describe('hairpin forward walk', () => {
  it('a hairpin port-forward is one source translation - no double-nat observation', () => {
    const topology = referenceScenario();
    const rtr = topology.devices.find((device) => device.id === 'RTR');
    const nat = rtr?.functions.find((fn) => fn.kind === 'nat');
    if (nat?.kind !== 'nat') throw new Error('fixture: RTR NAT missing');
    nat.portForwards.push({
      proto: 'tcp',
      outsidePort: 443,
      toIp: '192.168.10.10',
      toPort: 443,
    });
    const ctx = createRunContext(topology);
    const result = send(ctx, {
      from: 'H10',
      dstIp: '192.0.2.2',
      payload: { kind: 'service', proto: 'tcp', dstPort: 443, srcPort: 40000 },
    });
    const translations = result.hops.filter(
      (hop) => hop.step === 'nat' && hop.reasonCode === 'nat:translated',
    );
    expect(translations).toHaveLength(2);
    expect(translations[0]?.reason).toBe(
      'Port forward rewrote the destination to 192.168.10.10:443 at RTR',
    );
    expect(translations[1]?.outPort).toBe('lan');
    expect(
      result.observations.some((obs) => obs.observation === 'double-nat'),
    ).toBe(false);
  });
});

describe('equal-cost defaults (ECMP)', () => {
  const forwardedLookup = (hops: { device: string; fn?: string; step: string; action: string }[]) =>
    hops.find(
      (hop) =>
        hop.device === 'RTR' &&
        hop.fn === 'rt' &&
        hop.step === 'route-lookup' &&
        hop.action === 'forwarded',
    );

  it('two equal-cost defaults forward via the first in routes[] order — repeatable', () => {
    for (let run = 0; run < 2; run += 1) {
      const ctx = createRunContext(failoverScenario({ ecmpVlan10: true }));
      const result = send(ctx, {
        from: 'H10',
        dstIp: '203.0.113.1',
        payload: { kind: 'icmp' },
      });
      const pick = forwardedLookup(result.hops);
      expect(pick?.reasonCode).toBe('route-lookup:forwarded');
      expect(pick?.outPort).toBe('wan');
      expect(pick?.outPort).not.toBe('wan2');
      const arp = result.hops.find(
        (hop) =>
          hop.device === 'RTR' && hop.step === 'arp' && hop.action === 'flooded',
      );
      expect(arp?.outPort).toBe('wan');
      expect(
        result.hops.some(
          (hop) => hop.outPort === 'wan2' && hop.action === 'forwarded',
        ),
      ).toBe(false);
    }
  });

  it('row 26 names the chosen via — verbatim', () => {
    expect(row26).toBeDefined();
    const ctx = createRunContext(failoverScenario({ ecmpVlan10: true }));
    const result = send(ctx, {
      from: 'H10',
      dstIp: '203.0.113.1',
      payload: { kind: 'icmp' },
    });
    const pick = forwardedLookup(result.hops);
    if (!pick || !row26) return;
    expect(pick.reason).toBe(row26.expected);
  });
});
