import type { DeviceId, MacAddr, VlanId } from './model';
import { type Outcome, type PipelineStep, reasonCode } from './reasons';

export interface HopFacts {
  port?: string;
  otherPort?: string;
  otherDevice?: DeviceId;
  otherVlan?: VlanId;
  ip?: string;
  otherIp?: string;
  mac?: MacAddr;
  count?: number;
  portCount?: number;
  devices?: readonly DeviceId[];
  path?: readonly DeviceId[];
  returnPath?: readonly DeviceId[];
  priority?: number;
  fromVlan?: VlanId;
  toVlan?: VlanId;
  via?: string;
  prefix?: string;
  toward?: DeviceId;
  ssid?: string;
  mappedVlan?: VlanId;
  landedVlan?: VlanId;
  expectedVlan?: VlanId;
  proto?: 'udp' | 'tcp';
  dstPort?: number;
  reachedVlan?: VlanId;
}

export interface HopInput {
  kind: 'hop';
  device: DeviceId;
  fn?: string;
  inPort?: string;
  outPort?: string;
  vlan: VlanId | null;
  action: 'forwarded' | 'flooded' | 'dropped' | 'delivered';
  step: PipelineStep;
  outcome: Outcome;
  facts?: HopFacts;
}

export interface TraceInput {
  kind: 'trace';
  observation:
    | 'vlan-leak'
    | 'dual-offer'
    | 'double-nat'
    | 'mac-flap'
    | 'relay-chain'
    | 'stp-root'
    | 'unmanaged-flood'
    | 'loop'
    | 'wrong-pvid-lease'
    | 'local-subnet'
    | 'arp-no-reply'
    | 'dhcp-no-server'
    | 'ssid-untagged';
  facts: HopFacts;
}

export interface FlowInput {
  kind: 'flow';
  observation: 'asymmetric-path' | 'missing-return-route' | 'firewall-reply';
  facts: HopFacts;
}

export interface WarningInput {
  kind: 'warning';
  observation: 'single-instance-stp';
  facts: HopFacts;
}

export type FormatInput = HopInput | TraceInput | FlowInput | WarningInput;

export function shortMac(mac: MacAddr): string {
  const parts = mac.split(':');
  if (parts.length !== 6) return mac;
  return `${parts[0]}:..:${parts[5]}`;
}

function joinPath(devices: readonly string[]): string {
  return devices.join('->');
}

function portOf(input: HopInput): string {
  return input.facts?.port ?? input.outPort ?? input.inPort ?? '';
}

export function format(input: FormatInput): string {
  switch (input.kind) {
    case 'hop':
      return formatHop(input);
    case 'trace':
      return formatTrace(input);
    case 'flow':
      return formatFlow(input);
    case 'warning':
      return formatWarning(input);
  }
}

function formatHop(input: HopInput): string {
  const code = reasonCode(input.step, input.outcome);
  const f = input.facts ?? {};

  if (code === 'egress-membership:dropped') {
    return `Dropped at ${input.device} port ${portOf(input)} (egress): port is not a member of VLAN ${input.vlan}`;
  }
  if (code === 'ingress-filtering:admitted') {
    return 'Admitted only because ingress filtering is disabled';
  }
  if (code === 'acceptable-frame-types:dropped') {
    return `${input.device} port ${input.inPort} admits tagged frames only; the untagged frame from ${f.otherDevice} was dropped at ingress`;
  }
  if (code === 'firewall:dropped' && f.ip !== undefined && f.dstPort !== undefined) {
    return `Query to ${f.ip}:${f.dstPort} left VLAN ${f.fromVlan}; dropped by rule VLAN${f.fromVlan} -> VLAN${f.toVlan} deny`;
  }
  if (code === 'route-lookup:dropped' && f.prefix !== undefined) {
    return `Reached ${f.otherIp} via ${f.via}. Reply to ${f.ip} dropped at ${input.device}: no route — add ${f.prefix} via ${f.via}`;
  }
  if (code === 'route-lookup:dropped' && f.via !== undefined && f.ip !== undefined) {
    return `Default via ${f.via} skipped: its link is down — no usable route to ${f.ip}`;
  }
  if (code === 'port-forward:dropped' && f.otherDevice !== undefined) {
    return `Port forward on ${f.otherDevice} was never reached — dropped at ${input.device} NAT: no matching forward`;
  }
  if (code === 'port-forward:dropped' && f.ip !== undefined) {
    return `Port forward to ${f.ip}:${f.dstPort} dropped at ${input.device}: no interface on ${f.prefix}`;
  }
  if (code === 'route-lookup:forwarded' && f.fromVlan !== undefined && f.via !== undefined) {
    return `VLAN ${f.fromVlan} frame forwarded via ${f.via} by destination-only lookup - no route carries a VLAN ${f.fromVlan} selector`;
  }
  if (code === 'route-lookup:forwarded' && f.via !== undefined && f.fromVlan === undefined) {
    return `Equal-cost routes do not split here: via ${f.via} — the first in the table — carries every frame. Real gear may hash flows across them`;
  }
  if (code === 'mtu:dropped') {
    return `Dropped at ${input.device} port ${portOf(input)} (egress): frame exceeds usable MTU`;
  }
  if (
    code === 'nat:translated' &&
    f.count !== undefined &&
    f.dstPort !== undefined
  ) {
    return `Return leg matched the first of ${f.count} sessions sharing its port tuple - client port ${f.dstPort} collided`;
  }
  if (code === 'nat:translated' && f.count !== undefined) {
    return `Return leg matched the first of ${f.count} address-keyed sessions - no ports on the frame to disambiguate them`;
  }
  if (code === 'nat:translated' && f.ip !== undefined && f.dstPort !== undefined) {
    return `Port forward rewrote the destination to ${f.ip}:${f.dstPort} at ${input.device}`;
  }

  const where = input.inPort
    ? ` at ${input.device} port ${input.inPort}`
    : ` at ${input.device}`;
  return `${input.action}${where} (${input.step})`;
}

