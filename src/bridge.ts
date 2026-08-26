import { format, type HopFacts } from './format';
import {
  carriedVlans,
  type BridgePort,
  type Chassis,
  type DeviceId,
  type Encapsulation,
  type Fn,
  type FnId,
  type Frame,
  type Hop,
  type HopAction,
  type MacAddr,
  type VlanId,
} from './model';
import { reasonCode, type Outcome, type PipelineStep } from './reasons';
import { learn, lookup, portState, type RunContext } from './run';

export interface Transmission {
  outPort: string;
  frame: Frame;
}

export interface BridgeResult {
  hop: Hop;
  transmissions: Transmission[];
}

export interface BridgeArgs {
  device: DeviceId;
  inPort: string;
  frame: Frame;
  arrivedFrom?: DeviceId;
}

function chassisOf(ctx: RunContext, id: DeviceId): Chassis | undefined {
  return ctx.topology.devices.find((item) => item.id === id);
}

function bridgingFn(chassis: Chassis, fnId: FnId): Extract<Fn, { kind: 'bridging' }> | undefined {
  const fn = chassis.functions.find((item) => item.id === fnId);
  return fn?.kind === 'bridging' ? fn : undefined;
}

function memberOf(
  bridge: Extract<Fn, { kind: 'bridging' }>,
  portId: string,
): BridgePort | undefined {
  return bridge.members.find((member) => member.port === portId);
}

function isGroupAddress(mac: MacAddr): boolean {
  const first = mac.split(':')[0];
  if (first === undefined) return false;
  const octet = Number.parseInt(first, 16);
  return Number.isFinite(octet) && (octet & 1) === 1;
}

function isVlanTagged(vlan: VlanId | null): boolean {
  return vlan !== null && vlan !== 0;
}

function isMember(bridge: Extract<Fn, { kind: 'bridging' }>, port: BridgePort, vlan: VlanId): boolean {
  if (!bridge.vlanAware) return true;
  return carriedVlans(port).has(vlan);
}

function fdbVlan(bridge: Extract<Fn, { kind: 'bridging' }>, vlan: VlanId): VlanId {
  return bridge.vlanAware ? vlan : 0;
}

function makeHop(args: {
  device: DeviceId;
  fn?: FnId;
  inPort?: string;
  outPort?: string;
  vlan: VlanId | null;
  action: HopAction;
  step: PipelineStep;
  outcome: Outcome;
  facts?: HopFacts;
}): Hop {
  const reason = format({
    kind: 'hop',
    device: args.device,
    fn: args.fn,
    inPort: args.inPort,
    outPort: args.outPort,
    vlan: args.vlan,
    action: args.action,
    step: args.step,
    outcome: args.outcome,
    facts: args.facts,
  });
  return {
    device: args.device,
    fn: args.fn,
    inPort: args.inPort,
    outPort: args.outPort,
    vlan: args.vlan,
    action: args.action,
    step: args.step,
    reasonCode: reasonCode(args.step, args.outcome),
    reason,
  };
}

function drop(
  args: Omit<Parameters<typeof makeHop>[0], 'action' | 'outcome'> & {
    outcome?: Outcome;
  },
): BridgeResult {
  return {
    hop: makeHop({
      ...args,
      action: 'dropped',
      outcome: args.outcome ?? 'dropped',
    }),
    transmissions: [],
  };
}

function applyTag(frame: Frame, vlan: VlanId | null, hop: Hop): Frame {
  const tagged = vlan !== null;
  const without: Encapsulation[] = [];
  for (const layer of frame.encapsulation) {
    if (layer !== 'vlan-tag') without.push(layer);
  }
  const encapsulation: Encapsulation[] = tagged
    ? (() => {
        const at = without.indexOf('ethernet');
        const next = [...without];
        next.splice(at === -1 ? next.length : at + 1, 0, 'vlan-tag');
        return next;
      })()
    : without;
  return {
    ...frame,
    vlan,
    encapsulation,
    hops: [...frame.hops, hop],
  };
}

function egressVlan(
  bridge: Extract<Fn, { kind: 'bridging' }>,
  port: BridgePort,
  vlan: VlanId,
  arrivedVlan: VlanId | null,
): VlanId | null {
  if (!bridge.vlanAware) return arrivedVlan;
  if (port.untaggedVlans.has(vlan)) return null;
  return vlan;
}

/**
 * One pass through one bridging function. STP ingress is before learning;
 * STP egress is before a port is allowed to appear as `outPort`.
 */
