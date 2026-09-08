import type { Chassis, DeviceId, Topology } from '../src/index';
import { viewBoxAttr, type Camera } from './camera';
import { autoPlace, type Layout } from './layout';
import { isSviMemberPort } from './state';

const BOX_W = 168;
const BOX_H = 72;

export type TokenMark = {
  x: number;
  y: number;
  from?: { x: number; y: number };
  action?: string;
};

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

export function contentSize(state: {
  topology: Topology;
  layout: Layout | null;
}): { maxX: number; maxY: number } {
  const layout = layoutForDisplay(state.topology, state.layout);
  let maxX = 220;
  let maxY = 180;
  for (const device of state.topology.devices) {
    const origin = layout[device.id] ?? { x: 0, y: 0 };
    maxX = Math.max(maxX, origin.x + BOX_W + 48);
    maxY = Math.max(maxY, origin.y + BOX_H + 56);
  }
  return { maxX, maxY };
}

function faceOf(chassis: Chassis): string {
  if (chassis.preset) return chassis.preset;
  const kinds = new Set(chassis.functions.map((fn) => fn.kind));
  if (kinds.has('isp-handoff')) return 'modem';
  if (kinds.has('wireless')) return 'access-point';
  if (kinds.has('dhcp-server') && !kinds.has('routing')) return 'dhcp-server';
  if (kinds.has('routing') && kinds.has('bridging')) return 'l3-switch';
  if (kinds.has('routing')) return 'router';
  if (kinds.has('bridging')) {
    const bridge = chassis.functions.find((fn) => fn.kind === 'bridging');
    return bridge && !bridge.vlanAware ? 'unmanaged-switch' : 'switch';
  }
  return 'host';
}

function glyph(face: string): string {
  switch (face) {
    case 'host':
      return (
        '<rect class="glyph" x="18" y="14" width="36" height="24" rx="2" />' +
        '<rect class="glyph-fill" x="21" y="17" width="30" height="16" />' +
        '<rect class="glyph" x="32" y="38" width="8" height="4" />'
      );
    case 'switch':
    case 'l3-switch':
      return (
        '<rect class="glyph" x="16" y="18" width="48" height="18" rx="2" />' +
        '<rect class="led" x="22" y="24" width="5" height="5" />' +
        '<rect class="led" x="30" y="24" width="5" height="5" />' +
        '<rect class="led" x="38" y="24" width="5" height="5" />' +
        '<rect class="led" x="46" y="24" width="5" height="5" />' +
        (face === 'l3-switch' ? '<path class="glyph" d="M72 22 l8 8 -8 8" />' : '')
      );
    case 'unmanaged-switch':
      return (
        '<rect class="glyph" x="16" y="20" width="48" height="16" rx="2" />' +
        '<rect class="led dim" x="22" y="25" width="5" height="5" />' +
        '<rect class="led dim" x="30" y="25" width="5" height="5" />' +
        '<rect class="led dim" x="38" y="25" width="5" height="5" />'
      );
    case 'router':
      return (
        '<rect class="glyph" x="20" y="16" width="32" height="26" rx="3" />' +
        '<path class="glyph" d="M28 16 v-8 M36 16 v-10 M44 16 v-8" />' +
        '<circle class="led" cx="36" cy="29" r="3" />'
      );
    case 'access-point':
      return (
        '<circle class="glyph" cx="36" cy="30" r="8" />' +
        '<path class="glyph radio" d="M24 22 a16 16 0 0 1 24 0" />' +
        '<path class="glyph radio" d="M18 16 a24 24 0 0 1 36 0" />'
      );
    case 'modem':
      return (
        '<rect class="glyph" x="18" y="22" width="50" height="16" rx="2" />' +
        '<circle class="led" cx="28" cy="30" r="2.5" />' +
        '<circle class="led" cx="38" cy="30" r="2.5" />'
      );
    case 'dhcp-server':
      return (
        '<rect class="glyph" x="22" y="12" width="40" height="12" rx="2" />' +
        '<rect class="glyph" x="22" y="26" width="40" height="12" rx="2" />' +
        '<rect class="glyph" x="22" y="40" width="40" height="10" rx="2" />'
      );
    default:
      return '<rect class="glyph" x="24" y="18" width="28" height="22" rx="3" />';
  }
}

