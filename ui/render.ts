import type { EditorState } from './state';
import { bridgeMemberOf, freePorts } from './state';
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
  // The owning bridging function is the source of truth for what this
  // port's controls are (ADR 0013), never the preset id.
  const owningBridge = member
    ? chassis.functions.find(
        (fn) => fn.kind === 'bridging' && fn.members.some((m) => m.port === portId),
      )
    : undefined;
  // A VLAN-blind bridge reads none of the per-port VLAN membership config:
  // PVID is applied only when vlanAware (src/bridge.ts:216), membership
  // tests are vacuously true (:65), egress ignores untaggedVlans (:157),
  // flood candidate selection skips the VLAN filter (:260), and ingress
  // filtering's drop branch is unreachable because isMember never returns
  // false. Those controls would be a false affordance: edits that change
  // nothing. Alan's call: HIDE, not disable (#67, ADR 0007).
  const vlanBlind = owningBridge?.kind === 'bridging' && !owningBridge.vlanAware;
  // An SVI port is an rt-owned port that is a bridging member AND carries a
  // matching routing iface - the #71 composition has two halves: the
  // routing iface's vlan and the member's carried VLANs. The member's
  // PVID/tagged/untagged controls would edit the bridge half alone and
  // desync it from the iface half (routed egress is gated by the member's
  // carried VLANs), so SVI ports render no bridge-member controls (#83).
  // The iface-id match mirrors the engine's own sviBridgeMember condition:
  // rt-owned + bridging member WITHOUT a matching iface is not an SVI, and
  // its member VLANs stay live L2 config (cycle 3). Every bridging function
  // is checked - a port that is a member of any of them counts, not just
  // the first (#87).
  if (member) {
    const port = chassis.ports.find((item) => item.id === portId);
    const ownedByRouting = chassis.functions.some(
      (fn) =>
        fn.kind === 'routing' &&
        port?.ownedBy === fn.id &&
        fn.ifaces.some((iface) => iface.id === portId),
    );
    const sviMember = chassis.functions.some(
      (fn) =>
        fn.kind === 'bridging' &&
        fn.members.some((m) => m.port === portId),
    );
    if (ownedByRouting && sviMember) {
      return '';
    }
  }
  const rows: string[] = [];
  if (member) {
    if (!vlanBlind) {
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
    // Acceptable frame types is enforced unconditionally by bridge.ts
    // (:193-213), VLAN-blind or not - the control is live on an unmanaged
    // port and stays (#96 review cycle 1). ADR 0008 wording applies: the
    // label names the 802.1Q mechanism, never a fused "Native VLAN" phrase.
    rows.push(
      `<label>Acceptable frame types ` +
        `<select data-port="${esc(portId)}" data-action="acceptable">` +
        `<option value="all"${member.acceptableFrameTypes === 'all' ? ' selected' : ''}>all</option>` +
        `<option value="tagged-only"${member.acceptableFrameTypes === 'tagged-only' ? ' selected' : ''}>tagged only</option>` +
        `<option value="untagged-only"${member.acceptableFrameTypes === 'untagged-only' ? ' selected' : ''}>untagged only</option>` +
        `</select></label>`,
    );
    if (!vlanBlind) {
      // The per-port admission rule bridge.ts enforces at ingress (#69) -
      // live only when membership can actually reject, i.e. vlanAware.
      rows.push(
        `<label>Ingress filtering ` +
          `<input type="checkbox" data-port="${esc(portId)}" data-action="ingress-filtering"` +
          `${member.ingressFiltering ? ' checked' : ''}></label>`,
      );
    }
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
    `<button type="button" data-action="remove" data-device="${esc(chassis.id)}">` +
      `Remove</button>`,
  );
  const free = freePorts(state.topology, chassis);
  if (free.length > 0) {
    parts.push('<fieldset class="link-ports"><legend>Link from port</legend>');
    for (const portId of free) {
      parts.push(
        `<button type="button" data-action="start-link" data-device="${esc(chassis.id)}" ` +
          `data-port="${esc(portId)}">Start link (${esc(portId)})</button>`,
      );
    }
    parts.push('</fieldset>');
  }
  const routing = chassis.functions.find((fn) => fn.kind === 'routing');
  if (routing && routing.kind === 'routing') {
    for (const iface of routing.ifaces) {
      // The SVI composition (issue #71) is one mechanism: an rt-owned port
      // that is also a bridging member of its VLAN. The generic
      // sub-interface VLAN input would move iface.vlan alone and leave the
      // bridging member behind, silently breaking the composition (#83),
      // so SVI-shaped ifaces render no independent control. Every bridging
      // function is checked, not just the first (#87).
      const port = chassis.ports.find((item) => item.id === iface.id);
      const isSvi =
        port !== undefined &&
        port.ownedBy === routing.id &&
        chassis.functions.some(
          (fn) =>
            fn.kind === 'bridging' &&
            fn.members.some((member) => member.port === iface.id),
        );
      if (isSvi) continue;
      const label = iface.id === 'wan' ? 'WAN VLAN' : `VLAN (${iface.id})`;
      parts.push(
        `<label>${esc(label)} ` +
          `<input type="number" data-action="iface-vlan" data-iface="${esc(iface.id)}" ` +
          `value="${iface.vlan ?? ''}"></label>`,
      );
    }
  }
  const isp = chassis.functions.find((fn) => fn.kind === 'isp-handoff');
  if (isp && isp.kind === 'isp-handoff') {
    const mode = isp.mode === 'pppoe' ? 'PPPoE' : isp.mode.toUpperCase();
    const vlan = isp.vlanTag !== undefined ? `VLAN ${isp.vlanTag}` : 'no VLAN';
    parts.push(
      `<p class="isp-check">ISP check: ${esc(mode)}, required ${esc(vlan)}</p>`,
    );
  }
  // STP priority renders only for a chassis that HAS an stp function -
  // function presence, not preset id (#69). An unmanaged switch has no stp
  // function and stays bare (#67).
  const stp = chassis.functions.find((fn) => fn.kind === 'stp');
  if (stp && stp.kind === 'stp') {
    parts.push(
      `<label>STP priority ` +
        `<input type="number" step="4096" min="0" max="61440" data-action="stp-priority" ` +
        `value="${stp.priority}"></label>`,
    );
  }
  // One note per VLAN-blind bridge, not per port or per chassis: each
  // bridge states its own member count - the broadcast domain it actually
  // forms (#97). A zero-member VLAN-blind bridge renders no note: "all 0
  // ports are one broadcast domain" states nothing. A drop is an outcome,
  // and this device is the lesson of row 5 (#67, ADR 0007).
  for (const fn of chassis.functions) {
    if (fn.kind !== 'bridging' || fn.vlanAware) continue;
    if (fn.members.length === 0) continue;
    parts.push(
      `<p class="hint">This switch has no VLAN awareness - all ${fn.members.length} ` +
        `ports are one broadcast domain. No configurable per-port VLAN ` +
        `membership (ADR 0007).</p>`,
    );
  }
  const dhcpServer = chassis.functions.find(
    (fn) => fn.kind === 'dhcp-server',
  );
  if (dhcpServer && dhcpServer.kind === 'dhcp-server') {
    dhcpServer.scopes.forEach((scope, index) => {
      const fields: [keyof typeof scope, 'number' | 'text'][] = [
        ['vlan', 'number'],
        ['poolStart', 'text'],
        ['poolEnd', 'text'],
        ['gateway', 'text'],
        ['resolver', 'text'],
      ];
      const rows = fields
        .map(
          ([field, type]) =>
            `<label>${esc(field)} ` +
            `<input type="${type}" data-action="scope-field" data-scope="${index}" ` +
            `data-field="${esc(field)}" value="${esc(String(scope[field]))}"></label>`,
        )
        .join('\n');
      parts.push(
        `<fieldset class="dhcp-scope"><legend>DHCP scope ${index + 1}</legend>${rows}</fieldset>`,
      );
    });
  }
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
  );
  // ADR 0002: the trace is the answer — no summary verdict line. The
  // delivered/dropped sentences and the flow notes already name the result.
  return parts.join('\n');
}
