import type { Outcome, PipelineStep, ReasonCode } from './reasons';

export type VlanId = number;
export type MacAddr = string;
export type Bytes = number;
export type DeviceId = string;
export type FnId = string;

export type Encapsulation = 'ethernet' | 'vlan-tag' | 'pppoe';
export type HopAction = 'forwarded' | 'flooded' | 'dropped' | 'delivered';
export type TransportProto = 'udp' | 'tcp';
export type StpPortState = 'forwarding' | 'blocking' | 'disabled';

export interface Topology {
  devices: Chassis[];
  links: Link[];
  profiles: string[];
}

export interface Link {
  id: string;
  a: { device: DeviceId; port: string };
  b: { device: DeviceId; port: string };
  medium: 'wired' | 'wireless';
  /** Omitted is up. Down is a link property, not a device role (ADR 0020). */
  up?: boolean;
}

export interface Chassis {
  id: DeviceId;
  label: string;
  preset?: string;
  ports: Port[];
  radios: Radio[];
  functions: Fn[];
  internal: InternalEdge[];
  mac?: MacAddr;
  ip?: string;
  prefix?: number;
  gateway?: string;
  vlan?: VlanId;
}

export interface Port {
  id: string;
  mtu: Bytes;
  ownedBy: FnId;
}

export interface Radio {
  id: string;
  band: '2.4' | '5' | '6';
}

export interface InternalEdge {
  from: FnId | string;
  to: FnId | string;
}

export type Fn =
  | {
      kind: 'bridging';
      id: FnId;
      vlanAware: boolean;
      canTag?: boolean;
      members: BridgePort[];
      fdb: Map<string, string>;
    }
  | {
      kind: 'stp';
      id: FnId;
      bridge: FnId;
      priority: number;
      baseMac: MacAddr;
      state: Map<string, Map<string, StpPortState>>;
    }
  | {
      kind: 'routing';
      id: FnId;
      ifaces: RouterIface[];
      routes: Route[];
      firewall: { from: VlanId; to: VlanId; action: 'allow' | 'deny' }[];
    }
  | {
      kind: 'nat';
      id: FnId;
      on: FnId;
      portForwards: PortForward[];
    }
  | { kind: 'dhcp-server'; id: FnId; scopes: DhcpScope[] }
  | { kind: 'dhcp-relay'; id: FnId; helper: string }
  | {
      kind: 'wireless';
      id: FnId;
      radio: string;
      mode: 'ap' | 'client' | 'mesh';
      ssid: string;
      vlan?: VlanId;
    }
  | {
      kind: 'isp-handoff';
      id: FnId;
      port: string;
      mode: 'pppoe' | 'dhcp' | 'static';
      vlanTag?: VlanId;
      credentials?: { user: string; pass: string };
      ip?: string;
      prefix?: number;
    };

export interface PortForward {
  proto: TransportProto;
  outsidePort: number;
  toIp: string;
  toPort: number;
}

export interface BridgePort {
  port: string;
  mode: 'access' | 'trunk';
  pvid: VlanId;
  taggedVlans: Set<VlanId>;
  untaggedVlans: Set<VlanId>;
  acceptableFrameTypes: 'all' | 'tagged-only' | 'untagged-only';
  ingressFiltering: boolean;
}

export interface RouterIface {
  id: string;
  vlan?: VlanId;
  ip: string;
  prefix: number;
  mac: MacAddr;
}

export interface Route {
  dest: string;
  prefix: number;
  via: string;
  fromVlan?: VlanId;
}

export interface DhcpScope {
  vlan: VlanId;
  poolStart: string;
  poolEnd: string;
  gateway: string;
  resolver: string;
}

export type FramePayload =
  | { kind: 'arp' | 'icmp'; srcIp?: string; dstIp?: string }
  | { kind: 'dhcp'; srcIp?: string; dstIp?: string; dhcpType?: string }
  | {
      kind: 'service';
      proto: TransportProto;
      dstPort: number;
      srcIp?: string;
      dstIp?: string;
      srcPort?: number;
    };

export interface Frame {
  srcMac: MacAddr;
  dstMac: MacAddr;
  vlan: VlanId | null;
  size: Bytes;
  encapsulation: Encapsulation[];
  payload: FramePayload;
  hops: Hop[];
}

export interface Hop {
  device: DeviceId;
  fn?: FnId;
  inPort?: string;
  outPort?: string;
  vlan: VlanId | null;
  action: HopAction;
  step: PipelineStep;
  reasonCode: ReasonCode;
  reason: string;
  provenance?: { profile: string; version: string; fields: string[] };
}

export interface Flow {
  id: string;
  request: Frame;
  reply?: Frame;
  outcome: 'round-trip' | 'request-failed' | 'reply-failed';
  asymmetric?: boolean;
}

export type { PipelineStep, Outcome, ReasonCode };

export function isGroupMac(mac: MacAddr): boolean {
  const first = mac.split(':')[0];
  if (first === undefined) return false;
  const octet = Number.parseInt(first, 16);
  return Number.isFinite(octet) && (octet & 1) === 1;
}

/** Native VLAN is derived for display, never stored (ADR 0008). */
export function nativeVlanOf(port: BridgePort): VlanId | undefined {
  if (port.untaggedVlans.size !== 1) return undefined;
  const [vlan] = port.untaggedVlans;
  return vlan;
}

/** VLANs this port is a member of on egress (tagged ∪ untagged). */
export function carriedVlans(port: BridgePort): Set<VlanId> {
  return new Set([...port.taggedVlans, ...port.untaggedVlans]);
}
