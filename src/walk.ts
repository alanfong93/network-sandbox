import { bridgeFrame } from './bridge';
import { standaloneDhcpDecision } from './dhcp';
import { usableMtu } from './defaults';
import { format, type HopFacts, type TraceInput } from './format';
import { makeHop } from './hop';
import { handleHost, hostWouldHandle } from './host';
import { handoffFrame, handoffWouldHandle } from './isp';
import {
  isGroupMac,
  type Chassis,
  type DeviceId,
  type Fn,
  type FnId,
  type Frame,
  type Hop,
  type Topology,
  type VlanId,
} from './model';
import { reasonCode } from './reasons';
import { routingWouldHandle, routeFrame } from './route';
import { lookup, portState, type RunContext } from './run';
import { classifyWireless, wirelessWouldHandle } from './wireless';

export interface WalkArgs {
  device: DeviceId;
  inPort: string;
  frame: Frame;
  arrivedFrom?: DeviceId;
}

export interface WalkObservation {
  observation: TraceInput['observation'];
  facts: HopFacts;
}

export interface WalkResult {
  hops: Hop[];
  observations: WalkObservation[];
  deliveredFrame?: Frame;
}

interface Job {
  device: DeviceId;
  inPort: string;
  frame: Frame;
  arrivedFrom?: DeviceId;
  dispatchFn?: FnId;
}

function chassisOf(ctx: RunContext, id: DeviceId): Chassis | undefined {
  return ctx.topology.devices.find((item) => item.id === id);
}

function portFn(
  chassis: Chassis,
  portId: string,
  dispatchFn?: FnId,
): Fn | undefined {
  if (dispatchFn) return chassis.functions.find((item) => item.id === dispatchFn);
  const port = chassis.ports.find((item) => item.id === portId);
  if (!port) return undefined;
  return chassis.functions.find((item) => item.id === port.ownedBy);
}

export function peerOf(
  topology: Topology,
  device: DeviceId,
  port: string,
): { device: DeviceId; port: string } | undefined {
  for (const link of topology.links) {
    if (link.up === false) continue;
    if (link.a.device === device && link.a.port === port) return link.b;
    if (link.b.device === device && link.b.port === port) return link.a;
  }
  return undefined;
}

function makeBudgetHop(job: Job): Hop {
  const step = 'hop-budget' as const;
  const outcome = 'dropped' as const;
  const action = 'dropped' as const;
  const reason = format({
    kind: 'hop',
    device: job.device,
    inPort: job.inPort,
    vlan: job.frame.vlan,
    action,
    step,
    outcome,
  });
  return {
    device: job.device,
    inPort: job.inPort,
    vlan: job.frame.vlan,
    action,
    step,
    reasonCode: reasonCode(step, outcome),
    reason,
  };
}

function chassisTakesLocal(
  chassis: Chassis,
  frame: Frame,
  vlan: VlanId | null,
): boolean {
  if (chassis.vlan !== undefined && chassis.vlan !== vlan) return false;
  return hostWouldHandle(chassis, frame);
}

/**
 * The classified VLAN applied to an internal dispatch frame — the same
 * shape wireless uses to hand a classified frame to the chassis bridge.
 */
function withVlan(frame: Frame, vlan: VlanId): Frame {
  const without: Frame['encapsulation'] = [];
  for (const layer of frame.encapsulation) {
    if (layer !== 'vlan-tag') without.push(layer);
  }
  const at = without.indexOf('ethernet');
  const next = [...without];
  next.splice(at === -1 ? next.length : at + 1, 0, 'vlan-tag');
  return { ...frame, vlan, encapsulation: next };
}

/**
 * SVI composition (issue #71): a routing function reachable from bridging
 * ports. Two narrow frame shapes are intercepted after bridge ingress
 * classification: an ARP for a routing iface's IP on that iface's VLAN, and
 * a frame addressed to a routing iface's MAC. The first reuses routeFrame's
 * ARP-reply shape (the SVI's MAC answers, not the chassis MAC); the second
 * hands the frame to routeFrame as if it arrived on the SVI — matchIface
 * resolves because RouterIface.id is the SVI's own id. Both reuse existing
 * pipeline steps; there is no new step and no new ReasonCode (ADR 0001).
 * Returns undefined when the frame is not one of the two shapes — the
 * caller bridges it exactly as before.
 */
