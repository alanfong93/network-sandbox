import type { Transmission } from './bridge';
import { makeHop } from './hop';
import { isGroupMac, type Chassis, type Frame, type Hop } from './model';
import { setResolvedMac, type RunContext } from './run';

export interface HostResult {
  hops: Hop[];
  transmissions: Transmission[];
}

export function isAddressedHost(chassis: Chassis): boolean {
  return chassis.mac !== undefined && chassis.ip !== undefined;
}

export function resolveKey(sender: string, ip: string): string {
  return `${sender}|${ip}`;
}

export function hostWouldHandle(chassis: Chassis, frame: Frame): boolean {
  if (!isAddressedHost(chassis) || chassis.mac === undefined) return false;
  if (frame.payload.kind === 'arp') {
    if (isGroupMac(frame.dstMac)) return frame.payload.dstIp === chassis.ip;
    return frame.dstMac === chassis.mac;
  }
  return frame.dstMac === chassis.mac;
}

export function handleHost(
  ctx: RunContext,
  args: { device: string; inPort: string; frame: Frame },
): HostResult | undefined {
  const chassis = ctx.topology.devices.find((item) => item.id === args.device);
  if (!chassis || !hostWouldHandle(chassis, args.frame)) return undefined;
  const mac = chassis.mac;
  const ip = chassis.ip;
  if (mac === undefined || ip === undefined) return undefined;

  if (args.frame.payload.kind === 'arp' && isGroupMac(args.frame.dstMac)) {
    const hop = makeHop({
      device: args.device,
      inPort: args.inPort,
      vlan: args.frame.vlan,
      action: 'delivered',
      step: 'arp',
      outcome: 'delivered',
    });
    const reply: Frame = {
      srcMac: mac,
      dstMac: args.frame.srcMac,
      vlan: args.frame.vlan,
      size: args.frame.size,
      encapsulation: [...args.frame.encapsulation],
      payload: {
        kind: 'arp',
        srcIp: ip,
        dstIp: args.frame.payload.srcIp,
      },
      hops: [...args.frame.hops, hop],
    };
    return {
      hops: [hop],
      transmissions: [{ outPort: args.inPort, frame: reply }],
    };
  }

  if (args.frame.payload.kind === 'arp') {
    const srcIp = args.frame.payload.srcIp;
    if (srcIp !== undefined) {
      setResolvedMac(ctx, resolveKey(args.device, srcIp), args.frame.srcMac);
    }
    return {
      hops: [
        makeHop({
          device: args.device,
          inPort: args.inPort,
          vlan: args.frame.vlan,
          action: 'delivered',
          step: 'arp',
          outcome: 'delivered',
        }),
      ],
      transmissions: [],
    };
  }

  return {
    hops: [
      makeHop({
        device: args.device,
        inPort: args.inPort,
        vlan: args.frame.vlan,
        action: 'delivered',
        step: 'delivery',
        outcome: 'delivered',
      }),
    ],
    transmissions: [],
  };
}
