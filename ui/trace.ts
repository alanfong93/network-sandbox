import {
  createRunContext,
  flowObservationAsFormatInput,
  format,
  observationAsFormatInput,
  runFlow,
  warningAsFormatInput,
} from '../src/index';
import type { DeviceId, Flow, Hop, Topology } from '../src/index';

/**
 * The cold-cache precondition is user-visible, not an implementation footnote
 * (ADR 0010): the ARP exchange at the top of every ICMP trace is correct here.
 * A DHCP DISCOVER has no ARP leg (broadcast, needsArp false), so its notice
 * names what actually runs cold instead - the FDB every flood consults.
 */
export const COLD_TRACE_NOTICE =
  'Every trace starts cold: the ARP exchange below runs fresh on each send. ' +
  'There is no ARP cache and nothing carries between traces, so this is ' +
  'correct here, not a bug.';

export const COLD_DISCOVER_NOTICE =
  'Every trace starts cold: the MAC tables consulted by the flood below are ' +
  'fresh on each send, so the broadcast reaches every member. Nothing ' +
  'carries between traces - this is correct here, not a bug.';

export const COLD_DISCOVER_DIRECT_NOTICE =
  'Every trace starts cold: the broadcast delivery below is computed fresh ' +
  'on each send. Nothing carries between traces - this is correct here, ' +
  'not a bug.';

/** SPEC: timers are not modelled — the limit belongs in the UI, not just in the spec. */
export const NO_TIMERS_NOTICE =
  'Timers are not modelled: the converged state is computed, so delays such ' +
  'as listening, learning and BPDU timeouts do not appear.';

export interface TraceRender {
  warnings: string[];
  request: string[];
  reply: string[];
  requestHops: Hop[];
  replyHops: Hop[];
  flowNotes: string[];
  notices: string[];
  outcome: Flow['outcome'];
  /**
   * Machine codes behind the sentences (#162): walk/flow observation codes
   * and run-context warning codes, so the AI payload can gate failure
   * catalogue rows on what the run actually produced instead of matching
   * prose. Sentences stay the only human surface.
   */
  observationCodes: string[];
  warningCodes: string[];
}

/**
 * Render one send as sentences. Hop sentences are the engine's own — the walk
 * produced them with `format()` at trace time — and observations and STP
 * warnings go through `format()` here. The UI never re-derives a sentence.
 *
 * Three origins (#126): an ICMP echo to a destination IP, a send-by-name —
 * the engine walks udp/53 to the advertised resolver, then pings the
 * resolved IP (ADR 0030) — or a DHCP DISCOVER, a broadcast that needs no
 * destination (#82). A DISCOVER trace is request-only: flow.ts early-returns
 * for non-ICMP payloads, so the hops (flood path, OFFERs) are the honest
 * as-shipped truth; the observation sentences render here, labelled by
 * phase (#63). A name send's request leg is the query walk, then the echo
 * walk; `flow.query` carries the query frame separately from the echo.
 */
export function runTrace(
  topology: Topology,
  args:
    | { from: DeviceId; dstIp: string }
    | { from: DeviceId; dstName: string }
    | { from: DeviceId; kind: 'dhcp-discover' },
): TraceRender {
  const ctx = createRunContext(topology);
  const warnings = ctx.warnings.map((warning) =>
    format(warningAsFormatInput(warning)),
  );
  const icmpArgs = 'dstIp' in args ? args : undefined;
  const nameArgs = 'dstName' in args ? args : undefined;
  const result =
    icmpArgs !== undefined
      ? runFlow(ctx, {
          from: icmpArgs.from,
          dstIp: icmpArgs.dstIp,
          payload: { kind: 'icmp' },
        })
      : nameArgs !== undefined
        ? // The name path reads the sender's advertised resolver itself;
          // the payload is ignored there - a name send is a ping (ADR 0030).
          runFlow(ctx, {
            from: nameArgs.from,
            dstIp: '',
            dstName: nameArgs.dstName,
            payload: { kind: 'icmp' },
          })
        : runFlow(ctx, {
            from: args.from,
            dstIp: '255.255.255.255',
            payload: { kind: 'dhcp', dhcpType: 'discover' },
          });
  // Every observation is the engine's own sentence via format() - walk
  // observations are labelled with the leg that produced them, flow
  // observations need no label (#63). Order is the runFlow contract:
  // request, then reply, then flow-level.
  const flowNotes = result.observations.map((entry) => {
    const sentence =
      entry.kind === 'walk'
        ? format(observationAsFormatInput(entry.observation))
        : format(flowObservationAsFormatInput(entry.observation));
    return entry.phase === 'flow'
      ? sentence
      : `${entry.phase[0]!.toUpperCase()}${entry.phase.slice(1)}: ${sentence}`;
  });
  const replyHops = result.flow.reply?.hops ?? [];
  // A name send's request leg is the query walk, then the echo walk: the
  // query frame's hops lead so the trace shows the resolver step in order
  // (ADR 0030). A dropped query means no echo walk exists and the request
  // section is the query alone.
  const requestHops = [
    ...(result.flow.query?.hops ?? []),
    ...result.flow.request.hops,
  ];
  const request = requestHops.map((hop) => hop.reason);
  return {
    warnings,
    request,
    requestHops,
    reply: replyHops.map((hop) => hop.reason),
    replyHops,
    flowNotes,
    observationCodes: result.observations.map(
      (entry) => entry.observation.observation,
    ),
    warningCodes: ctx.warnings.map((warning) => warning.observation),
    notices: [
      // The action token leads every formatted hop sentence, so 'flooded'
      // at line-start is a real flood; a device id merely CONTAINING
      // 'flood' (import preserves arbitrary ids) must not flip the
      // notice. A name send runs ARP legs exactly like an IP trace.
      icmpArgs === undefined && nameArgs === undefined
        ? request.some((line) => /^flooded\b/.test(line))
          ? COLD_DISCOVER_NOTICE
          : COLD_DISCOVER_DIRECT_NOTICE
        : COLD_TRACE_NOTICE,
      NO_TIMERS_NOTICE,
    ],
    outcome: result.flow.outcome,
  };
}
