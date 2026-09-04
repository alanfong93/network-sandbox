import { describe, expect, it } from 'vitest';
import { addPreset, completeLink, initialState, select, setHostAddress, setPvid, setUntaggedVlans, startLink } from './state';
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
});
