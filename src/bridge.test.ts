import { describe, expect, it } from 'vitest';
import { bridgeFrame } from './bridge';
import { CATALOGUE } from './catalogue';
import { defaults } from './defaults';
import type {
  BridgePort,
  Chassis,
  Frame,
  Link,
  MacAddr,
  Topology,
  VlanId,
} from './model';
import { createRunContext, learn, lookup, portState } from './run';

function trunk(
  port: string,
  tagged: VlanId[],
  opts?: { pvid?: VlanId; untagged?: VlanId[]; filtering?: boolean; frames?: BridgePort['acceptableFrameTypes'] },
): BridgePort {
  return {
    port,
    mode: 'trunk',
    pvid: opts?.pvid ?? 1,
    taggedVlans: new Set(tagged),
    untaggedVlans: new Set(opts?.untagged ?? []),
    acceptableFrameTypes: opts?.frames ?? 'all',
    ingressFiltering: opts?.filtering ?? true,
  };
}

function access(
  port: string,
  vlan: VlanId,
  opts?: { filtering?: boolean; frames?: BridgePort['acceptableFrameTypes'] },
): BridgePort {
  return {
    port,
    mode: 'access',
    pvid: vlan,
    taggedVlans: new Set(),
    untaggedVlans: new Set([vlan]),
    acceptableFrameTypes: opts?.frames ?? 'all',
    ingressFiltering: opts?.filtering ?? true,
  };
}

function switchBox(
  id: string,
  members: BridgePort[],
  opts?: { vlanAware?: boolean; stp?: boolean; mac?: MacAddr; priority?: number },
): Chassis {
  const vlanAware = opts?.vlanAware ?? true;
  const functions: Chassis['functions'] = [
    {
      kind: 'bridging',
      id: 'br',
      vlanAware,
      members,
      fdb: new Map(),
    },
  ];
  if (opts?.stp) {
    functions.push({
      kind: 'stp',
      id: 'stp',
      bridge: 'br',
      priority: opts.priority ?? defaults.stp.priority,
      baseMac: opts.mac ?? 'aa:00:00:00:00:01',
      state: new Map(),
    });
  }
  return {
    id,
    label: id,
    ports: members.map((member) => ({
      id: member.port,
      mtu: defaults.portMtu,
      ownedBy: 'br',
    })),
    radios: [],
    functions,
    internal: [],
  };
}

function topo(devices: Chassis[], links: Link[] = []): Topology {
  return { devices, links, profiles: [] };
}

function frame(partial: {
  src?: MacAddr;
  dst?: MacAddr;
  vlan?: VlanId | null;
}): Frame {
  const vlan = partial.vlan === undefined ? 20 : partial.vlan;
  return {
    srcMac: partial.src ?? 'aa:00:00:00:00:10',
    dstMac: partial.dst ?? 'aa:00:00:00:00:20',
    vlan,
    size: 128,
    encapsulation: vlan === null ? ['ethernet'] : ['ethernet', 'vlan-tag'],
    payload: { kind: 'icmp' },
    hops: [],
  };
}

const row1 = CATALOGUE.find((row) => row.id === 1);
const row4 = CATALOGUE.find((row) => row.id === 4);
const row18 = CATALOGUE.find((row) => row.id === 18);

