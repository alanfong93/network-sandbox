import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import { defaults } from './defaults';
import { resolveKey } from './host';
import type { Chassis, Frame, MacAddr, PortForward, Topology, VlanId } from './model';
import { createRunContext, setResolvedMac } from './run';
import { routeFrame } from './route';

function router(): Chassis {
  return {
    id: 'R1',
    label: 'R1',
    ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'rt' }],
    radios: [],
    functions: [
      {
        kind: 'routing',
        id: 'rt',
        ifaces: [
          {
            id: '1',
            vlan: 10,
            ip: '192.168.10.1',
            prefix: 24,
            mac: 'aa:00:00:00:00:01',
          },
          {
            id: '1',
            vlan: 20,
            ip: '192.168.20.1',
            prefix: 24,
            mac: 'aa:00:00:00:00:01',
          },
        ],
        routes: [],
        firewall: [],
      },
    ],
    internal: [],
  };
}

function topo(devices: Chassis[]): Topology {
  return { devices, links: [], profiles: [] };
}

function ipFrame(dstIp: string, vlan = 10): Frame {
  return {
    srcMac: 'aa:00:00:00:00:10',
    dstMac: 'aa:00:00:00:00:01',
    vlan,
    size: 128,
    encapsulation: ['ethernet', 'vlan-tag'],
    payload: { kind: 'icmp', srcIp: '192.168.10.10', dstIp },
    hops: [],
  };
}

describe('routeFrame', () => {
  it('matches a tagged sub-interface by port and vlan', () => {
    const box = router();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('192.168.10.1', 10),
    });
    expect(result.hops[0]?.fn).toBe('rt');
    expect(result.hops[0]?.device).toBe('R1');
    expect(result.hops[0]?.step).toBe('delivery');
    expect(result.hops[0]?.reasonCode).toBe('delivery:delivered');
    expect(result.hops[0]?.action).toBe('delivered');
    expect(result.hops[0]?.vlan).toBe(10);
  });

  it('drops at route-lookup when no connected iface or route matches', () => {
    const box = router();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('8.8.8.8', 10),
    });
    expect(result.hops[0]?.fn).toBe('rt');
    expect(result.hops[0]?.step).toBe('route-lookup');
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:dropped');
    expect(result.hops[0]?.action).toBe('dropped');
    expect(result.transmissions).toEqual([]);
  });

  it('prefers the longest prefix among connected ifaces then routes', () => {
    const box = router();
    const rt = box.functions[0];
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    rt.routes.push({ dest: '0.0.0.0', prefix: 0, via: '192.168.20.2' });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('192.168.10.50', 10),
    });
    expect(result.hops[0]?.step).toBe('route-lookup');
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:forwarded');
    expect(result.hops.some((hop) => hop.step === 'arp')).toBe(true);
    expect(result.transmissions[0]?.frame.payload.kind).toBe('arp');
    expect(result.transmissions[0]?.frame.payload.dstIp).toBe('192.168.10.50');
  });

  it('drops at firewall on the first matching deny', () => {
    const box = router();
    const rt = box.functions[0];
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    rt.firewall.push({ from: 10, to: 20, action: 'deny' });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('192.168.20.10', 10),
    });
    expect(result.hops[0]?.device).toBe('R1');
    expect(result.hops[0]?.fn).toBe('rt');
    expect(result.hops[0]?.step).toBe('firewall');
    expect(result.hops[0]?.reasonCode).toBe('firewall:dropped');
    expect(result.hops[0]?.action).toBe('dropped');
    expect(result.hops[0]?.vlan).toBe(10);
    expect(result.transmissions).toEqual([]);
  });

  it('does not answer a broadcast ARP for a different IP on a matching iface', () => {
    const box = router();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:10',
        dstMac: defaults.broadcastMac,
        vlan: 10,
        size: 64,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: {
          kind: 'arp',
          srcIp: '192.168.10.10',
          dstIp: '192.168.10.99',
        },
        hops: [],
      },
    });
    expect(result.hops).toEqual([]);
    expect(result.transmissions).toEqual([]);
  });

  it('drops a unicast IP to an iface MAC when no sub-interface matches the VLAN', () => {
    const box = router();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('192.168.10.1', 30),
    });
    expect(result.hops[0]?.device).toBe('R1');
    expect(result.hops[0]?.fn).toBe('rt');
    expect(result.hops[0]?.step).toBe('route-lookup');
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:dropped');
    expect(result.hops[0]?.action).toBe('dropped');
    expect(result.hops[0]?.vlan).toBe(30);
    expect(result.hops[0]?.inPort).toBe('1');
    expect(result.transmissions).toEqual([]);
  });

  it('allows inter-VLAN when no rule matches', () => {
    const box = router();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: ipFrame('192.168.20.10', 10),
    });
    expect(result.hops[0]?.step).toBe('route-lookup');
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:forwarded');
    expect(result.hops[0]?.action).toBe('forwarded');
  });
});

