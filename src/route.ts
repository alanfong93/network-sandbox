import type { Transmission } from './bridge';
import { defaults } from './defaults';
import type { HopFacts } from './format';
import { makeHop } from './hop';
import { resolveKey } from './host';
import { inSubnet, longestPrefixMatch } from './ip';
import {
  isGroupMac,
  type Chassis,
  type DeviceId,
  type Encapsulation,
  type Fn,
  type Frame,
  type Hop,
  type RouterIface,
  type VlanId,
} from './model';
import {
  getResolvedMac,
  setResolvedMac,
  type RunContext,
} from './run';

export interface RouteArgs {
  device: DeviceId;
  inPort: string;
  frame: Frame;
}

export interface RouteResult {
  hops: Hop[];
  transmissions: Transmission[];
}

type RoutingFn = Extract<Fn, { kind: 'routing' }>;

function routingFn(chassis: Chassis, fnId: string): RoutingFn | undefined {
  const fn = chassis.functions.find((item) => item.id === fnId);
  return fn?.kind === 'routing' ? fn : undefined;
}

export function matchIface(
  fn: RoutingFn,
  portId: string,
  vlan: VlanId | null,
): RouterIface | undefined {
  const want = vlan === null ? undefined : vlan;
  return fn.ifaces.find((iface) => iface.id === portId && iface.vlan === want);
}

export function routingWouldHandle(
  fn: RoutingFn,
  inPort: string,
  frame: Frame,
): boolean {
  const iface = matchIface(fn, inPort, frame.vlan);
  if (!iface) return false;
  if (frame.payload.kind === 'arp') {
    if (isGroupMac(frame.dstMac)) return frame.payload.dstIp === iface.ip;
    return frame.dstMac === iface.mac;
  }
  return true;
}

function withVlan(frame: Frame, vlan: VlanId | null, hop: Hop): Frame {
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
  return {
    ...frame,
    vlan,
    encapsulation,
    hops: [...frame.hops, hop],
  };
}

function lookupEgress(
  fn: RoutingFn,
  dstIp: string,
): { iface: RouterIface; nextHop: string } | undefined {
  const connected = fn.ifaces.map((iface) => ({
    dest: iface.ip,
    prefix: iface.prefix,
    value: { iface, nextHop: dstIp },
  }));
  const hit = longestPrefixMatch(dstIp, connected);
  if (hit) return hit;
  const routes = fn.routes.map((route) => ({
    dest: route.dest,
    prefix: route.prefix,
    value: route,
  }));
  const route = longestPrefixMatch(dstIp, routes);
  if (!route) return undefined;
  const iface = fn.ifaces.find((item) =>
    inSubnet(route.via, item.ip, item.prefix),
  );
  if (!iface) return undefined;
  return { iface, nextHop: route.via };
}

function firewallDrop(
  fn: RoutingFn,
  fromVlan: VlanId | undefined,
  toVlan: VlanId | undefined,
): boolean {
  if (fromVlan === undefined || toVlan === undefined) return false;
  if (fromVlan === toVlan) return false;
  const rule = fn.firewall.find(
    (item) => item.from === fromVlan && item.to === toVlan,
  );
  return rule?.action === 'deny';
}

