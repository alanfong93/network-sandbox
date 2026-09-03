import type { Transmission } from './bridge';
import { makeHop } from './hop';
import { inSubnet } from './ip';
import type {
  Chassis,
  DeviceId,
  DhcpScope,
  Fn,
  Frame,
  FramePayload,
  Hop,
  RouterIface,
  Topology,
} from './model';
import type { WalkObservation } from './walk';

export type DhcpServerFn = Extract<Fn, { kind: 'dhcp-server' }>;
export type DhcpRelayFn = Extract<Fn, { kind: 'dhcp-relay' }>;
type RoutingFn = Extract<Fn, { kind: 'routing' }>;

export type DhcpDecision =
  | { action: 'respond'; hops: Hop[]; transmissions: Transmission[] }
  | { action: 'relay'; hop: Hop; payload: FramePayload }
  | { action: 'drop' }
  | { action: 'pass' };

export function findDhcpServer(chassis: Chassis): DhcpServerFn | undefined {
  const fn = chassis.functions.find((item) => item.kind === 'dhcp-server');
  return fn?.kind === 'dhcp-server' ? fn : undefined;
}

export function findDhcpRelay(chassis: Chassis): DhcpRelayFn | undefined {
  const fn = chassis.functions.find((item) => item.kind === 'dhcp-relay');
  return fn?.kind === 'dhcp-relay' ? fn : undefined;
}

export function otherDhcpServer(
  topology: Topology,
  except: readonly DeviceId[],
): DeviceId | undefined {
  const skip = new Set(except);
  for (const device of topology.devices) {
    if (skip.has(device.id)) continue;
    if (device.functions.some((fn) => fn.kind === 'dhcp-server')) return device.id;
  }
  return undefined;
}

export function matchScope(
  server: DhcpServerFn | undefined,
  iface: RouterIface,
  frame: Frame,
): DhcpScope | undefined {
  if (!server) return undefined;
  if (iface.vlan !== undefined) {
    const local = server.scopes.find((scope) => scope.vlan === iface.vlan);
    if (local) return local;
  } else {
    const local = server.scopes.find(
      (scope) =>
        inSubnet(iface.ip, scope.gateway, 24) ||
        inSubnet(iface.ip, scope.poolStart, 24),
    );
    if (local) return local;
  }
  const giaddr = frame.payload.srcIp;
  if (giaddr === undefined) return undefined;
  return server.scopes.find(
    (scope) =>
      inSubnet(giaddr, scope.gateway, 24) || inSubnet(giaddr, scope.poolStart, 24),
  );
}

function dhcpTypeOf(frame: Frame): string | undefined {
  if (frame.payload.kind !== 'dhcp') return undefined;
  return frame.payload.dhcpType?.toLowerCase();
}

/**
 * Standalone dispatch: a chassis carrying a dhcp-server function answers a
 * DHCP DISCOVER on its own addressing VLAN, even when the chassis has no
 * routing function — provided it carries its own mac and ip: the OFFER is
 * sourced from the server's identity, never a fabricated one (RFC 2131
 * s4.3.1: the server IP source is its own address, not the scope's gateway
 * option). One identity means one VLAN: a tagged frame for any other VLAN
 * is not answered here — that server would need its own address on that
 * VLAN, or the relay path. The reply reuses the same OFFER shape as the
 * router path. Reachability is honest (issue #72): the answer leaves the
 * arrival port — the frame reached this chassis, so the reply follows the
 * same path back. REQUEST and every other DHCP type keep today's dispatch
 * untouched.
 */
export function standaloneDhcpDecision(args: {
  device: DeviceId;
  chassis: Chassis;
  inPort: string;
  frame: Frame;
}):
  | { action: 'respond'; hops: Hop[]; transmissions: Transmission[] }
  | { action: 'pass' } {
  if (args.frame.payload.kind !== 'dhcp') return { action: 'pass' };
  const type = dhcpTypeOf(args.frame);
  if (type !== 'discover') return { action: 'pass' };
  const server = findDhcpServer(args.chassis);
  if (!server) return { action: 'pass' };
  // The server has exactly one identity (one mac, one ip), so it answers on
  // exactly one VLAN — the chassis' declared addressing VLAN. An untagged
  // arrival is classified to it; a tagged frame is answered only when its
  // tag names the same VLAN. Anything else is another VLAN's traffic and
  // needs a server addressed there (or the relay path).
  const ownVlan = args.chassis.vlan;
  if (ownVlan === undefined) return { action: 'pass' };
  const vlan = args.frame.vlan ?? ownVlan;
  if (vlan !== ownVlan) return { action: 'pass' };
  const scope = server.scopes.find((item) => item.vlan === vlan);
  if (!scope) return { action: 'pass' };
  // The server answers from its own identity, never a fabricated one: an
  // OFFER's IP source is the server's address (RFC 2131 s4.3.1), not the
  // scope's gateway option, and its Ethernet source is the chassis MAC.
  // A server chassis without its own address cannot answer at all.
  const mac = args.chassis.mac;
  const ip = args.chassis.ip;
  if (mac === undefined || ip === undefined) return { action: 'pass' };
  const iface: RouterIface = {
    id: args.inPort,
    vlan,
    ip,
    prefix: 24,
    mac,
  };
  return {
    action: 'respond',
    ...reply({
      device: args.device,
      server,
      iface,
      inPort: args.inPort,
      frame: args.frame,
      scope,
      type: 'offer',
    }),
  };
}

