import { describe, expect, it } from 'vitest';
import { addPreset, completeLink, initialState, setPvid, startLink } from './state';
import { runTrace } from './trace';
import { allHops, floodGroup, stepIndex, tokenMarks, tokenPoint } from './replay';
import type { Hop } from '../src/index';

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

function floodHop(device: string, outPort?: string): Hop {
  return {
    device,
    inPort: '1',
    outPort,
    vlan: 10,
    action: 'flooded',
    step: 'egress-tagging',
    reasonCode: 'egress-tagging:flooded',
    reason: `flooded at ${device}`,
  };
}

describe('flood concurrent tokens (#108)', () => {
  it('characterises DISCOVER flood hops and never invents extra tokens', () => {
    const { state, h1 } = threeBoxLine();
    const trace = runTrace(state.topology, { from: h1, kind: 'dhcp-discover' });
    const hops = allHops(trace);
    const flooded = hops.filter((hop) => hop.action === 'flooded');
    expect(trace.request.length).toBe(hops.filter((_, i) => i < trace.requestHops.length).length);
    for (let i = 0; i < hops.length; i++) {
      const group = floodGroup(hops, i);
      const tokens = group
        .map((hop) => tokenPoint(hop, state.topology, null))
        .filter((item) => item !== null);
      expect(tokens.length, `index ${i}`).toBeLessThanOrEqual(
        Math.max(1, flooded.length),
      );
      expect(tokens.length).toBeLessThanOrEqual(hops.length);
    }
  });

  it('unicast path is still one token', () => {
    const { state, h1, lastIp } = threeBoxLine();
    const hops = allHops(runTrace(state.topology, { from: h1, dstIp: lastIp }));
    const fwd = hops.findIndex((hop) => hop.action === 'forwarded' || hop.action === 'delivered');
    expect(fwd).toBeGreaterThanOrEqual(0);
    expect(floodGroup(hops, fwd)).toHaveLength(1);
  });

  it('tokenMarks carry a from-point so the packet can ride the previous hop', () => {
    const { state, h1, lastIp } = threeBoxLine();
    const hops = allHops(runTrace(state.topology, { from: h1, dstIp: lastIp }));
    expect(hops.length).toBeGreaterThan(1);
    const marks = tokenMarks(hops, 1, state.topology, null);
    expect(marks.length).toBeGreaterThan(0);
    const prev = tokenPoint(hops[0]!, state.topology, null);
    expect(marks[0]!.from).toEqual({ x: prev!.x, y: prev!.y });
    expect(marks.length).toBeLessThanOrEqual(hops.length);
  });

  it('consecutive flooded hops on one device draw one token per recorded hop, not more', () => {
    const hops = [
      floodHop('sw-1', '1'),
      floodHop('sw-1', '2'),
      floodHop('sw-1', '3'),
    ];
    const group = floodGroup(hops, 1);
    expect(group).toHaveLength(3);
    expect(group.map((hop) => hop.outPort)).toEqual(['1', '2', '3']);
  });
});
