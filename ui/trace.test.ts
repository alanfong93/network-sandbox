import { describe, expect, it } from 'vitest';
import { addPreset, completeLink, initialState, setPortMode, setTaggedVlans, startLink } from './state';
import { COLD_TRACE_NOTICE, NO_TIMERS_NOTICE, runTrace } from './trace';

function twoHostsOnASwitch() {
  let state = initialState;
  state = addPreset(state, 'host');
  state = addPreset(state, 'switch');
  state = addPreset(state, 'host');
  const [h1, sw, h2] = state.topology.devices.map((d) => d.id);
  state = startLink(state, h1!);
  state = completeLink(state, sw!);
  state = startLink(state, sw!);
  state = completeLink(state, h2!);
  const first = state.topology.devices[0]!;
  const last = state.topology.devices[2]!;
  return { state, h1: h1!, h2: h2!, firstIp: first.ip!, lastIp: last.ip! };
}

describe('trace', () => {
  it('a frame between two placed hosts round-trips and renders format() sentences', () => {
    const { state, h1, firstIp, lastIp } = twoHostsOnASwitch();
    const trace = runTrace(state.topology, { from: h1, dstIp: lastIp });
    expect(trace.outcome).toBe('round-trip');
    expect(trace.request.length).toBeGreaterThan(0);
    // The engine's own format() sentence for the delivery hop (ADR 0001:
    // the UI renders engine sentences, it does not re-derive them).
    expect(trace.request[trace.request.length - 1]).toMatch(
      /delivered at .+ \(delivery\)/,
    );
    expect(trace.reply.length).toBeGreaterThan(0);
    for (const line of [...trace.request, ...trace.reply]) {
      expect(line.length).toBeGreaterThan(0);
    }
    expect(firstIp).toBeTruthy();
  });

  it('the cold-trace notice is visible (ADR 0010)', () => {
    const { state, h1, lastIp } = twoHostsOnASwitch();
    const trace = runTrace(state.topology, { from: h1, dstIp: lastIp });
    expect(trace.notices.join('\n')).toMatch(/every trace starts cold/i);
    expect(COLD_TRACE_NOTICE).toMatch(/arp/i);
  });

  it('the no-timers notice is visible (SPEC: not modelled: timers)', () => {
    const { state, h1, lastIp } = twoHostsOnASwitch();
    const trace = runTrace(state.topology, { from: h1, dstIp: lastIp });
    expect(trace.notices.join('\n')).toMatch(/timers are not modelled/i);
    expect(NO_TIMERS_NOTICE.length).toBeGreaterThan(0);
  });

  it('two parallel trunks between stp bridges owe the single-instance warning (ADR 0011)', () => {
    let state = initialState;
    state = addPreset(state, 'switch');
    state = addPreset(state, 'switch');
    const [sw1, sw2] = state.topology.devices.map((d) => d.id);
    state = startLink(state, sw1!);
    state = completeLink(state, sw2!);
    state = startLink(state, sw1!);
    state = completeLink(state, sw2!);
    for (const port of ['1', '2']) {
      state = setPortMode(state, sw1!, port, 'trunk');
      state = setTaggedVlans(state, sw1!, port, [10, 20]);
      state = setPortMode(state, sw2!, port, 'trunk');
      state = setTaggedVlans(state, sw2!, port, [10, 20]);
    }
    const trace = runTrace(state.topology, {
      from: state.topology.devices[0]!.id,
      dstIp: '192.168.1.1',
    });
    expect(trace.warnings).toHaveLength(1);
    expect(trace.warnings[0]).toMatch(/one spanning tree/);
  });

  it('one link between two switches fires no warning', () => {
    let state = initialState;
    state = addPreset(state, 'switch');
    state = addPreset(state, 'switch');
    const [sw1, sw2] = state.topology.devices.map((d) => d.id);
    state = startLink(state, sw1!);
    state = completeLink(state, sw2!);
    const trace = runTrace(state.topology, {
      from: sw1!,
      dstIp: '192.168.1.1',
    });
    expect(trace.warnings).toHaveLength(0);
  });
});