function sviDecision(
  ctx: RunContext,
  chassis: Chassis,
  bridgeId: FnId,
  args: {
    device: DeviceId;
    inPort: string;
    vlan: VlanId | null;
    frame: Frame;
  },
):
  | {
      hops: Hop[];
      transmissions: { outPort: string; frame: Frame }[];
      internal?: { fn: FnId; frame: Frame; inPort?: string };
    }
  | undefined {
  const rt = chassis.functions.find(
    (item) => item.kind === 'routing' && item.id !== bridgeId,
  );
  if (rt?.kind !== 'routing') return undefined;
  if (args.vlan === null) return undefined;
  const iface = rt.ifaces.find((item) => item.vlan === args.vlan);
  if (!iface) return undefined;
  // The SVI must belong to THIS bridge: a chassis may carry more than one
  // bridging function, and a frame arriving on a different bridge's port is
  // that bridge's traffic — a VLAN number alone is not a bridge identity.
  // The check is the frame-stealing mitigation's second half.
  if (sviBridgeMember(chassis, rt.id, iface.id)?.bridgeId !== bridgeId) {
    return undefined;
  }

  if (
    args.frame.payload.kind === 'arp' &&
    isGroupMac(args.frame.dstMac) &&
    args.frame.payload.dstIp === iface.ip
  ) {
    const hop = makeHop({
      device: args.device,
      fn: rt.id,
      inPort: args.inPort,
      vlan: args.vlan,
      action: 'delivered',
      step: 'arp',
      outcome: 'delivered',
    });
    const reply: Frame = {
      srcMac: iface.mac,
      dstMac: args.frame.srcMac,
      vlan: args.vlan,
      size: args.frame.size,
      encapsulation: [...args.frame.encapsulation],
      payload: {
        kind: 'arp',
        srcIp: iface.ip,
        dstIp: args.frame.payload.srcIp,
      },
      hops: [...args.frame.hops, hop],
    };
    return {
      hops: [hop],
      transmissions: [{ outPort: args.inPort, frame: reply }],
    };
  }

  if (args.frame.dstMac === iface.mac) {
    // Internal dispatch onto the routing function at the SVI port — the
    // same mechanism wireless uses to reach the chassis bridge. The SVI
    // port's ownedBy is the routing fn and RouterIface.id is the SVI port
    // id, so matchIface resolves and the whole existing routing pipeline
    // (firewall, LPM, NAT) runs unchanged.
    return {
      hops: [],
      transmissions: [],
      internal: {
        fn: rt.id,
        frame: withVlan(args.frame, args.vlan),
        inPort: iface.id,
      },
    };
  }

  return undefined;
}

/**
 * The fallback host/standalone-server dispatch answers when the port's own
 * function cannot: a plain host takes frames addressed to it, and a chassis
 * with a dhcp-server function answers a same-VLAN DISCOVER (the routing path
 * keeps its own decideDhcp branch, so a routing chassis never runs both —
 * routing is checked before this fallback).
 */
function fallbackWouldHandle(chassis: Chassis, job: Job): boolean {
  if (standaloneDhcpDecision({
    device: job.device,
    chassis,
    inPort: job.inPort,
    frame: job.frame,
  }).action === 'respond') {
    return true;
  }
  return hostWouldHandle(chassis, job.frame);
}

function canHandle(ctx: RunContext, job: Job): boolean {
  const chassis = chassisOf(ctx, job.device);
  if (!chassis) return false;
  const fn = portFn(chassis, job.inPort, job.dispatchFn);
  if (fn?.kind === 'bridging') return true;
  if (fn?.kind === 'wireless') return wirelessWouldHandle(fn);
  if (fn?.kind === 'isp-handoff') return handoffWouldHandle(fn);
  if (fn?.kind === 'routing') {
    return routingWouldHandle(fn, job.inPort, job.frame);
  }
  return fallbackWouldHandle(chassis, job);
}

/**
 * True when the named port is a bridging member of this chassis whose port
 * entry is owned by the routing function — the SVI shape. The routed frame
 * egressing there re-enters the chassis bridge (InternalEdge rt→br) instead
 * of looking for a link the SVI does not have.
 */
function sviBridgeMember(
  chassis: Chassis,
  routingId: FnId,
  portId: string,
): { port: string; bridgeId: FnId } | undefined {
  const port = chassis.ports.find((item) => item.id === portId);
  if (!port || port.ownedBy !== routingId) return undefined;
  // Search every routing->fn edge: a chassis may carry more than one
  // bridging function and the routing function may be SVI-attached to
  // several of them. The SVI port belongs to whichever bridge carries it
  // as a member — not merely the first edge drawn.
  for (const edge of chassis.internal) {
    if (edge.from !== routingId) continue;
    const to = chassis.functions.find((item) => item.id === edge.to);
    if (to?.kind !== 'bridging') continue;
    if (to.members.some((member) => member.port === portId)) {
      return { port: portId, bridgeId: to.id };
    }
  }
  return undefined;
}

