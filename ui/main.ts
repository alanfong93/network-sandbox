import type { DeviceId } from '../src/index';
import { parseIpv4 } from '../src/index';
import { divergentScopeWarning, exportSandbox, importSandbox } from './jsonio';
import { PRESETS } from './presets';
import { missingReturnRoute } from './starters';
import { fitContent, panCamera, screenDeltaToWorld, zoomAt, type Camera } from './camera';
import { contentSize, renderCanvas } from './canvas';
import { renderDeviceList, renderInspector, renderTrace } from './render';
import { autoPlace } from './layout';
import { allHops, stepIndex, tokenMarks } from './replay';
import {
  addFirewallRule,
  addPreset,
  addResolverRecord,
  cancelLink,
  completeLink,
  initialState,
  loadTopology,
  removeResolverRecord,
  select,
  setDhcpScope,
  setHostAddress,
  setIspHandoff,
  setNatOn,
  setPortAcceptable,
  setPortIngressFiltering,
  setPortMode,
  setPvid,
  setResolverRecord,
  setRouterIfaceVlan,
  setRouterPortCount,
  setStpPriority,
  setSwitchPortCount,
  setTaggedVlans,
  removeFirewallRule,
  setFirewallRule,
  setUntaggedVlans,
  setWirelessAp,
  startLink,
  placePreset,
  portOccupied,
  moveDevice,
  removeDevice,
  type EditorState,
} from './state';
import { runTrace, type TraceRender } from './trace';
import { traceFromId } from './tracefrom';
import {
  blankAiConfig,
  buildAiPayload,
  buildReviewMessages,
  fromAiJson,
  postChat,
  toAiJson,
  topologyFingerprint,
  type AiConfig,
  type AiMessage,
} from './ai';

