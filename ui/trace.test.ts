import { describe, expect, it } from 'vitest';
import { addPreset, completeLink, initialState, setPortMode, setPvid, setTaggedVlans, setUntaggedVlans, startLink } from './state';
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

  it('the sender leads its own request and reply sections (#123)', () => {
    const { state, h1, lastIp } = twoHostsOnASwitch();
    const trace = runTrace(state.topology, { from: h1, dstIp: lastIp });
    expect(trace.request[0]).toMatch(new RegExp(`^sent from ${h1} port 1`));
    expect(trace.reply[0]).toMatch(new RegExp(`^sent from .+ port 1`));
  });

  it('a name send shows one origin line per walk - query then echo (#123 x #126)', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'resolver');
    state = addPreset(state, 'switch');
    const [h1, dns, sw] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!, '1');
    state = completeLink(state, sw!, '1');
    state = startLink(state, sw!, '2');
    state = completeLink(state, dns!, '1');
    // The resolver is the host's advertised resolver and holds the record.
    state = {
      ...state,
      topology: {
        ...state.topology,
        devices: state.topology.devices.map((device) =>
          device.id === h1
            ? { ...device, resolver: state.topology.devices.find((d) => d.id === dns)!.ip! }
            : device,
        ),
      },
    };
    const trace = runTrace(state.topology, { from: h1!, dstName: 'google.com' });
    expect(trace.outcome).toBe('request-failed');
    // Two walks, each led by its own origin line naming the same sender.
    const origins = trace.request.filter((line) => /^sent from /.test(line));
    expect(origins.length).toBe(2);
    expect(trace.request[0]).toMatch(new RegExp(`^sent from ${h1} port 1`));
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

  it('a DHCP DISCOVER from a host on a serverless VLAN shows the flooded walk, no OFFER (row 8 shape, #82)', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'switch');
    state = addPreset(state, 'host');
    const [h1, sw, h2] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!);
    state = completeLink(state, sw!);
    state = startLink(state, sw!);
    state = completeLink(state, h2!);
    // No dhcp-server anywhere: the DISCOVER floods and nothing answers.
    const trace = runTrace(state.topology, { from: h1!, kind: 'dhcp-discover' });
    expect(trace.request.length).toBeGreaterThan(0);
    expect(trace.request.some((line) => line.match(/flood/i))).toBe(true);
    expect(trace.request.some((line) => line.match(/offer/i))).toBe(false);
    // No ARP leg: a DISCOVER is broadcast (needsArp false, src/send.ts).
    expect(trace.request.some((line) => line.match(/arp/i))).toBe(false);
    // The DISCOVER-specific cold notice names MAC tables, not the ARP
    // exchange that does not run here (ADR 0010 honesty).
    expect(trace.notices.join('\n')).toMatch(/mac tables/i);
    expect(trace.notices.join('\n')).not.toMatch(/arp exchange below/i);
    // Request-only trace: a DISCOVER is broadcast, there is no ICMP reply
    // leg to render (flow.ts early-returns for non-ICMP payloads).
    expect(trace.reply).toEqual([]);
    // No verdict/summary line (ADR 0002).
    expect(trace.request.join('\n')).not.toMatch(/Outcome:/i);
  });

  it('a device id containing flood never flips the notice - only the flooded action does (#82)', () => {
    // Import preserves arbitrary device ids, so a delivered-to id like
    // 'flood-host' puts the WORD flood into a hop sentence without any
    // flood action. The notice selector must key on the leading action
    // token, not the substring anywhere in the line.
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [h1, other] = state.topology.devices.map((d) => d.id);
    state.topology.devices[1]!.id = 'flood-host';
    state = startLink(state, h1!);
    state = completeLink(state, other!);
    const trace = runTrace(state.topology, { from: h1!, kind: 'dhcp-discover' });
    expect(trace.request.some((line) => /^flooded\b/.test(line))).toBe(false);
    expect(trace.notices.join('\n')).toMatch(/broadcast delivery below/i);
    expect(trace.notices.join('\n')).not.toMatch(/flood below/i);
  });

  it('a direct-link DISCOVER renders without a flood hop and without the flood notice (#82)', () => {
    // No switch on the path: there is nothing to flood and no MAC table to
    // consult, so the flood-worded cold notice would be a lie here. The
    // DISCOVER itself is unchanged - no ARP, no OFFER, request only.
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'dhcp-server');
    const [h1, srv] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!);
    state = completeLink(state, srv!);
    const trace = runTrace(state.topology, { from: h1!, kind: 'dhcp-discover' });
    expect(trace.request.some((line) => line.match(/flood/i))).toBe(false);
    expect(trace.request.some((line) => line.match(/arp/i))).toBe(false);
    expect(trace.request.some((line) => line.match(/offer/i))).toBe(false);
    expect(trace.reply).toEqual([]);
    expect(trace.notices.join('\n')).toMatch(/broadcast delivery below/i);
    expect(trace.notices.join('\n')).not.toMatch(/flood below/i);
    expect(trace.notices.join('\n')).not.toMatch(/arp exchange below/i);
  });

  it('two standalone dhcp-servers on one VLAN both OFFER a browser-originated DISCOVER (row 11 shape, #82)', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'switch');
    state = addPreset(state, 'dhcp-server');
    state = addPreset(state, 'dhcp-server');
    const [h1, sw, srv1, srv2] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!);
    state = completeLink(state, sw!);
    state = startLink(state, sw!);
    state = completeLink(state, srv1!);
    state = startLink(state, sw!);
    state = completeLink(state, srv2!);
    // The switch preset's access ports sit on VLAN 1; the servers answer
    // on chassis.vlan 10, so move everyone onto the service VLAN.
    state = setPvid(state, sw!, '1', 10);
    state = setUntaggedVlans(state, sw!, '1', [10]);
    state = setPvid(state, sw!, '2', 10);
    state = setUntaggedVlans(state, sw!, '2', [10]);
    state = setPvid(state, sw!, '3', 10);
    state = setUntaggedVlans(state, sw!, '3', [10]);
    state = setPvid(state, sw!, '4', 10);
    state = setUntaggedVlans(state, sw!, '4', [10]);
    const trace = runTrace(state.topology, { from: h1!, kind: 'dhcp-discover' });
    // Row 11's hop truth before #63: both servers forward an answer back
    // (the OFFER), each as a dhcp-server hop naming the server chassis -
    // exactly two deliveries, one per server, never a duplicated single
    // delivery or an unrelated request-leg match.
    const serverLines = trace.request.filter((line) =>
      line.match(/dhcp-server/),
    );
    expect(serverLines.length).toBe(2);
    expect(
      trace.request.filter((line) => line.includes(srv1!)).length,
    ).toBe(1);
    expect(
      trace.request.filter((line) => line.includes(srv2!)).length,
    ).toBe(1);
    expect(
      trace.request.filter((line) => line.match(/delivered at host-1/)).length,
    ).toBe(2);
  });
});