function execute(
  ctx: RunContext,
  job: Job,
):
  | {
      hops: Hop[];
      transmissions: { outPort: string; frame: Frame }[];
      internal?: { fn: FnId; frame: Frame; inPort?: string };
    }
  | undefined {
  const chassis = chassisOf(ctx, job.device);
  if (!chassis) return undefined;
  const fn = portFn(chassis, job.inPort, job.dispatchFn);
  if (fn?.kind === 'bridging') {
    const result = bridgeFrame(ctx, {
      device: job.device,
      inPort: job.inPort,
      frame: job.frame,
      arrivedFrom: job.arrivedFrom,
      fn: fn.id,
    });
    const vlan = result.hop.vlan;
    if (
      result.hop.action === 'dropped' &&
      result.hop.step !== 'destination-lookup'
    ) {
      return { hops: [result.hop], transmissions: result.transmissions };
    }
    // SVI composition (issue #71): after ingress classification has run
    // (STP, acceptable frames, PVID, ingress filtering — the bridge already
    // decided the frame belongs here), a chassis routing function is
    // reachable from the bridging port for exactly two frame shapes: an ARP
    // asking for a routing iface's IP on that iface's VLAN, and a frame
    // addressed to a routing iface's MAC. Everything else bridges exactly
    // as before — the narrow predicate is the frame-stealing mitigation.
    const svi = sviDecision(ctx, chassis, fn.id, {
      device: job.device,
      inPort: job.inPort,
      vlan,
      frame: job.frame,
    });
    if (svi) return svi;
    if (chassisTakesLocal(chassis, job.frame, vlan)) {
      const local = handleHost(ctx, {
        device: job.device,
        inPort: job.inPort,
        frame: { ...job.frame, vlan },
      });
      if (local) return local;
    }
    return { hops: [result.hop], transmissions: result.transmissions };
  }
  if (fn?.kind === 'wireless') {
    return classifyWireless(ctx, {
      device: job.device,
      inPort: job.inPort,
      frame: job.frame,
    });
  }
  if (fn?.kind === 'isp-handoff') {
    return handoffFrame(ctx, {
      device: job.device,
      inPort: job.inPort,
      frame: job.frame,
    });
  }
  if (fn?.kind === 'routing') {
    const routed = routeFrame(ctx, {
      device: job.device,
      inPort: job.inPort,
      frame: job.frame,
    });
    // SVI egress (issue #71): a transmission whose egress port is a bridging
    // member of this chassis (the SVI port) has no link — the routed frame
    // re-enters the bridge through the InternalEdge rt->br, exactly as if
    // the SVI were an uplink into the VLAN. The walk enqueues the internal
    // job onto the BRIDGE function at the SVI member port; bridging then
    // delivers it to the VLAN's real ports.
    const internal: { fn: FnId; frame: Frame; inPort?: string }[] = [];
    const transmissions = routed.transmissions.flatMap((tx) => {
      const member = sviBridgeMember(chassis, fn.id, tx.outPort);
      if (!member) return [tx];
      internal.push({ fn: member.bridgeId, frame: tx.frame, inPort: member.port });
      return [];
    });
    return internal.length > 0
      ? { hops: routed.hops, transmissions, internal: internal[0] }
      : { hops: routed.hops, transmissions };
  }
  const standalone = standaloneDhcpDecision({
    device: job.device,
    chassis,
    inPort: job.inPort,
    frame: job.frame,
  });
  if (standalone.action === 'respond') {
    return {
      hops: standalone.hops,
      transmissions: standalone.transmissions,
    };
  }
  return handleHost(ctx, {
    device: job.device,
    inPort: job.inPort,
    frame: job.frame,
  });
}

function hasStp(chassis: Chassis | undefined): boolean {
  return chassis?.functions.some((fn) => fn.kind === 'stp') === true;
}

function stpPriority(chassis: Chassis | undefined): number | undefined {
  const stp = chassis?.functions.find((item) => item.kind === 'stp');
  return stp?.kind === 'stp' ? stp.priority : undefined;
}

