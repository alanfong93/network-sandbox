import { bridgeFrame } from './bridge';
import { format, type HopFacts, type TraceInput } from './format';
import { handleHost, hostWouldHandle } from './host';
import type {
  Chassis,
  DeviceId,
  Fn,
  Frame,
  Hop,
  Topology,
} from './model';
import { reasonCode } from './reasons';
import { routingWouldHandle, routeFrame } from './route';
import { lookup, type RunContext } from './run';

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
}

function chassisOf(ctx: RunContext, id: DeviceId): Chassis | undefined {
  return ctx.topology.devices.find((item) => item.id === id);
}

function portFn(chassis: Chassis, portId: string): Fn | undefined {
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
  const fn = portFn(chassis, job.inPort);
  if (fn?.kind === 'bridging') return true;
  if (fn?.kind === 'routing') {
    return routingWouldHandle(fn, job.inPort, job.frame);
  }
  return hostWouldHandle(chassis, job.frame);
}

function execute(
  ctx: RunContext,
  job: Job,
): { hops: Hop[]; transmissions: { outPort: string; frame: Frame }[] } | undefined {
  const chassis = chassisOf(ctx, job.device);
  if (!chassis) return undefined;
  const fn = portFn(chassis, job.inPort);
  if (fn?.kind === 'bridging') {
    const result = bridgeFrame(ctx, {
      device: job.device,
      inPort: job.inPort,
      frame: job.frame,
      arrivedFrom: job.arrivedFrom,
    });
    return { hops: [result.hop], transmissions: result.transmissions };
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
  if (observations.some((item) => item.observation === obs.observation)) return;
  observations.push(obs);
}

function maxVisits(visits: Map<DeviceId, number>): number {
  let count = 0;
  for (const n of visits.values()) {
    if (n > count) count = n;
  }
  return count;
}

function uniqueForwardDevices(hops: Hop[]): DeviceId[] {
  const out: DeviceId[] = [];
  for (const hop of hops) {
    if (hop.action === 'dropped') continue;
    if (out[out.length - 1] !== hop.device) out.push(hop.device);
  }
  return out;
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
    const fn = chassis ? portFn(chassis, job.inPort) : undefined;
    if (!canHandle(ctx, job)) continue;

    if (ctx.hopsLeft <= 0) {
      hops.push(makeBudgetHop(job));
      const devices = [...visits.keys()];
      const count = maxVisits(visits);
      if (
        count > 1 &&
        devices.every((id) => !hasStp(chassisOf(ctx, id)))
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

    for (const tx of result.transmissions) {
      const far = peerOf(ctx.topology, job.device, tx.outPort);
      if (!far) continue;
      queue.push({
        device: far.device,
        inPort: far.port,
        frame: tx.frame,
        arrivedFrom: job.device,
      });
    }
  }

  const path = uniqueForwardDevices(hops);
  if (path.length >= 3) {
    const start = path[0];
    const end = path[path.length - 1];
    if (start !== undefined && end !== undefined) {
      let root: { device: DeviceId; priority: number } | undefined;
      for (const id of path.slice(1, -1)) {
        const priority = stpPriority(chassisOf(ctx, id));
        if (priority === undefined) continue;
        if (!root || priority < root.priority) {
          root = { device: id, priority };
        }
      }
      const startPriority = stpPriority(chassisOf(ctx, start));
      const endPriority = stpPriority(chassisOf(ctx, end));
      if (
        root &&
        (startPriority === undefined || root.priority < startPriority) &&
        (endPriority === undefined || root.priority < endPriority)
      ) {
        note(observations, {
          observation: 'stp-root',
          facts: {
            devices: [root.device],
            priority: root.priority,
            path: [start, end],
          },
        });
      }
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
