import type { DeviceId, Topology } from '../src/index';
import { autoPlace, type Layout } from './layout';

const BOX_W = 120;
const BOX_H = 48;

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function layoutForDisplay(topology: Topology, layout: Layout | null): Layout {
  const placed = autoPlace(topology);
  if (!layout) return placed;
  return { ...placed, ...layout };
}

export function handlePoint(
  topology: Topology,
  layout: Layout | null,
  deviceId: DeviceId,
  portId: string,
): { x: number; y: number } | null {
  const chassis = topology.devices.find((device) => device.id === deviceId);
  if (!chassis) return null;
  const display = layoutForDisplay(topology, layout);
  return portPoint(chassis, portId, display[deviceId] ?? { x: 0, y: 0 });
}

function portPoint(
  chassis: Topology['devices'][number],
  portId: string,
  origin: { x: number; y: number },
): { x: number; y: number } {
  const index = Math.max(
    0,
    chassis.ports.findIndex((port) => port.id === portId),
  );
  const n = Math.max(1, chassis.ports.length);
  return {
    x: origin.x + ((index + 1) * BOX_W) / (n + 1),
    y: origin.y + BOX_H,
  };
}

export function renderCanvas(
  state: {
    topology: Topology;
    layout: Layout | null;
    selected: DeviceId | null;
  },
  token?: { x: number; y: number } | null,
): string {
  const layout = layoutForDisplay(state.topology, state.layout);
  const devices = state.topology.devices
    .map((device) => {
      const origin = layout[device.id] ?? { x: 0, y: 0 };
      const selected =
        device.id === state.selected ? ' device selected' : ' device';
      const ports = device.ports
        .map((port, i) => {
          const n = Math.max(1, device.ports.length);
          const cx = ((i + 1) * BOX_W) / (n + 1);
          return (
            `<circle class="port" data-device="${esc(device.id)}" ` +
            `data-port="${esc(port.id)}" cx="${cx}" cy="${BOX_H}" r="4" />`
          );
        })
        .join('');
      return (
        `<g class="${selected.trim()}" data-device="${esc(device.id)}" ` +
        `transform="translate(${origin.x} ${origin.y})">` +
        `<rect class="box" width="${BOX_W}" height="${BOX_H}" rx="4" />` +
        `<text x="${BOX_W / 2}" y="20" text-anchor="middle">${esc(device.label)}</text>` +
        ports +
        `</g>`
      );
    })
    .join('');

  const byId = new Map(state.topology.devices.map((device) => [device.id, device]));
  const links = state.topology.links
    .map((link) => {
      const aDev = byId.get(link.a.device);
      const bDev = byId.get(link.b.device);
      if (!aDev || !bDev) return '';
      const a = portPoint(aDev, link.a.port, layout[aDev.id] ?? { x: 0, y: 0 });
      const b = portPoint(bDev, link.b.port, layout[bDev.id] ?? { x: 0, y: 0 });
      const down = link.up === false ? ' down' : '';
      const medium = link.medium === 'wireless' ? ' wireless' : ' wired';
      const assumption =
        link.medium === 'wireless'
          ? `<text class="assumption" x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 6}" text-anchor="middle">estimate</text>`
          : '';
      return (
        `<path class="link${medium}${down}" data-link="${esc(link.id)}" ` +
        `d="M ${a.x} ${a.y} L ${b.x} ${b.y}" />` +
        assumption
      );
    })
    .join('');

  let maxX = 160;
  let maxY = 120;
  for (const device of state.topology.devices) {
    const origin = layout[device.id] ?? { x: 0, y: 0 };
    maxX = Math.max(maxX, origin.x + BOX_W + 16);
    maxY = Math.max(maxY, origin.y + BOX_H + 24);
  }
  const marker = token
    ? `<circle class="token" cx="${token.x}" cy="${token.y}" r="6" />`
    : '';
  return (
    `<svg class="canvas-svg" viewBox="0 0 ${maxX} ${maxY}" ` +
    `xmlns="http://www.w3.org/2000/svg">${links}${devices}${marker}</svg>`
  );
}
