import type { DeviceId, Topology } from '../src/index';

export type Layout = Record<DeviceId, { x: number; y: number }>;

const COLS = 4;
const GX = 200;
const GY = 160;

export function pruneLayout(raw: unknown, topology: Topology): Layout {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const ids = new Set(topology.devices.map((device) => device.id));
  const out: Layout = {};
  for (const [id, pos] of Object.entries(raw as Record<string, unknown>)) {
    if (!ids.has(id)) continue;
    if (typeof pos !== 'object' || pos === null) continue;
    const rec = pos as { x?: unknown; y?: unknown };
    if (typeof rec.x !== 'number' || typeof rec.y !== 'number') continue;
    if (!Number.isFinite(rec.x) || !Number.isFinite(rec.y)) continue;
    out[id] = { x: rec.x, y: rec.y };
  }
  return out;
}

export function autoPlace(topology: Topology): Layout {
  const out: Layout = {};
  topology.devices.forEach((device, i) => {
    out[device.id] = {
      x: (i % COLS) * GX,
      y: Math.floor(i / COLS) * GY,
    };
  });
  return out;
}

export function dropDevice(layout: Layout, id: DeviceId): Layout {
  const next = { ...layout };
  delete next[id];
  return next;
}
