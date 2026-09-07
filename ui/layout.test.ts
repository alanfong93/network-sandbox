import { describe, expect, it } from 'vitest';
import { addPreset, initialState } from './state';
import { autoPlace, dropDevice, pruneLayout, type Layout } from './layout';

function devices(n: number) {
  let state = initialState;
  for (let i = 0; i < n; i++) state = addPreset(state, 'host');
  return state.topology;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('layout sidecar (#104)', () => {
  it('pruneLayout keeps finite x/y for ids that exist and drops the rest', () => {
    const topology = devices(2);
    const [a, b] = topology.devices.map((d) => d.id);
    const raw = {
      [a!]: { x: 10, y: 20 },
      [b!]: { x: Number.NaN, y: 1 },
      'ghost-1': { x: 3, y: 4 },
      notAPos: 5,
    };
    expect(pruneLayout(raw, topology)).toEqual({ [a!]: { x: 10, y: 20 } });
  });

  it('pruneLayout does not auto-place missing ids', () => {
    const topology = devices(2);
    const [a] = topology.devices.map((d) => d.id);
    const pruned = pruneLayout({ [a!]: { x: 1, y: 2 } }, topology);
    expect(Object.keys(pruned)).toEqual([a]);
  });

  it('pruneLayout yields {} for non-objects', () => {
    const topology = devices(1);
    expect(pruneLayout(null, topology)).toEqual({});
    expect(pruneLayout('nope', topology)).toEqual({});
    expect(pruneLayout([{ x: 1, y: 2 }], topology)).toEqual({});
  });

  it('autoPlace is a deterministic grid from devices array order', () => {
    const topology = devices(5);
    expect(autoPlace(topology)).toEqual(autoPlace(topology));
    const ids = topology.devices.map((d) => d.id);
    expect(autoPlace(topology)).toEqual({
      [ids[0]!]: { x: 0, y: 0 },
      [ids[1]!]: { x: 200, y: 0 },
      [ids[2]!]: { x: 400, y: 0 },
      [ids[3]!]: { x: 600, y: 0 },
      [ids[4]!]: { x: 0, y: 160 },
    });
  });

  it('dropDevice removes that id and no other', () => {
    const layout: Layout = { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } };
    expect(dropDevice(layout, 'a')).toEqual({ b: { x: 3, y: 4 } });
    expect(layout).toEqual({ a: { x: 1, y: 2 }, b: { x: 3, y: 4 } });
  });

  it('for generated layouts, prune keys are a subset of device ids and positions are finite', () => {
    for (let seed = 0; seed < 64; seed++) {
      const rng = mulberry32(seed);
      const topology = devices(1 + Math.floor(rng() * 4));
      const ids = topology.devices.map((d) => d.id);
      const raw: Record<string, unknown> = {};
      for (const id of ids) {
        if (rng() < 0.7) {
          raw[id] = {
            x: rng() < 0.1 ? Number.POSITIVE_INFINITY : Math.floor(rng() * 800),
            y: rng() < 0.1 ? Number.NaN : Math.floor(rng() * 600),
          };
        }
      }
      raw[`ghost-${seed}`] = { x: 1, y: 2 };
      const pruned = pruneLayout(raw, topology);
      const live = new Set(ids);
      for (const [id, pos] of Object.entries(pruned)) {
        expect(live.has(id), `seed ${seed} extra id ${id}`).toBe(true);
        expect(Number.isFinite(pos.x), `seed ${seed} ${id}.x`).toBe(true);
        expect(Number.isFinite(pos.y), `seed ${seed} ${id}.y`).toBe(true);
      }
    }
  });
});
