import { inSubnet } from './ip';
import type {
  Chassis,
  DeviceId,
  Fn,
  Frame,
  PortForward,
  RouterIface,
  Topology,
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

export function wanIface(fn: RoutingFn): RouterIface | undefined {
  const def = fn.routes.find((route) => route.prefix === 0);
  if (!def) return undefined;
  return fn.ifaces.find((iface) => inSubnet(def.via, iface.ip, iface.prefix));
}

export function matchSession(
  ctx: RunContext,
  device: DeviceId,
  frame: Frame,
): NatSession | undefined {
  const dst = frame.payload.dstIp;
  const src = frame.payload.srcIp;
  if (dst === undefined || src === undefined) return undefined;
  return ctx.natSessions.find(
    (item) =>
      item.device === device &&
      item.outsideIp === dst &&
      item.remoteIp === src,
  );
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
      item.remoteIp === session.remoteIp,
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