function reply(
  args: {
    device: DeviceId;
    server: DhcpServerFn;
    iface: RouterIface;
    inPort: string;
    frame: Frame;
    scope: DhcpScope;
    type: 'offer' | 'ack';
  },
): { hops: Hop[]; transmissions: Transmission[] } {
  const hop = makeHop({
    device: args.device,
    fn: args.server.id,
    inPort: args.inPort,
    outPort: args.inPort,
    vlan: args.frame.vlan,
    action: 'forwarded',
    step: 'dhcp-server',
    outcome: 'forwarded',
  });
  const out: Frame = {
    srcMac: args.iface.mac,
    dstMac: args.frame.srcMac,
    vlan: args.frame.vlan,
    size: args.frame.size,
    encapsulation: [...args.frame.encapsulation],
    payload: {
      kind: 'dhcp',
      dhcpType: args.type,
      srcIp: args.iface.ip,
      dstIp: args.scope.poolStart,
    },
    hops: [...args.frame.hops, hop],
  };
  return {
    hops: [hop],
    transmissions: [{ outPort: args.inPort, frame: out }],
  };
}

export function decideDhcp(args: {
  device: DeviceId;
  chassis: Chassis;
  fn: RoutingFn;
  iface: RouterIface;
  inPort: string;
  frame: Frame;
}): DhcpDecision {
  if (args.frame.payload.kind !== 'dhcp') return { action: 'pass' };
  const type = dhcpTypeOf(args.frame);
  const server = findDhcpServer(args.chassis);
  const relay = findDhcpRelay(args.chassis);
  const scope = matchScope(server, args.iface, args.frame);

  if ((type === 'discover' || type === 'request') && server && scope) {
    return {
      action: 'respond',
      ...reply({
        device: args.device,
        server,
        iface: args.iface,
        inPort: args.inPort,
        frame: args.frame,
        scope,
        type: type === 'request' ? 'ack' : 'offer',
      }),
    };
  }

  if (type === 'discover' && relay) {
    const hop = makeHop({
      device: args.device,
      fn: relay.id,
      inPort: args.inPort,
      vlan: args.frame.vlan,
      action: 'forwarded',
      step: 'dhcp-relay',
      outcome: 'relayed',
    });
    return {
      action: 'relay',
      hop,
      payload: {
        kind: 'dhcp',
        dhcpType: 'discover',
        srcIp: args.iface.ip,
        dstIp: relay.helper,
      },
    };
  }

  const dstIp = args.frame.payload.dstIp;
  if (dstIp !== undefined && args.fn.ifaces.some((item) => item.ip === dstIp)) {
    return {
      action: 'respond',
      hops: [
        makeHop({
          device: args.device,
          fn: args.fn.id,
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

  if (type === 'discover') return { action: 'drop' };
  return { action: 'pass' };
}

function uniqueDevices(hops: readonly Hop[], step: Hop['step']): DeviceId[] {
  const out: DeviceId[] = [];
  for (const hop of hops) {
    if (hop.step !== step) continue;
    if (hop.action === 'dropped') continue;
    if (out[out.length - 1] !== hop.device) out.push(hop.device);
  }
  return out;
}

export function dhcpObservations(
  topology: Topology,
  hops: readonly Hop[],
  deliveredFrame: Frame | undefined,
  facts: { fromVlan?: number; expectedVlan?: number },
): WalkObservation[] {
  const servers = uniqueDevices(hops, 'dhcp-server');
  if (servers.length >= 2) {
    return [
      {
        observation: 'dual-offer',
        facts: { devices: servers.slice(0, 2) },
      },
    ];
  }

  const relays = uniqueDevices(hops, 'dhcp-relay');
  if (relays.length > 0 && servers.length === 0) {
    const stopped =
      [...hops].reverse().find((hop) => hop.step === 'delivery')?.device ??
      relays[relays.length - 1];
    const path = stopped && relays[relays.length - 1] !== stopped
      ? [...relays, stopped]
      : relays;
    const toward = otherDhcpServer(topology, path);
    return [
      {
        observation: 'relay-chain',
        facts: {
          path,
          devices: stopped ? [stopped] : undefined,
          toward,
        },
      },
    ];
  }

  const out: WalkObservation[] = [];
  if (servers.length === 0 && relays.length === 0 && facts.fromVlan !== undefined) {
    out.push({
      observation: 'dhcp-no-server',
      facts: { fromVlan: facts.fromVlan },
    });
  }

  const offered =
    deliveredFrame?.payload.kind === 'dhcp' ? deliveredFrame.payload.dstIp : undefined;
  if (
    servers.length === 1 &&
    offered !== undefined &&
    facts.expectedVlan !== undefined &&
    facts.fromVlan !== undefined &&
    facts.expectedVlan !== facts.fromVlan
  ) {
    out.push({
      observation: 'wrong-pvid-lease',
      facts: { ip: offered, expectedVlan: facts.expectedVlan },
    });
  }
  return out;
}
