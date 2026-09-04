import {
  createRunContext,
  flowObservationAsFormatInput,
  format,
  runFlow,
  warningAsFormatInput,
} from '../src/index';
import type { DeviceId, Flow, Topology } from '../src/index';

/**
 * The cold-cache precondition is user-visible, not an implementation footnote
 * (ADR 0010): the ARP exchange at the top of every trace is correct here.
 */
export const COLD_TRACE_NOTICE =
  'Every trace starts cold: the ARP exchange below runs fresh on each send. ' +
  'There is no ARP cache and nothing carries between traces, so this is ' +
  'correct here, not a bug.';

/** SPEC: timers are not modelled — the limit belongs in the UI, not just in the spec. */
export const NO_TIMERS_NOTICE =
  'Timers are not modelled: the converged state is computed, so delays such ' +
  'as listening, learning and BPDU timeouts do not appear.';

export interface TraceRender {
  warnings: string[];
  request: string[];
  reply: string[];
  flowNotes: string[];
  notices: string[];
  outcome: Flow['outcome'];
}

/**
 * Render one send as sentences. Hop sentences are the engine's own — the walk
 * produced them with `format()` at trace time — and observations and STP
 * warnings go through `format()` here. The UI never re-derives a sentence.
 *
 * Two origins: an ICMP echo to a destination IP, or a DHCP DISCOVER — a
 * broadcast that needs no destination (#82). A DISCOVER trace is
 * request-only: flow.ts early-returns for non-ICMP payloads, so the hops
 * (flood path, OFFERs) are the honest as-shipped truth; the observation
 * sentences arrive with #63.
 */
export function runTrace(
  topology: Topology,
  args: { from: DeviceId; dstIp: string } | { from: DeviceId; kind: 'dhcp-discover' },
): TraceRender {
  const ctx = createRunContext(topology);
  const warnings = ctx.warnings.map((warning) =>
    format(warningAsFormatInput(warning)),
  );
  const discover = 'kind' in args && args.kind === 'dhcp-discover';
  const result = runFlow(ctx, {
    from: args.from,
    dstIp: discover ? '255.255.255.255' : (args as { dstIp: string }).dstIp,
    payload: discover
      ? { kind: 'dhcp', dhcpType: 'discover' }
      : { kind: 'icmp' },
  });
  const flowNotes = result.observations.map((observation) =>
    format(flowObservationAsFormatInput(observation)),
  );
  return {
    warnings,
    request: result.flow.request.hops.map((hop) => hop.reason),
    reply: result.flow.reply?.hops.map((hop) => hop.reason) ?? [],
    flowNotes,
    notices: [COLD_TRACE_NOTICE, NO_TIMERS_NOTICE],
    outcome: result.flow.outcome,
  };
}