function note(observations: WalkObservation[], obs: WalkObservation): void {
  if (
    observations.some(
      (item) =>
        item.observation === obs.observation &&
        JSON.stringify(item.facts) === JSON.stringify(obs.facts),
    )
  ) {
    return;
  }
  observations.push(obs);
}

function maxVisits(visits: Map<DeviceId, number>): number {
  let count = 0;
  for (const n of visits.values()) {
    if (n > count) count = n;
  }
  return count;
}

function blockedStpLink(
  ctx: RunContext,
): { a: DeviceId; b: DeviceId } | undefined {
  for (const link of ctx.topology.links) {
    if (!hasStp(chassisOf(ctx, link.a.device))) continue;
    if (!hasStp(chassisOf(ctx, link.b.device))) continue;
    const aState = portState(ctx, link.a.device, link.a.port);
    const bState = portState(ctx, link.b.device, link.b.port);
    if (aState !== 'blocking' && bState !== 'blocking') continue;
    return { a: link.a.device, b: link.b.device };
  }
  return undefined;
}

export function observationAsFormatInput(obs: WalkObservation): TraceInput {
  return { kind: 'trace', observation: obs.observation, facts: obs.facts };
}

/**
 * Follow transmissions across links. Dispatch on `Port.ownedBy`. Flood
 * branches share one hop budget — a storm spends it as a tree, not per path.
 */
