import type { Transmission } from './bridge';
import { defaults } from './defaults';
import type { HopFacts } from './format';
import { makeHop } from './hop';
import { resolveKey } from './host';
import { formatPrefix, inSubnet, longestPrefixMatch } from './ip';
import {
  isGroupMac,
  type Chassis,
  type DeviceId,
  type Encapsulation,
  type Fn,
  type Frame,
  type FramePayload,
  type Hop,
  type Route,
  type RouterIface,
  type VlanId,
} from './model';
import { decideDhcp } from './dhcp';
import {
  findNat,
  matchForward,
  matchSession,
  otherForwardDevice,
  recordSession,
  wanIface,
} from './nat';
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
  if (frame.payload.kind === 'arp') {
    if (!iface) return false;
    if (isGroupMac(frame.dstMac)) return frame.payload.dstIp === iface.ip;
    return frame.dstMac === iface.mac;
  }
  if (iface) return true;
  return fn.ifaces.some(
    (item) => item.id === inPort && item.mac === frame.dstMac,
  );
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
  fromVlan?: VlanId,
): { iface: RouterIface; nextHop: string; route?: Route } | undefined {
  const connected = fn.ifaces.map((iface) => ({
    dest: iface.ip,
    prefix: iface.prefix,
    value: { iface, nextHop: dstIp },
  }));
  const hit = longestPrefixMatch(dstIp, connected);
  if (hit) return hit;
  const toCandidate = (route: Route) => ({
    dest: route.dest,
    prefix: route.prefix,
    value: route,
  });
  // Selector tier first: a route carrying fromVlan matches only frames of
  // that VLAN and beats any destination-only route. Absent fromVlan on the
  // frame (or no matching selector) falls back to destination-only LPM.
  const selected = fn.routes.filter(
    (route) => fromVlan !== undefined && route.fromVlan === fromVlan,
  );
  const destOnly = fn.routes.filter((route) => route.fromVlan === undefined);
  const route =
    longestPrefixMatch(dstIp, selected.map(toCandidate)) ??
    longestPrefixMatch(dstIp, destOnly.map(toCandidate));
  if (!route) return undefined;
  const iface = fn.ifaces.find((item) =>
    inSubnet(route.via, item.ip, item.prefix),
  );
  if (!iface) return undefined;
  return { iface, nextHop: route.via, route };
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

  if (args.frame.payload.kind === 'arp' && isGroupMac(args.frame.dstMac)) {
    if (args.frame.payload.dstIp !== iface.ip) {
      return { hops: [], transmissions: [] };
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

  const nat = findNat(chassis, fn.id);
  const wan = wanIface(fn, iface.vlan);
  let working: Frame = args.frame;
  let skipSnat = false;
  let skipLocal = false;
  const extraHops: Hop[] = [];

  if (args.frame.payload.kind === 'dhcp') {
    const decision = decideDhcp({
      device: args.device,
      chassis,
      fn,
      iface,
      inPort: args.inPort,
      frame: args.frame,
    });
    if (decision.action === 'respond') {
      return {
        hops: decision.hops,
        transmissions: decision.transmissions,
      };
    }
    if (decision.action === 'drop') {
      return { hops: [], transmissions: [] };
    }
    if (decision.action === 'relay') {
      extraHops.push(decision.hop);
      working = {
        ...working,
        payload: decision.payload,
        hops: [...working.hops, decision.hop],
      };
      skipSnat = true;
      skipLocal = true;
    }
  }

  let dstIp = working.payload.dstIp;
  if (
    !skipLocal &&
    dstIp !== undefined &&
    fn.ifaces.some((item) => item.ip === dstIp)
  ) {
    const session = nat ? matchSession(ctx, args.device, working) : undefined;
    if (session && nat) {
      const payload: FramePayload = {
        ...working.payload,
        dstIp: session.insideIp,
      };
      const hop = makeHop({
        device: args.device,
        fn: nat.id,
        inPort: args.inPort,
        vlan: working.vlan,
        action: 'forwarded',
        step: 'nat',
        outcome: 'translated',
      });
      extraHops.push(hop);
      working = { ...working, payload, hops: [...working.hops, hop] };
      dstIp = session.insideIp;
      skipSnat = true;
    } else if (
      nat &&
      (wan !== undefined || wanIface(fn) !== undefined) &&
      [wan, wanIface(fn)].some(
        (candidate) => candidate !== undefined && candidate.ip === dstIp,
      ) &&
      working.payload.kind === 'service'
    ) {
      const fwd = matchForward(nat, working);
      if (!fwd) {
        const other = otherForwardDevice(ctx.topology, args.device);
        return {
          hops: [
            makeHop({
              device: args.device,
              fn: nat.id,
              inPort: args.inPort,
              vlan: args.frame.vlan,
              action: 'dropped',
              step: 'port-forward',
              outcome: 'dropped',
              facts: other ? { otherDevice: other } : undefined,
            }),
          ],
          transmissions: [],
        };
      }
      if (
        !fn.ifaces.some((item) => inSubnet(fwd.toIp, item.ip, item.prefix))
      ) {
        return {
          hops: [
            makeHop({
              device: args.device,
              fn: nat.id,
              inPort: args.inPort,
              vlan: args.frame.vlan,
              action: 'dropped',
              step: 'port-forward',
              outcome: 'dropped',
              facts: {
                ip: fwd.toIp,
                dstPort: fwd.toPort,
                prefix: formatPrefix(fwd.toIp, 24),
              },
            }),
          ],
          transmissions: [],
        };
      }
      const payload: FramePayload = {
        ...working.payload,
        dstIp: fwd.toIp,
        dstPort: fwd.toPort,
      };
      working = { ...working, payload };
      dstIp = fwd.toIp;
      skipSnat = true;
    } else {
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

  const egress = lookupEgress(fn, dstIp, iface.vlan);
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
        working.payload.kind === 'service'
          ? working.payload.dstPort
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

  // Catalogue row 24: on a multi-WAN box, a tagged frame that fell through to
  // a selectorless default names what it missed - no route carries its VLAN's
  // selector, so the pick was destination-only.
  const selectorMiss =
    iface.vlan !== undefined &&
    egress.route !== undefined &&
    egress.route.fromVlan === undefined &&
    egress.route.prefix === 0 &&
    fn.routes.filter((route) => route.prefix === 0).length > 1 &&
    !fn.routes.some((route) => route.fromVlan === iface.vlan);
  const hop = makeHop({
    device: args.device,
    fn: fn.id,
    inPort: args.inPort,
    outPort: egress.iface.id,
    vlan: args.frame.vlan,
    action: 'forwarded',
    step: 'route-lookup',
    outcome: 'forwarded',
    facts: selectorMiss
      ? { fromVlan: iface.vlan, via: egress.nextHop }
      : undefined,
  });

  let payload = working.payload;
  const natHops: Hop[] = [];
  // Masquerade when the frame leaves via any default-route iface for this
  // VLAN - the selector-aware pick or the plain default. The selector pick
  // alone would miss connected egress on the other WAN.
  const natOut = [wan, wanIface(fn)].find(
    (candidate) =>
      candidate !== undefined &&
      egress.iface.id === candidate.id &&
      egress.iface.vlan === candidate.vlan,
  );
  if (nat && !skipSnat && natOut) {
    const srcIp = payload.srcIp;
    if (srcIp !== undefined && srcIp !== natOut.ip) {
      recordSession(ctx, {
        device: args.device,
        insideIp: srcIp,
        outsideIp: natOut.ip,
        remoteIp: dstIp,
      });
      payload = { ...payload, srcIp: natOut.ip };
      natHops.push(
        makeHop({
          device: args.device,
          fn: nat.id,
          inPort: args.inPort,
          outPort: egress.iface.id,
          vlan: args.frame.vlan,
          action: 'forwarded',
          step: 'nat',
          outcome: 'translated',
        }),
      );
    }
  }

  const outVlan = egress.iface.vlan ?? null;
  let ipFrame = withVlan(
    {
      ...working,
      srcMac: egress.iface.mac,
      payload,
    },
    outVlan,
    hop,
  );
  for (const natHop of natHops) {
    ipFrame = { ...ipFrame, hops: [...ipFrame.hops, natHop] };
  }

  const mac = getResolvedMac(ctx, resolveKey(args.device, egress.nextHop));
  const hops = [...extraHops, hop, ...natHops];
  if (mac) {
    return {
      hops,
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
    hops: [...ipFrame.hops, arpHop],
  };

  return {
    hops: [...hops, arpHop],
    transmissions: [{ outPort: egress.iface.id, frame: arp }],
  };
}
