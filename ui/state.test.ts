import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/index';
import {
  addPreset,
  cancelLink,
  completeLink,
  initialState,
  moveDevice,
  placePreset,
  removeDevice,
  setDhcpScope,
  setIspHandoff,
  setPortAcceptable,
  setPortIngressFiltering,
  setPvid,
  setRouterIfaceVlan,
  setStpPriority,
  setUntaggedVlans,
  startLink,
  type EditorState,
} from './state';

function placed(
  state: EditorState,
  presetId: string,
  times = 1,
): { state: EditorState; ids: DeviceId[] } {
  let next = state;
  const ids: DeviceId[] = [];
  for (let i = 0; i < times; i++) {
    next = addPreset(next, presetId);
    ids.push(next.topology.devices[next.topology.devices.length - 1]!.id);
  }
  return { state: next, ids };
}

describe('editor state', () => {
  it('addPreset places a preset box with a unique id and selects it', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    expect(state.topology.devices).toHaveLength(2);
    const [first, second] = state.topology.devices;
    expect(first?.id).not.toBe(second?.id);
    expect(state.selected).toBe(second?.id ?? null);
  });

  it('a dhcp-server chassis IP tracks the server count, not the global seq (#92)', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    state = addPreset(state, 'dhcp-server');
    const server = state.topology.devices[state.topology.devices.length - 1]!;
    // Three unrelated placements must not push the first server off .2:
    // the derivation is keyed to the server ordinal, the issue's named
    // root cause, not the global placement seq.
    expect(server.ip).toBe('192.168.10.2');
  });

  it('a dhcp-server chassis IP never reuses a live ordinal after a delete (#92)', () => {
    let state = initialState;
    state = addPreset(state, 'dhcp-server');
    state = addPreset(state, 'dhcp-server');
    const [first, second] = state.topology.devices.slice(-2).map((d) => d.id);
    expect(state.topology.devices.at(-1)?.ip).toBe('192.168.10.3');
    state = removeDevice(state, first!);
    state = addPreset(state, 'dhcp-server');
    const third = state.topology.devices.at(-1)!;
    // The surviving server holds .3 (ordinal 2); deleting the first
    // server freed ordinal 1, and the lowest-free scan takes it - never
    // the live .3.
    expect(third.ip).toBe('192.168.10.2');
    expect(second).toBeDefined();
  });

  it('the 154th dhcp-server hits the exhaustion notice with no derived IP (#92)', () => {
    let state = initialState;
    for (let i = 0; i < 153; i++) state = addPreset(state, 'dhcp-server');
    state = addPreset(state, 'dhcp-server');
    const last = state.topology.devices.at(-1)!;
    expect(state.notice).toMatch(/exhausted/i);
    expect(last.ip).toBeUndefined();
    // The 153 placed servers all hold valid, distinct addresses.
    const servers = state.topology.devices.slice(0, -1);
    expect(new Set(servers.map((d) => d.ip)).size).toBe(153);
  });

  it('links two placed boxes without hand-editing JSON', () => {
    let state = initialState;
    const placed2 = placed(state, 'host', 2);
    state = placed2.state;
    const [a, b] = placed2.ids;
    state = startLink(state, a!, '1');
    expect(state.pendingLink?.device).toBe(a);
    state = completeLink(state, b!, '1');
    expect(state.topology.links).toHaveLength(1);
    expect(state.topology.links[0]?.a.device).toBe(a);
    expect(state.topology.links[0]?.b.device).toBe(b);
    expect(state.pendingLink).toBeNull();
  });

  it('running out of ports is a notice, not a link and not a crash', () => {
    let state = initialState;
    const placed2 = placed(state, 'host', 2);
    state = placed2.state;
    const [a, b] = placed2.ids;
    state = startLink(state, a!, '1');
    state = completeLink(state, b!, '1');
    const placed3 = placed(state, 'host');
    state = placed3.state;
    const [c] = placed3.ids;
    state = startLink(state, c!, '1');
    // a and b each have their only port consumed
    state = completeLink(state, a!, '1');
    expect(state.topology.links).toHaveLength(1);
    expect(state.notice).toMatch(/occupied|no free port/i);
  });

  it('cancelLink clears a pending link', () => {
    let state = initialState;
    const placed1 = placed(state, 'host');
    state = placed1.state;
    const [a] = placed1.ids;
    state = startLink(state, a!, '1');
    state = cancelLink(state);
    expect(state.pendingLink).toBeNull();
  });

  it('setIspHandoff switches mode and clears or sets the VLAN tag (#68)', () => {
    let state = addPreset(initialState, 'modem');
    const modem = state.topology.devices[0]!.id;
    const isp = (s: EditorState) => {
      const chassis = s.topology.devices.find((d) => d.id === modem)!;
      const fn = chassis.functions.find((f) => f.kind === 'isp-handoff')!;
      if (fn.kind !== 'isp-handoff') throw new Error('expected isp-handoff');
      return fn;
    };
    // The preset ships pppoe + tag 500.
    expect(isp(state).mode).toBe('pppoe');
    expect(isp(state).vlanTag).toBe(500);
    // A mode-only patch keeps the tag.
    state = setIspHandoff(state, modem, { mode: 'dhcp' });
    expect(isp(state).mode).toBe('dhcp');
    expect(isp(state).vlanTag).toBe(500);
    // An explicit undefined clears the tag - no-tag handoff.
    state = setIspHandoff(state, modem, { vlanTag: undefined });
    expect(isp(state).mode).toBe('dhcp');
    expect(isp(state).vlanTag).toBeUndefined();
    // Setting a tag on a tag-less handoff works.
    state = setIspHandoff(state, modem, { vlanTag: 500 });
    expect(isp(state).vlanTag).toBe(500);
    // And the third mode.
    state = setIspHandoff(state, modem, { mode: 'static' });
    expect(isp(state).mode).toBe('static');
  });

  it('setIspHandoff rejects an invalid mode and preserves state (#68 review)', () => {
    let state = addPreset(initialState, 'modem');
    const modem = state.topology.devices[0]!.id;
    state = setIspHandoff(state, modem, {
      mode: 'nope' as 'pppoe',
    });
    expect(state.notice).toMatch(/invalid/i);
    const chassis = state.topology.devices.find((d) => d.id === modem)!;
    const fn = chassis.functions.find((f) => f.kind === 'isp-handoff')!;
    if (fn.kind !== 'isp-handoff') throw new Error('expected isp-handoff');
    // Rejected patch: mode stays the shipped pppoe.
    expect(fn.mode).toBe('pppoe');
    expect(fn.vlanTag).toBe(500);
  });
  it('setPvid writes ingress only — untaggedVlans is untouched (ADR 0008)', () => {
    let state = initialState;
    const placedSw = placed(state, 'switch');
    state = placedSw.state;
    const [sw] = placedSw.ids;
    state = setPvid(state, sw!, '1', 7);
    const chassis = state.topology.devices.find((d) => d.id === sw)!;
    const bridge = chassis.functions.find((fn) => fn.kind === 'bridging')!;
    if (bridge.kind !== 'bridging') throw new Error('expected bridging');
    const member = bridge.members.find((m) => m.port === '1')!;
    expect(member.pvid).toBe(7);
    expect([...member.untaggedVlans]).toEqual([1]);
  });

  it('setPvid reaches a port living only in a second bridging function (#89)', () => {
    let state = initialState;
    const placedSw = placed(state, 'switch');
    state = placedSw.state;
    const [sw] = placedSw.ids;
    const chassis = state.topology.devices.find((d) => d.id === sw)!;
    const br = chassis.functions.find((fn) => fn.kind === 'bridging')!;
    if (br.kind !== 'bridging') throw new Error('expected bridging');
    const secondBridge = {
      ...br,
      id: 'br2',
      members: br.members.filter((m) => m.port === '3'),
    };
    br.members = br.members.filter((m) => m.port !== '3');
    chassis.functions = [...chassis.functions, secondBridge];
    state = setPvid(state, sw!, '3', 42);
    // The update is immutable - re-read the chassis from the NEW state.
    const updated = state.topology.devices.find((d) => d.id === sw)!;
    const br2 = updated.functions.find((fn) => fn.id === 'br2')!;
    if (br2.kind !== 'bridging') throw new Error('expected bridging');
    expect(br2.members.find((m) => m.port === '3')!.pvid).toBe(42);
  });

  it('setUntaggedVlans writes egress only — pvid is untouched (ADR 0008)', () => {
    let state = initialState;
    const placedSw = placed(state, 'switch');
    state = placedSw.state;
    const [sw] = placedSw.ids;
    state = setUntaggedVlans(state, sw!, '1', []);
    const chassis = state.topology.devices.find((d) => d.id === sw)!;
    const bridge = chassis.functions.find((fn) => fn.kind === 'bridging')!;
    if (bridge.kind !== 'bridging') throw new Error('expected bridging');
    const member = bridge.members.find((m) => m.port === '1')!;
    expect([...member.untaggedVlans]).toEqual([]);
    expect(member.pvid).toBe(1);
  });

  it('removeDevice drops the attached links', () => {
    let state = initialState;
    const placed2 = placed(state, 'host', 2);
    state = placed2.state;
    const [a, b] = placed2.ids;
    state = startLink(state, a!, '1');
    state = completeLink(state, b!, '1');
    state = removeDevice(state, a!);
    expect(state.topology.devices).toHaveLength(1);
    expect(state.topology.links).toHaveLength(0);
  });

  it('removeDevice drops the layout entry and does not auto-fill holes (#104)', () => {
    let state = initialState;
    const placed2 = placed(state, 'host', 2);
    state = placed2.state;
    const [a, b] = placed2.ids;
    state = {
      ...state,
      layout: { [a!]: { x: 1, y: 2 }, [b!]: { x: 3, y: 4 } },
    };
    state = removeDevice(state, a!);
    expect(state.layout).toEqual({ [b!]: { x: 3, y: 4 } });
  });

  it('addPreset does not write autoPlace into layout (#104)', () => {
    const state = addPreset(initialState, 'host');
    expect(state.layout).toBeNull();
  });

  it('placePreset writes chassis and a layout point (#106)', () => {
    const state = placePreset(initialState, 'host', { x: 40, y: 80 });
    const id = state.topology.devices[0]!.id;
    expect(state.layout).toEqual({ [id]: { x: 40, y: 80 } });
  });

  it('moveDevice updates layout only (#106)', () => {
    let state = placePreset(initialState, 'host', { x: 0, y: 0 });
    const before = state.topology;
    const id = state.topology.devices[0]!.id;
    state = moveDevice(state, id, { x: 99, y: 7 });
    expect(state.topology).toBe(before);
    expect(state.layout).toEqual({ [id]: { x: 99, y: 7 } });
  });

  it('canvas port-port click uses the same link helpers as inspector Start-link (#106)', () => {
    let canvas = initialState;
    canvas = addPreset(canvas, 'host');
    canvas = addPreset(canvas, 'host');
    const [a, b] = canvas.topology.devices.map((d) => d.id);
    canvas = startLink(canvas, a!, '1');
    canvas = completeLink(canvas, b!, '1');
    let inspector = initialState;
    inspector = addPreset(inspector, 'host');
    inspector = addPreset(inspector, 'host');
    inspector = startLink(inspector, a!, '1');
    inspector = completeLink(inspector, b!, '1');
    expect(canvas.topology.links).toEqual(inspector.topology.links);
  });

  it('first cable can be router wan to modem 1', () => {
    let state = initialState;
    state = addPreset(state, 'router');
    state = addPreset(state, 'modem');
    const [rtr, ont] = state.topology.devices.map((d) => d.id);
    state = startLink(state, rtr!, 'wan');
    expect(state.pendingLink).toEqual({ device: rtr, port: 'wan' });
    state = completeLink(state, ont!, '1');
    expect(state.topology.links).toHaveLength(1);
    expect(state.topology.links[0]?.a.port).toBe('wan');
    expect(state.topology.links[0]?.b.port).toBe('1');
    const routing = state.topology.devices
      .find((d) => d.id === rtr)
      ?.functions.find((fn) => fn.kind === 'routing');
    expect(routing && routing.kind === 'routing' ? routing.ifaces[0]?.id : null).toBe(
      'lan',
    );
  });

  it('occupied ports cannot be chosen', () => {
    let state = initialState;
    state = addPreset(state, 'router');
    state = addPreset(state, 'modem');
    const [rtr, ont] = state.topology.devices.map((d) => d.id);
    state = startLink(state, rtr!, 'wan');
    state = completeLink(state, ont!, '1');
    state = startLink(state, rtr!, 'wan');
    expect(state.pendingLink).toBeNull();
    expect(state.notice).toMatch(/occupied|in use|no free/i);
  });

  it('setRouterIfaceVlan writes WAN vlan without touching PVID', () => {
    let state = initialState;
    state = addPreset(state, 'router');
    const [rtr] = state.topology.devices.map((d) => d.id);
    state = setRouterIfaceVlan(state, rtr!, 'wan', undefined);
    const routing = state.topology.devices
      .find((d) => d.id === rtr)
      ?.functions.find((fn) => fn.kind === 'routing');
    const wan =
      routing && routing.kind === 'routing'
        ? routing.ifaces.find((iface) => iface.id === 'wan')
        : undefined;
    expect(wan?.vlan).toBeUndefined();
    state = setRouterIfaceVlan(state, rtr!, 'wan', 500);
    const again = state.topology.devices
      .find((d) => d.id === rtr)
      ?.functions.find((fn) => fn.kind === 'routing');
    const wan500 =
      again && again.kind === 'routing'
        ? again.ifaces.find((iface) => iface.id === 'wan')
        : undefined;
    expect(wan500?.vlan).toBe(500);
  });

  it('setDhcpScope patches only the named scope and preserves siblings', () => {
    let state = addPreset(initialState, 'dhcp-server');
    const [srv] = state.topology.devices.map((d) => d.id);
    state = setDhcpScope(state, srv!, 0, { poolStart: '192.168.10.50' });
    const server = state.topology.devices
      .find((d) => d.id === srv)
      ?.functions.find((fn) => fn.kind === 'dhcp-server');
    const scope = server && server.kind === 'dhcp-server' ? server.scopes[0] : undefined;
    expect(scope?.poolStart).toBe('192.168.10.50');
    // Untouched siblings-in-scope:
    expect(scope?.poolEnd).toBe('192.168.10.199');
    expect(scope?.gateway).toBe('192.168.10.1');
    expect(scope?.resolver).toBe('192.168.10.1');
    expect(scope?.vlan).toBe(10);
  });

  it('setDhcpScope rejects a vlan outside 1..4094 and an empty address', () => {
    let state = addPreset(initialState, 'dhcp-server');
    const [srv] = state.topology.devices.map((d) => d.id);
    const badVlan = setDhcpScope(state, srv!, 0, { vlan: 5000 });
    expect(badVlan.topology.devices[0]).toBe(state.topology.devices[0]);
    expect(badVlan.notice).toMatch(/invalid/i);
    const badVlan0 = setDhcpScope(state, srv!, 0, { vlan: 0 });
    expect(badVlan0.notice).toMatch(/invalid/i);
    const emptyAddr = setDhcpScope(state, srv!, 0, { gateway: '  ' });
    expect(emptyAddr.notice).toMatch(/invalid/i);
  });

  it('setDhcpScope moves the service VLAN with the scope vlan - never a silent disable (#84)', () => {
    let state = addPreset(initialState, 'dhcp-server');
    const [srv] = state.topology.devices.map((d) => d.id);
    state = setDhcpScope(state, srv!, 0, { vlan: 20 });
    const chassis = state.topology.devices.find((d) => d.id === srv);
    // The scope and the chassis addressing VLAN move together: the engine
    // answer gates on chassis.vlan (src/dhcp.ts), so a scope vlan that has
    // drifted from it can never answer - the sync removes the trap.
    expect(chassis?.vlan).toBe(20);
    const server = chassis?.functions.find((fn) => fn.kind === 'dhcp-server');
    const scope = server && server.kind === 'dhcp-server' ? server.scopes[0] : undefined;
    expect(scope?.vlan).toBe(20);
  });

  it('setDhcpScope preserves the chassis vlan when the patch has no vlan', () => {
    let state = addPreset(initialState, 'dhcp-server');
    const [srv] = state.topology.devices.map((d) => d.id);
    state = setDhcpScope(state, srv!, 0, { poolEnd: '192.168.10.150' });
    const chassis = state.topology.devices.find((d) => d.id === srv);
    expect(chassis?.vlan).toBe(10);
  });

  it('setStpPriority writes the stp function on that chassis only (#69)', () => {
    let state = addPreset(initialState, 'switch');
    const [sw] = state.topology.devices.map((d) => d.id);
    state = setStpPriority(state, sw!, 4096);
    const chassis = state.topology.devices.find((d) => d.id === sw);
    const stp = chassis?.functions.find((fn) => fn.kind === 'stp');
    expect(stp && stp.kind === 'stp' ? stp.priority : undefined).toBe(4096);
    // A chassis with no stp function is left bare - the setter is a no-op
    // there, never inventing a function (#67).
    state = addPreset(state, 'unmanaged-switch');
    const [usw] = state.topology.devices.map((d) => d.id).slice(-1);
    const before = JSON.stringify(state.topology.devices.find((d) => d.id === usw));
    const after = setStpPriority(state, usw!, 4096);
    expect(
      JSON.stringify(after.topology.devices.find((d) => d.id === usw)),
    ).toBe(before);
  });

  it('setStpPriority accepts 0 (the root-guaranteeing legal value) and rejects non-4096 multiples (#69)', () => {
    let state = addPreset(initialState, 'switch');
    const [sw] = state.topology.devices.map((d) => d.id);
    // 0 is a legal 802.1D bridge priority - the top-4-bits field starts at
    // zero, and 0 guarantees root. The first implementation rejected it.
    state = setStpPriority(state, sw!, 0);
    const chassis = state.topology.devices.find((d) => d.id === sw);
    const stp = chassis?.functions.find((fn) => fn.kind === 'stp');
    expect(stp && stp.kind === 'stp' ? stp.priority : undefined).toBe(0);
    // Non-multiples of 4096 are not bridge ids - the priority occupies the
    // high bits; the input's step=4096 and the setter must agree.
    const odd = setStpPriority(state, sw!, 32767);
    expect(odd.notice).toMatch(/steps of 4096/);
    const overRange = setStpPriority(state, sw!, 65536);
    expect(overRange.notice).toMatch(/0\.\.61440/);
  });

  it('setPortAcceptable writes the admission rule on the bridge port (#69)', () => {
    let state = addPreset(initialState, 'switch');
    const [sw] = state.topology.devices.map((d) => d.id);
    state = setPortAcceptable(state, sw!, '1', 'tagged-only');
    const chassis = state.topology.devices.find((d) => d.id === sw);
    const bridge = chassis?.functions.find((fn) => fn.kind === 'bridging');
    const member =
      bridge && bridge.kind === 'bridging'
        ? bridge.members.find((m) => m.port === '1')
        : undefined;
    expect(member?.acceptableFrameTypes).toBe('tagged-only');
  });

  it('setPortIngressFiltering writes the 802.1Q mechanism flag on the bridge port (#69)', () => {
    let state = addPreset(initialState, 'switch');
    const [sw] = state.topology.devices.map((d) => d.id);
    state = setPortIngressFiltering(state, sw!, '1', false);
    const chassis = state.topology.devices.find((d) => d.id === sw);
    const bridge = chassis?.functions.find((fn) => fn.kind === 'bridging');
    const member =
      bridge && bridge.kind === 'bridging'
        ? bridge.members.find((m) => m.port === '1')
        : undefined;
    expect(member?.ingressFiltering).toBe(false);
  });
});
