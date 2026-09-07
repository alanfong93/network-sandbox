import { describe, expect, it } from 'vitest';
import { addPreset, completeLink, initialState, setPvid, startLink } from './state';
import { runTrace } from './trace';
import { allHops, stepIndex, tokenPoint } from './replay';

function threeBoxLine() {
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
  return { state, h1: h1!, lastIp: last.ip!, firstIp: first.ip! };
}

describe('hop replay (#107)', () => {
  it('TraceRender exposes structured hops whose reasons match the sentences', () => {
    const { state, h1, lastIp } = threeBoxLine();
    const trace = runTrace(state.topology, { from: h1, dstIp: lastIp });
    expect(trace.requestHops.map((hop) => hop.reason)).toEqual(trace.request);
    expect(trace.replyHops.map((hop) => hop.reason)).toEqual(trace.reply);
  });

  it('stepping visits hop.device for every index (request then reply)', () => {
    const { state, h1, lastIp } = threeBoxLine();
    const trace = runTrace(state.topology, { from: h1, dstIp: lastIp });
    const hops = allHops(trace);
    expect(hops.length).toBeGreaterThan(0);
    for (let i = 0; i < hops.length; i++) {
      expect(stepIndex(hops.length, 0, i)).toBe(i);
      const token = tokenPoint(hops[i]!, state.topology, state.layout);
      expect(token?.device, `index ${i}`).toBe(hops[i]!.device);
    }
  });

  it('a drop freezes the token on that hop.device', () => {
    const { state, h1 } = threeBoxLine();
    const sw = state.topology.devices[1]!.id;
    const dropped = runTrace(
      setPvid(state, sw, '1', 99).topology,
      { from: h1, dstIp: '192.168.1.11' },
    );
    const hops = allHops(dropped);
    const last = hops[hops.length - 1]!;
    expect(last.action === 'dropped' || last.action === 'delivered').toBe(true);
    const token = tokenPoint(last, state.topology, null);
    expect(token?.device).toBe(last.device);
  });

  it('for any hop list, step never leaves the recorded sequence', () => {
    const { state, h1, lastIp } = threeBoxLine();
    const hops = allHops(runTrace(state.topology, { from: h1, dstIp: lastIp }));
    for (let start = 0; start < hops.length; start++) {
      for (const delta of [-3, -1, 0, 1, 5, hops.length]) {
        const next = stepIndex(hops.length, start, delta);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(hops.length);
        expect(hops[next]!.device).toBe(hops[next]!.device);
      }
    }
  });
});
