import type { Hop, Topology } from '../src/index';
import { handlePoint } from './canvas';
import type { Layout } from './layout';
import type { TraceRender } from './trace';

export function allHops(trace: Pick<TraceRender, 'requestHops' | 'replyHops'>): Hop[] {
  return [...trace.requestHops, ...trace.replyHops];
}

export function stepIndex(length: number, index: number, delta: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index + delta));
}

export function floodGroup(hops: readonly Hop[], index: number): Hop[] {
  const current = hops[index];
  if (!current) return [];
  if (current.action !== 'flooded') return [current];
  let start = index;
  while (
    start > 0 &&
    hops[start - 1]!.action === 'flooded' &&
    hops[start - 1]!.device === current.device
  ) {
    start -= 1;
  }
  let end = index;
  while (
    end + 1 < hops.length &&
    hops[end + 1]!.action === 'flooded' &&
    hops[end + 1]!.device === current.device
  ) {
    end += 1;
  }
  return hops.slice(start, end + 1);
}

export function tokenPoint(
  hop: Hop,
  topology: Topology,
  layout: Layout | null,
): { x: number; y: number; device: string } | null {
  const chassis = topology.devices.find((device) => device.id === hop.device);
  if (!chassis) return null;
  const port = hop.outPort ?? hop.inPort ?? chassis.ports[0]?.id;
  if (!port) return null;
  const point = handlePoint(topology, layout, hop.device, port);
  if (!point) return null;
  return { ...point, device: hop.device };
}
