import type { DeviceId } from '../src/index';
import { divergentScopeWarning, exportSandbox, importSandbox } from './jsonio';
import { PRESETS } from './presets';
import { renderDeviceList, renderInspector, renderTrace } from './render';
import {
  addPreset,
  cancelLink,
  completeLink,
  initialState,
  select,
  setDhcpScope,
  setHostAddress,
  setPortMode,
  setPvid,
  setRouterIfaceVlan,
  setTaggedVlans,
  setUntaggedVlans,
  startLink,
  removeDevice,
  type EditorState,
} from './state';
import { runTrace } from './trace';

let state: EditorState = initialState;
let sendFrom: DeviceId | null = null;
let lastDstIp = '192.168.1.11';
let sendKind: 'icmp' | 'dhcp-discover' = 'icmp';

function renderLinks(state: EditorState): string {
  if (state.topology.links.length === 0) {
    return '<p class="hint">No links yet.</p>';
  }
  const items = state.topology.links
    .map(
      (link) =>
        `<li>${esc(link.a.device)}:${esc(link.a.port)} &mdash; ` +
        `${esc(link.b.device)}:${esc(link.b.port)} (${esc(link.medium)})</li>`,
    )
    .join('\n');
  return `<ul class="link-list">\n${items}\n</ul>`;
}

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function render(): void {
  const palette = document.querySelector<HTMLDivElement>('#palette');
  const devices = document.querySelector<HTMLDivElement>('#devices');
  const inspector = document.querySelector<HTMLDivElement>('#inspector');
  const trace = document.querySelector<HTMLDivElement>('#trace');
  if (!palette || !devices || !inspector || !trace) return;

  palette.innerHTML =
    '<h2>Palette</h2>' +
    PRESETS.map(
      (preset) =>
        `<button type="button" class="preset" data-action="add" ` +
        `data-preset="${esc(preset.id)}">${esc(preset.label)}</button>`,
    ).join(' ');

  const linking = state.pendingLink
    ? `<p class="linking">Linking from <strong>${esc(state.pendingLink.device)}` +
      `:${esc(state.pendingLink.port)}</strong> &mdash; click another device, ` +
      `or <button type="button" data-action="cancel-link">Cancel</button></p>`
    : '';
  devices.innerHTML =
    '<h2>Devices</h2>' +
    linking +
    renderDeviceList(state) +
    '<h3>Links</h3>' +
    renderLinks(state) +
    (state.notice ? `<p class="notice">${esc(state.notice)}</p>` : '');

  inspector.innerHTML = renderInspector(state);

  const options =
    state.topology.devices.length > 0
      ? state.topology.devices
          .map(
            (device) =>
              `<option value="${esc(device.id)}"` +
              `${device.id === sendFrom ? ' selected' : ''}>` +
              `${esc(device.label)} (${esc(device.id)})</option>`,
          )
          .join('')
      : '<option value="">place a device first</option>';

  trace.innerHTML =
    '<h2>Trace</h2>' +
    '<p class="hint">Send runs the engine on the current topology: ' +
    'ICMP to the destination IP, then the reply, against one cold run context.</p>' +
    '<form id="send-form"><label>From ' +
    `<select id="send-from" name="from">${options}</select></label> ` +
    '<label>Send type ' +
    '<select id="send-kind" name="kind">' +
    `<option value="icmp"${sendKind === 'icmp' ? ' selected' : ''}>ICMP echo</option>` +
    `<option value="dhcp-discover"${sendKind === 'dhcp-discover' ? ' selected' : ''}>DHCP DISCOVER</option>` +
    '</select></label> ' +
    // A DISCOVER is broadcast: no destination IP is sent or asked for
    // (#82). The ICMP path keeps its dstIp input untouched.
    (sendKind === 'icmp'
      ? '<label>Destination IP ' +
        `<input type="text" name="dstIp" value="${esc(lastDstIp)}"></label> `
      : '') +
    '<button type="submit">Send</button></form>' +
    '<div id="trace-out"></div>' +
    '<h2>Sandbox JSON</h2>' +
    '<button type="button" data-action="export">Export file</button> ' +
    '<label class="file">Import <input type="file" id="import-file" accept=".json,application/json"></label>' +
    '<textarea id="json-view" readonly placeholder="Exported sandbox JSON appears here"></textarea>';

  const out = document.querySelector<HTMLDivElement>('#trace-out');
  if (out && lastTraceRender) out.innerHTML = lastTraceRender;
}

let lastTraceRender: string | null = null;

function send(event: Event): void {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const from = (form.elements.namedItem('from') as HTMLSelectElement).value;
  if (!from) return;
  if (sendKind === 'dhcp-discover') {
    // A DISCOVER is broadcast (#82): no destination IP, request-only trace.
    const trace = runTrace(state.topology, { from, kind: 'dhcp-discover' });
    lastTraceRender = renderTrace(trace);
  } else {
    const dstIp = (form.elements.namedItem('dstIp') as HTMLInputElement).value;
    if (!dstIp) return;
    lastDstIp = dstIp;
    const trace = runTrace(state.topology, { from, dstIp });
    lastTraceRender = renderTrace(trace);
  }
  render();
  const out = document.querySelector<HTMLDivElement>('#trace-out');
  out?.scrollIntoView({ behavior: 'smooth' });
}

