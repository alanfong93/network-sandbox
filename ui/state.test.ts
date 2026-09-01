import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/index';
import {
  addPreset,
  cancelLink,
  completeLink,
  initialState,
  removeDevice,
  setPvid,
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

  it('links two placed boxes without hand-editing JSON', () => {
    let state = initialState;
    const placed2 = placed(state, 'host', 2);
    state = placed2.state;
    const [a, b] = placed2.ids;
    state = startLink(state, a!);
    expect(state.pendingLink?.device).toBe(a);
    state = completeLink(state, b!);
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
    state = startLink(state, a!);
    state = completeLink(state, b!);
    const placed3 = placed(state, 'host');
    state = placed3.state;
    const [c] = placed3.ids;
    state = startLink(state, c!);
    // a and b each have their only port consumed
    state = completeLink(state, a!);
    expect(state.topology.links).toHaveLength(1);
    expect(state.notice).toMatch(/no free port/i);
  });

  it('cancelLink clears a pending link', () => {
    let state = initialState;
    const placed1 = placed(state, 'host');
    state = placed1.state;
    const [a] = placed1.ids;
    state = startLink(state, a!);
    state = cancelLink(state);
    expect(state.pendingLink).toBeNull();
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
    state = startLink(state, a!);
    state = completeLink(state, b!);
    state = removeDevice(state, a!);
    expect(state.topology.devices).toHaveLength(1);
    expect(state.topology.links).toHaveLength(0);
  });
});
