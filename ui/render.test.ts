import { describe, expect, it } from 'vitest';
import { addPreset, addFirewallRule, addResolverRecord, completeLink, initialState, removeResolverRecord, select, setHostAddress, setIspHandoff, setPortAcceptable, setPvid, setResolverRecord, setRouterIfaceVlan, setRouterPortCount, setUntaggedVlans, setWirelessAp, startLink } from './state';
import { renderInspector, renderTrace } from './render';
import { COLD_TRACE_NOTICE, runTrace } from './trace';

function switchedState() {
  let state = initialState;
  state = addPreset(state, 'host');
  state = addPreset(state, 'switch');
  const [h1, sw] = state.topology.devices.map((d) => d.id);
  state = startLink(state, h1!, '1');
  state = completeLink(state, sw!, '1');
  state = select(state, sw!);
  return { state, sw: sw!, h1: h1! };
}

describe('inspector', () => {
  it('a bridge port shows PVID (ingress) and Untagged VLANs (egress) as separate controls', () => {
    const { state } = switchedState();
    const html = renderInspector(state);
    expect(html).toMatch(/PVID \(ingress\)/);
    expect(html).toMatch(/Untagged VLANs \(egress\)/);
  });

  it('never renders the forbidden fused label (ADR 0008)', () => {
    const { state } = switchedState();
    expect(renderInspector(state)).not.toMatch(/Native VLAN \(PVID\)/);
  });

  it('a host shows address fields and no PVID control', () => {
    const { state, h1 } = switchedState();
    const html = renderInspector(select(state, h1));
    expect(html).toMatch(/Gateway/);
    expect(html).not.toMatch(/PVID \(ingress\)/);
  });

  it('a host shows the advertised resolver field with the shipped value (#126)', () => {
    const { state, h1 } = switchedState();
    const html = renderInspector(select(state, h1));
    expect(html).toMatch(/Resolver/);
    expect(html).toMatch(/data-action="resolver"/);
    expect(html).toMatch(/value="192\.168\.1\.1"/);
  });

  it('a resolver box shows the records editor and its shipped record (#126)', () => {
    let state = addPreset(initialState, 'resolver');
    const dns = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, dns));
    expect(html).toMatch(/DNS server records/);
    expect(html).toMatch(/data-action="record-field"/);
    expect(html).toMatch(/data-action="record-add"/);
    expect(html).toMatch(/value="google\.com"/);
    expect(html).toMatch(/value="192\.0\.2\.1"/);
  });

  it('record edits land in the named row and removal drops only that row (#126)', () => {
    let state = addPreset(initialState, 'resolver');
    const dns = state.topology.devices[0]!.id;
    state = addResolverRecord(state, dns);
    state = setResolverRecord(state, dns, 1, { name: 'nas.home', ip: '192.168.1.50' });
    let chassis = state.topology.devices[0]!;
    const fn = chassis.functions.find((f) => f.kind === 'resolver');
    expect(fn?.kind === 'resolver' ? fn.records : []).toEqual([
      { name: 'google.com', ip: '192.0.2.1' },
      { name: 'nas.home', ip: '192.168.1.50' },
    ]);
    state = removeResolverRecord(state, dns, 0);
    chassis = state.topology.devices[0]!;
    const after = chassis.functions.find((f) => f.kind === 'resolver');
    expect(after?.kind === 'resolver' ? after.records : []).toEqual([
      { name: 'nas.home', ip: '192.168.1.50' },
    ]);
  });

  it('a switch shows the SKU port-count select at its current count (#125)', () => {
    let state = addPreset(initialState, 'unmanaged-switch');
    const sw = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, sw));
    expect(html).toMatch(/Port count/);
    expect(html).toMatch(/data-action="switch-ports"/);
    expect(html).toMatch(/<option value="5" selected>/);
  });

  it('names a saved four-port switch as legacy without making it a SKU (#125)', () => {
    let state = addPreset(initialState, 'unmanaged-switch');
    const sw = state.topology.devices[0]!.id;
    const chassis = state.topology.devices[0]!;
    state = {
      ...state,
      topology: {
        ...state.topology,
        devices: [{ ...chassis, ports: chassis.ports.slice(0, 4), functions: chassis.functions.map((fn) =>
          fn.kind === 'bridging' ? { ...fn, members: fn.members.slice(0, 4) } : fn,
        ) }],
      },
    };
    const html = renderInspector(select(state, sw));
    expect(html).toMatch(/<option value="4" selected disabled>4 ports \(legacy\)<\/option>/);
    expect(html).not.toMatch(/<option value="4">4 ports<\/option>/);
  });

  it('an L3 switch and a host show no port-count control (#125)', () => {
    let state = addPreset(initialState, 'l3-switch');
    const l3 = state.topology.devices[0]!.id;
    expect(renderInspector(select(state, l3))).not.toMatch(/switch-ports/);
    state = addPreset(state, 'host');
    const h = state.topology.devices.at(-1)!.id;
    expect(renderInspector(select(state, h))).not.toMatch(/switch-ports/);
  });

  it('router inspector offers LAN count and WAN count inputs (#124)', () => {
    let state = addPreset(initialState, 'router');
    const rtr = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, rtr));
    expect(html).toMatch(/LAN count/);
    expect(html).toMatch(/WAN count/);
    expect(html).toMatch(/data-action="router-lan-count"[^>]*value="1"/);
    expect(html).toMatch(/data-action="router-wan-count"[^>]*value="1"/);
  });

  it('an L3 switch offers no router count inputs (#124)', () => {
    let state = addPreset(initialState, 'l3-switch');
    const l3 = state.topology.devices[0]!.id;
    expect(renderInspector(select(state, l3))).not.toMatch(/router-lan-count/);
    expect(renderInspector(select(state, l3))).not.toMatch(/router-wan-count/);
  });

  it('the router LAN SVI port is not offered for cabling (#124)', () => {
    let state = addPreset(initialState, 'router');
    const rtr = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, rtr));
    expect(html).not.toMatch(/data-port="lan-svi"/);
    expect(html).toMatch(/data-action="start-link"[^>]*data-port="lan"/);
  });

  it('a pre-ADR-0031 imported router keeps its shape and shows no count controls (#124)', () => {
    let state = addPreset(initialState, 'router');
    const chassis = state.topology.devices[0]!;
    const id = chassis.id;
    // Back-date to the old shape: a routed lan port, no bridge, no internal
    // edge - what a saved topology from before the change still imports as.
    chassis.ports = [
      { id: 'lan', mtu: chassis.ports[0]!.mtu, ownedBy: 'rt' },
      { id: 'wan', mtu: chassis.ports[0]!.mtu, ownedBy: 'rt' },
    ];
    chassis.functions = chassis.functions
      .filter((fn) => fn.kind !== 'bridging')
      .map((fn) => {
        if (fn.kind !== 'routing') return fn;
        return {
          ...fn,
          ifaces: fn.ifaces.map((iface) =>
            iface.id === 'lan-svi' ? { ...iface, id: 'lan' } : iface,
          ),
        };
      });
    chassis.internal = [];
    const html = renderInspector(select(state, id));
    expect(html).not.toMatch(/router-lan-count/);
    expect(html).not.toMatch(/router-wan-count/);
    expect(html).toMatch(/data-action="start-link"[^>]*data-port="lan"/);
  });

  it('a grown second WAN does not steal the egress - masquerade keeps following the first default (#124)', () => {
    let state = initialState;
    state = addPreset(state, 'router');
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [rtr, h1, wanHost] = state.topology.devices.map((d) => d.id);
    state = setRouterIfaceVlan(state, rtr!, 'wan', undefined);
    state = setRouterPortCount(state, rtr!, 'wan', 2);
    state = startLink(state, h1!, '1');
    state = completeLink(state, rtr!, 'lan');
    state = startLink(state, wanHost!, '1');
    state = completeLink(state, rtr!, 'wan');
    state = setHostAddress(state, wanHost!, {
      ip: '203.0.113.1',
      prefix: 24,
      gateway: '203.0.113.2',
    });
    // Two defaults now name wan and wan2. First-wins in routes[] order keeps
    // the shipped wan default first (row 26) - the LAN host still egresses
    // wan and the reply still returns through the same NAT session.
    const trace = runTrace(state.topology, { from: h1!, dstIp: '203.0.113.1' });
    expect(trace.outcome).toBe('round-trip');
    expect(
      trace.requestHops.some(
        (hop) => hop.step === 'delivery' && hop.action === 'delivered' && hop.device === wanHost,
      ),
    ).toBe(true);
    expect(
      (trace.replyHops ?? []).some(
        (hop) => hop.step === 'delivery' && hop.action === 'delivered' && hop.device === h1,
      ),
    ).toBe(true);
  });

  it('two hosts on two router LAN jacks reach each other without a second subnet (#124 done-when)', () => {
    let state = initialState;
    state = addPreset(state, 'router');
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [rtr, h1, h2] = state.topology.devices.map((d) => d.id);
    state = setRouterPortCount(state, rtr!, 'lan', 4);
    state = setRouterPortCount(state, rtr!, 'wan', 2);
    state = startLink(state, h1!, '1');
    state = completeLink(state, rtr!, 'lan');
    state = startLink(state, h2!, '1');
    state = completeLink(state, rtr!, 'lan3');
    const h2Ip = state.topology.devices.find((d) => d.id === h2)!.ip!;
    const trace = runTrace(state.topology, { from: h1!, dstIp: h2Ip });
    // Delivered both ways - the ARP between the two jacks resolved through
    // the one LAN bridge (the #124 tripwire).
    expect(trace.outcome).toBe('round-trip');
    // One network: the request never routes - there is no route-lookup hop
    // between two hosts on the same subnet.
    expect(
      trace.requestHops.some((hop) => hop.step === 'route-lookup'),
    ).toBe(false);
    expect(trace.requestHops.some((hop) => hop.step === 'delivery' && hop.action === 'delivered' && hop.device === h2)).toBe(true);
  });

  it('the router answers a LAN host at its own SVI address (#129 done-when)', () => {
    let state = initialState;
    state = addPreset(state, 'router');
    state = addPreset(state, 'host');
    const [rtr, h1] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!, '1');
    state = completeLink(state, rtr!, 'lan');
    const trace = runTrace(state.topology, { from: h1!, dstIp: '192.168.1.1' });
    expect(trace.outcome).toBe('round-trip');
    expect(
      trace.requestHops.some(
        (hop) => hop.step === 'delivery' && hop.action === 'delivered' && hop.device === rtr,
      ),
    ).toBe(true);
    expect(
      (trace.replyHops ?? []).some(
        (hop) => hop.step === 'delivery' && hop.action === 'delivered' && hop.device === h1,
      ),
    ).toBe(true);
    // The reply originated through the router's routing function, not a
    // host send: its first leg is the router's own route-lookup.
    expect(
      (trace.replyHops ?? []).some(
        (hop) => hop.device === rtr && hop.step === 'route-lookup' && hop.action === 'forwarded',
      ),
    ).toBe(true);
  });

  it('a LAN host reaches a WAN-side host through the SVI punt and masquerade (#124)', () => {
    let state = initialState;
    state = addPreset(state, 'router');
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [rtr, h1, wanHost] = state.topology.devices.map((d) => d.id);
    // A direct host on the WAN jack needs the no-tag handoff - the shipped
    // tag 500 is for the modem path (#68's clear-the-tag control).
    state = setRouterIfaceVlan(state, rtr!, 'wan', undefined);
    state = startLink(state, h1!, '1');
    state = completeLink(state, rtr!, 'lan');
    state = startLink(state, wanHost!, '1');
    state = completeLink(state, rtr!, 'wan');
    // The WAN-side host is the shipped default route's via: the exact
    // gateway the router ARPs for on the WAN segment.
    state = setHostAddress(state, wanHost!, {
      ip: '203.0.113.1',
      prefix: 24,
      gateway: '203.0.113.2',
    });
    const trace = runTrace(state.topology, { from: h1!, dstIp: '203.0.113.1' });
    expect(trace.outcome).toBe('round-trip');
    // The request punted through the SVI into routing - without the punt
    // the frame would flood the LAN bridge and die.
    expect(
      trace.requestHops.some((hop) => hop.step === 'route-lookup' && hop.device === rtr),
    ).toBe(true);
    expect(
      trace.requestHops.some(
        (hop) => hop.step === 'delivery' && hop.action === 'delivered' && hop.device === wanHost,
      ),
    ).toBe(true);
    // The reply returns through the NAT session to the LAN host.
    expect(
      (trace.replyHops ?? []).some(
        (hop) => hop.step === 'delivery' && hop.action === 'delivered' && hop.device === h1,
      ),
    ).toBe(true);
  });

  it('router inspector has a WAN VLAN control, not Native VLAN (PVID)', () => {
    let state = addPreset(initialState, 'router');
    const rtr = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, rtr));
    expect(html).toMatch(/WAN VLAN/);
    expect(html).toMatch(/data-action="iface-vlan"/);
    expect(html).not.toMatch(/Native VLAN \(PVID\)/);
  });

  it('modem inspector names the ISP check (PPPoE, VLAN 500)', () => {
    let state = addPreset(initialState, 'modem');
    const ont = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, ont));
    expect(html).toMatch(/ISP check/);
    expect(html).toMatch(/PPPoE/i);
    expect(html).toMatch(/VLAN 500/);
  });

  it('modem inspector offers ISP mode and VLAN tag controls (#68)', () => {
    let state = addPreset(initialState, 'modem');
    const ont = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, ont));
    expect(html).toMatch(/data-action="isp-mode"/);
    expect(html).toMatch(/<option value="pppoe" selected>/);
    expect(html).toMatch(/<option value="dhcp">/);
    expect(html).toMatch(/<option value="static">/);
    expect(html).toMatch(/data-action="isp-vlan-tag"/);
    expect(html).toMatch(/data-action="isp-vlan-tag" value="500"/);
    // Switched state: selected attr follows mode, tag and summary line
    // are fresh, not literals (#68 review).
    state = setIspHandoff(state, ont, { mode: 'dhcp' });
    state = setIspHandoff(state, ont, { vlanTag: 300 });
    const switched = renderInspector(select(state, ont));
    expect(switched).toMatch(/<option value="dhcp" selected>/);
    expect(switched).not.toMatch(/<option value="pppoe" selected>/);
    expect(switched).toMatch(/data-action="isp-vlan-tag" value="300"/);
    expect(switched).toMatch(/ISP check: DHCP, required VLAN 300/);
    // No-tag handoff: summary says so, input renders empty.
    state = setIspHandoff(state, ont, { vlanTag: undefined });
    const untagged = renderInspector(select(state, ont));
    expect(untagged).toMatch(/ISP check: DHCP, no VLAN tag/);
    expect(untagged).toMatch(/data-action="isp-vlan-tag" value=""/);
  });

  it('inspector offers only free ports for linking', () => {
    let state = addPreset(initialState, 'router');
    state = addPreset(state, 'modem');
    const [rtr, ont] = state.topology.devices.map((d) => d.id);
    state = startLink(state, rtr!, 'wan');
    state = completeLink(state, ont!, '1');
    state = select(state, rtr!);
    const html = renderInspector(state);
    expect(html).toMatch(/data-port="lan"/);
    expect(html).not.toMatch(/data-action="start-link"[^>]*data-port="wan"/);
  });

  it('dhcp-server inspector shows editable scope controls (resolver, never dns)', () => {
    let state = addPreset(initialState, 'dhcp-server');
    const srv = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, srv));
    expect(html).toMatch(/data-action="scope-field"/);
    for (const field of ['vlan', 'poolStart', 'poolEnd', 'gateway', 'resolver']) {
      expect(html).toMatch(new RegExp(`data-field="${field}"`));
    }
    expect(html).not.toMatch(/\bdns\b/i);
  });

  it('L3-switch SVI ports expose no independent iface-vlan control (#83)', () => {
    let state = addPreset(initialState, 'l3-switch');
    const l3s = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, l3s));
    // The SVI composition is a preset invariant: iface.vlan and the
    // bridging member's VLAN are one mechanism. An independent control on
    // either half can desynchronise them silently, so neither SVI iface
    // renders the generic sub-interface VLAN input.
    expect(html).not.toMatch(/data-action="iface-vlan"[^>]*data-iface="svi10"/);
    expect(html).not.toMatch(/data-action="iface-vlan"[^>]*data-iface="svi20"/);
    expect(html).not.toMatch(/VLAN \(svi10\)/);
    expect(html).not.toMatch(/VLAN \(svi20\)/);
  });

  it('a chassis with an stp function renders an STP priority control; a bare chassis does not (#69)', () => {
    let state = addPreset(initialState, 'switch');
    const sw = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, sw));
    expect(html).toMatch(/STP priority/);
    expect(html).toMatch(/data-action="stp-priority"[^>]*value="32768"/);
    state = addPreset(state, 'unmanaged-switch');
    const usw = state.topology.devices[1]!.id;
    const bare = renderInspector(select(state, usw));
    expect(bare).not.toMatch(/STP priority/);
    expect(bare).not.toMatch(/data-action="stp-priority"/);
  });

  it('the acceptable-frame-types select marks the current rule as selected (#69)', () => {
    let state = addPreset(initialState, 'switch');
    const sw = state.topology.devices[0]!.id;
    state = setPortAcceptable(state, sw, '1', 'tagged-only');
    const html = renderInspector(select(state, sw));
    expect(html).toMatch(
      /<option value="tagged-only" selected>tagged only<\/option>/,
    );
    // Port 1's own select must not still mark 'all'; other ports keep theirs.
    const port1 = html.match(
      /<fieldset class="port"><legend>Port 1<\/legend>[\s\S]*?<\/fieldset>/,
    )?.[0];
    expect(port1).toBeDefined();
    expect(port1).toMatch(/<option value="tagged-only" selected>tagged only<\/option>/);
    expect(port1).not.toMatch(/<option value="all" selected>/);
  });

  it('bridge-member ports render Acceptable frame types and Ingress filtering controls (#69)', () => {
    let state = addPreset(initialState, 'switch');
    const sw = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, sw));
    expect(html).toMatch(/Acceptable frame types/);
    expect(html).toMatch(/data-action="acceptable"/);
    for (const option of ['all', 'tagged-only', 'untagged-only']) {
      expect(html).toMatch(new RegExp(`value="${option}"`));
    }
    expect(html).toMatch(/Ingress filtering/);
    expect(html).toMatch(/data-action="ingress-filtering"/);
    expect(html).toMatch(/type="checkbox"[^>]*data-action="ingress-filtering"[^>]*checked/);
    // ADR 0008: no control is ever labelled Native VLAN (PVID).
    expect(html).not.toMatch(/Native VLAN \(PVID\)/);
  });

  it('L3-switch SVI ports expose no independent PVID/untagged/tagged controls (#83, other half)', () => {
    let state = addPreset(initialState, 'l3-switch');
    const l3s = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, l3s));
    // Routed egress out an SVI is gated by the member's carried VLANs
    // (src/bridge.ts egress-membership), so editing the member's PVID or
    // untagged set while iface.vlan stays put desyncs the same composition
    // from the other direction. The SVI member port renders no bridge-member
    // VLAN controls either - the access ports keep theirs.
    for (const svi of ['svi10', 'svi20']) {
      const fieldset = new RegExp(`<fieldset class="port"><legend>Port ${svi}</legend>`);
      expect(html).not.toMatch(fieldset);
    }
    expect(html).toMatch(/<fieldset class="port"><legend>Port 1<\/legend>/);
    expect(html).toMatch(/data-action="pvid"[^>]*value="1"/);
  });

  it('an rt-owned bridge member with no matching routing iface keeps its controls (cycle 3)', () => {
    // Import-only shape: a bridging member whose port is owned by the
    // routing function, but the routing function carries no iface with that
    // port id. The engine's SVI composition requires the iface-id match
    // (src/walk.ts sviBridgeMember), so this port is NOT an SVI - its
    // bridge-member VLANs are live L2 config (a flooded frame reads them at
    // egress, src/bridge.ts) and must stay editable.
    let state = addPreset(initialState, 'l3-switch');
    const l3s = state.topology.devices[0]!.id;
    const chassis = state.topology.devices.find((d) => d.id === l3s)!;
    const rt = chassis.functions.find((fn) => fn.kind === 'routing');
    if (rt?.kind !== 'routing') throw new Error('expected routing');
    // Drop every routing iface: svi10/svi20 stay rt-owned bridge members,
    // but nothing routes through them anymore.
    chassis.functions = chassis.functions.map((fn) =>
      fn.kind === 'routing' ? { ...fn, ifaces: [] } : fn,
    );
    const html = renderInspector(select(state, l3s));
    expect(html).toMatch(/<fieldset class="port"><legend>Port svi10<\/legend>/);
    expect(html).toMatch(/<fieldset class="port"><legend>Port svi20<\/legend>/);
    expect(html).toMatch(/data-action="pvid"/);
  });

  it('unmanaged-switch ports keep only the live acceptable-frame-types control - the inert VLAN controls are hidden (ADR 0007, #67)', () => {
    let state = addPreset(initialState, 'unmanaged-switch');
    const usw = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, usw));
    // The inert membership controls: no mode, no PVID, no untagged, no
    // tagged, no ingress filtering (isMember is vacuously true on a
    // VLAN-blind bridge, so the filtering drop branch is unreachable).
    // Alan's call: hide, not disable.
    expect(html).not.toMatch(/data-action="mode"/);
    expect(html).not.toMatch(/PVID \(ingress\)/);
    expect(html).not.toMatch(/data-action="untagged"/);
    expect(html).not.toMatch(/data-action="tagged"/);
    expect(html).not.toMatch(/data-action="ingress-filtering"/);
    // Acceptable frame types STAYS: src/bridge.ts enforces it
    // unconditionally, VLAN-blind or not - hiding a live control would be
    // the false affordance in reverse (#96 review cycle 1).
    expect(html).toMatch(/data-action="acceptable"/);
  });

  it('the unmanaged chassis renders the one-broadcast-domain capability note once, with the port count (#67)', () => {
    let state = addPreset(initialState, 'unmanaged-switch');
    const usw = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, usw));
    expect(html).toMatch(
      /This switch has no VLAN awareness - all 5 ports are one broadcast domain/,
    );
    expect(html).toMatch(/No configurable per-port VLAN membership/);
    // Once per chassis, not once per port.
    const occurrences = html.match(/no VLAN awareness/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  it('the note counts the VLAN-blind bridge members, not the chassis ports (#96 review cycle 1)', () => {
    let state = addPreset(initialState, 'unmanaged-switch');
    const usw = state.topology.devices[0]!.id;
    const chassis = state.topology.devices.find((d) => d.id === usw)!;
    const bridge = chassis.functions.find((fn) => fn.kind === 'bridging');
    if (bridge?.kind === 'bridging') bridge.members.splice(2); // 2 of 4 ports
    const html = renderInspector(select(state, usw));
    expect(html).toMatch(/all 2 ports are one broadcast domain/);
  });

  it('renders one capability note per VLAN-blind bridge, each with its own member count (#97)', () => {
    let state = addPreset(initialState, 'unmanaged-switch');
    const usw = state.topology.devices[0]!.id;
    const chassis = state.topology.devices.find((d) => d.id === usw)!;
    const br = chassis.functions.find((fn) => fn.kind === 'bridging');
    if (br?.kind !== 'bridging') throw new Error('expected bridging');
    // Distinct counts (3 and 1) so a regression that reused the FIRST
    // bridge's count for every note cannot pass (review cycle 1).
    const secondBridge = { ...br, id: 'br2', members: br.members.slice(0, 3) };
    br.members = br.members.slice(3);
    chassis.functions = [...chassis.functions, secondBridge];
    const html = renderInspector(select(state, usw));
    // Two notes, one per VLAN-blind bridge, each with its own count.
    // The trailing period anchors the match: "domains" or any suffix after
    // "domain" must not satisfy the assertion (review cycle 2).
    const occurrences = html.match(/no VLAN awareness/g)?.length ?? 0;
    expect(occurrences).toBe(2);
    expect(html).toMatch(/all 3 ports are one broadcast domain\./);
    expect(html).toMatch(/all 2 ports are one broadcast domain\./);
  });

  it('a VLAN-blind bridge with zero members renders no capability note (#97)', () => {
    let state = addPreset(initialState, 'unmanaged-switch');
    const usw = state.topology.devices[0]!.id;
    const chassis = state.topology.devices.find((d) => d.id === usw)!;
    const br = chassis.functions.find((fn) => fn.kind === 'bridging');
    if (br?.kind !== 'bridging') throw new Error('expected bridging');
    // A degenerate import shape: an empty VLAN-blind bridge placed FIRST,
    // so the old single-find note picked it and rendered "all 0 ports".
    const emptyBridge = { ...br, id: 'br0', members: [] };
    chassis.functions = [emptyBridge, ...chassis.functions];
    const html = renderInspector(select(state, usw));
    expect(html).not.toMatch(/all 0 ports/);
    // The real bridge still gets its note.
    expect(html).toMatch(/all 5 ports are one broadcast domain/);
  });

  it('a mixed chassis renders the note for the VLAN-blind bridge only, and the aware bridge keeps its controls (#97)', () => {
    let state = addPreset(initialState, 'switch');
    const sw = state.topology.devices[0]!.id;
    const chassis = state.topology.devices.find((d) => d.id === sw)!;
    const br = chassis.functions.find((fn) => fn.kind === 'bridging');
    if (br?.kind !== 'bridging') throw new Error('expected bridging');
    const blindBridge = {
      ...br,
      id: 'br2',
      vlanAware: false,
      members: br.members.slice(0, 2),
    };
    chassis.functions = [...chassis.functions, blindBridge];
    const html = renderInspector(select(state, sw));
    const occurrences = html.match(/no VLAN awareness/g)?.length ?? 0;
    expect(occurrences).toBe(1);
    expect(html).toMatch(/all 2 ports are one broadcast domain/);
    expect(html).toMatch(/data-action="pvid"/);
  });

  it('detection is the owning function vlanAware flag, never the preset id (#67)', () => {
    // A vlan-aware chassis that happens to carry the unmanaged preset id
    // keeps its controls (function is the source of truth, ADR 0013).
    let state = addPreset(initialState, 'switch');
    const sw = state.topology.devices[0]!.id;
    const chassis = state.topology.devices.find((d) => d.id === sw)!;
    chassis.preset = 'unmanaged-switch';
    const mislabeled = renderInspector(select(state, sw));
    expect(mislabeled).toMatch(/data-action="pvid"/);
    // And the reverse: a chassis with no preset id but a VLAN-blind bridge
    // gets the note and no controls.
    state = addPreset(state, 'unmanaged-switch');
    const usw = state.topology.devices[1]!.id;
    const bare = state.topology.devices.find((d) => d.id === usw)!;
    delete bare.preset;
    const stripped = renderInspector(select(state, usw));
    expect(stripped).not.toMatch(/data-action="pvid"/);
    expect(stripped).toMatch(/no VLAN awareness/);
  });

  it('managed switch and AP bridge ports keep their VLAN controls (#67 regression)', () => {
    let state = addPreset(initialState, 'switch');
    const sw = state.topology.devices[0]!.id;
    const managedHtml = renderInspector(select(state, sw));
    expect(managedHtml).toMatch(/data-action="mode"/);
    expect(managedHtml).toMatch(/PVID \(ingress\)/);
    expect(managedHtml).toMatch(/data-action="untagged"/);
    expect(managedHtml).toMatch(/data-action="tagged"/);
    state = addPreset(state, 'access-point');
    const ap = state.topology.devices[1]!.id;
    const apHtml = renderInspector(select(state, ap));
    expect(apHtml).toMatch(/data-action="pvid"/);
    expect(apHtml).toMatch(/data-action="untagged"/);
  });

  it('AP inspector has SSID and VLAN controls per ap-mode wireless function (#152)', () => {
    let state = addPreset(initialState, 'access-point');
    const ap = state.topology.devices[0]!.id;
    const html = renderInspector(select(state, ap));
    expect(html).toMatch(/data-action="wireless-ssid"/);
    expect(html).toMatch(/data-action="wireless-vlan"/);
    expect(html).toMatch(/data-fn="wlan"/);
    expect(html).toMatch(/data-action="wireless-ssid"[^>]*value="main"/);
    expect(html).toMatch(/data-action="wireless-vlan"[^>]*value="10"/);
    state = setWirelessAp(state, ap, 'wlan', { ssid: 'guest', vlan: 30 });
    const edited = renderInspector(select(state, ap));
    expect(edited).toMatch(/data-action="wireless-ssid"[^>]*value="guest"/);
    expect(edited).toMatch(/data-action="wireless-vlan"[^>]*value="30"/);
  });

  it('after inspector VLAN 30, a wifi client classifies ssid-vlan as 30 (#152)', () => {
    let state = addPreset(initialState, 'host');
    state = addPreset(state, 'access-point');
    const [h1, ap] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!, '1');
    state = completeLink(state, ap!, 'wifi');
    state = setWirelessAp(state, ap!, 'wlan', { vlan: 30 });
    const trace = runTrace(state.topology, { from: h1!, dstIp: '192.168.1.1' });
    const classify = trace.requestHops.find(
      (hop) => hop.device === ap && hop.step === 'ssid-vlan',
    );
    expect(classify?.vlan).toBe(30);
    expect(classify?.reasonCode).toBe('ssid-vlan:classified');
  });

  it('an access port living only in a second bridging function renders its controls (#89)', () => {
    // Import-only shape: palette presets carry one bridging function, but
    // json round-trips many. First-bridge-only lookup rendered this port
    // as nothing; multi-bridge lookup (ADR 0028) makes it editable.
    let state = addPreset(initialState, 'switch');
    const sw = state.topology.devices[0]!.id;
    const chassis = state.topology.devices.find((d) => d.id === sw)!;
    const br = chassis.functions.find((fn) => fn.kind === 'bridging');
    if (br?.kind !== 'bridging') throw new Error('expected bridging');
    const secondBridge = {
      ...br,
      id: 'br2',
      members: br.members.filter((m) => m.port === '3'),
    };
    br.members = br.members.filter((m) => m.port !== '3');
    chassis.functions = [...chassis.functions, secondBridge];
    const html = renderInspector(select(state, sw));
    expect(html).toMatch(/<fieldset class="port"><legend>Port 3<\/legend>/);
    expect(html).toMatch(/data-action="pvid"/);
  });

  it('a port in two bridges resolves its member from the first bridging function (#89 identity pin)', () => {
    // First match in functions[] order is canonical for member identity
    // (ADR 0028): edits land in the first bridge that carries the port.
    let state = addPreset(initialState, 'switch');
    const sw = state.topology.devices[0]!.id;
    const chassis = state.topology.devices.find((d) => d.id === sw)!;
    const br = chassis.functions.find((fn) => fn.kind === 'bridging');
    if (br?.kind !== 'bridging') throw new Error('expected bridging');
    const shadowBridge = {
      ...br,
      id: 'br2',
      members: [{ ...br.members[0]!, pvid: 99 }],
    };
    chassis.functions = [...chassis.functions, shadowBridge];
    state = setPvid(state, sw, '1', 42);
    // The update is immutable - re-read from the NEW state.
    const updated = state.topology.devices.find((d) => d.id === sw)!;
    const bridges = updated.functions.filter((fn) => fn.kind === 'bridging');
    const first = bridges[0]!.members.find((m) => m.port === '1')!;
    const shadow = bridges[1]!.members.find((m) => m.port === '1')!;
    expect(first.pvid).toBe(42);
    expect(shadow.pvid).toBe(99);
    // Render-side identity: the DOM shows the FIRST bridge's member
    // value, never the shadow bridge's.
    const html = renderInspector(select(state, sw));
    expect(html).toMatch(/data-action="pvid"[^>]*value="42"/);
    expect(html).not.toMatch(/data-action="pvid"[^>]*value="99"/);
  });

  it('a two-bridge chassis suppresses the SVI controls when the SVI port sits only in the second bridge (#87)', () => {
    // Import-only shape (#87): a chassis whose routing function is SVI-
    // attached via a SECOND bridging function. The pre-fix predicate read
    // only the first bridging function (functions.find shape), so this
    // topology rendered the generic iface-vlan control again and reopened
    // the #83 desync path. Not reachable from the shipped palette - every
    // preset carries at most one bridging function - so the chassis is
    // mutated directly, like the cycle-3 test above.
    let state = addPreset(initialState, 'l3-switch');
    const l3s = state.topology.devices[0]!.id;
    const chassis = state.topology.devices.find((d) => d.id === l3s)!;
    // Second bridge carrying ONLY the SVI ports as members: svi10/svi20 are
    // members of the second bridging function, never of the first.
    const br = chassis.functions.find((fn) => fn.kind === 'bridging');
    if (br?.kind !== 'bridging') throw new Error('expected bridging');
    const secondBridge = {
      ...br,
      id: 'br2',
      members: br.members.filter((m) => m.port.startsWith('svi')),
    };
    // First bridge keeps every member EXCEPT the SVI ports.
    br.members = br.members.filter((m) => !m.port.startsWith('svi'));
    chassis.functions = [...chassis.functions, secondBridge];
    // Both internal edges exist, so walk.ts sviBridgeMember finds the
    // second bridge - matching the engine-side semantics the UI mirrors.
    chassis.internal = [
      ...chassis.internal,
      { from: 'rt', to: 'br2' },
    ];
    const html = renderInspector(select(state, l3s));
    // Inspector half: no generic iface-vlan control on either SVI.
    expect(html).not.toMatch(/data-action="iface-vlan"[^>]*data-iface="svi10"/);
    expect(html).not.toMatch(/data-action="iface-vlan"[^>]*data-iface="svi20"/);
    expect(html).not.toMatch(/VLAN \(svi10\)/);
    expect(html).not.toMatch(/VLAN \(svi20\)/);
    // Port-controls half: no PVID/untagged/tagged fieldset on either SVI
    // port - the access ports keep theirs.
    for (const svi of ['svi10', 'svi20']) {
      const fieldset = new RegExp(`<fieldset class="port"><legend>Port ${svi}</legend>`);
      expect(html).not.toMatch(fieldset);
    }
    expect(html).toMatch(/<fieldset class="port"><legend>Port 1<\/legend>/);
    expect(html).toMatch(/data-action="pvid"/);
  });

  it('a placed L3 switch routes between two cabled hosts (issue #73 done-when)', () => {
    let state = initialState;
    state = addPreset(state, 'l3-switch');
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [l3s, h1, h2] = state.topology.devices.map((d) => d.id);
    // Host 1 on access port 1 (VLAN 10), host 2 on access port 2 (VLAN 20):
    // placing the box is not enough — the access ports must be assigned to
    // the SVI VLANs, which is the real L3-switch workflow.
    state = startLink(state, h1!, '1');
    state = completeLink(state, l3s!, '1');
    state = startLink(state, h2!, '1');
    state = completeLink(state, l3s!, '2');
    state = setPvid(state, l3s!, '1', 10);
    state = setUntaggedVlans(state, l3s!, '1', [10]);
    state = setPvid(state, l3s!, '2', 20);
    state = setUntaggedVlans(state, l3s!, '2', [20]);
    state = setHostAddress(state, h1!, {
      ip: '192.168.10.10',
      prefix: 24,
      gateway: '192.168.10.1',
    });
    state = setHostAddress(state, h2!, {
      ip: '192.168.20.20',
      prefix: 24,
      gateway: '192.168.20.1',
    });
    const trace = runTrace(state.topology, {
      from: h1!,
      dstIp: '192.168.20.20',
    });
    const html = renderTrace(trace);
    expect(html).toMatch(/route-lookup/);
    expect(html).toMatch(/delivered at .+ \(delivery\)/);
  });

  it('routing inspector has add/remove firewall rule controls (#151)', () => {
    let state = addPreset(initialState, 'router');
    const rtr = state.topology.devices[0]!.id;
    const empty = renderInspector(select(state, rtr));
    expect(empty).toMatch(/data-action="firewall-add"/);
    expect(empty).not.toMatch(/data-action="firewall-remove"/);
    state = addFirewallRule(state, rtr, { from: 20, to: 10, action: 'deny' });
    const html = renderInspector(select(state, rtr));
    expect(html).toMatch(/data-action="firewall-from"/);
    expect(html).toMatch(/data-action="firewall-to"/);
    expect(html).toMatch(/data-action="firewall-action"/);
    expect(html).toMatch(/data-action="firewall-remove"/);
    expect(html).toMatch(/value="20"/);
    expect(html).toMatch(/value="10"/);
    expect(html).toMatch(/<option value="deny" selected>/);
  });

  it('deny VLAN20→VLAN10 from the inspector drops the ICMP reply at firewall (#151)', () => {
    let state = initialState;
    state = addPreset(state, 'l3-switch');
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [l3s, h1, h2] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!, '1');
    state = completeLink(state, l3s!, '1');
    state = startLink(state, h2!, '1');
    state = completeLink(state, l3s!, '2');
    state = setPvid(state, l3s!, '1', 10);
    state = setUntaggedVlans(state, l3s!, '1', [10]);
    state = setPvid(state, l3s!, '2', 20);
    state = setUntaggedVlans(state, l3s!, '2', [20]);
    state = setHostAddress(state, h1!, {
      ip: '192.168.10.10',
      prefix: 24,
      gateway: '192.168.10.1',
    });
    state = setHostAddress(state, h2!, {
      ip: '192.168.20.20',
      prefix: 24,
      gateway: '192.168.20.1',
    });
    state = addFirewallRule(state, l3s!, { from: 20, to: 10, action: 'deny' });
    const trace = runTrace(state.topology, {
      from: h1!,
      dstIp: '192.168.20.20',
    });
    const drop = trace.replyHops.find((hop) => hop.step === 'firewall');
    expect(drop?.reasonCode).toBe('firewall:dropped');
    expect(drop?.action).toBe('dropped');
    expect(drop?.reason).toBe(drop ? drop.reason : '');
    expect(trace.flowNotes.some((line) =>
      line.includes('ICMP reached VLAN 20') && line.includes('VLAN20 -> VLAN10 deny'),
    )).toBe(true);
  });
});