function formatTrace(input: TraceInput): string {
  const f = input.facts;
  switch (input.observation) {
    case 'vlan-leak':
      return `Untagged frame entered VLAN ${f.fromVlan} at ${f.devices?.[0]}, arrived as VLAN ${f.toVlan} at ${f.devices?.[1]} — VLAN leak`;
    case 'dual-offer':
      return `Two DHCP OFFERs for the same DISCOVER — from ${f.devices?.[0]} and ${f.devices?.[1]}`;
    case 'double-nat':
      return 'Two NAT translations on this path — inbound connections cannot be initiated';
    case 'mac-flap':
      return `MAC ${f.mac ? shortMac(f.mac) : ''} seen on port ${f.port} and port ${f.otherPort} within one step — MAC table is flapping`;
    case 'relay-chain':
      return `DISCOVER relayed ${f.path ? joinPath(f.path) : ''}, stopped at ${f.devices?.[0]}: no helper address toward ${f.toward}`;
    case 'stp-root':
      return `Root is ${f.devices?.[0]} (priority ${f.priority}). Traffic ${f.path ? joinPath(f.path) : ''} now transits ${f.devices?.[0]}`;
    case 'unmanaged-flood':
      return `This device has no VLAN awareness — all ${f.portCount} ports are one broadcast domain`;
    case 'loop':
      return `Frame has looped ${f.count}x — no BPDUs on this path, STP cannot break this loop`;
    case 'wrong-pvid-lease':
      return `Host got ${f.ip} — expected VLAN ${f.expectedVlan}`;
    case 'local-subnet':
      return `Destination ${f.ip} matches the local subnet — never sent upstream`;
    case 'arp-no-reply':
      return `ARP for ${f.ip} flooded VLAN ${f.fromVlan} — no reply; gateway is on VLAN ${f.otherVlan}`;
    case 'dhcp-no-server':
      return `DHCP DISCOVER flooded VLAN ${f.fromVlan} — no server is a member. Add a relay on the VLAN ${f.fromVlan} interface`;
    case 'ssid-untagged':
      return `Guest SSID maps to VLAN ${f.mappedVlan}, but this node passes untagged only — clients landed in VLAN ${f.landedVlan} with everything else`;
  }
}

function formatFlow(input: FlowInput): string {
  const f = input.facts;
  switch (input.observation) {
    case 'asymmetric-path':
      return `Request ${f.path ? joinPath(f.path) : ''}; reply ${f.returnPath ? joinPath(f.returnPath) : ''} — return path differs`;
    case 'missing-return-route':
      return `Reached ${f.otherIp} via ${f.via}. Reply to ${f.ip} dropped at ${f.devices?.[0]}: no route — add ${f.prefix} via ${f.via}`;
    case 'firewall-reply':
      return `ICMP reached VLAN ${f.reachedVlan}; reply dropped by rule VLAN${f.fromVlan} -> VLAN${f.toVlan} deny`;
  }
}

function formatWarning(input: WarningInput): string {
  const f = input.facts;
  return `This model runs one spanning tree: port ${f.port} is blocked for every VLAN. Gear defaulting to Rapid PVST+ may forward VLAN ${f.fromVlan} here and VLAN ${f.toVlan} on the other trunk`;
}
