import { inSubnet } from './ip';
import type {
  Chassis,
  DeviceId,
  Fn,
  Frame,
  PortForward,
  Route,
  RouterIface,
  Topology,
  VlanId,
} from './model';
import type { NatSession, RunContext } from './run';

export type NatFn = Extract<Fn, { kind: 'nat' }>;
export type RoutingFn = Extract<Fn, { kind: 'routing' }>;

export function findNat(chassis: Chassis, routingId: string): NatFn | undefined {
  const fn = chassis.functions.find(
    (item) => item.kind === 'nat' && item.on === routingId,
  );
  return fn?.kind === 'nat' ? fn : undefined;
}

export function matchForward(
  nat: NatFn,
  frame: Frame,
): PortForward | undefined {
  const payload = frame.payload;
  if (payload.kind !== 'service') return undefined;
  return nat.portForwards.find(
    (item) =>
      item.proto === payload.proto && item.outsidePort === payload.dstPort,
  );
}

export function wanIface(
  fn: RoutingFn,
  fromVlan?: VlanId,
  reachable?: (iface: RouterIface) => boolean,
): RouterIface | undefined {
  // Without a reachability test this is the plain two-tier pick: a default
  // carrying the frame VLAN's selector wins; otherwise the destination-only
  // default as before.
  if (reachable === undefined) {
    const def =
      (fromVlan !== undefined
        ? fn.routes.find(
            (route) => route.prefix === 0 && route.fromVlan === fromVlan,
          )
        : undefined) ??
      fn.routes.find(
        (route) => route.prefix === 0 && route.fromVlan === undefined,
      );
    if (!def) return undefined;
    return fn.ifaces.find((iface) => inSubnet(def.via, iface.ip, iface.prefix));
  }
  // Reachability-aware: the same two-tier order, but a default whose via sits
  // behind a down link is not a candidate (ADR 0020) — the next default wins,
  // so masquerade follows the failover egress.
  const tiers: Route[][] = [];
  if (fromVlan !== undefined) {
    tiers.push(
      fn.routes.filter(
        (route) => route.prefix === 0 && route.fromVlan === fromVlan,
      ),
    );
  }
  tiers.push(
    fn.routes.filter(
      (route) => route.prefix === 0 && route.fromVlan === undefined,
    ),
  );
  for (const tier of tiers) {
    for (const route of tier) {
      const iface = fn.ifaces.find((item) =>
        inSubnet(route.via, item.ip, item.prefix),
      );
      if (iface && reachable(iface)) return iface;
    }
  }
  return undefined;
}

/**
 * What a return-leg lookup found, and what it had to choose from (ADR 0023).
 * `ambiguous` is true when first-match-wins chose among several sessions the
 * frame cannot disambiguate - address twins for a portless frame, or a shared
 * port tuple for a ported one - and the route hop names that pick.
 */
export interface SessionMatch {
  session?: NatSession;
  candidates: number;
  ambiguous: boolean;
}

export function matchSession(
  ctx: RunContext,
  device: DeviceId,
  frame: Frame,
): NatSession | undefined {
  return matchSessionDetail(ctx, device, frame).session;
}

export function matchSessionDetail(
  ctx: RunContext,
  device: DeviceId,
  frame: Frame,
): SessionMatch {
  const payload = frame.payload;
  const dst = payload.dstIp;
  const src = payload.srcIp;
  if (dst === undefined || src === undefined) {
    return { candidates: 0, ambiguous: false };
  }
  const candidates = ctx.natSessions.filter(
    (item) =>
      item.device === device &&
      item.outsideIp === dst &&
      item.remoteIp === src,
  );
  if (candidates.length === 0) {
    return { candidates: 0, ambiguous: false };
  }
  // A frame carrying port identity names its session exactly: the server
  // replies from its service port (session toPort) to the client's ephemeral
  // (session clientPort). No address-only fallback here - that fallback is
  // the diversion this key removes (issue #51). Two sessions can still share
  // the tuple (same-port clients - the engine never translates source
  // ports); first-match-wins stands and the tie is named.
  if (
    payload.kind === 'service' &&
    payload.srcPort !== undefined &&
    payload.dstPort !== undefined
  ) {
    const tuple = candidates.filter(
      (item) =>
        item.proto === payload.proto &&
        item.toPort === payload.srcPort &&
        item.clientPort === payload.dstPort,
    );
    return {
      session: tuple[0],
      candidates: tuple.length,
      ambiguous: tuple.length > 1,
    };
  }
  // A frame without port identity (ICMP-style, or a service frame whose
  // ports are absent) cannot name a session; only sessions without port
  // identity match it. First-match-wins stands - dropping the return would
  // break masquerade ping - and the route hop names the pick.
  const portless = candidates.filter((item) => item.proto === undefined);
  return {
    session: portless[0],
    candidates: portless.length,
    ambiguous: portless.length > 1,
  };
}

export function recordSession(
  ctx: RunContext,
  session: NatSession,
): void {
  const exists = ctx.natSessions.some(
    (item) =>
      item.device === session.device &&
      item.insideIp === session.insideIp &&
      item.outsideIp === session.outsideIp &&
      item.remoteIp === session.remoteIp &&
      item.origDstIp === session.origDstIp &&
      item.proto === session.proto &&
      item.outsidePort === session.outsidePort &&
      item.toPort === session.toPort &&
      item.clientPort === session.clientPort,
  );
  if (!exists) ctx.natSessions.push(session);
}

export function otherForwardDevice(
  topology: Topology,
  except: DeviceId,
): DeviceId | undefined {
  for (const device of topology.devices) {
    if (device.id === except) continue;
    for (const fn of device.functions) {
      if (fn.kind === 'nat' && fn.portForwards.length > 0) return device.id;
    }
  }
  return undefined;
}