let state: EditorState = initialState;
let didDrag = false;
let dragBox: {
  id: DeviceId;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  svg: SVGSVGElement;
} | null = null;
let sendFrom: DeviceId | null = null;
let camera: Camera | null = null;
let panView: {
  clientX: number;
  clientY: number;
  origin: Camera;
  svg: SVGSVGElement;
} | null = null;
let lastDst = '192.168.1.11';
// The draft keeps an unsent destination across re-renders (send-kind
// toggle, device adds) - render() rebuilds the form, and lastDst only
// records successful sends.
let dstIpDraft: string | null = null;
let sendKind: 'icmp' | 'dhcp-discover' = 'icmp';
// The optional AI review path (#162, ADR 0033). aiConfig lives in this tab
// only, never in sandbox JSON; aiPreview holds the exact outbound payload
// between Review and Confirm; aiConversation is the frozen snapshot chat
// (the payload message is turn 1 and never changes); aiReviewedFingerprint
// blocks chat after any topology edit until Review runs again.
let aiConfig: AiConfig | null = null;
let aiPreview: { text: string; messages: AiMessage[]; fingerprint: string } | null = null;
let aiConversation: AiMessage[] | null = null;
let aiReviewedFingerprint: string | null = null;
let aiBusy = false;

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

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function aiErrorText(error: unknown): string {
  if (error instanceof Error && error.name !== 'Error') {
    return `${error.name} — ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The optional AI panel. Advice is visually and semantically separate from
 * the hop trace (ADR 0002, ADR 0033): its own heading, its own styling, and
 * a label that says what it is. Nothing here renders before a config is
 * loaded, and the endpoint is shown on load — before any request could use
 * the key (#162 Watch lines).
 */
function renderAiPanel(): string {
  const head = '<h2>AI review (optional)</h2>';
  if (!aiConfig) {
    return (
      head +
      '<p class="hint">Optional. Nothing is sent anywhere until you load an ' +
      'AI config and confirm a review. The config file holds your own ' +
      'endpoint, model and key — it is never part of sandbox JSON.</p>' +
      '<button type="button" data-action="ai-template">Download blank AI config</button> ' +
      '<label class="file">Load AI config <input type="file" id="ai-file" accept=".json,application/json"></label>'
    );
  }
  let body =
    head +
    `<p class="ai-loaded">Loaded — endpoint <code>${esc(aiConfig.endpoint || '(empty)')}</code>` +
    `, model <code>${esc(aiConfig.model || '(empty)')}</code></p>` +
    '<button type="button" data-action="ai-export">Save AI config</button> ' +
    '<button type="button" data-action="ai-unload">Unload (drops the key)</button> ' +
    '<button type="button" data-action="ai-review">Review with AI</button>';
  if (aiBusy) {
    body += '<p class="notice">Contacting the endpoint…</p>';
  }
  if (aiPreview) {
    body +=
      '<p class="hint">Preview — Confirm sends exactly this JSON to the ' +
      'endpoint. ISP credentials are stripped; the API key is not in it.</p>' +
      `<textarea id="ai-preview" readonly>${esc(aiPreview.text)}</textarea>` +
      '<button type="button" data-action="ai-confirm">Confirm and send</button> ' +
      '<button type="button" data-action="ai-cancel">Cancel</button>';
  }
  if (aiConversation) {
    const stale =
      aiReviewedFingerprint !== null &&
      aiReviewedFingerprint !== topologyFingerprint(state.topology);
    const turns = aiConversation
      .filter((message) => message.role !== 'system')
      .map((message) => {
        const who = message.role === 'user' ? 'You (snapshot)' : 'AI advice';
        return `<div class="ai-turn"><span class="ai-who">${who}</span>${esc(message.content)}</div>`;
      })
      .join('\n');
    body +=
      '<div class="ai-advice">' +
      '<h3>AI advice — not a trace</h3>' +
      turns +
      '</div>';
    if (stale) {
      body +=
        '<p class="notice">Topology changed since the review — Review with ' +
        'AI again before asking more.</p>';
    } else {
      body +=
        '<form id="ai-chat-form"><input type="text" name="msg" ' +
        'placeholder="Ask about the reviewed topology" autocomplete="off">' +
        '<button type="submit">Ask</button></form>' +
        '<p class="hint">Follow-ups use the reviewed snapshot. Editing the ' +
        'topology blocks chat until Review again.</p>';
    }
  }
  return body;
}

function render(): void {
  const palette = document.querySelector<HTMLDivElement>('#palette');
  const stage = document.querySelector<HTMLElement>('#stage');
  const inspector = document.querySelector<HTMLDivElement>('#inspector');
  const trace = document.querySelector<HTMLDivElement>('#trace');
  if (!palette || !stage || !inspector || !trace) return;

  palette.innerHTML =
    '<h2>Palette</h2>' +
    PRESETS.map(
      (preset) =>
        `<button type="button" class="preset" data-action="add" ` +
        `data-preset="${esc(preset.id)}" draggable="true">${esc(preset.label)}</button>`,
    ).join(' ');

  const hops = lastTrace ? allHops(lastTrace) : [];
  const tokens = lastTrace
    ? tokenMarks(hops, replayIndex, state.topology, state.layout)
    : [];
  const linking = state.pendingLink
    ? `<p class="linking">Linking from <strong>${esc(state.pendingLink.device)}` +
      `:${esc(state.pendingLink.port)}</strong> &mdash; click another port, ` +
      `or <button type="button" data-action="cancel-link">Cancel</button></p>`
    : '';
  const size = contentSize(state);
  if (!camera) camera = fitContent(size.maxX, size.maxY);
  stage.innerHTML =
    '<p class="camera-bar"><button type="button" data-action="fit-camera">Fit</button> ' +
    '<span class="hint">wheel zoom, drag empty space to pan</span></p>' +
    renderCanvas(state, tokens, camera, { playing: replayTimer !== null }) +
    linking +
    '<h2>Devices</h2>' +
    renderDeviceList(state) +
    '<h3>Links</h3>' +
    renderLinks(state) +
    (state.notice ? `<p class="notice">${esc(state.notice)}</p>` : '');

  inspector.innerHTML = renderInspector(state);

  const fromId = traceFromId(state.selected, sendFrom, state.topology.devices);
  const options =
    state.topology.devices.length > 0
      ? state.topology.devices
          .map(
            (device) =>
              `<option value="${esc(device.id)}"` +
              `${device.id === fromId ? ' selected' : ''}>` +
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
    // (#82). The ICMP path keeps its destination input untouched. The
    // field accepts an IP or a name (#126): a dotted quad goes by IP,
    // anything else is a name and walks the resolver first (ADR 0030).
    (sendKind === 'icmp'
      ? '<label>Destination (IP or name) ' +
        `<input type="text" name="dstIp" value="${esc(dstIpDraft ?? lastDst)}"></label> `
      : '') +
    '<button type="submit">Send</button></form>' +
    '<div id="trace-out"></div>' +
    '<h2>Sandbox JSON</h2>' +
    '<button type="button" data-action="export">Export file</button> ' +
    '<button type="button" data-action="load-starter">Load missing-return-route starter</button> ' +
    '<label class="file">Import <input type="file" id="import-file" accept=".json,application/json"></label>' +
    '<textarea id="json-view" readonly placeholder="Exported sandbox JSON appears here"></textarea>' +
    renderAiPanel();

  const out = document.querySelector<HTMLDivElement>('#trace-out');
  if (out && lastTrace) {
    out.innerHTML =
      '<div class="replay">' +
      '<button type="button" data-action="replay-back">Step back</button> ' +
      '<button type="button" data-action="replay-step">Step</button> ' +
      '<button type="button" data-action="replay-play">Play</button> ' +
      '<button type="button" data-action="replay-pause">Pause</button>' +
      '</div>' +
      renderTrace(lastTrace, replayIndex);
  }
}

let lastTrace: TraceRender | null = null;
let replayIndex = 0;
let replayTimer: ReturnType<typeof setInterval> | null = null;

function stopReplay(): void {
  if (replayTimer !== null) {
    clearInterval(replayTimer);
    replayTimer = null;
  }
}

function send(event: Event): void {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const from = (form.elements.namedItem('from') as HTMLSelectElement).value;
  if (!from) return;
  stopReplay();
  if (sendKind === 'dhcp-discover') {
    // A DISCOVER is broadcast (#82): no destination IP, request-only trace.
    lastTrace = runTrace(state.topology, { from, kind: 'dhcp-discover' });
  } else {
    // Trim before the guard: whitespace-only input would otherwise pass,
    // classify as a name, and fall through the engine's blank-name check
    // to a gateway ping the user never asked for (#126 review cycle 1).
    const dst = (form.elements.namedItem('dstIp') as HTMLInputElement)
      .value
      .trim();
    if (!dst) return;
    lastDst = dst;
    dstIpDraft = null;
    lastTrace = runTrace(
      state.topology,
      parseIpv4(dst) !== undefined ? { from, dstIp: dst } : { from, dstName: dst },
    );
  }
  replayIndex = 0;
  render();
  const out = document.querySelector<HTMLDivElement>('#trace-out');
  out?.scrollIntoView({ behavior: 'smooth' });
}

function exportJson(): void {
  const text = exportSandbox(state.topology, state.layout);
  downloadText('sandbox.json', text);
  const view = document.querySelector<HTMLTextAreaElement>('#json-view');
  if (view) view.value = text;
}

async function importJson(file: File): Promise<void> {
  try {
    const imported = importSandbox(await file.text());
    // Import-only limitation, named where the user meets it (#86): the
    // engine's standalone DHCP model is one VLAN (src/dhcp.ts), so a
    // multi-scope chassis answers on chassis.vlan only. Warn, never
    // reject - the topology is legal.
    const warning = divergentScopeWarning(imported.topology);
    state = loadTopology(imported.topology, imported.layout, warning);
    lastTrace = null;
    stopReplay();
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

async function importAiConfig(file: File): Promise<void> {
  try {
    aiConfig = fromAiJson(await file.text());
    // The endpoint is in front of the user before any request can use the
    // key (#162 Watch) — a swapped or hostile config file is visible now.
    aiPreview = null;
    aiConversation = null;
    aiReviewedFingerprint = null;
  } catch (error) {
    state = { ...state, notice: `AI config rejected: ${aiErrorText(error)}` };
  }
  render();
}

/** Review = build the share-safe payload and show it. No network yet. */
function aiReview(): void {
  if (!aiConfig) return;
  const payload = buildAiPayload(state.topology, lastTrace);
  const messages = buildReviewMessages(payload);
  aiPreview = {
    text: JSON.stringify(payload, null, 2),
    messages,
    fingerprint: topologyFingerprint(state.topology),
  };
  // A new review invalidates the old conversation: the snapshot it froze
  // is no longer the one on screen.
  aiConversation = null;
  aiReviewedFingerprint = null;
  render();
}

async function aiConfirm(): Promise<void> {
  if (!aiConfig || !aiPreview || aiBusy) return;
  aiBusy = true;
  render();
  try {
    const reply = await postChat(aiConfig, aiPreview.messages);
    aiConversation = [...aiPreview.messages, { role: 'assistant', content: reply }];
    aiReviewedFingerprint = aiPreview.fingerprint;
    aiPreview = null;
  } catch (error) {
    state = { ...state, notice: aiErrorText(error) };
  } finally {
    aiBusy = false;
    render();
  }
}

async function aiChatSend(form: HTMLFormElement): Promise<void> {
  if (!aiConfig || !aiConversation || aiBusy) return;
  const input = form.elements.namedItem('msg') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  if (topologyFingerprint(state.topology) !== aiReviewedFingerprint) {
    state = {
      ...state,
      notice: 'Topology changed since the review — Review with AI again',
    };
    render();
    return;
  }
  const next: AiMessage[] = [...aiConversation, { role: 'user', content: text }];
  aiBusy = true;
  input.value = '';
  aiConversation = next;
  render();
  try {
    const reply = await postChat(aiConfig, next);
    aiConversation = [...next, { role: 'assistant', content: reply }];
  } catch (error) {
    // The turn failed: drop it so the conversation is exactly what was sent.
    aiConversation = aiConversation.filter(
      (message) => message.role !== 'user' || message.content !== text,
    );
    state = { ...state, notice: aiErrorText(error) };
  } finally {
    aiBusy = false;
    render();
  }
}

function onClick(event: MouseEvent): void {
  if (didDrag) {
    didDrag = false;
    return;
  }
  const portEl = (event.target as Element).closest('.port');
  if (portEl) {
    const id = portEl.getAttribute('data-device');
    const port = portEl.getAttribute('data-port');
    if (id && port && !portOccupied(state.topology, id, port)) {
      if (
        state.pendingLink &&
        state.pendingLink.device === id &&
        state.pendingLink.port === port
      ) {
        return;
      }
      if (state.pendingLink) {
        state = completeLink(state, id, port);
      } else {
        state = startLink(state, id, port);
      }
      render();
    }
    return;
  }
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
    case 'record-add':
      if (device) state = addResolverRecord(state, device);
      break;
    case 'firewall-add':
      if (device) state = addFirewallRule(state, device);
      break;
    case 'firewall-remove': {
      const rule = target.dataset.rule;
      if (device && rule !== undefined) {
        state = removeFirewallRule(state, device, Number(rule));
      }
      break;
    }
    case 'record-remove': {
      const record = target.dataset.record;
      if (device && record !== undefined) {
        state = removeResolverRecord(state, device, Number(record));
      }
      break;
    }
    case 'fit-camera': {
      const size = contentSize(state);
      camera = fitContent(size.maxX, size.maxY);
      break;
    }
    case 'export':
      exportJson();
      return;
    case 'ai-template':
      downloadText('network-sandbox-ai.json', toAiJson(blankAiConfig()));
      return;
    case 'ai-export':
      if (aiConfig) downloadText('network-sandbox-ai.json', toAiJson(aiConfig));
      return;
    case 'ai-unload':
      aiConfig = null;
      aiPreview = null;
      aiConversation = null;
      aiReviewedFingerprint = null;
      state = { ...state, notice: 'AI config unloaded — the key is dropped from this tab' };
      break;
    case 'ai-review':
      aiReview();
      return;
    case 'ai-confirm':
      void aiConfirm();
      return;
    case 'ai-cancel':
      aiPreview = null;
      break;
    case 'load-starter':
      state = loadTopology(missingReturnRoute());
      lastTrace = null;
      stopReplay();
      sendFrom = null;
      break;
    case 'replay-step':
      if (lastTrace) {
        replayIndex = stepIndex(allHops(lastTrace).length, replayIndex, 1);
      }
      break;
    case 'replay-back':
      if (lastTrace) {
        replayIndex = stepIndex(allHops(lastTrace).length, replayIndex, -1);
      }
      break;
    case 'replay-play':
      stopReplay();
      // The Play pace. #122's chevron march period (0.35s, index.html) must
      // divide this evenly: each re-render restarts CSS animations, and a
      // whole number of cycles per step keeps the restart invisible.
      replayTimer = setInterval(() => {
        if (!lastTrace) {
          stopReplay();
          return;
        }
        const hops = allHops(lastTrace);
        const next = stepIndex(hops.length, replayIndex, 1);
        if (next === replayIndex) {
          stopReplay();
          return;
        }
        replayIndex = next;
        render();
      }, 700);
      return;
    case 'replay-pause':
      stopReplay();
      break;
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
    case 'acceptable':
      if (port) {
        state = setPortAcceptable(
          state,
          device,
          port,
          input.value as 'all' | 'tagged-only' | 'untagged-only',
        );
      }
      break;
    case 'ingress-filtering':
      if (port) {
        state = setPortIngressFiltering(
          state,
          device,
          port,
          (input as HTMLInputElement).checked,
        );
      }
      break;
    case 'switch-ports':
      state = setSwitchPortCount(state, device, Number(input.value));
      break;
    case 'router-lan-count': {
      // Blank is a no-op, not a silent count-0 commit (#95 pattern).
      const raw = input.value.trim();
      if (raw === '') break;
      state = setRouterPortCount(state, device, 'lan', Number(raw));
      break;
    }
    case 'router-wan-count': {
      const raw = input.value.trim();
      if (raw === '') break;
      state = setRouterPortCount(state, device, 'wan', Number(raw));
      break;
    }
    case 'stp-priority': {
      // A cleared number input reports '' and Number('') is 0 - without
      // this guard, blanking the field would silently commit priority 0,
      // the root-guaranteeing value (#95 review). Treat blank as no-op.
      const raw = input.value.trim();
      if (raw === '') break;
      state = setStpPriority(state, device, Number(raw));
      break;
    }
    case 'nat-on':
      state = setNatOn(state, device, (input as HTMLInputElement).checked);
      break;
    case 'isp-mode':
      state = setIspHandoff(state, device, {
        mode: input.value as 'pppoe' | 'dhcp' | 'static',
      });
      break;
    case 'isp-vlan-tag': {
      // Blank clears the tag (a no-tag handoff); a number sets it. The
      // setter validates the range (#68).
      const raw = input.value.trim();
      state = setIspHandoff(state, device, {
        vlanTag: raw === '' ? undefined : Number(raw),
      });
      break;
    }
    case 'wireless-ssid': {
      const fn = input.dataset.fn;
      if (fn) state = setWirelessAp(state, device, fn, { ssid: input.value });
      break;
    }
    case 'wireless-vlan': {
      const fn = input.dataset.fn;
      const raw = input.value.trim();
      if (fn && raw !== '') {
        state = setWirelessAp(state, device, fn, { vlan: Number(raw) });
      }
      break;
    }
    case 'firewall-from':
    case 'firewall-to':
    case 'firewall-action': {
      const rule = input.dataset.rule;
      const raw = input.value.trim();
      if (device && rule !== undefined && raw !== '') {
        const index = Number(rule);
        if (action === 'firewall-action') {
          state = setFirewallRule(state, device, index, {
            action: raw as 'allow' | 'deny',
          });
        } else if (action === 'firewall-from') {
          state = setFirewallRule(state, device, index, { from: Number(raw) });
        } else {
          state = setFirewallRule(state, device, index, { to: Number(raw) });
        }
      }
      break;
    }
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
    case 'resolver':
      state = setHostAddress(state, device, { resolver: input.value });
      break;
    case 'record-field': {
      const record = input.dataset.record;
      const field = input.dataset.field;
      if (record !== undefined && (field === 'name' || field === 'ip')) {
        state = setResolverRecord(
          state,
          device,
          Number(record),
          { [field]: input.value },
        );
      }
      break;
    }
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
  if ((event.target as HTMLElement).id === 'ai-chat-form') {
    event.preventDefault();
    void aiChatSend(event.target as HTMLFormElement);
  }
});
document.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'send-from' && target.value) {
    sendFrom = target.value;
    state = select(state, target.value);
    render();
  }
  if (target.id === 'send-kind') {
    sendKind = target.value === 'dhcp-discover' ? 'dhcp-discover' : 'icmp';
    render();
  }
  if (target.id === 'import-file' && target.files?.[0]) {
    void importJson(target.files[0]);
  }
  if (target.id === 'ai-file' && target.files?.[0]) {
    void importAiConfig(target.files[0]);
  }
});

// Preserve the unsent destination draft across form re-renders: render()
// rebuilds the input, so without this the send-kind toggle (or any other
// re-render) would silently revert the field to the last SENT value.
document.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.name === 'dstIp') dstIpDraft = target.value;
});

function clientToSvg(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const matrix = svg.getScreenCTM();
  if (!matrix) return { x: clientX, y: clientY };
  const loc = pt.matrixTransform(matrix.inverse());
  return { x: loc.x, y: loc.y };
}

document.addEventListener('dragstart', (event) => {
  const btn = (event.target as Element).closest('.preset');
  const preset = btn?.getAttribute('data-preset');
  if (preset) event.dataTransfer?.setData('text/plain', preset);
});
document.addEventListener('dragover', (event) => {
  if ((event.target as Element).closest('.canvas-svg')) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  const svg = (event.target as Element).closest('svg.canvas-svg');
  if (!(svg instanceof SVGSVGElement)) return;
  event.preventDefault();
  const preset = event.dataTransfer?.getData('text/plain');
  if (!preset) return;
  state = placePreset(state, preset, clientToSvg(svg, event.clientX, event.clientY));
  render();
});

document.addEventListener(
  'wheel',
  (event) => {
    const svg = (event.target as Element).closest('svg.canvas-svg');
    if (!(svg instanceof SVGSVGElement) || !camera) return;
    event.preventDefault();
    const world = clientToSvg(svg, event.clientX, event.clientY);
    camera = zoomAt(camera, world.x, world.y, event.deltaY > 0 ? 1.12 : 0.88);
    render();
  },
  { passive: false },
);

document.addEventListener('pointerdown', (event) => {
  if ((event.target as Element).closest('.port')) return;
  const g = (event.target as Element).closest('.device[data-device]');
  if (!g || !g.closest('.canvas-svg')) {
    const svg = (event.target as Element).closest('svg.canvas-svg');
    if (svg instanceof SVGSVGElement && camera && !g) {
      panView = {
        clientX: event.clientX,
        clientY: event.clientY,
        origin: camera,
        svg,
      };
    }
    return;
  }
  const svg = g.closest('svg.canvas-svg');
  if (!(svg instanceof SVGSVGElement)) return;
  const id = g.getAttribute('data-device');
  if (!id) return;
  const display = { ...autoPlace(state.topology), ...(state.layout ?? {}) };
  const origin = display[id] ?? { x: 0, y: 0 };
  const start = clientToSvg(svg, event.clientX, event.clientY);
  dragBox = {
    id,
    startX: start.x,
    startY: start.y,
    origX: origin.x,
    origY: origin.y,
    svg,
  };
  didDrag = false;
});
document.addEventListener('pointermove', (event) => {
  if (panView && camera) {
    const svg = panView.svg;
    const delta = screenDeltaToWorld(
      panView.origin,
      event.clientX - panView.clientX,
      event.clientY - panView.clientY,
      Math.max(1, svg.clientWidth),
      Math.max(1, svg.clientHeight),
    );
    camera = panCamera(panView.origin, delta.x, delta.y);
    render();
    const next = document.querySelector('svg.canvas-svg');
    if (next instanceof SVGSVGElement) panView.svg = next;
    return;
  }
  if (!dragBox) return;
  const now = clientToSvg(dragBox.svg, event.clientX, event.clientY);
  const dx = now.x - dragBox.startX;
  const dy = now.y - dragBox.startY;
  if (Math.hypot(dx, dy) > 2) didDrag = true;
  state = moveDevice(state, dragBox.id, {
    x: dragBox.origX + dx,
    y: dragBox.origY + dy,
  });
  render();
  const svg = document.querySelector('svg.canvas-svg');
  if (svg instanceof SVGSVGElement && dragBox) dragBox.svg = svg;
});
document.addEventListener('pointerup', () => {
  dragBox = null;
  panView = null;
});

render();