describe('802.1Q pipeline', () => {
  it('catalogue row 1 is green structurally and verbatim', () => {
    const sw = switchBox('SW2', [
      trunk('1', [10, 20]),
      trunk('3', [10]),
    ]);
    const ctx = createRunContext(topo([sw]));
    learn(ctx, 20, 'aa:00:00:00:00:20', 'SW2', '3');
    const result = bridgeFrame(ctx, {
      device: 'SW2',
      inPort: '1',
      frame: frame({ vlan: 20 }),
    });
    expect(result.hop.device).toBe('SW2');
    expect(result.hop.fn).toBe('br');
    expect(result.hop.outPort).toBe('3');
    expect(result.hop.vlan).toBe(20);
    expect(result.hop.action).toBe('dropped');
    expect(result.hop.step).toBe('egress-membership');
    expect(result.hop.reasonCode).toBe('egress-membership:dropped');
    expect(result.hop.reason.length).toBeGreaterThan(0);
    expect(result.transmissions).toEqual([]);
    expect(result.hop.reason).toBe(row1?.expected);
  });

  it('catalogue row 4 is green structurally and verbatim', () => {
    const sw = switchBox('SW1', [
      access('1', 10, { filtering: false }),
      trunk('2', [10, 20]),
    ]);
    const ctx = createRunContext(topo([sw]));
    learn(ctx, 20, 'aa:00:00:00:00:20', 'SW1', '2');
    const result = bridgeFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: 20 }),
    });
    expect(result.hop.device).toBe('SW1');
    expect(result.hop.fn).toBe('br');
    expect(result.hop.inPort).toBe('1');
    expect(result.hop.vlan).toBe(20);
    expect(result.hop.action).toBe('forwarded');
    expect(result.hop.step).toBe('ingress-filtering');
    expect(result.hop.reasonCode).toBe('ingress-filtering:admitted');
    expect(result.hop.reason).toBe(row4?.expected);
    expect(result.transmissions).toHaveLength(1);
    expect(result.transmissions[0]?.outPort).toBe('2');
  });

  it('catalogue row 18 is green structurally and verbatim', () => {
    const sw = switchBox('SW1', [
      trunk('1', [10, 20]),
      trunk('2', [10, 20], { frames: 'tagged-only', untagged: [] }),
    ]);
    const ctx = createRunContext(topo([sw]));
    const result = bridgeFrame(ctx, {
      device: 'SW1',
      inPort: '2',
      frame: frame({ vlan: null }),
      arrivedFrom: 'SW2',
    });
    expect(result.hop.device).toBe('SW1');
    expect(result.hop.inPort).toBe('2');
    expect(result.hop.action).toBe('dropped');
    expect(result.hop.step).toBe('acceptable-frame-types');
    expect(result.hop.reasonCode).toBe('acceptable-frame-types:dropped');
    expect(result.hop.reason).toBe(row18?.expected);
    expect(result.transmissions).toEqual([]);
  });

  it('does not learn on a blocked ingress port and never emits it as outPort', () => {
    const sw = switchBox('SW1', [trunk('1', [10]), trunk('2', [10])], { stp: true });
    const ctx = createRunContext(topo([sw]));
    ctx.stp.set('SW1', new Map([['1', 'blocking'], ['2', 'forwarding']]));
    const ingress = bridgeFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ src: 'aa:00:00:00:00:10', dst: 'aa:00:00:00:00:20', vlan: 10 }),
    });
    expect(ingress.hop.step).toBe('stp-ingress');
    expect(ingress.hop.action).toBe('dropped');
    expect(lookup(ctx, 10, 'aa:00:00:00:00:10')).toBeUndefined();

    learn(ctx, 10, 'aa:00:00:00:00:20', 'SW1', '1');
    const egress = bridgeFrame(ctx, {
      device: 'SW1',
      inPort: '2',
      frame: frame({ src: 'aa:00:00:00:00:30', dst: 'aa:00:00:00:00:20', vlan: 10 }),
    });
    expect(egress.hop.step).toBe('stp-egress');
    expect(egress.transmissions).toEqual([]);
    expect(egress.hop.outPort).toBeUndefined();
    expect(egress.transmissions.some((tx) => tx.outPort === '1')).toBe(false);
  });

  it('uses PVID only at ingress; egress tagging follows untaggedVlans', () => {
    const sw = switchBox('SW1', [
      access('1', 10),
      trunk('2', [10], { pvid: 10, untagged: [] }),
    ]);
    const ctx = createRunContext(topo([sw]));
    learn(ctx, 10, 'aa:00:00:00:00:20', 'SW1', '2');
    const result = bridgeFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: null }),
    });
    expect(result.hop.vlan).toBe(10);
    expect(result.hop.action).toBe('forwarded');
    expect(result.transmissions[0]?.frame.vlan).toBe(10);
    expect(result.transmissions[0]?.frame.encapsulation).toContain('vlan-tag');
  });

  it('treats membership as vacuous when vlanAware is false', () => {
    const sw = switchBox(
      'USW',
      [access('1', 1), access('2', 1)],
      { vlanAware: false },
    );
    const ctx = createRunContext(topo([sw]));
    const result = bridgeFrame(ctx, {
      device: 'USW',
      inPort: '1',
      frame: frame({ vlan: 20 }),
    });
    expect(result.hop.action).toBe('flooded');
    expect(result.transmissions).toHaveLength(1);
    expect(result.transmissions[0]?.outPort).toBe('2');
    expect(result.transmissions[0]?.frame.vlan).toBe(20);
  });

  it('classifies a priority-tagged frame (VLAN 0) to the PVID', () => {
    const sw = switchBox('SW1', [access('1', 10), trunk('2', [10], { untagged: [10] })]);
    const ctx = createRunContext(topo([sw]));
    learn(ctx, 10, 'aa:00:00:00:00:20', 'SW1', '2');
    const result = bridgeFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: 0 }),
    });
    expect(result.hop.vlan).toBe(10);
    expect(result.hop.action).toBe('forwarded');
  });

  it('names stp-egress when the only flood candidate is blocked', () => {
    const sw = switchBox('SW1', [trunk('1', [10]), trunk('2', [10])], { stp: true });
    const ctx = createRunContext(topo([sw]));
    ctx.stp.set('SW1', new Map([['1', 'forwarding'], ['2', 'blocking']]));
    const result = bridgeFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({
        src: 'aa:00:00:00:00:10',
        dst: defaults.broadcastMac,
        vlan: 10,
      }),
    });
    expect(result.hop.step).toBe('stp-egress');
    expect(result.hop.outPort).toBeUndefined();
    expect(result.transmissions).toEqual([]);
  });

  it('leaves an untagged vlan-blind frame untagged and does not invent a PVID hop', () => {
    const sw = switchBox(
      'USW',
      [access('1', 1), access('2', 1)],
      { vlanAware: false },
    );
    const ctx = createRunContext(topo([sw]));
    const result = bridgeFrame(ctx, {
      device: 'USW',
      inPort: '1',
      frame: frame({ vlan: null }),
    });
    expect(result.hop.action).toBe('flooded');
    expect(result.transmissions[0]?.frame.vlan).toBeNull();
  });

  it('drops a tagged frame on an access port when ingress filtering is on', () => {
    const sw = switchBox('SW1', [
      access('1', 10, { filtering: true }),
      trunk('2', [10, 20]),
    ]);
    const ctx = createRunContext(topo([sw]));
    const result = bridgeFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ src: 'aa:00:00:00:00:10', vlan: 20 }),
    });
    expect(result.hop.step).toBe('ingress-filtering');
    expect(result.hop.reasonCode).toBe('ingress-filtering:dropped');
    expect(result.hop.action).toBe('dropped');
    expect(result.transmissions).toEqual([]);
    expect(lookup(ctx, 20, 'aa:00:00:00:00:10')).toBeUndefined();
  });

  it('drops a tagged frame when the port admits untagged-only', () => {
    const sw = switchBox('SW1', [
      trunk('1', [10, 20], { frames: 'untagged-only', untagged: [10] }),
      trunk('2', [10, 20]),
    ]);
    const ctx = createRunContext(topo([sw]));
    const result = bridgeFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: 20 }),
    });
    expect(result.hop.step).toBe('acceptable-frame-types');
    expect(result.hop.reasonCode).toBe('acceptable-frame-types:dropped');
    expect(result.hop.action).toBe('dropped');
    expect(result.transmissions).toEqual([]);
  });

  it('uses computeStp: blocked port does not learn and is never an outPort', () => {
    const sw1 = switchBox('SW1', [trunk('1', [10]), trunk('2', [10])], {
      stp: true,
      mac: 'aa:00:00:00:00:01',
    });
    const sw2 = switchBox('SW2', [trunk('1', [10]), trunk('2', [10])], {
      stp: true,
      mac: 'aa:00:00:00:00:02',
    });
    const ctx = createRunContext(
      topo(
        [sw1, sw2],
        [
          {
            id: 'l1',
            a: { device: 'SW1', port: '1' },
            b: { device: 'SW2', port: '1' },
            medium: 'wired',
          },
          {
            id: 'l2',
            a: { device: 'SW1', port: '2' },
            b: { device: 'SW2', port: '2' },
            medium: 'wired',
          },
        ],
      ),
    );
    expect(portState(ctx, 'SW2', '2')).toBe('blocking');

    const ingress = bridgeFrame(ctx, {
      device: 'SW2',
      inPort: '2',
      frame: frame({ src: 'aa:00:00:00:00:10', dst: 'aa:00:00:00:00:20', vlan: 10 }),
    });
    expect(ingress.hop.step).toBe('stp-ingress');
    expect(lookup(ctx, 10, 'aa:00:00:00:00:10')).toBeUndefined();

    learn(ctx, 10, 'aa:00:00:00:00:20', 'SW2', '2');
    const egress = bridgeFrame(ctx, {
      device: 'SW2',
      inPort: '1',
      frame: frame({ src: 'aa:00:00:00:00:30', dst: 'aa:00:00:00:00:20', vlan: 10 }),
    });
    expect(egress.hop.step).toBe('stp-egress');
    expect(egress.hop.outPort).toBeUndefined();
    expect(egress.transmissions).toEqual([]);
  });

  it('does not pretend STP dropped a frame that never entered a bridge', () => {
    const host: Chassis = {
      id: 'H1',
      label: 'H1',
      ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'none' }],
      radios: [],
      functions: [],
      internal: [],
    };
    const ctx = createRunContext(topo([host]));
    expect(() =>
      bridgeFrame(ctx, {
        device: 'H1',
        inPort: '1',
        frame: frame({ vlan: null }),
      }),
    ).toThrow(/not a bridging member/);
  });

  it('always records a non-empty reason on a successful forward', () => {
    const sw = switchBox('SW1', [access('1', 10), access('2', 10)]);
    const ctx = createRunContext(topo([sw]));
    learn(ctx, 10, 'aa:00:00:00:00:20', 'SW1', '2');
    const result = bridgeFrame(ctx, {
      device: 'SW1',
      inPort: '1',
      frame: frame({ vlan: null }),
    });
    expect(result.hop.action).toBe('forwarded');
    expect(result.hop.reason.length).toBeGreaterThan(0);
  });
});