export function routeFrame(ctx: RunContext, args: RouteArgs): RouteResult {
  const chassis = ctx.topology.devices.find((item) => item.id === args.device);
  const port = chassis?.ports.find((item) => item.id === args.inPort);
  const fn = port && chassis ? routingFn(chassis, port.ownedBy) : undefined;
  if (!chassis || !port || !fn) {
    throw new Error(
      `routeFrame: ${args.device}:${args.inPort} is not a routing port`,
    );
  }

  const iface = matchIface(fn, args.inPort, args.frame.vlan);
  if (!iface) {
    return { hops: [], transmissions: [] };
  }

  if (args.frame.payload.kind === 'arp' && isGroupMac(args.frame.dstMac)) {
    const hop = makeHop({
      device: args.device,
      fn: fn.id,
      inPort: args.inPort,
      vlan: args.frame.vlan,
      action: 'delivered',
      step: 'arp',
      outcome: 'delivered',
    });
    const reply: Frame = {
      srcMac: iface.mac,
      dstMac: args.frame.srcMac,
      vlan: args.frame.vlan,
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

  if (args.frame.payload.kind === 'arp') {
    const srcIp = args.frame.payload.srcIp;
    if (srcIp !== undefined) {
      setResolvedMac(ctx, resolveKey(args.device, srcIp), args.frame.srcMac);
    }
    const hop = makeHop({
      device: args.device,
      fn: fn.id,
      inPort: args.inPort,
      vlan: args.frame.vlan,
      action: 'delivered',
      step: 'arp',
      outcome: 'delivered',
    });
    const ready = ctx.pendingSends.filter(
      (item) => item.device === args.device && item.nextHopIp === srcIp,
    );
    ctx.pendingSends = ctx.pendingSends.filter(
      (item) => !(item.device === args.device && item.nextHopIp === srcIp),
    );
    const mac = args.frame.srcMac;
    return {
      hops: [hop],
      transmissions: ready.map((item) => ({
        outPort: item.outPort,
        frame: { ...item.frame, dstMac: mac },
      })),
    };
  }

  const dstIp = args.frame.payload.dstIp;
  if (dstIp !== undefined && fn.ifaces.some((item) => item.ip === dstIp)) {
    return {
      hops: [
        makeHop({
          device: args.device,
          fn: fn.id,
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

  if (dstIp === undefined) {
    return {
      hops: [
        makeHop({
          device: args.device,
          fn: fn.id,
          inPort: args.inPort,
          vlan: args.frame.vlan,
          action: 'dropped',
          step: 'route-lookup',
          outcome: 'dropped',
        }),
      ],
      transmissions: [],
    };
  }

  const egress = lookupEgress(fn, dstIp);
  if (!egress) {
    return {
      hops: [
        makeHop({
          device: args.device,
          fn: fn.id,
          inPort: args.inPort,
          vlan: args.frame.vlan,
          action: 'dropped',
          step: 'route-lookup',
          outcome: 'dropped',
        }),
      ],
      transmissions: [],
    };
  }

  if (firewallDrop(fn, iface.vlan, egress.iface.vlan)) {
    const facts: HopFacts = {
      fromVlan: iface.vlan,
      toVlan: egress.iface.vlan,
      ip: dstIp,
      dstPort:
        args.frame.payload.kind === 'service'
          ? args.frame.payload.dstPort
          : undefined,
    };
    return {
      hops: [
        makeHop({
          device: args.device,
          fn: fn.id,
          inPort: args.inPort,
          vlan: args.frame.vlan,
          action: 'dropped',
          step: 'firewall',
          outcome: 'dropped',
          facts,
        }),
      ],
      transmissions: [],
    };
  }

  const hop = makeHop({
    device: args.device,
    fn: fn.id,
    inPort: args.inPort,
    outPort: egress.iface.id,
    vlan: args.frame.vlan,
    action: 'forwarded',
    step: 'route-lookup',
    outcome: 'forwarded',
  });

  const outVlan = egress.iface.vlan ?? null;
  const ipFrame = withVlan(
    {
      ...args.frame,
      srcMac: egress.iface.mac,
    },
    outVlan,
    hop,
  );

  const mac = getResolvedMac(ctx, resolveKey(args.device, egress.nextHop));
  if (mac) {
    return {
      hops: [hop],
      transmissions: [
        {
          outPort: egress.iface.id,
          frame: { ...ipFrame, dstMac: mac },
        },
      ],
    };
  }

  ctx.pendingSends.push({
    device: args.device,
    outPort: egress.iface.id,
    nextHopIp: egress.nextHop,
    frame: ipFrame,
  });

  const arpHop = makeHop({
    device: args.device,
    fn: fn.id,
    inPort: args.inPort,
    outPort: egress.iface.id,
    vlan: outVlan,
    action: 'flooded',
    step: 'arp',
    outcome: 'flooded',
  });
  const arp: Frame = {
    srcMac: egress.iface.mac,
    dstMac: defaults.broadcastMac,
    vlan: outVlan,
    size: 64,
    encapsulation:
      outVlan === null ? ['ethernet'] : ['ethernet', 'vlan-tag'],
    payload: {
      kind: 'arp',
      srcIp: egress.iface.ip,
      dstIp: egress.nextHop,
    },
    hops: [...args.frame.hops, hop, arpHop],
  };

  return {
    hops: [hop, arpHop],
    transmissions: [{ outPort: egress.iface.id, frame: arp }],
  };
}
