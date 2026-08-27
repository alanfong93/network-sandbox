import type { Transmission } from './bridge';
import { makeHop } from './hop';
import type {
  Chassis,
  DeviceId,
  Encapsulation,
  Fn,
  Frame,
  Hop,
  VlanId,
} from './model';
import type { RunContext } from './run';

export type WirelessFn = Extract<Fn, { kind: 'wireless' }>;

export interface WirelessArgs {
  device: DeviceId;
  inPort: string;
  frame: Frame;
}

export interface WirelessResult {
  hops: Hop[];
  transmissions: Transmission[];
  internal?: { fn: string; frame: Frame };
}

function wirelessOn(chassis: Chassis, fnId: string): WirelessFn | undefined {
  const fn = chassis.functions.find((item) => item.id === fnId);
  return fn?.kind === 'wireless' ? fn : undefined;
}

export function wirelessWouldHandle(fn: WirelessFn): boolean {
  return fn.kind === 'wireless';
}

function withVlan(frame: Frame, vlan: VlanId | null): Frame {
  const without: Encapsulation[] = [];
  for (const layer of frame.encapsulation) {
    if (layer !== 'vlan-tag') without.push(layer);
  }
  const encapsulation: Encapsulation[] =
    vlan !== null
      ? (() => {
          const at = without.indexOf('ethernet');
          const next = [...without];
          next.splice(at === -1 ? next.length : at + 1, 0, 'vlan-tag');
          return next;
        })()
      : without;
  return { ...frame, vlan, encapsulation };
}

/**
 * Classify an arrival onto a wireless function at `ssid-vlan`.
 * The walk then follows `InternalEdge` onto the chassis bridge.
 */
export function classifyWireless(
  ctx: RunContext,
  args: WirelessArgs,
): WirelessResult {
  const chassis = ctx.topology.devices.find((item) => item.id === args.device);
  const port = chassis?.ports.find((item) => item.id === args.inPort);
  const fn = port && chassis ? wirelessOn(chassis, port.ownedBy) : undefined;
  if (!chassis || !port || !fn) {
    throw new Error(
      `classifyWireless: ${args.device}:${args.inPort} is not a wireless port`,
    );
  }

  const vlan = fn.vlan ?? null;
  const classified = withVlan(args.frame, vlan);
  const hop = makeHop({
    device: args.device,
    fn: fn.id,
    inPort: args.inPort,
    vlan,
    action: 'forwarded',
    step: 'ssid-vlan',
    outcome: 'classified',
    facts: { ssid: fn.ssid, mappedVlan: fn.vlan },
  });
  const edge = chassis.internal.find((item) => item.from === fn.id);
  const to = edge
    ? chassis.functions.find((item) => item.id === edge.to)
    : undefined;
  if (to?.kind !== 'bridging') {
    return { hops: [hop], transmissions: [] };
  }
  return {
    hops: [hop],
    transmissions: [],
    internal: {
      fn: to.id,
      frame: { ...classified, hops: [...classified.hops, hop] },
    },
  };
}