describe('trace panel', () => {
  it('renders warnings, request lines and notices, without a verdict', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'switch');
    state = addPreset(state, 'host');
    const [h1, sw, h2] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!, '1');
    state = completeLink(state, sw!, '1');
    state = startLink(state, sw!, '2');
    state = completeLink(state, h2!, '1');
    const lastIp = state.topology.devices[2]!.ip!;
    const trace = runTrace(state.topology, { from: h1!, dstIp: lastIp });
    const html = renderTrace(trace);
    expect(html).toMatch(new RegExp(COLD_TRACE_NOTICE.slice(0, 20)));
    expect(html).toMatch(/delivered at .+ \(delivery\)/);
    // ADR 0002: the trace is the answer; no summary verdict line.
    expect(html).not.toMatch(/Outcome:/);
    // No verdict: the panel reports the outcome, it does not judge the network.
    expect(html).not.toMatch(/\b(OK|PASS|SUCCESS|GOOD)\b/);
  });

  it('highlights the active hop sentence in lockstep with the cursor (#107)', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'switch');
    state = addPreset(state, 'host');
    const [h1, sw, h2] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!, '1');
    state = completeLink(state, sw!, '1');
    state = startLink(state, sw!, '2');
    state = completeLink(state, h2!, '1');
    const lastIp = state.topology.devices[2]!.ip!;
    const trace = runTrace(state.topology, { from: h1!, dstIp: lastIp });
    const html = renderTrace(trace, 0);
    expect(html).toMatch(/data-hop-index="0"[^>]*class="active"|class="active"[^>]*data-hop-index="0"/);
    expect(html).toContain(trace.requestHops[0]!.reason);
    expect(html).not.toMatch(/\b(Success|Fail)\b/);
    expect(html).toMatch(/timers are not modelled/i);
  });
});
