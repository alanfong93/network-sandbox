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
  matchSessionDetail,
  otherForwardDevice,
  recordSession,
} from './nat';
import {
  getResolvedMac,
  portLinkDown,
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

/**
 * Every iface a default route names, in no particular order (ADR 0022): the
 * WAN set. Topological only - reachability is the caller's concern, and the
 * port-forward candidate check has never applied it.
 */
function defaultNamedIfaces(fn: RoutingFn): RouterIface[] {
  const found: RouterIface[] = [];
  for (const route of fn.routes) {
    if (route.prefix !== 0) continue;
    const via = fn.ifaces.find((item) =>
      inSubnet(route.via, item.ip, item.prefix),
    );
    if (
      via &&
      !found.some((item) => item.id === via.id && item.vlan === via.vlan)
    ) {
      found.push(via);
    }
  }
  return found;
}

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
  reachable?: (iface: RouterIface) => boolean,
): { iface: RouterIface; nextHop: string; route?: Route; ties?: number } | undefined {
  const usable = (iface: RouterIface) =>
    reachable === undefined || reachable(iface);
  const connected = fn.ifaces
    .filter((iface) => usable(iface))
    .map((iface) => ({
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
  // A via whose link is down is not a candidate (ADR 0020) — including a
  // selector route targeting the down WAN. Without a reachability test the
  // candidate set is unchanged.
  const candidates =
    reachable === undefined
      ? fn.routes
      : fn.routes.filter((route) => {
          const via = fn.ifaces.find((item) =>
            inSubnet(route.via, item.ip, item.prefix),
          );
          return via !== undefined && usable(via);
        });
  // Selector tier first: a route carrying fromVlan matches only frames of
  // that VLAN and beats any destination-only route. Absent fromVlan on the
  // frame (or no matching selector) falls back to destination-only LPM.
  const tier = (pool: Route[]) => {
    const entries = pool.map(toCandidate);
    const route = longestPrefixMatch(dstIp, entries);
    if (!route) return undefined;
    // Equal prefixes tie; longestPrefixMatch keeps the first. Counting the
    // tie is what lets the hop name the pick instead of implying a split
    // (ADR 0021) — there is no clock to spread frames over (ADR 0003).
    const ties = entries.filter(
      (candidate) =>
        inSubnet(dstIp, candidate.dest, candidate.prefix) &&
        candidate.prefix === route.prefix,
    ).length;
    return { route, ties };
  };
  const picked =
    tier(
      candidates.filter(
        (route) => fromVlan !== undefined && route.fromVlan === fromVlan,
      ),
    ) ?? tier(candidates.filter((route) => route.fromVlan === undefined));
  if (!picked) return undefined;
  const { route, ties } = picked;
  const iface = fn.ifaces.find((item) =>
    inSubnet(route.via, item.ip, item.prefix),
  );
  if (!iface) return undefined;
  return { iface, nextHop: route.via, route, ties };
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
  let working: Frame = args.frame;
  let skipSnat = false;
  let skipLocal = false;
  // A DNAT arrived at from an internal iface (one no default route names) is
  // hairpin: the client reached the public IP from inside, so the frame leaves
  // via an internal iface and masquerade applies there too (ADR 0022).
  // Undefined - false - for every other frame.
  let hairpin = false;
  // Hairpin only: the public IP the client sent to, restored as the reply's
  // source on the return leg.
  let origDst: string | undefined;
  // Hairpin only: the public port the client contacted, restored as the
  // reply's source port on the return leg (the port analogue of origDst).
  let origDstPort: number | undefined;
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
    const match = nat ? matchSessionDetail(ctx, args.device, working) : undefined;
    const session = match?.session;
    if (session && nat && match) {
      const payload: FramePayload = {
        ...working.payload,
        dstIp: session.insideIp,
      };
      // A hairpin return restores the public address the client originally
      // contacted, so the client's socket tuple matches (ADR 0022). Plain
      // masquerade sessions carry no origDstIp: their clients talked to the
      // remote's real address, and the source must stay as it is.
      if (session.origDstIp !== undefined && payload.srcIp !== undefined) {
        payload.srcIp = session.origDstIp;
      }
      // The port analogue of the restore above: the client sees the reply
      // from the port it contacted, not the server's internal one (ADR 0023).
      if (
        payload.kind === 'service' &&
        session.outsidePort !== undefined &&
        payload.srcPort !== undefined &&
        payload.srcPort !== session.outsidePort
      ) {
        payload.srcPort = session.outsidePort;
      }
      const hop = makeHop({
        device: args.device,
        fn: nat.id,
        inPort: args.inPort,
        vlan: working.vlan,
        action: 'forwarded',
        step: 'nat',
        outcome: 'translated',
        // Trace-not-verdict (ADR 0002): a return picked first-wins among
        // sessions the frame cannot disambiguate names the pick instead of
        // implying precision. The ambiguity kind decides the sentence: a
        // collided port tuple carries the client port, a service frame
        // without a source port names that, and a portless frame names the
        // address-keyed bucket.
        facts: match.ambiguous
          ? match.ambiguity === 'port-tuple' && payload.kind === 'service'
            ? { count: match.candidates, dstPort: payload.dstPort }
            : payload.kind === 'service'
              ? { count: match.candidates, proto: payload.proto }
              : { count: match.candidates }
          : undefined,
      });
      extraHops.push(hop);
      working = { ...working, payload, hops: [...working.hops, hop] };
      dstIp = session.insideIp;
      skipSnat = true;
    } else if (
      nat &&
      working.payload.kind === 'service' &&
      defaultNamedIfaces(fn).some((candidate) => candidate.ip === dstIp)
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
      origDst = dstIp;
      origDstPort = working.payload.dstPort;
      const dnatHop = makeHop({
        device: args.device,
        fn: nat.id,
        inPort: args.inPort,
        vlan: args.frame.vlan,
        action: 'forwarded',
        step: 'nat',
        outcome: 'translated',
        facts: { ip: fwd.toIp, dstPort: fwd.toPort },
      });
      extraHops.push(dnatHop);
      working = { ...working, payload };
      dstIp = fwd.toIp;
      hairpin = !defaultNamedIfaces(fn).some(
        (w) => w.id === iface.id && w.vlan === iface.vlan,
      );
      // An external client DNATed to a LAN server keeps its public source
      // address; a hairpin client is rewritten so the server's reply returns
      // through the router (ADR 0022).
      if (!hairpin) skipSnat = true;
    } else {
      const payload = working.payload;
      const facts =
        payload.kind === 'service' && payload.name !== undefined
          ? { name: payload.name, dstPort: payload.dstPort, ip: payload.dstIp }
          : undefined;
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
            facts,
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

  // ADR 0020: an iface whose link is down is not a route candidate — the
  // connected route and any default behind it are excluded before the pick.
  const reachable = (candidate: RouterIface): boolean =>
    !portLinkDown(ctx.topology, args.device, candidate.id);

  const egress = lookupEgress(fn, dstIp, iface.vlan, reachable);
  if (!egress) {
    // Name a default that was actually a candidate for this frame: the same
    // tier order lookupEgress consults - the frame VLAN's selector defaults
    // first, then destination-only. Reaching this branch means every
    // applicable default is absent or down, so a down one here is the cause.
    const downDefaultIn = (routes: Route[]) =>
      routes.find((route) => {
        const via = fn.ifaces.find((item) =>
          inSubnet(route.via, item.ip, item.prefix),
        );
        return via !== undefined && portLinkDown(ctx.topology, args.device, via.id);
      });
    const defaultsIn = (fromVlan: VlanId | undefined) =>
      fn.routes.filter((route) => route.prefix === 0 && route.fromVlan === fromVlan);
    const downVia =
      (iface.vlan !== undefined
        ? downDefaultIn(defaultsIn(iface.vlan))
        : undefined) ?? downDefaultIn(defaultsIn(undefined));
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
          facts: downVia ? { via: downVia.via, ip: dstIp } : undefined,
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
  // Equal-cost tie in the matched tier: name the deterministic pick (first
  // reachable in routes[] order) rather than implying a split (ADR 0021).
  // The selector-miss lesson wins when both apply.
  const ecmp =
    !selectorMiss &&
    egress.route !== undefined &&
    (egress.ties ?? 1) > 1;
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
      : ecmp
        ? { via: egress.nextHop }
        : undefined,
  });

  let payload = working.payload;
  const natHops: Hop[] = [];
  // Masquerade whenever the frame leaves via any iface a default route names
  // (ADR 0022): the selector-aware pick for this VLAN, the plain default, or
  // any other WAN reached by a longer-prefix static or selector route. The
  // pick is reachability-aware: a default whose via sits behind a down link
  // names nothing (ADR 0020), so masquerade follows failover. A DNATed
  // hairpin frame instead masquerades out the resolved egress iface, so the
  // server's reply re-enters the router and the session delivers it with the
  // original public source restored (ADR 0022).
  const natTarget = hairpin
    ? egress.iface
    : fn.routes
        .filter((route) => route.prefix === 0)
        .map((route) =>
          fn.ifaces.find((item) => inSubnet(route.via, item.ip, item.prefix)),
        )
        .find(
          (item) =>
            item !== undefined &&
            reachable(item) &&
            item.id === egress.iface.id &&
            item.vlan === egress.iface.vlan,
        );
  if (nat && !skipSnat && natTarget) {
    const srcIp = payload.srcIp;
    if (srcIp !== undefined && srcIp !== natTarget.ip) {
      const service = payload.kind === 'service' ? payload : undefined;
      recordSession(ctx, {
        device: args.device,
        insideIp: srcIp,
        outsideIp: natTarget.ip,
        remoteIp: dstIp,
        ...(hairpin ? { origDstIp: origDst } : {}),
        // Port identity (ADR 0023): recorded wherever the payload carries
        // it, so return legs match the session on the full tuple.
        ...(service
          ? {
              proto: service.proto,
              toPort: service.dstPort,
              clientPort: service.srcPort,
              ...(hairpin ? { outsidePort: origDstPort } : {}),
            }
          : {}),
      });
      payload = { ...payload, srcIp: natTarget.ip };
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