const row24 = CATALOGUE.find((row) => row.id === 24);

/** Two WANs: WAN1 is the plain default, WAN2 may carry a fromVlan selector. */
function dualWanRouter(opts?: {
  wan2Selector?: VlanId;
  nat?: boolean | PortForward[];
}): Chassis {
  const functions: Chassis['functions'] = [
    {
      kind: 'routing',
      id: 'rt',
      ifaces: [
        {
          id: '1',
          vlan: 30,
          ip: '192.168.30.1',
          prefix: 24,
          mac: 'aa:00:00:00:00:01',
        },
        {
          id: 'wan1',
          ip: '198.51.100.2',
          prefix: 24,
          mac: 'aa:00:00:00:00:02',
        },
        {
          id: 'wan2',
          ip: '203.0.113.2',
          prefix: 24,
          mac: 'aa:00:00:00:00:03',
        },
      ],
      routes: [
        { dest: '0.0.0.0', prefix: 0, via: '198.51.100.1' },
        {
          dest: '0.0.0.0',
          prefix: 0,
          via: '203.0.113.1',
          ...(opts?.wan2Selector !== undefined
            ? { fromVlan: opts.wan2Selector }
            : {}),
        },
      ],
      firewall: [],
    },
  ];
  if (opts?.nat !== undefined) {
    functions.push({
      kind: 'nat',
      id: 'nat',
      on: 'rt',
      portForwards: opts.nat === true ? [] : opts.nat,
    });
  }
  return {
    id: 'R1',
    label: 'R1',
    ports: [
      { id: '1', mtu: defaults.portMtu, ownedBy: 'rt' },
      { id: 'wan1', mtu: defaults.portMtu, ownedBy: 'rt' },
      { id: 'wan2', mtu: defaults.portMtu, ownedBy: 'rt' },
    ],
    radios: [],
    functions,
    internal: [],
  };
}

function vlan30Frame(dstIp: string): Frame {
  return {
    srcMac: 'aa:00:00:00:00:10',
    dstMac: 'aa:00:00:00:00:01',
    vlan: 30,
    size: 128,
    encapsulation: ['ethernet', 'vlan-tag'],
    payload: { kind: 'icmp', srcIp: '192.168.30.10', dstIp },
    hops: [],
  };
}

