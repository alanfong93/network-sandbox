import type { FlowInput, HopFacts } from './format';
import type { DeviceId, Flow, Frame, FramePayload, Hop, Topology } from './model';
import type { RunContext } from './run';
import { send, senderVlan, type SendArgs } from './send';

export type FlowArgs = SendArgs;

export interface FlowObservation {
  observation: FlowInput['observation'];
  facts: HopFacts;
}

export interface FlowResult {
  flow: Flow;
  observations: FlowObservation[];
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

function deliveryDevice(hops: Hop[]): DeviceId | undefined {
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (hop?.step === 'delivery' && hop.action === 'delivered') return hop.device;
  }
  return undefined;
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
 * One flow: the request, then — if it was delivered — the ICMP reply, against
 * the same run context so the return walk reads the tables the request built.
 */
export function runFlow(ctx: RunContext, args: FlowArgs): FlowResult {
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
      observations: [],
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
      observations: [],
    };
  }

  const replyWalk = send(ctx, {
    from: dest,
    dstIp: srcIp,
    payload: {
      kind: 'icmp',
      srcIp: args.dstIp,
      dstIp: srcIp,
    },
  });
  const destChassis = ctx.topology.devices.find((item) => item.id === dest);
  const reply = asFrame(
    destChassis?.mac ?? '00:00:00:00:00:00',
    { kind: 'icmp', srcIp: args.dstIp, dstIp: srcIp },
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

  return { flow, observations };
}