function exportJson(): void {
  const text = exportSandbox(state.topology);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'sandbox.json';
  anchor.click();
  URL.revokeObjectURL(url);
  const view = document.querySelector<HTMLTextAreaElement>('#json-view');
  if (view) view.value = text;
}

function maxSuffix(topology: EditorState['topology']): number {
  let max = 0;
  for (const device of topology.devices) {
    const match = /(\d+)$/.exec(device.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  for (const link of topology.links) {
    const match = /^l(\d+)$/.exec(link.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

async function importJson(file: File): Promise<void> {
  try {
    const topology = importSandbox(await file.text());
    // Import-only limitation, named where the user meets it (#86): the
    // engine's standalone DHCP model is one VLAN (src/dhcp.ts), so a
    // multi-scope chassis answers on chassis.vlan only. Warn, never
    // reject - the topology is legal.
    const warning = divergentScopeWarning(topology);
    state = {
      ...initialState,
      topology,
      seq: maxSuffix(topology),
      notice: warning ?? null,
    };
    lastTraceRender = null;
    sendFrom = null;
    render();
  } catch (error) {
    state = {
      ...state,
      notice: `Import failed: ${error instanceof Error ? error.message : String(error)}`,
    };
    render();
  }
}

function onClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action],[data-device].device');
  if (!target) return;

  if (target.matches('.device[data-device]')) {
    const id = target.dataset.device!;
    if (state.pendingLink && state.pendingLink.device !== id) {
      const chassis = state.topology.devices.find((d) => d.id === id);
      const port = chassis?.ports.find(
        (p) =>
          !state.topology.links.some(
            (link) =>
              (link.a.device === id && link.a.port === p.id) ||
              (link.b.device === id && link.b.port === p.id),
          ),
      )?.id;
      state = completeLink(state, id, port);
    } else {
      state = select(state, id);
    }
    render();
    return;
  }

  const action = target.dataset.action;
  const device = target.dataset.device ?? state.selected;
  switch (action) {
    case 'add':
      state = addPreset(state, target.dataset.preset!);
      break;
    case 'start-link':
      if (device) state = startLink(state, device, target.dataset.port);
      break;
    case 'cancel-link':
      state = cancelLink(state);
      break;
    case 'remove':
      if (device) state = removeDevice(state, device);
      break;
    case 'export':
      exportJson();
      return;
    default:
      return;
  }
  render();
}

function onChange(event: Event): void {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  const action = input.dataset.action;
  const device = input.closest('[data-device]')?.getAttribute('data-device') ?? state.selected;
  const port = input.dataset.port;
  if (!action || !device) return;
  switch (action) {
    case 'mode':
      if (port) {
        state = setPortMode(state, device, port, input.value as 'access' | 'trunk');
      }
      break;
    case 'pvid':
      if (port) state = setPvid(state, device, port, Number(input.value));
      break;
    case 'untagged':
      if (port) {
        state = setUntaggedVlans(
          state,
          device,
          port,
          parseVlans(input.value),
        );
      }
      break;
    case 'tagged':
      if (port) {
        state = setTaggedVlans(state, device, port, parseVlans(input.value));
      }
      break;
    case 'ip':
      state = setHostAddress(state, device, { ip: input.value });
      break;
    case 'prefix':
      state = setHostAddress(state, device, { prefix: Number(input.value) });
      break;
    case 'gateway':
      state = setHostAddress(state, device, { gateway: input.value });
      break;
    case 'iface-vlan': {
      const iface = input.dataset.iface;
      if (iface) {
        const raw = input.value.trim();
        state = setRouterIfaceVlan(
          state,
          device,
          iface,
          raw === '' ? undefined : Number(raw),
        );
      }
      break;
    }
    case 'scope-field': {
      const scope = input.dataset.scope;
      const field = input.dataset.field;
      if (scope !== undefined && field) {
        const index = Number(scope);
        const patch: Partial<Record<string, number | string>> = {};
        if (field === 'vlan') {
          patch.vlan = Number(input.value);
        } else {
          patch[field] = input.value;
        }
        state = setDhcpScope(state, device, index, patch);
      }
      break;
    }
    default:
      return;
  }
  render();
}

function parseVlans(text: string): number[] {
  return text
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

document.addEventListener('click', onClick);
document.addEventListener('change', onChange);
document.addEventListener('submit', (event) => {
  if ((event.target as HTMLElement).id === 'send-form') send(event);
});
document.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'send-from') sendFrom = target.value;
  if (target.id === 'send-kind') {
    sendKind = target.value === 'dhcp-discover' ? 'dhcp-discover' : 'icmp';
    render();
  }
  if (target.id === 'import-file' && target.files?.[0]) {
    void importJson(target.files[0]);
  }
});

render();