describe('policy routing (Route.fromVlan)', () => {
  it('a frame from VLAN 30 with fromVlan: 30 via WAN2 takes WAN2', () => {
    const box = dualWanRouter({ wan2Selector: 30 });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: vlan30Frame('8.8.8.8'),
    });
    expect(result.hops[0]?.step).toBe('route-lookup');
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:forwarded');
    expect(result.hops[0]?.action).toBe('forwarded');
    expect(result.hops[0]?.outPort).toBe('wan2');
    expect(result.transmissions[0]?.outPort).toBe('wan2');
  });

  it('a VLAN 30 frame with no fromVlan selector still takes WAN1 (row 24)', () => {
    const box = dualWanRouter();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: vlan30Frame('8.8.8.8'),
    });
    expect(result.hops[0]?.device).toBe('R1');
    expect(result.hops[0]?.fn).toBe('rt');
    expect(result.hops[0]?.vlan).toBe(30);
    expect(result.hops[0]?.action).toBe('forwarded');
    expect(result.hops[0]?.step).toBe('route-lookup');
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:forwarded');
    expect(result.hops[0]?.outPort).toBe('wan1');
    expect(result.hops[0]?.reason).toBe(row24?.expected);
  });

  it('NAT default pick uses the same lookup: masquerade out WAN2 for VLAN 30', () => {
    const box = dualWanRouter({ wan2Selector: 30, nat: true });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: vlan30Frame('8.8.8.8'),
    });
    const nat = result.hops.find((hop) => hop.reasonCode === 'nat:translated');
    expect(nat?.outPort).toBe('wan2');
    expect(ctx.pendingSends[0]?.frame.payload.srcIp).toBe('203.0.113.2');
  });

  it('NAT default pick stays on WAN1 when no selector is installed', () => {
    const box = dualWanRouter({ nat: true });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: vlan30Frame('8.8.8.8'),
    });
    const nat = result.hops.find((hop) => hop.reasonCode === 'nat:translated');
    expect(nat?.outPort).toBe('wan1');
    expect(ctx.pendingSends[0]?.frame.payload.srcIp).toBe('198.51.100.2');
  });

  it('a selector default beats a more-specific destination-only route (policy tier)', () => {
    const box = dualWanRouter({ wan2Selector: 30 });
    const rt = box.functions[0];
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    rt.routes.unshift({ dest: '8.8.8.0', prefix: 24, via: '198.51.100.1' });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: vlan30Frame('8.8.8.8'),
    });
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:forwarded');
    expect(result.hops[0]?.outPort).toBe('wan2');
  });

  it('NAT still masquerades a connected WAN1 host when the selector default is WAN2', () => {
    const box = dualWanRouter({ wan2Selector: 30, nat: true });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: vlan30Frame('198.51.100.50'),
    });
    const nat = result.hops.find((hop) => hop.reasonCode === 'nat:translated');
    expect(nat?.outPort).toBe('wan1');
    expect(ctx.pendingSends[0]?.frame.payload.srcIp).toBe('198.51.100.2');
    expect(ctx.natSessions[0]?.outsideIp).toBe('198.51.100.2');
  });

  it('a hairpin service frame to WAN1 public IP still hits the port-forward when the selector default is WAN2', () => {
    const box = dualWanRouter({
      wan2Selector: 30,
      nat: [
        { proto: 'tcp', outsidePort: 443, toIp: '192.168.30.10', toPort: 443 },
      ],
    });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: {
        ...vlan30Frame('198.51.100.2'),
        payload: {
          kind: 'service',
          proto: 'tcp',
          srcIp: '192.168.30.10',
          dstIp: '198.51.100.2',
          dstPort: 443,
        },
      },
    });
    const delivered = result.hops.find(
      (hop) => hop.step === 'delivery' && hop.device === 'R1',
    );
    expect(delivered).toBeUndefined();
    expect(result.transmissions[0]?.frame.payload.dstIp).toBe('192.168.30.10');
  });

  it('a hairpin service frame to WAN2 public IP hits the port-forward under the same selector', () => {
    const box = dualWanRouter({
      wan2Selector: 30,
      nat: [
        { proto: 'tcp', outsidePort: 443, toIp: '192.168.30.10', toPort: 443 },
      ],
    });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: {
        ...vlan30Frame('203.0.113.2'),
        payload: {
          kind: 'service',
          proto: 'tcp',
          srcIp: '192.168.30.10',
          dstIp: '203.0.113.2',
          dstPort: 443,
        },
      },
    });
    const delivered = result.hops.find(
      (hop) => hop.step === 'delivery' && hop.device === 'R1',
    );
    expect(delivered).toBeUndefined();
    expect(result.transmissions[0]?.frame.payload.dstIp).toBe('192.168.30.10');
  });

  it('a frame from another VLAN is destination-only even when a selector exists', () => {
    const box = dualWanRouter({ wan2Selector: 30 });
    const rt = box.functions[0];
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    rt.ifaces.push({
      id: '1',
      vlan: 20,
      ip: '192.168.20.1',
      prefix: 24,
      mac: 'aa:00:00:00:00:01',
    });
    const ctx = createRunContext(topo([box]));
    const vlan20 = vlan30Frame('8.8.8.8');
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: {
        ...vlan20,
        vlan: 20,
        payload: { ...vlan20.payload, srcIp: '192.168.20.10' },
      },
    });
    expect(result.hops[0]?.reasonCode).toBe('route-lookup:forwarded');
    expect(result.hops[0]?.outPort).toBe('wan1');
  });
});

