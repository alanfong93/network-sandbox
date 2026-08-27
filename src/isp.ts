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

export type IspFn = Extract<Fn, { kind: 'isp-handoff' }>;

export interface HandoffArgs {
  device: DeviceId;
  inPort: string;
  frame: Frame;
}

export interface HandoffResult {
  hops: Hop[];
  transmissions: Transmission[];
}

function ispFn(chassis: Chassis, fnId: string): IspFn | undefined {
  const fn = chassis.functions.find((item) => item.id === fnId);
  return fn?.kind === 'isp-handoff' ? fn : undefined;
}

export function handoffWouldHandle(fn: IspFn): boolean {
  return fn.kind === 'isp-handoff';
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

function withPppoe(frame: Frame): Frame {
  if (frame.encapsulation.includes('pppoe')) return frame;
  return { ...frame, encapsulation: [...frame.encapsulation, 'pppoe'] };
}

function isIpPayload(frame: Frame): boolean {
  return frame.payload.kind !== 'arp';
}

/**
 * One pass through an ISP handoff. The named `port` faces the customer.
 * The other ports owned by the same function face the provider.
 */
export function handoffFrame(ctx: RunContext, args: HandoffArgs): HandoffResult {
  const chassis = ctx.topology.devices.find((item) => item.id === args.device);
  const port = chassis?.ports.find((item) => item.id === args.inPort);
  const fn = port && chassis ? ispFn(chassis, port.ownedBy) : undefined;
  if (!chassis || !port || !fn) {
    throw new Error(
      `handoffFrame: ${args.device}:${args.inPort} is not an isp-handoff port`,
    );
  }

  const fromCustomer = args.inPort === fn.port;
  if (fromCustomer) {
    if (fn.vlanTag !== undefined && args.frame.vlan !== fn.vlanTag) {
      return {
        hops: [
          makeHop({
            device: args.device,
            fn: fn.id,
            inPort: args.inPort,
            vlan: args.frame.vlan,
            action: 'dropped',
            step: 'isp-handoff',
            outcome: 'dropped',
          }),
        ],
        transmissions: [],
      };
    }
    if (
      fn.mode === 'pppoe' &&
      isIpPayload(args.frame) &&
      !args.frame.encapsulation.includes('pppoe')
    ) {
      return {
        hops: [
          makeHop({
            device: args.device,
            fn: fn.id,
            inPort: args.inPort,
            vlan: args.frame.vlan,
            action: 'dropped',
            step: 'isp-handoff',
            outcome: 'dropped',
          }),
        ],
        transmissions: [],
      };
    }
    const hop = makeHop({
      device: args.device,
      fn: fn.id,
      inPort: args.inPort,
      vlan: args.frame.vlan,
      action: 'forwarded',
      step: 'isp-handoff',
      outcome: 'forwarded',
    });
    const transmissions: Transmission[] = [];
    for (const other of chassis.ports) {
      if (other.ownedBy !== fn.id || other.id === args.inPort) continue;
      transmissions.push({
        outPort: other.id,
        frame: { ...args.frame, hops: [...args.frame.hops, hop] },
      });
    }
    return { hops: [hop], transmissions };
  }

  let outgoing = args.frame;
  if (fn.vlanTag !== undefined && outgoing.vlan !== fn.vlanTag) {
    outgoing = withVlan(outgoing, fn.vlanTag);
  }
  if (fn.mode === 'pppoe' && isIpPayload(outgoing)) {
    outgoing = withPppoe(outgoing);
  }
  const hop = makeHop({
    device: args.device,
    fn: fn.id,
    inPort: args.inPort,
    outPort: fn.port,
    vlan: outgoing.vlan,
    action: 'forwarded',
    step: 'isp-handoff',
    outcome: 'forwarded',
  });
  return {
    hops: [hop],
    transmissions: [
      {
        outPort: fn.port,
        frame: { ...outgoing, hops: [...outgoing.hops, hop] },
      },
    ],
  };
}
