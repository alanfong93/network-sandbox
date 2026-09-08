import type { FlowInput, HopFacts } from './format';
import { formatPrefix } from './ip';
import type { DeviceId, Flow, Frame, FramePayload, Hop, Topology } from './model';
import type { RunContext } from './run';
import { lookupRecord } from './resolver';
import { originate, send, senderVlan, type SendArgs } from './send';
import type { WalkObservation } from './walk';

/** A name send adds the destination name; the walk itself stays an IP send. */
export type FlowArgs = SendArgs & { dstName?: string };

export interface FlowObservation {
  observation: FlowInput['observation'];
  facts: HopFacts;
}

/** Where an observation came from: the request walk, the reply walk, or
 * the flow-level analysis. Part of the ordering contract (#63). */
export type FlowPhase = 'request' | 'reply' | 'flow';

export type FlowResultObservation =
  | {
      phase: 'request' | 'reply';
      kind: 'walk';
      observation: WalkObservation;
    }
  | { phase: 'flow'; kind: 'flow'; observation: FlowObservation };

export interface FlowResult {
  flow: Flow;
  /**
   * Ordering contract (#63): the request walk's observations (in walk
   * order), then the reply walk's (in walk order), then the flow-level
   * observations. Renderers must not reorder.
   */
  observations: FlowResultObservation[];
}

export function flowObservationAsFormatInput(obs: FlowObservation): FlowInput {
  return { kind: 'flow', observation: obs.observation, facts: obs.facts };
}

function payloadOf(args: FlowArgs, srcIp: string | undefined): FramePayload {
  return {
    ...args.payload,
    srcIp: args.payload.srcIp ?? srcIp,
    dstIp: args.payload.dstIp ?? args.dstIp,
  };
}

function asFrame(
  srcMac: string,
  payload: FramePayload,
  hops: Hop[],
  dstMac?: string,
): Frame {
  return {
    srcMac,
    dstMac: dstMac ?? '00:00:00:00:00:00',
    vlan: null,
    size: 64,
    encapsulation: ['ethernet'],
    payload,
    hops,
  };
}

function phaseOf(
  phase: 'request' | 'reply',
  observations: WalkObservation[],
): FlowResultObservation[] {
  return observations.map((observation) => ({
    phase,
    kind: 'walk',
    observation,
  }));
}

function deliveryDevice(hops: Hop[]): DeviceId | undefined {
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (hop?.step === 'delivery' && hop.action === 'delivered') return hop.device;
  }
  return undefined;
}

function flowObs(observation: FlowObservation): FlowResultObservation {
  return { phase: 'flow', kind: 'flow', observation };
}

function routedPath(hops: Hop[], topology: Topology): DeviceId[] {
  const routers = new Set(
    topology.devices
      .filter((device) => device.functions.some((fn) => fn.kind === 'routing'))
      .map((device) => device.id),
  );
  const out: DeviceId[] = [];
  for (const hop of hops) {
    if (!routers.has(hop.device)) continue;
    if (hop.step !== 'route-lookup' || hop.action !== 'forwarded') continue;
    if (out[out.length - 1] !== hop.device) out.push(hop.device);
  }
  return out;
}