describe('masquerade beyond the default pick', () => {
  it('masquerades egress via a longer-prefix static route to the non-default WAN', () => {
    const box = dualWanRouter({ nat: true });
    const rt = box.functions[0];
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    rt.routes.unshift({ dest: '8.8.8.0', prefix: 24, via: '203.0.113.1' });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: vlan30Frame('8.8.8.8'),
    });
    const nat = result.hops.find((hop) => hop.reasonCode === 'nat:translated');
    expect(nat?.fn).toBe('nat');
    expect(nat?.device).toBe('R1');
    expect(nat?.action).toBe('forwarded');
    expect(nat?.outPort).toBe('wan2');
    expect(ctx.pendingSends[0]?.frame.payload.srcIp).toBe('203.0.113.2');
    expect(ctx.natSessions[0]).toEqual({
      device: 'R1',
      insideIp: '192.168.30.10',
      outsideIp: '203.0.113.2',
      remoteIp: '8.8.8.8',
    });
  });

  it('a masqueraded service session records the port tuple for its return leg', () => {
    const box = dualWanRouter({ nat: true });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: {
        ...vlan30Frame('8.8.8.8'),
        payload: {
          kind: 'service',
          proto: 'tcp',
          srcIp: '192.168.30.10',
          dstIp: '8.8.8.8',
          dstPort: 80,
          srcPort: 40000,
        },
      },
    });
    const nat = result.hops.find((hop) => hop.reasonCode === 'nat:translated');
    expect(nat?.outPort).toBe('wan1');
    expect(ctx.natSessions[0]).toEqual({
      device: 'R1',
      insideIp: '192.168.30.10',
      outsideIp: '198.51.100.2',
      remoteIp: '8.8.8.8',
      proto: 'tcp',
      toPort: 80,
      clientPort: 40000,
    });
  });
});