describe('walk observations render in the trace panel (#63)', () => {
  function pvidMismatchState() {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'switch');
    state = addPreset(state, 'switch');
    state = addPreset(state, 'host');
    const [h1, sw1, sw2, h2] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!);
    state = completeLink(state, sw1!);
    state = startLink(state, sw1!);
    state = completeLink(state, sw2!);
    state = startLink(state, sw2!);
    state = completeLink(state, h2!);
    // Row 2: SW1 side in VLAN 10, SW2 side in VLAN 20. The sw1<->sw2
    // link occupies sw1 p2 and sw2 p1 (first-free port wiring above).
    state = setPvid(state, sw1!, '1', 10);
    state = setUntaggedVlans(state, sw1!, '1', [10]);
    state = setPvid(state, sw1!, '2', 10);
    state = setUntaggedVlans(state, sw1!, '2', [10]);
    state = setPvid(state, sw2!, '1', 20);
    state = setUntaggedVlans(state, sw2!, '1', [20]);
    state = setPvid(state, sw2!, '2', 20);
    state = setUntaggedVlans(state, sw2!, '2', [20]);
    const first = state.topology.devices[0]!;
    const last = state.topology.devices[3]!;
    return { state, h1: h1!, dstIp: last.ip! };
  }

  it('the row-2 vlan-leak sentence renders, labelled with its phase (#63)', () => {
    const { state, h1, dstIp } = pvidMismatchState();
    const trace = runTrace(state.topology, { from: h1, dstIp });
    const leak = trace.flowNotes.find((line) => /VLAN leak/.test(line));
    expect(leak).toBeDefined();
    expect(leak).toMatch(/^Request: /);
    expect(leak).toMatch(/entered VLAN 10 at/);
    expect(leak).toMatch(/arrived as VLAN 20 at/);
    // The reply walk mirrors the leak in the same panel.
    const replyLeak = trace.flowNotes.find(
      (line) => /^Reply: /.test(line) && /VLAN leak/.test(line),
    );
    expect(replyLeak).toBeDefined();
  });

  it('the row-6 loop observation renders on an unmanaged cycle (#63)', () => {
    let state = initialState;
    state = addPreset(state, 'unmanaged-switch');
    state = addPreset(state, 'unmanaged-switch');
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [u1, u2, h1, h2] = state.topology.devices.map((d) => d.id);
    state = startLink(state, h1!);
    state = completeLink(state, u1!);
    state = startLink(state, u1!);
    state = completeLink(state, u2!);
    state = startLink(state, u2!);
    state = completeLink(state, u1!);
    state = startLink(state, h2!);
    state = completeLink(state, u2!);
    const trace = runTrace(state.topology, {
      from: h1!,
      dstIp: state.topology.devices[3]!.ip!,
    });
    const loop = trace.flowNotes.find((line) => /looped/i.test(line));
    expect(loop).toBeDefined();
    expect(loop).toMatch(/^Request: /);
    expect(loop).toMatch(/STP cannot break this loop/);
    // No verdict/summary line (ADR 0002).
    expect(trace.flowNotes.join('\n')).not.toMatch(/Outcome:/i);
  });
});
