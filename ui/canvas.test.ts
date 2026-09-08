import { describe, expect, it } from 'vitest';
import { addPreset, completeLink, initialState, select, startLink } from './state';
import { autoPlace } from './layout';
import { handlePoint, renderCanvas } from './canvas';

describe('SVG canvas view (#105)', () => {
  it('lists every device as a labelled box with data-device', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'switch');
    const svg = renderCanvas(state);
    for (const device of state.topology.devices) {
      expect(svg).toContain(`data-device="${device.id}"`);
      expect(svg).toContain(device.label);
    }
    expect(svg).toMatch(/<svg[\s>]/);
  });

  it('lists every port as a handle with data-device and data-port', () => {
    const state = addPreset(initialState, 'switch');
    const chassis = state.topology.devices[0]!;
    const svg = renderCanvas(state);
    for (const port of chassis.ports) {
      expect(svg).toMatch(
        new RegExp(`data-device="${chassis.id}"[^>]*data-port="${port.id}"|data-port="${port.id}"[^>]*data-device="${chassis.id}"`),
      );
    }
  });

  it('draws no handle for an SVI member port - it is not a jack (#124)', () => {
    const state = addPreset(initialState, 'router');
    const svg = renderCanvas(state);
    expect(svg).not.toMatch(/data-port="lan-svi"/);
    expect(svg).toMatch(/data-port="lan"/);
    expect(svg).toMatch(/data-port="wan"/);
  });

  it('lists every link as a path between those handles', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [a, b] = state.topology.devices.map((d) => d.id);
    state = startLink(state, a!, '1');
    state = completeLink(state, b!, '1');
    const svg = renderCanvas(state);
    const link = state.topology.links[0]!;
    expect(svg).toContain(`data-link="${link.id}"`);
    expect(svg).toMatch(/<path[^>]*data-link=/);
  });

  it('marks the selected box', () => {
    let state = addPreset(initialState, 'host');
    const id = state.topology.devices[0]!.id;
    state = select(state, id);
    const svg = renderCanvas(state);
    expect(svg).toMatch(new RegExp(`class="[^"]*device[^"]*selected[^"]*"[^>]*data-device="${id}"|data-device="${id}"[^>]*class="[^"]*selected`));
  });

  it('missing layout uses autoPlace without writing it', () => {
    const state = addPreset(initialState, 'host');
    expect(state.layout).toBeNull();
    const svg = renderCanvas(state);
    const placed = autoPlace(state.topology);
    const id = state.topology.devices[0]!.id;
    const pos = placed[id]!;
    expect(svg).toContain(`translate(${pos.x} ${pos.y})`);
    expect(state.layout).toBeNull();
  });

  it('down links are visually distinct from up links', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [a, b] = state.topology.devices.map((d) => d.id);
    state = startLink(state, a!, '1');
    state = completeLink(state, b!, '1');
    const down = {
      ...state,
      topology: {
        ...state.topology,
        links: state.topology.links.map((link) => ({ ...link, up: false })),
      },
    };
    const upSvg = renderCanvas(state);
    const downSvg = renderCanvas(down);
    expect(downSvg).toMatch(/class="[^"]*down/);
    expect(upSvg).not.toMatch(/class="[^"]*down/);
  });

  it('wireless links have a distinct stroke and an assumption label', () => {
    let state = initialState;
    state = addPreset(state, 'access-point');
    state = addPreset(state, 'host');
    const ap = state.topology.devices.find((d) => d.id.startsWith('access-point-'))!;
    const host = state.topology.devices.find((d) => d.id !== ap.id)!;
    const wifiPort =
      ap.ports.find((p) =>
        ap.functions.some((fn) => fn.kind === 'wireless' && fn.id === p.ownedBy),
      )?.id ?? ap.ports[0]!.id;
    state = startLink(state, ap.id, wifiPort);
    state = completeLink(state, host.id, '1');
    const svg = renderCanvas(state);
    expect(svg).toMatch(/class="[^"]*wireless/);
    expect(svg).toMatch(/assumption/i);
    expect(svg).not.toMatch(/heatmap|coverage/i);
  });

  it('draws a replay token at the given point (#107)', () => {
    const state = addPreset(initialState, 'host');
    const svg = renderCanvas(state, { x: 10, y: 20 });
    expect(svg).toMatch(/class="token"/);
    expect(svg).toContain('cx="10"');
    expect(svg).toContain('cy="20"');
    const many = renderCanvas(state, [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect(many.match(/class="token"/g)?.length).toBe(2);
  });

  it('optional camera writes the viewBox in world units', () => {
    const state = addPreset(initialState, 'host');
    const svg = renderCanvas(state, null, { x: 10, y: 20, w: 30, h: 40 });
    expect(svg).toContain('viewBox="10 20 30 40"');
  });

  it('rides the cable when a from-point is given', () => {
    const state = addPreset(initialState, 'host');
    const svg = renderCanvas(state, { x: 40, y: 50, from: { x: 10, y: 20 }, action: 'forwarded' });
    expect(svg).toMatch(/class="token forwarded"/);
    expect(svg).toContain('from="10"');
    expect(svg).toContain('to="40"');
  });

  it('a live wired hop is not classed wireless', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [a, b] = state.topology.devices.map((d) => d.id);
    state = startLink(state, a!, '1');
    state = completeLink(state, b!, '1');
    const from = handlePoint(state.topology, state.layout, a!, '1')!;
    const to = handlePoint(state.topology, state.layout, b!, '1')!;
    const svg = renderCanvas(state, { ...to, from, action: 'forwarded' });
    expect(svg).toMatch(/class="[^"]*wired[^"]*live/);
    expect(svg).not.toMatch(/class="[^"]*wireless[^"]*live/);
  });

  it('a live cable draws the flow overlay from origin toward the destination (#122)', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [a, b] = state.topology.devices.map((d) => d.id);
    state = startLink(state, a!, '1');
    state = completeLink(state, b!, '1');
    const from = handlePoint(state.topology, state.layout, a!, '1')!;
    const to = handlePoint(state.topology, state.layout, b!, '1')!;
    const linkId = state.topology.links[0]!.id;
    const svg = renderCanvas(state, { ...to, from, action: 'forwarded' });
    // The flow overlay is its own element on the same cable, and its path
    // data starts at the origin end so the march runs toward the
    // destination.
    expect(svg).toMatch(
      new RegExp(`class="link-flow wired live"[^>]*data-link="${linkId}"`),
    );
    expect(svg).toMatch(
      new RegExp(`class="link-flow wired live"[^>]*d="M ${from.x} ${from.y}`),
    );
  });

  it('the flow overlay reverses with the hop direction (#122)', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [a, b] = state.topology.devices.map((d) => d.id);
    state = startLink(state, a!, '1');
    state = completeLink(state, b!, '1');
    const from = handlePoint(state.topology, state.layout, a!, '1')!;
    const to = handlePoint(state.topology, state.layout, b!, '1')!;
    const svg = renderCanvas(state, { ...from, from: to, action: 'forwarded' });
    expect(svg).toMatch(
      new RegExp(`class="link-flow wired live"[^>]*d="M ${to.x} ${to.y}`),
    );
  });

  it('the wired live base cable stays solid - the flow is a separate element (#122, #119)', () => {
    let state = initialState;
    state = addPreset(state, 'host');
    state = addPreset(state, 'host');
    const [a, b] = state.topology.devices.map((d) => d.id);
    state = startLink(state, a!, '1');
    state = completeLink(state, b!, '1');
    const from = handlePoint(state.topology, state.layout, a!, '1')!;
    const to = handlePoint(state.topology, state.layout, b!, '1')!;
    const linkId = state.topology.links[0]!.id;
    const svg = renderCanvas(state, { ...to, from, action: 'forwarded' });
    // The base cable keeps exactly its own class string - no dash classes
    // leak onto it - and the flow element is separate.
    expect(svg).toMatch(new RegExp(`class="link wired live"[^>]*data-link="${linkId}"`));
    const flowMatch = svg.match(/class="link-flow[^>]*data-link/g);
    expect(flowMatch?.length).toBe(1);
  });

  it('a wireless live hop keeps the estimate dash and gains the direction overlay (#122)', () => {
    let state = initialState;
    state = addPreset(state, 'access-point');
    state = addPreset(state, 'host');
    const ap = state.topology.devices.find((d) => d.id.startsWith('access-point-'))!;
    const host = state.topology.devices.find((d) => d.id !== ap.id)!;
    const wifiPort =
      ap.ports.find((p) =>
        ap.functions.some((fn) => fn.kind === 'wireless' && fn.id === p.ownedBy),
      )?.id ?? ap.ports[0]!.id;
    state = startLink(state, ap.id, wifiPort);
    state = completeLink(state, host.id, '1');
    const from = handlePoint(state.topology, state.layout, ap.id, wifiPort)!;
    const to = handlePoint(state.topology, state.layout, host.id, '1')!;
    const svg = renderCanvas(state, { ...to, from, action: 'forwarded' });
    expect(svg).toMatch(/class="[^"]*wireless[^"]*live/);
    expect(svg).toMatch(/class="link-flow wireless live"/);
  });

  it('does not emit drag, drop, or hop-token markup', () => {
    const state = addPreset(initialState, 'host');
    const svg = renderCanvas(state);
    expect(svg).not.toMatch(/draggable|dragstart|ondrop|hop-token|data-hop/i);
  });
});