export function bridgeFrame(ctx: RunContext, args: BridgeArgs): BridgeResult {
  const chassis = chassisOf(ctx, args.device);
  if (!chassis) {
    return drop({
      device: args.device,
      inPort: args.inPort,
      vlan: args.frame.vlan,
      step: 'stp-ingress',
    });
  }
  const port = chassis.ports.find((item) => item.id === args.inPort);
  const bridge = port ? bridgingFn(chassis, port.ownedBy) : undefined;
  const member = bridge ? memberOf(bridge, args.inPort) : undefined;
  if (!port || !bridge || !member) {
    return drop({
      device: args.device,
      inPort: args.inPort,
      vlan: args.frame.vlan,
      step: 'stp-ingress',
    });
  }

  const facts: HopFacts = { otherDevice: args.arrivedFrom };
  const ingressState = portState(ctx, args.device, args.inPort);
  if (ingressState !== 'forwarding') {
    return drop({
      device: args.device,
      fn: bridge.id,
      inPort: args.inPort,
      vlan: args.frame.vlan,
      step: 'stp-ingress',
      facts,
    });
  }

  const arrivedTagged = isVlanTagged(args.frame.vlan);
  const acceptable = member.acceptableFrameTypes;
  if (acceptable === 'tagged-only' && !arrivedTagged) {
    return drop({
      device: args.device,
      fn: bridge.id,
      inPort: args.inPort,
      vlan: args.frame.vlan,
      step: 'acceptable-frame-types',
      facts,
    });
  }
  if (acceptable === 'untagged-only' && arrivedTagged) {
    return drop({
      device: args.device,
      fn: bridge.id,
      inPort: args.inPort,
      vlan: args.frame.vlan,
      step: 'acceptable-frame-types',
      facts,
    });
  }

  let vlan: VlanId | null = args.frame.vlan;
  if (bridge.vlanAware && !isVlanTagged(vlan)) {
    vlan = member.pvid;
  }

  let admittedDespiteFilter = false;
  if (vlan !== null && !isMember(bridge, member, vlan)) {
    if (member.ingressFiltering) {
      return drop({
        device: args.device,
        fn: bridge.id,
        inPort: args.inPort,
        vlan,
        step: 'ingress-filtering',
        facts,
      });
    }
    admittedDespiteFilter = true;
  }

  const tableVlan = fdbVlan(bridge, vlan ?? 0);

  if (!isGroupAddress(args.frame.srcMac)) {
    learn(ctx, tableVlan, args.frame.srcMac, args.device, args.inPort);
  }

  const dest = args.frame.dstMac;
  const flood = isGroupAddress(dest);
  const known = flood ? undefined : lookup(ctx, tableVlan, dest);

  const candidates: string[] = [];
  if (known && known.device === args.device && known.port !== args.inPort) {
    candidates.push(known.port);
  } else if (known && known.device === args.device && known.port === args.inPort) {
    return drop({
      device: args.device,
      fn: bridge.id,
      inPort: args.inPort,
      vlan,
      step: 'destination-lookup',
      facts,
    });
  } else {
    for (const other of bridge.members) {
      if (other.port === args.inPort) continue;
      if (vlan !== null && bridge.vlanAware && !isMember(bridge, other, vlan)) continue;
      candidates.push(other.port);
    }
  }

  const outgoing: { outPort: string; outVlan: VlanId | null }[] = [];
  let egressDrop: BridgeResult | undefined;
  for (const outPort of candidates) {
    const outMember = memberOf(bridge, outPort);
    if (!outMember) continue;
    if (portState(ctx, args.device, outPort) !== 'forwarding') {
      egressDrop = drop({
        device: args.device,
        fn: bridge.id,
        inPort: args.inPort,
        vlan,
        step: 'stp-egress',
        facts,
      });
      continue;
    }
    if (vlan !== null && !isMember(bridge, outMember, vlan)) {
      if (!flood && known) {
        egressDrop = drop({
          device: args.device,
          fn: bridge.id,
          inPort: args.inPort,
          outPort,
          vlan,
          step: 'egress-membership',
          facts,
        });
      }
      continue;
    }
    outgoing.push({
      outPort,
      outVlan: vlan === null
        ? args.frame.vlan
        : egressVlan(bridge, outMember, vlan, args.frame.vlan),
    });
  }

  if (outgoing.length === 0) {
    return (
      egressDrop ??
      drop({
        device: args.device,
        fn: bridge.id,
        inPort: args.inPort,
        vlan,
        step: 'destination-lookup',
        facts,
      })
    );
  }

  const action: HopAction =
    outgoing.length > 1 || flood || !known ? 'flooded' : 'forwarded';
  const representative = outgoing[0];
  const hop = makeHop({
    device: args.device,
    fn: bridge.id,
    inPort: args.inPort,
    outPort: action === 'forwarded' ? representative?.outPort : undefined,
    vlan,
    action,
    step: admittedDespiteFilter ? 'ingress-filtering' : 'egress-tagging',
    outcome: admittedDespiteFilter
      ? 'admitted'
      : action === 'flooded'
        ? 'flooded'
        : 'forwarded',
    facts,
  });

  return {
    hop,
    transmissions: outgoing.map((tx) => ({
      outPort: tx.outPort,
      frame: applyTag(args.frame, tx.outVlan, hop),
    })),
  };
}
