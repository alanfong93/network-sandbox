import { bridgeFrame } from './bridge';
import { usableMtu } from './defaults';
import { format, type HopFacts, type TraceInput } from './format';
import { makeHop } from './hop';
import { handleHost, hostWouldHandle } from './host';
import { handoffFrame, handoffWouldHandle } from './isp';
import type {
  Chassis,
  DeviceId,
  Fn,
  FnId,
  Frame,
  Hop,
  Topology,
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
  return hostWouldHandle(chassis, job.frame);
}

function execute(
  ctx: RunContext,
  job: Job,
):
  | {
      hops: Hop[];
      transmissions: { outPort: string; frame: Frame }[];
      internal?: { fn: FnId; frame: Frame };
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
    return routeFrame(ctx, {
      device: job.device,
      inPort: job.inPort,
      frame: job.frame,
    });
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
        inPort: job.inPort,
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

  const translations = hops.filter(
    (item) => item.step === 'nat' && item.reasonCode === 'nat:translated',
  );
  if (translations.length >= 2) {
    note(observations, { observation: 'double-nat', facts: {} });
  }

  return { hops, observations, deliveredFrame };
}