function cablePath(
  a: { x: number; y: number },
  b: { x: number; y: number },
): string {
  const sag = Math.max(28, Math.abs(a.x - b.x) * 0.18);
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + sag}, ${b.x} ${b.y + sag}, ${b.x} ${b.y}`;
}

function renderToken(item: TokenMark): string {
  const action = item.action ? ` ${esc(item.action)}` : '';
  const travel =
    item.from && (item.from.x !== item.x || item.from.y !== item.y)
      ? `<animate attributeName="cx" from="${item.from.x}" to="${item.x}" dur="0.55s" fill="freeze" />` +
        `<animate attributeName="cy" from="${item.from.y}" to="${item.y}" dur="0.55s" fill="freeze" />`
      : '';
  return (
    `<circle class="token${action}" cx="${item.x}" cy="${item.y}" r="8">` +
    `${travel}</circle>` +
    `<circle class="token-core${action}" cx="${item.x}" cy="${item.y}" r="3.5">` +
    `${travel}</circle>`
  );
}

export function renderCanvas(
  state: {
    topology: Topology;
    layout: Layout | null;
    selected: DeviceId | null;
    pendingLink?: { device: DeviceId; port: string } | null;
  },
  token?: TokenMark | readonly TokenMark[] | null,
  camera?: Camera | null,
): string {
  const layout = layoutForDisplay(state.topology, state.layout);
  const tokens = token == null ? [] : Array.isArray(token) ? token : [token];
  const devices = state.topology.devices
    .map((device) => {
      const origin = layout[device.id] ?? { x: 0, y: 0 };
      const face = faceOf(device);
      const selected =
        device.id === state.selected ? ' device selected' : ' device';
      const ports = device.ports
        .map((port, i) => {
          // An SVI member port is internal wiring, not a jack (#124): it
          // never carries a link, so it draws no handle. The index math
          // keeps the full array so real ports stay where links attach.
          if (isSviMemberPort(device, port.id)) return '';
          const n = Math.max(1, device.ports.length);
          const cx = ((i + 1) * BOX_W) / (n + 1);
          const busy = state.topology.links.some(
            (link) =>
              (link.a.device === device.id && link.a.port === port.id) ||
              (link.b.device === device.id && link.b.port === port.id),
          );
          const pending =
            state.pendingLink?.device === device.id &&
            state.pendingLink.port === port.id;
          const klass = `port${busy ? ' occupied' : ''}${pending ? ' pending' : ''}`;
          return (
            `<rect class="${klass}" data-device="${esc(device.id)}" ` +
            `data-port="${esc(port.id)}" x="${cx - 5}" y="${BOX_H - 7}" ` +
            `width="10" height="10" rx="1.5" />`
          );
        })
        .join('');
      return (
        `<g class="${selected.trim()} face-${esc(face)}" data-device="${esc(device.id)}" ` +
        `transform="translate(${origin.x} ${origin.y})">` +
        `<rect class="box-shadow" x="3" y="5" width="${BOX_W}" height="${BOX_H}" rx="10" />` +
        `<rect class="box" width="${BOX_W}" height="${BOX_H}" rx="10" />` +
        `<rect class="box-head" width="${BOX_W}" height="8" rx="10" />` +
        glyph(face) +
        `<text class="label" x="${BOX_W / 2}" y="58" text-anchor="middle">${esc(device.label)}</text>` +
        ports +
        `</g>`
      );
    })
    .join('');

  const byId = new Map(state.topology.devices.map((device) => [device.id, device]));
  const live = new Set(
    tokens.flatMap((item) => {
      if (!item.from) return [];
      return state.topology.links
        .filter((link) => {
          const aDev = byId.get(link.a.device);
          const bDev = byId.get(link.b.device);
          if (!aDev || !bDev) return false;
          const a = portPoint(aDev, link.a.port, layout[aDev.id] ?? { x: 0, y: 0 });
          const b = portPoint(bDev, link.b.port, layout[bDev.id] ?? { x: 0, y: 0 });
          const hits = (p: { x: number; y: number }, q: { x: number; y: number }) =>
            (Math.hypot(p.x - item.from!.x, p.y - item.from!.y) < 12 &&
              Math.hypot(q.x - item.x, q.y - item.y) < 12) ||
            (Math.hypot(q.x - item.from!.x, q.y - item.from!.y) < 12 &&
              Math.hypot(p.x - item.x, p.y - item.y) < 12);
          return hits(a, b);
        })
        .map((link) => link.id);
    }),
  );
  const links = state.topology.links
    .map((link) => {
      const aDev = byId.get(link.a.device);
      const bDev = byId.get(link.b.device);
      if (!aDev || !bDev) return '';
      const a = portPoint(aDev, link.a.port, layout[aDev.id] ?? { x: 0, y: 0 });
      const b = portPoint(bDev, link.b.port, layout[bDev.id] ?? { x: 0, y: 0 });
      const down = link.up === false ? ' down' : '';
      const medium = link.medium === 'wireless' ? ' wireless' : ' wired';
      const riding = live.has(link.id) ? ' live' : '';
      const assumption =
        link.medium === 'wireless'
          ? `<text class="assumption" x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 + 18}" text-anchor="middle">estimate</text>`
          : '';
      const d = cablePath(a, b);
      return (
        `<path class="link-glow${medium}${down}${riding}" data-link="${esc(link.id)}" d="${d}" />` +
        `<path class="link${medium}${down}${riding}" data-link="${esc(link.id)}" d="${d}" />` +
        assumption
      );
    })
    .join('');

  const { maxX, maxY } = contentSize(state);
  const marker = tokens.map(renderToken).join('');
  const box = camera ?? { x: 0, y: 0, w: maxX, h: maxY };
  return (
    `<svg class="canvas-svg" viewBox="${viewBoxAttr(box)}" ` +
    `xmlns="http://www.w3.org/2000/svg">` +
    `<defs>` +
    `<pattern id="ns-grid" width="24" height="24" patternUnits="userSpaceOnUse">` +
    `<path d="M 24 0 L 0 0 0 24" fill="none" stroke="currentColor" stroke-width="0.6" />` +
    `</pattern>` +
    `</defs>` +
    `<rect class="grid" width="100%" height="100%" fill="url(#ns-grid)" />` +
    `${links}${devices}${marker}</svg>`
  );
}
