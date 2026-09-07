import { describe, expect, it } from 'vitest';
import { addPreset, completeLink, initialState, select, startLink } from './state';
import { autoPlace } from './layout';
import { renderCanvas } from './canvas';

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

  it('does not emit drag, drop, or hop-token markup', () => {
    const state = addPreset(initialState, 'host');
    const svg = renderCanvas(state);
    expect(svg).not.toMatch(/draggable|dragstart|ondrop|hop-token|data-hop/i);
  });
});
