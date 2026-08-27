import { defaults } from './defaults';
import { resolveKey } from './host';
import { inSubnet } from './ip';
import type {
  Chassis,
  DeviceId,
  Frame,
  FramePayload,
  MacAddr,
  Topology,
  VlanId,
} from './model';
import type { Hop } from './model';
import { getResolvedMac, type RunContext } from './run';
import {
  peerOf,
  walkFrame,
  type WalkObservation,
  type WalkResult,
} from './walk';

export interface SendArgs {
  from: DeviceId;
  dstIp: string;
  payload: FramePayload;
  dstMac?: MacAddr;
}

export function nextHopIp(sender: Chassis, dstIp: string): string | undefined {
  if (
    sender.ip !== undefined &&
    sender.prefix !== undefined &&
    inSubnet(dstIp, sender.ip, sender.prefix)
  ) {
    return dstIp;
  }
  return sender.gateway;
}

export function needsArp(payload: FramePayload, dstMac?: MacAddr): boolean {
  if (payload.kind === 'arp') return false;
  if (payload.kind === 'dhcp' && payload.dhcpType?.toLowerCase() === 'discover') {
    return false;
  }
  if (dstMac !== undefined) return false;
  return true;
}

export function vlanOfIp(topology: Topology, ip: string): VlanId | undefined {
  for (const chassis of topology.devices) {
    for (const fn of chassis.functions) {
      if (fn.kind !== 'routing') continue;
      for (const iface of fn.ifaces) {
        if (iface.ip === ip && iface.vlan !== undefined) return iface.vlan;
      }
    }
  }
  return undefined;
}

export function senderVlan(
  topology: Topology,
  device: DeviceId,
): VlanId | undefined {
  const chassis = topology.devices.find((item) => item.id === device);
  const port = chassis?.ports[0];
  if (!port) return undefined;
  const far = peerOf(topology, device, port.id);
  if (!far) return undefined;
  const peer = topology.devices.find((item) => item.id === far.device);
  const bridge = peer?.functions.find((fn) => fn.kind === 'bridging');
  if (bridge?.kind !== 'bridging') return undefined;
  return bridge.members.find((member) => member.port === far.port)?.pvid;
}

function originFrame(
  chassis: Chassis,
  dstMac: MacAddr,
  payload: FramePayload,
): Frame {
  return {
    srcMac: chassis.mac ?? '00:00:00:00:00:00',
    dstMac,
    vlan: null,
    size: 64,
    encapsulation: ['ethernet'],
    payload,
    hops: [],
  };
}

export function send(ctx: RunContext, args: SendArgs): WalkResult {
  const chassis = ctx.topology.devices.find((item) => item.id === args.from);
  const port = chassis?.ports[0];
  if (!chassis || !port) return { hops: [], observations: [] };
  const far = peerOf(ctx.topology, args.from, port.id);
  const payload: FramePayload = {
    ...args.payload,
    srcIp: args.payload.srcIp ?? chassis.ip,
    dstIp: args.payload.dstIp ?? args.dstIp,
  };

  if (!needsArp(payload, args.dstMac)) {
    const dstMac = args.dstMac ?? defaults.broadcastMac;
    if (!far) return { hops: [], observations: [] };
    return walkFrame(ctx, {
      device: far.device,
      inPort: far.port,
      frame: originFrame(chassis, dstMac, payload),
      arrivedFrom: args.from,
    });
  }

  const nextHop = nextHopIp(chassis, args.dstIp);
  if (nextHop === undefined) return { hops: [], observations: [] };

  let mac = getResolvedMac(ctx, resolveKey(args.from, nextHop));
  const hops: Hop[] = [];
  const observations: WalkObservation[] = [];

  if (!mac && far) {
    const arp = originFrame(chassis, defaults.broadcastMac, {
      kind: 'arp',
      srcIp: chassis.ip,
      dstIp: nextHop,
    });
    const arpWalk = walkFrame(ctx, {
      device: far.device,
      inPort: far.port,
      frame: arp,
      arrivedFrom: args.from,
    });
    hops.push(...arpWalk.hops);
    observations.push(...arpWalk.observations);
    mac = getResolvedMac(ctx, resolveKey(args.from, nextHop));
  }

  if (!mac) {
    const otherVlan = vlanOfIp(ctx.topology, nextHop);
    const fromVlan = senderVlan(ctx.topology, args.from);
    if (
      otherVlan !== undefined &&
      fromVlan !== undefined &&
      otherVlan !== fromVlan
    ) {
      observations.push({
        observation: 'arp-no-reply',
        facts: { ip: nextHop, fromVlan, otherVlan },
      });
    }
    if (nextHop === args.dstIp) {
      observations.push({
        observation: 'local-subnet',
        facts: { ip: args.dstIp },
      });
    }
    return { hops, observations };
  }

  if (!far) return { hops, observations };
  const ipWalk = walkFrame(ctx, {
    device: far.device,
    inPort: far.port,
    frame: originFrame(chassis, mac, payload),
    arrivedFrom: args.from,
  });
  return {
    hops: [...hops, ...ipWalk.hops],
    observations: [...observations, ...ipWalk.observations],
    deliveredFrame: ipWalk.deliveredFrame,
  };
}
