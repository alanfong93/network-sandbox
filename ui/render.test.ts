import { describe, expect, it } from 'vitest';
import { addPreset, completeLink, initialState, select, startLink } from './state';
import { renderInspector, renderTrace } from './render';
import { COLD_TRACE_NOTICE, runTrace } from './trace';

function switchedState() {
  let state = initialState;
  state = addPreset(state, 'host');
  state = addPreset(state, 'switch');
  const [h1, sw] = state.topology.devices.map((d) => d.id);
  state = startLink(state, h1!);
  state = completeLink(state, sw!);
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
});

describe('trace panel', () => {
  it('renders warnings, request lines and notices, without a verdict', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'switch');
    state = addPreset(state, 'host');
    const [h1, sw, h2] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!);
    state = completeLink(state, sw!);
    state = startLink(state, sw!);
    state = completeLink(state, h2!);
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