function sameSeq(a: readonly DeviceId[], b: readonly DeviceId[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

function firewallDrop(hops: Hop[]): Hop | undefined {
  return hops.find((hop) => hop.step === 'firewall' && hop.action === 'dropped');
}

/**
 * One flow. With `dstName` this is send-by-name (ADR 0030): a udp/53 walk to
 * the sender's advertised resolver first, the table lookup on the chassis the
 * query reached, then the ICMP leg to the resolved IP. Without it, the ICMP
 * echo walk. Both run against one context so later legs read the tables the
 * earlier ones built.
 */
export function runFlow(ctx: RunContext, args: FlowArgs): FlowResult {
  const name = args.dstName?.trim();
  if (name) return runNamedFlow(ctx, args, name);
  return runIcmpFlow(ctx, args);
}

function runIcmpFlow(ctx: RunContext, args: FlowArgs): FlowResult {
  const sender = ctx.topology.devices.find((item) => item.id === args.from);
  const requestPayload = payloadOf(args, sender?.ip);
  const requestWalk = send(ctx, args);
  const dest = deliveryDevice(requestWalk.hops);
  const request = asFrame(
    sender?.mac ?? '00:00:00:00:00:00',
    requestPayload,
    requestWalk.hops,
    args.dstMac,
  );

  if (dest === undefined) {
    return {
      flow: {
        id: `${args.from}:${args.dstIp}`,
        request,
        outcome: 'request-failed',
      },
      observations: phaseOf('request', requestWalk.observations),
    };
  }

  const srcIp = requestPayload.srcIp;
  if (srcIp === undefined || requestPayload.kind !== 'icmp') {
    return {
      flow: {
        id: `${args.from}:${args.dstIp}`,
        request,
        outcome: 'round-trip',
      },
      observations: phaseOf('request', requestWalk.observations),
    };
  }

  const seenSrc = requestWalk.deliveredFrame?.payload.srcIp ?? srcIp;
  // The reply's sender is the chassis the request was delivered at. When
  // that is a routing chassis there is no host identity to send() with, so
  // the reply originates through the router's own routing function (#129).
  const replyWalk = originate(ctx, {
    from: dest,
    dstIp: seenSrc,
    payload: {
      kind: 'icmp',
      srcIp: args.dstIp,
      dstIp: seenSrc,
    },
  });
  const destChassis = ctx.topology.devices.find((item) => item.id === dest);
  const reply = asFrame(
    destChassis?.mac ?? '00:00:00:00:00:00',
    { kind: 'icmp', srcIp: args.dstIp, dstIp: seenSrc },
    replyWalk.hops,
  );
  const returned = deliveryDevice(replyWalk.hops) !== undefined;
  const outcome = returned ? 'round-trip' : 'reply-failed';
  const requestPath = routedPath(requestWalk.hops, ctx.topology);
  const returnPath = routedPath(replyWalk.hops, ctx.topology);
  const asymmetric =
    outcome === 'round-trip' &&
    requestPath.length > 0 &&
    returnPath.length > 0 &&
    !sameSeq(requestPath, [...returnPath].reverse());

  const observations: FlowObservation[] = [];
  const drop = firewallDrop(replyWalk.hops);
  if (outcome === 'reply-failed' && drop) {
    observations.push({
      observation: 'firewall-reply',
      facts: {
        reachedVlan: senderVlan(ctx.topology, dest),
        fromVlan: drop.vlan ?? senderVlan(ctx.topology, dest),
        toVlan: senderVlan(ctx.topology, args.from),
      },
    });
  }
  const routeDrop = replyWalk.hops.find(
    (hop) => hop.step === 'route-lookup' && hop.action === 'dropped',
  );
  if (outcome === 'reply-failed' && !drop && routeDrop) {
    const via = [...requestPath].reverse().find((id) => id !== routeDrop.device);
    observations.push({
      observation: 'missing-return-route',
      facts: {
        otherIp: args.dstIp,
        via,
        ip: srcIp,
        devices: [routeDrop.device],
        prefix:
          sender?.prefix !== undefined
            ? formatPrefix(srcIp, sender.prefix)
            : undefined,
      },
    });
  }
  if (asymmetric) {
    observations.push({
      observation: 'asymmetric-path',
      facts: { path: requestPath, returnPath },
    });
  }

  const flow: Flow = {
    id: `${args.from}:${args.dstIp}`,
    request,
    reply,
    outcome,
  };
  if (asymmetric) flow.asymmetric = true;

  return {
    flow,
    observations: [
      ...phaseOf('request', requestWalk.observations),
      ...phaseOf('reply', replyWalk.observations),
      ...observations.map((observation) => ({
        phase: 'flow' as const,
        kind: 'flow' as const,
        observation,
      })),
    ],
  };
}

/**
 * Send-by-name (ADR 0030). The query is still a frame on the 802.1Q path: a
 * udp/53 service walk to the sending chassis' advertised resolver. The table
 * answers only after delivery — the record is looked up on the chassis the
 * query reached. A delivered record feeds the ICMP leg; a query that never
 * arrives, a sender with no advertised resolver, and a table without the
 * name each stop the flow there. Ping-by-IP never consults the table.
 */
function runNamedFlow(
  ctx: RunContext,
  args: FlowArgs,
  name: string,
): FlowResult {
  const sender = ctx.topology.devices.find((item) => item.id === args.from);
  const resolverIp = sender?.resolver;
  const queryPayload: FramePayload = {
    kind: 'service',
    proto: 'udp',
    dstPort: 53,
    name,
    srcIp: sender?.ip,
  };
  const flowId = `${args.from}:${name}`;
  const queryFrame = asFrame(
    sender?.mac ?? '00:00:00:00:00:00',
    queryPayload,
    [],
  );

  if (resolverIp === undefined) {
    return {
      flow: { id: flowId, request: queryFrame, outcome: 'request-failed' },
      observations: [flowObs({ observation: 'no-resolver', facts: { name } })],
    };
  }

  const walkedPayload: FramePayload = { ...queryPayload, dstIp: resolverIp };
  const queryWalk = send(ctx, {
    from: args.from,
    dstIp: resolverIp,
    payload: walkedPayload,
  });
  const walkedQuery = asFrame(
    sender?.mac ?? '00:00:00:00:00:00',
    walkedPayload,
    queryWalk.hops,
  );
  const queryPhase = phaseOf('request', queryWalk.observations);
  const deliveredAt = deliveryDevice(queryWalk.hops);

  if (deliveredAt === undefined) {
    return {
      flow: { id: flowId, request: walkedQuery, outcome: 'request-failed' },
      observations: queryPhase,
    };
  }

  const table = ctx.topology.devices.find((item) => item.id === deliveredAt);
  const record = table ? lookupRecord(table, name) : undefined;
  if (record === undefined) {
    return {
      flow: { id: flowId, request: walkedQuery, outcome: 'request-failed' },
      observations: [
        ...queryPhase,
        flowObs({
          observation: 'no-record',
          facts: { name, devices: [deliveredAt] },
        }),
      ],
    };
  }

  const resolved = runIcmpFlow(ctx, {
    from: args.from,
    dstIp: record,
    payload: { kind: 'icmp' },
  });
  return {
    flow: { ...resolved.flow, id: flowId, query: walkedQuery },
    observations: [...queryPhase, ...resolved.observations],
  };
}
