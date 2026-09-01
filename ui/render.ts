import type { EditorState } from './state';
import { bridgeMemberOf } from './state';
import type { TraceRender } from './trace';

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function vlans(vlans: Iterable<number>): string {
  return [...vlans].sort((a, b) => a - b).join(', ');
}

export function renderDeviceList(state: EditorState): string {
  const items = state.topology.devices
    .map((device) => {
      const selected = device.id === state.selected ? ' selected' : '';
      return (
        `<li><button type="button" class="device${selected}" ` +
        `data-device="${esc(device.id)}">${esc(device.label)} ` +
        `(${esc(device.id)})</button></li>`
      );
    })
    .join('\n');
  return `<ul class="device-list">\n${items}\n</ul>`;
}

function renderPortControls(state: EditorState, deviceId: string, portId: string): string {
  const chassis = state.topology.devices.find((d) => d.id === deviceId);
  if (!chassis) return '';
  const member = bridgeMemberOf(chassis, portId);
  const rows: string[] = [];
  if (member) {
    rows.push(
      `<label>Port mode ` +
        `<select data-port="${esc(portId)}" data-action="mode">` +
        `<option value="access"${member.mode === 'access' ? ' selected' : ''}>access</option>` +
        `<option value="trunk"${member.mode === 'trunk' ? ' selected' : ''}>trunk</option>` +
        `</select></label>`,
      // ADR 0008: PVID is ingress, the egress-untagged set is a separate
      // mechanism, and one control edits one mechanism. The fused
      // "Native VLAN (PVID)" label is forbidden.
      `<label>PVID (ingress) ` +
        `<input type="number" data-port="${esc(portId)}" data-action="pvid" ` +
        `value="${member.pvid}"></label>`,
      `<label>Untagged VLANs (egress) ` +
        `<input type="text" data-port="${esc(portId)}" data-action="untagged" ` +
        `value="${esc(vlans(member.untaggedVlans))}"></label>`,
      `<label>Tagged VLANs ` +
        `<input type="text" data-port="${esc(portId)}" data-action="tagged" ` +
        `value="${esc(vlans(member.taggedVlans))}"></label>`,
    );
  }
  return rows.length > 0
    ? `<fieldset class="port"><legend>Port ${esc(portId)}</legend>${rows.join('\n')}</fieldset>`
    : '';
}

export function renderInspector(state: EditorState): string {
  const chassis = state.topology.devices.find(
    (device) => device.id === state.selected,
  );
  if (!chassis) {
    return '<p class="hint">Select a device to inspect it.</p>';
  }
  const parts: string[] = [`<h2>${esc(chassis.label)} (${esc(chassis.id)})</h2>`];
  if (chassis.ip !== undefined || chassis.functions.length === 0) {
    parts.push(
      `<label>IP <input type="text" data-action="ip" value="${esc(chassis.ip ?? '')}"></label>`,
      `<label>Prefix <input type="number" data-action="prefix" value="${chassis.prefix ?? ''}"></label>`,
      `<label>Gateway <input type="text" data-action="gateway" value="${esc(chassis.gateway ?? '')}"></label>`,
    );
  }
  parts.push(
    `<button type="button" data-action="start-link" data-device="${esc(chassis.id)}">` +
      `Start link</button>`,
    `<button type="button" data-action="remove" data-device="${esc(chassis.id)}">` +
      `Remove</button>`,
  );
  for (const port of chassis.ports) {
    parts.push(renderPortControls(state, chassis.id, port.id));
  }
  return parts.join('\n');
}

export function renderTrace(trace: TraceRender): string {
  const parts: string[] = [];
  if (trace.warnings.length > 0) {
    parts.push(
      `<section class="warnings"><h3>STP warning</h3>` +
        trace.warnings.map((line) => `<p>${esc(line)}</p>`).join('\n') +
        `</section>`,
    );
  }
  parts.push(
    `<h3>Request</h3>\n<ol class="hops">` +
      trace.request.map((line) => `<li>${esc(line)}</li>`).join('\n') +
      `</ol>`,
  );
  if (trace.reply.length > 0) {
    parts.push(
      `<h3>Reply</h3>\n<ol class="hops">` +
        trace.reply.map((line) => `<li>${esc(line)}</li>`).join('\n') +
        `</ol>`,
    );
  }
  if (trace.flowNotes.length > 0) {
    parts.push(
      `<section class="flow-notes">` +
        trace.flowNotes.map((line) => `<p>${esc(line)}</p>`).join('\n') +
        `</section>`,
    );
  }
  parts.push(
    `<section class="notices">` +
      trace.notices.map((line) => `<p class="notice">${esc(line)}</p>`).join('\n') +
      `</section>`,
    `<p class="outcome">Outcome: ${esc(trace.outcome)}</p>`,
  );
  return parts.join('\n');
}