export function walkFrame(ctx: RunContext, args: WalkArgs): WalkResult {
  const hops: Hop[] = [];
  const observations: WalkObservation[] = [];
  let deliveredFrame: Frame | undefined;
  const queue: Job[] = [
    {
      device: args.device,
      inPort: args.inPort,
      frame: args.frame,
      arrivedFrom: args.arrivedFrom,
    },
  ];
  const learnedAt = new Map<string, string>();
  const visits = new Map<DeviceId, number>();

  while (queue.length > 0) {
    const job = queue.shift();
    if (job === undefined) break;

    const chassis = chassisOf(ctx, job.device);
    const fn = chassis ? portFn(chassis, job.inPort, job.dispatchFn) : undefined;
    if (!canHandle(ctx, job)) {
      if (chassis) {
        hops.push(
          makeHop({
            device: job.device,
            fn: fn?.id,
            inPort: job.inPort,
            vlan: job.frame.vlan,
            action: 'dropped',
            step: 'delivery',
            outcome: 'dropped',
          }),
        );
      }
      continue;
    }

    if (ctx.hopsLeft <= 0) {
      hops.push(makeBudgetHop(job));
      const count = maxVisits(visits);
      const cycling = [...visits.entries()]
        .filter(([, n]) => n === count)
        .map(([id]) => id);
      if (
        count > 1 &&
        cycling.every((id) => !hasStp(chassisOf(ctx, id)))
      ) {
        note(observations, {
          observation: 'loop',
          facts: { count },
        });
      }
      break;
    }

    const result = execute(ctx, job);
    if (!result) continue;

    ctx.hopsLeft -= 1;
    hops.push(...result.hops);
    if (
      result.hops.some(
        (item) => item.step === 'delivery' && item.action === 'delivered',
      )
    ) {
      deliveredFrame = job.frame;
    }
    visits.set(job.device, (visits.get(job.device) ?? 0) + 1);
    const primary = result.hops[0];

    if (
      fn?.kind === 'bridging' &&
      !fn.vlanAware &&
      primary?.action === 'flooded'
    ) {
      note(observations, {
        observation: 'unmanaged-flood',
        facts: { portCount: fn.members.length },
      });
    }

    if (
      fn?.kind === 'bridging' &&
      job.arrivedFrom !== undefined &&
      job.frame.vlan === null &&
      primary !== undefined &&
      primary.vlan !== null
    ) {
      const prior = hops.slice(0, -result.hops.length);
      const prev = [...prior]
        .reverse()
        .find((hop) => hop.device === job.arrivedFrom);
      if (
        prev?.vlan !== null &&
        prev?.vlan !== undefined &&
        prev.vlan !== primary.vlan
      ) {
        const mapped = [...prior]
          .reverse()
          .find(
            (hop) =>
              hop.device === job.arrivedFrom && hop.step === 'ssid-vlan',
          );
        const fromBridge = chassisOf(ctx, job.arrivedFrom)?.functions.find(
          (item) => item.kind === 'bridging',
        );
        if (
          fromBridge?.kind === 'bridging' &&
          fromBridge.canTag === false &&
          mapped?.vlan !== null &&
          mapped?.vlan !== undefined
        ) {
          note(observations, {
            observation: 'ssid-untagged',
            facts: {
              mappedVlan: mapped.vlan,
              landedVlan: primary.vlan,
            },
          });
        } else {
          note(observations, {
            observation: 'vlan-leak',
            facts: {
              fromVlan: prev.vlan,
              toVlan: primary.vlan,
              devices: [job.arrivedFrom, job.device],
            },
          });
        }
      }
    }

    if (
      fn?.kind === 'bridging' &&
      primary !== undefined &&
      (primary.action === 'forwarded' || primary.action === 'flooded')
    ) {
      const tableVlan = !fn.vlanAware ? 0 : (primary.vlan ?? 0);
      const entry = lookup(ctx, tableVlan, job.frame.srcMac);
      const key = `${job.device}|${tableVlan}|${job.frame.srcMac}`;
      const previous = learnedAt.get(key);
      if (entry && previous !== undefined && previous !== entry.port) {
        note(observations, {
          observation: 'mac-flap',
          facts: {
            mac: job.frame.srcMac,
            port: previous,
            otherPort: entry.port,
          },
        });
      }
      if (entry) learnedAt.set(key, entry.port);
    }

    if (result.internal) {
      queue.unshift({
        device: job.device,
        // An internal dispatch onto another function lands on that
        // function's port when the executor names one (the SVI handoff);
        // otherwise it stays on the arrival port (wireless to bridge).
        inPort: result.internal.inPort ?? job.inPort,
        frame: result.internal.frame,
        arrivedFrom: job.arrivedFrom,
        dispatchFn: result.internal.fn,
      });
    }

    for (const tx of result.transmissions) {
      const far = peerOf(ctx.topology, job.device, tx.outPort);
      let frame = tx.frame;
      if (far && frame.payload.kind !== 'arp') {
        const peer = chassisOf(ctx, far.device);
        const peerFn = peer ? portFn(peer, far.port) : undefined;
        if (
          peerFn?.kind === 'isp-handoff' &&
          peerFn.mode === 'pppoe' &&
          !frame.encapsulation.includes('pppoe')
        ) {
          frame = {
            ...frame,
            encapsulation: [...frame.encapsulation, 'pppoe'],
          };
        }
      }
      const outPort = chassis?.ports.find((item) => item.id === tx.outPort);
      if (
        outPort !== undefined &&
        frame.size > usableMtu(outPort.mtu, frame.encapsulation)
      ) {
        hops.push(
          makeHop({
            device: job.device,
            fn: fn?.id,
            inPort: job.inPort,
            outPort: tx.outPort,
            vlan: frame.vlan,
            action: 'dropped',
            step: 'mtu',
            outcome: 'dropped',
          }),
        );
        continue;
      }
      if (!far) continue;
      queue.push({
        device: far.device,
        inPort: far.port,
        frame,
        arrivedFrom: job.device,
      });
    }
  }

  const forwarded = new Set(
    hops.filter((hop) => hop.action !== 'dropped').map((hop) => hop.device),
  );
  const blocked = blockedStpLink(ctx);
  if (
    blocked &&
    forwarded.has(blocked.a) &&
    forwarded.has(blocked.b)
  ) {
    let root: { device: DeviceId; priority: number } | undefined;
    for (const id of forwarded) {
      if (id === blocked.a || id === blocked.b) continue;
      const priority = stpPriority(chassisOf(ctx, id));
      if (priority === undefined) continue;
      if (!root || priority < root.priority) {
        root = { device: id, priority };
      }
    }
    const aPriority = stpPriority(chassisOf(ctx, blocked.a));
    const bPriority = stpPriority(chassisOf(ctx, blocked.b));
    if (
      root &&
      (aPriority === undefined || root.priority < aPriority) &&
      (bPriority === undefined || root.priority < bPriority)
    ) {
      note(observations, {
        observation: 'stp-root',
        facts: {
          devices: [root.device],
          priority: root.priority,
          path: [blocked.a, blocked.b],
        },
      });
    }
  }

  // Double NAT counts source translations, and a SNAT hop always names its
  // egress port. The DNAT rewrite hop and the return-leg hop carry no
  // outPort (egress is unresolved or not theirs) and are not source picks.
  const translations = hops.filter(
    (item) =>
      item.step === 'nat' &&
      item.reasonCode === 'nat:translated' &&
      item.outPort !== undefined,
  );
  if (translations.length >= 2) {
    note(observations, { observation: 'double-nat', facts: {} });
  }

  return { hops, observations, deliveredFrame };
}