describe('hairpin NAT', () => {
  const hairpinRouter = () =>
    dualWanRouter({
      nat: [
        { proto: 'tcp', outsidePort: 443, toIp: '192.168.30.50', toPort: 443 },
      ],
    });

  const clientA = {
    mac: 'aa:00:00:00:00:10' as const,
    ip: '192.168.30.10',
    port: 40000,
  };
  const clientB = {
    mac: 'aa:00:00:00:00:11' as const,
    ip: '192.168.30.11',
    port: 40001,
  };

  const hairpinRequest = (
    client: { mac: MacAddr; ip: string; port: number } = clientA,
  ): Frame => ({
    srcMac: client.mac,
    dstMac: 'aa:00:00:00:00:01',
    vlan: 30,
    size: 128,
    encapsulation: ['ethernet', 'vlan-tag'],
    payload: {
      kind: 'service',
      proto: 'tcp',
      srcIp: client.ip,
      dstIp: '198.51.100.2',
      dstPort: 443,
      srcPort: client.port,
    },
    hops: [],
  });

  const hairpinReply = (
    client: { mac: MacAddr; port: number } = clientA,
  ): Frame => ({
    srcMac: 'aa:00:00:00:00:50',
    dstMac: 'aa:00:00:00:00:01',
    vlan: 30,
    size: 128,
    encapsulation: ['ethernet', 'vlan-tag'],
    payload: {
      kind: 'service',
      proto: 'tcp',
      srcIp: '192.168.30.50',
      dstIp: '192.168.30.1',
      dstPort: client.port,
      srcPort: 443,
    },
    hops: [],
  });

  it('SNATs a DNAT frame whose target is in the ingress VLAN subnet to the ingress iface IP', () => {
    const box = hairpinRouter();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: hairpinRequest(),
    });
    expect(result.transmissions[0]?.frame.payload.dstIp).toBe('192.168.30.50');
    expect(ctx.pendingSends[0]?.frame.payload).toEqual({
      kind: 'service',
      proto: 'tcp',
      srcIp: '192.168.30.1',
      dstIp: '192.168.30.50',
      dstPort: 443,
      srcPort: 40000,
    });
    expect(ctx.natSessions[0]).toEqual({
      device: 'R1',
      insideIp: '192.168.30.10',
      outsideIp: '192.168.30.1',
      remoteIp: '192.168.30.50',
      origDstIp: '198.51.100.2',
      proto: 'tcp',
      outsidePort: 443,
      toPort: 443,
      clientPort: 40000,
    });
  });

  it('the server reply returns through the router with the public source restored', () => {
    const box = hairpinRouter();
    const ctx = createRunContext(topo([box]));
    routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: hairpinRequest(),
    });
    setResolvedMac(ctx, resolveKey('R1', '192.168.30.10'), 'aa:00:00:00:00:10');
    const back = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: hairpinReply(),
    });
    const reply = back.transmissions[0]?.frame;
    expect(reply?.payload.dstIp).toBe('192.168.30.10');
    expect(reply?.payload.srcIp).toBe('198.51.100.2');
    expect(reply?.payload.srcPort).toBe(443);
    expect(reply?.payload.dstPort).toBe(40000);
    expect(reply?.dstMac).toBe('aa:00:00:00:00:10');
    expect(
      back.hops.find((hop) => hop.reasonCode === 'nat:translated')?.action,
    ).toBe('forwarded');
  });

  it('two hairpin clients of one forwarded service each receive their own returns', () => {
    const box = hairpinRouter();
    const ctx = createRunContext(topo([box]));
    routeFrame(ctx, { device: 'R1', inPort: '1', frame: hairpinRequest(clientA) });
    routeFrame(ctx, { device: 'R1', inPort: '1', frame: hairpinRequest(clientB) });
    expect(ctx.natSessions).toHaveLength(2);
    setResolvedMac(ctx, resolveKey('R1', '192.168.30.10'), 'aa:00:00:00:00:10');
    setResolvedMac(ctx, resolveKey('R1', '192.168.30.11'), 'aa:00:00:00:00:11');
    const backA = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: hairpinReply(clientA),
    });
    const backB = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: hairpinReply(clientB),
    });
    expect(backA.transmissions[0]?.frame.payload.dstIp).toBe('192.168.30.10');
    expect(backA.transmissions[0]?.frame.payload.srcIp).toBe('198.51.100.2');
    expect(backA.transmissions[0]?.frame.dstMac).toBe('aa:00:00:00:00:10');
    expect(backB.transmissions[0]?.frame.payload.dstIp).toBe('192.168.30.11');
    expect(backB.transmissions[0]?.frame.payload.srcIp).toBe('198.51.100.2');
    expect(backB.transmissions[0]?.frame.dstMac).toBe('aa:00:00:00:00:11');
  });

  it('a server-to-router-LAN-IP frame is delivered to the router while hairpin sessions exist', () => {
    const box = hairpinRouter();
    const ctx = createRunContext(topo([box]));
    routeFrame(ctx, { device: 'R1', inPort: '1', frame: hairpinRequest() });
    const back = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:50',
        dstMac: 'aa:00:00:00:00:01',
        vlan: 30,
        size: 128,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: { kind: 'icmp', srcIp: '192.168.30.50', dstIp: '192.168.30.1' },
        hops: [],
      },
    });
    expect(back.hops[0]?.step).toBe('delivery');
    expect(back.hops[0]?.action).toBe('delivered');
    expect(back.hops.some((hop) => hop.step === 'nat')).toBe(false);
  });

  it('a server frame whose ports name no session is delivered to the router', () => {
    const box = hairpinRouter();
    const ctx = createRunContext(topo([box]));
    routeFrame(ctx, { device: 'R1', inPort: '1', frame: hairpinRequest() });
    const back = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:50',
        dstMac: 'aa:00:00:00:00:01',
        vlan: 30,
        size: 128,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: {
          kind: 'service',
          proto: 'tcp',
          srcIp: '192.168.30.50',
          dstIp: '192.168.30.1',
          dstPort: 55555,
          srcPort: 443,
        },
        hops: [],
      },
    });
    expect(back.hops[0]?.step).toBe('delivery');
    expect(back.hops[0]?.action).toBe('delivered');
    expect(back.hops.some((hop) => hop.step === 'nat')).toBe(false);
  });

  it('the reply source port is restored to the port the client contacted', () => {
    const box = dualWanRouter({
      nat: [
        { proto: 'tcp', outsidePort: 8443, toIp: '192.168.30.50', toPort: 443 },
      ],
    });
    const ctx = createRunContext(topo([box]));
    const request = hairpinRequest();
    routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: {
        ...request,
        payload: { ...request.payload, dstPort: 8443 },
      },
    });
    setResolvedMac(ctx, resolveKey('R1', '192.168.30.10'), 'aa:00:00:00:00:10');
    const back = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: hairpinReply(),
    });
    const reply = back.transmissions[0]?.frame;
    expect(reply?.payload.dstIp).toBe('192.168.30.10');
    expect(reply?.payload.srcIp).toBe('198.51.100.2');
    expect(reply?.payload.srcPort).toBe(8443);
    expect(reply?.payload.dstPort).toBe(40000);
  });

  it('the forward trace carries the DNAT rewrite as its own named nat hop', () => {
    const box = hairpinRouter();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: hairpinRequest(),
    });
    const natHops = result.hops.filter((hop) => hop.step === 'nat');
    expect(natHops).toHaveLength(2);
    expect(natHops[0]?.reasonCode).toBe('nat:translated');
    expect(natHops[0]?.reason).toBe(
      'Port forward rewrote the destination to 192.168.30.50:443 at R1',
    );
    expect(natHops[1]?.reason).toBe('forwarded at R1 port 1 (nat)');
  });

  it('a client on another VLAN hairpins to the server-side iface IP and round-trips', () => {
    const box = hairpinRouter();
    const rt = box.functions[0];
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    rt.ifaces.push({
      id: '1',
      vlan: 20,
      ip: '192.168.20.1',
      prefix: 24,
      mac: 'aa:00:00:00:00:01',
    });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:20',
        dstMac: 'aa:00:00:00:00:01',
        vlan: 20,
        size: 128,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: {
          kind: 'service',
          proto: 'tcp',
          srcIp: '192.168.20.10',
          dstIp: '198.51.100.2',
          dstPort: 443,
          srcPort: 40000,
        },
        hops: [],
      },
    });
    expect(ctx.pendingSends[0]?.frame.payload).toEqual({
      kind: 'service',
      proto: 'tcp',
      srcIp: '192.168.30.1',
      dstIp: '192.168.30.50',
      dstPort: 443,
      srcPort: 40000,
    });
    expect(ctx.natSessions[0]).toEqual({
      device: 'R1',
      insideIp: '192.168.20.10',
      outsideIp: '192.168.30.1',
      remoteIp: '192.168.30.50',
      origDstIp: '198.51.100.2',
      proto: 'tcp',
      outsidePort: 443,
      toPort: 443,
      clientPort: 40000,
    });
    setResolvedMac(ctx, resolveKey('R1', '192.168.20.10'), 'aa:00:00:00:00:20');
    const back = routeFrame(ctx, {
      device: 'R1',
      inPort: '1',
      frame: {
        srcMac: 'aa:00:00:00:00:50',
        dstMac: 'aa:00:00:00:00:01',
        vlan: 30,
        size: 128,
        encapsulation: ['ethernet', 'vlan-tag'],
        payload: {
          kind: 'service',
          proto: 'tcp',
          srcIp: '192.168.30.50',
          dstIp: '192.168.30.1',
          dstPort: 40000,
          srcPort: 443,
        },
        hops: [],
      },
    });
    const reply = back.transmissions[0]?.frame;
    expect(reply?.payload.dstIp).toBe('192.168.20.10');
    expect(reply?.payload.srcIp).toBe('198.51.100.2');
  });

  it('a portless return among address-twin sessions names the first-wins pick', () => {
    const box = hairpinRouter();
    const ctx = createRunContext(topo([box]));
    ctx.natSessions.push(
      {
        device: 'R1',
        insideIp: '192.168.30.10',
        outsideIp: '198.51.100.2',
        remoteIp: '8.8.8.8',
      },
      {
        device: 'R1',
        insideIp: '192.168.30.11',
        outsideIp: '198.51.100.2',
        remoteIp: '8.8.8.8',
      },
    );
    setResolvedMac(ctx, resolveKey('R1', '192.168.30.10'), 'aa:00:00:00:00:10');
    const back = routeFrame(ctx, {
      device: 'R1',
      inPort: 'wan1',
      frame: {
        srcMac: 'aa:00:00:00:00:ee',
        dstMac: 'aa:00:00:00:00:02',
        vlan: null,
        size: 128,
        encapsulation: ['ethernet'],
        payload: { kind: 'icmp', srcIp: '8.8.8.8', dstIp: '198.51.100.2' },
        hops: [],
      },
    });
    expect(back.transmissions[0]?.frame.payload.dstIp).toBe('192.168.30.10');
    const natHop = back.hops.find(
      (hop) => hop.step === 'nat' && hop.reasonCode === 'nat:translated',
    );
    expect(natHop?.reason).toBe(
      'Return leg matched the first of 2 address-keyed sessions - no ports on the frame to disambiguate them',
    );
  });

  it('an external DNAT keeps its public source and records no session', () => {
    const box = hairpinRouter();
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: 'wan1',
      frame: {
        srcMac: 'aa:00:00:00:00:ee',
        dstMac: 'aa:00:00:00:00:02',
        vlan: null,
        size: 128,
        encapsulation: ['ethernet'],
        payload: {
          kind: 'service',
          proto: 'tcp',
          srcIp: '203.0.113.9',
          dstIp: '198.51.100.2',
          dstPort: 443,
        },
        hops: [],
      },
    });
    expect(result.transmissions[0]?.frame.payload.dstIp).toBe('192.168.30.50');
    expect(ctx.pendingSends[0]?.frame.payload.srcIp).toBe('203.0.113.9');
    expect(ctx.natSessions).toEqual([]);
  });

  it('a service frame to a third default-named WAN IP is a port-forward candidate', () => {
    const box = hairpinRouter();
    const rt = box.functions[0];
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    rt.ifaces.push({
      id: 'wan3',
      ip: '192.0.2.6',
      prefix: 24,
      mac: 'aa:00:00:00:00:04',
    });
    box.ports.push({ id: 'wan3', mtu: defaults.portMtu, ownedBy: 'rt' });
    rt.routes.push({ dest: '0.0.0.0', prefix: 0, via: '192.0.2.1' });
    const ctx = createRunContext(topo([box]));
    const result = routeFrame(ctx, {
      device: 'R1',
      inPort: 'wan3',
      frame: {
        srcMac: 'aa:00:00:00:00:ee',
        dstMac: 'aa:00:00:00:00:04',
        vlan: null,
        size: 128,
        encapsulation: ['ethernet'],
        payload: {
          kind: 'service',
          proto: 'tcp',
          srcIp: '203.0.113.9',
          dstIp: '192.0.2.6',
          dstPort: 443,
        },
        hops: [],
      },
    });
    const delivered = result.hops.find(
      (hop) => hop.step === 'delivery' && hop.action === 'delivered',
    );
    expect(delivered).toBeUndefined();
    expect(ctx.pendingSends[0]?.frame.payload.dstIp).toBe('192.168.30.50');
    expect(ctx.pendingSends[0]?.frame.payload.srcIp).toBe('203.0.113.9');
  });
});
