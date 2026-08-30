import { defaults } from './defaults';
import type { HopFacts } from './format';
import {
  carriedVlans,
  type Chassis,
  type DeviceId,
  type Fn,
  type Link,
  type MacAddr,
  type StpPortState,
  type Topology,
  type VlanId,
} from './model';

export type StpStateMap = Map<DeviceId, Map<string, StpPortState>>;

export interface StpWarning {
  observation: 'single-instance-stp';
  device: DeviceId;
  facts: HopFacts;
}

interface StpBridge {
  device: DeviceId;
  priority: number;
  baseMac: MacAddr;
  ports: Set<string>;
}

interface Attachment {
  device: DeviceId;
  port: string;
}

interface Segment {
  attachments: Attachment[];
}

interface DirectedEdge {
  from: DeviceId;
  fromPort: string;
  to: DeviceId;
  toPort: string;
  cost: number;
}

interface PathRecord {
  cost: number;
  parent?: DeviceId;
  parentPort?: string;
  localPort?: string;
}

function stpFn(chassis: Chassis): Extract<Fn, { kind: 'stp' }> | undefined {
  return chassis.functions.find((fn) => fn.kind === 'stp');
}

function bridgingFn(
  chassis: Chassis,
  id: string,
): Extract<Fn, { kind: 'bridging' }> | undefined {
  const fn = chassis.functions.find((item) => item.id === id);
  return fn?.kind === 'bridging' ? fn : undefined;
}

function deviceMap(topology: Topology): Map<DeviceId, Chassis> {
  const map = new Map<DeviceId, Chassis>();
  for (const chassis of topology.devices) map.set(chassis.id, chassis);
  return map;
}

function collectBridges(topology: Topology): Map<DeviceId, StpBridge> {
  const bridges = new Map<DeviceId, StpBridge>();
  for (const chassis of topology.devices) {
    const stp = stpFn(chassis);
    if (!stp) continue;
    const bridge = bridgingFn(chassis, stp.bridge);
    const ports = new Set<string>();
    if (bridge) {
      for (const member of bridge.members) ports.add(member.port);
    }
    bridges.set(chassis.id, {
      device: chassis.id,
      priority: stp.priority,
      baseMac: stp.baseMac.toLowerCase(),
      ports,
    });
  }
  return bridges;
}

function compareBridgeId(a: StpBridge, b: StpBridge): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.baseMac < b.baseMac) return -1;
  if (a.baseMac > b.baseMac) return 1;
  return 0;
}

function comparePortId(a: string, b: string): number {
  const partsA = a.match(/\d+|\D+/g) ?? [a];
  const partsB = b.match(/\d+|\D+/g) ?? [b];
  const n = Math.min(partsA.length, partsB.length);
  for (let i = 0; i < n; i++) {
    const pa = partsA[i] ?? '';
    const pb = partsB[i] ?? '';
    const digitsA = /^\d+$/.test(pa);
    const digitsB = /^\d+$/.test(pb);
    if (digitsA && digitsB) {
      const diff = Number(pa) - Number(pb);
      if (diff !== 0) return diff;
      continue;
    }
    if (pa !== pb) return pa < pb ? -1 : 1;
  }
  return partsA.length - partsB.length;
}

function isStpPort(
  bridges: Map<DeviceId, StpBridge>,
  device: DeviceId,
  port: string,
): boolean {
  return bridges.get(device)?.ports.has(port) === true;
}

function farEnd(
  link: Link,
  device: DeviceId,
  port: string,
): { device: DeviceId; port: string } | undefined {
  if (link.a.device === device && link.a.port === port) return link.b;
  if (link.b.device === device && link.b.port === port) return link.a;
  return undefined;
}

function linksOf(topology: Topology, device: DeviceId, port: string): Link[] {
  return topology.links.filter(
    (link) =>
      (link.a.device === device && link.a.port === port) ||
      (link.b.device === device && link.b.port === port),
  );
}

/**
 * A down link carries no BPDUs and no frames: STP computes as if it were not
 * drawn (ADR 0020). Omitted `up` is up, so topologies without the field are
 * returned untouched.
 */
function upLinksOnly(topology: Topology): Topology {
  if (!topology.links.some((link) => link.up === false)) return topology;
  return {
    ...topology,
    links: topology.links.filter((link) => link.up !== false),
  };
}

/**
 * A segment is one LAN: a point-to-point link between two STP ports, a single
 * STP attachment facing only non-STP devices (an edge port), or every STP port
 * reachable from one another only through chassis that have no stp function.
 * Unmanaged switches are the LAN, not bridges, because they have no stp
 * function — not because we special-case their kind.
 */
function segments(
  topology: Topology,
  bridges: Map<DeviceId, StpBridge>,
): Segment[] {
  const result: Segment[] = [];
  const seenP2p = new Set<string>();
  const claimedShared = new Set<string>();

  const attachmentKey = (a: Attachment) => `${a.device}:${a.port}`;

  for (const link of topology.links) {
    const aStp = isStpPort(bridges, link.a.device, link.a.port);
    const bStp = isStpPort(bridges, link.b.device, link.b.port);
    if (aStp && bStp) {
      const key = [attachmentKey(link.a), attachmentKey(link.b)].sort().join('|');
      if (seenP2p.has(key)) continue;
      seenP2p.add(key);
      result.push({ attachments: [link.a, link.b] });
    }
  }

  for (const [device, bridge] of bridges) {
    for (const port of bridge.ports) {
      const origin: Attachment = { device, port };
      if (claimedShared.has(attachmentKey(origin))) continue;
      const startLinks = linksOf(topology, device, port);
      const hopsToNonStp = startLinks.filter((link) => {
        const far = farEnd(link, device, port);
        return far !== undefined && !isStpPort(bridges, far.device, far.port);
      });
      if (hopsToNonStp.length === 0) continue;

      const found: Attachment[] = [origin];
      const foundKeys = new Set([attachmentKey(origin)]);
      const visitedDevice = new Set<DeviceId>();
      const queue: DeviceId[] = [];

      for (const link of hopsToNonStp) {
        const far = farEnd(link, device, port);
        if (!far) continue;
        if (!visitedDevice.has(far.device)) {
          visitedDevice.add(far.device);
          queue.push(far.device);
        }
      }

      while (queue.length > 0) {
        const currentId = queue.shift();
        if (currentId === undefined) break;
        if (bridges.has(currentId)) continue;
        const chassis = topology.devices.find((c) => c.id === currentId);
        if (!chassis) continue;
        for (const cPort of chassis.ports) {
          for (const link of linksOf(topology, chassis.id, cPort.id)) {
            const far = farEnd(link, chassis.id, cPort.id);
            if (!far) continue;
            if (isStpPort(bridges, far.device, far.port)) {
              const att = { device: far.device, port: far.port };
              const key = attachmentKey(att);
              if (!foundKeys.has(key)) {
                foundKeys.add(key);
                found.push(att);
              }
            } else if (!bridges.has(far.device) && !visitedDevice.has(far.device)) {
              visitedDevice.add(far.device);
              queue.push(far.device);
            }
          }
        }
      }

      if (found.length < 1) continue;
      for (const att of found) claimedShared.add(attachmentKey(att));
      result.push({ attachments: found });
    }
  }

  return result;
}

function directedEdges(segs: Segment[], cost: number): DirectedEdge[] {
  const edges: DirectedEdge[] = [];
  for (const seg of segs) {
    for (const from of seg.attachments) {
      for (const to of seg.attachments) {
        if (from.device === to.device && from.port === to.port) continue;
        if (from.device === to.device) continue;
        edges.push({
          from: from.device,
          fromPort: from.port,
          to: to.device,
          toPort: to.port,
          cost,
        });
      }
    }
  }
  return edges;
}

function betterPath(
  candidate: PathRecord,
  current: PathRecord,
  bridges: Map<DeviceId, StpBridge>,
): boolean {
  if (candidate.cost < current.cost) return true;
  if (candidate.cost > current.cost) return false;
  const cParent = candidate.parent ? bridges.get(candidate.parent) : undefined;
  const pParent = current.parent ? bridges.get(current.parent) : undefined;
  if (cParent && pParent) {
    const bid = compareBridgeId(cParent, pParent);
    if (bid !== 0) return bid < 0;
  } else if (cParent && !pParent) {
    return true;
  } else if (!cParent && pParent) {
    return false;
  }
  if (
    candidate.parentPort !== undefined &&
    current.parentPort !== undefined
  ) {
    const dp = comparePortId(candidate.parentPort, current.parentPort);
    if (dp !== 0) return dp < 0;
  }
  if (candidate.localPort !== undefined && current.localPort !== undefined) {
    return comparePortId(candidate.localPort, current.localPort) < 0;
  }
  return false;
}

function connectedComponents(
  bridges: Map<DeviceId, StpBridge>,
  edges: DirectedEdge[],
): DeviceId[][] {
  const adj = new Map<DeviceId, Set<DeviceId>>();
  for (const id of bridges.keys()) adj.set(id, new Set());
  for (const edge of edges) {
    adj.get(edge.from)?.add(edge.to);
    adj.get(edge.to)?.add(edge.from);
  }
  const seen = new Set<DeviceId>();
  const comps: DeviceId[][] = [];
  for (const id of bridges.keys()) {
    if (seen.has(id)) continue;
    const stack = [id];
    const comp: DeviceId[] = [];
    seen.add(id);
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined) break;
      comp.push(cur);
      for (const next of adj.get(cur) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    comps.push(comp);
  }
  return comps;
}

function electRoot(
  component: DeviceId[],
  bridges: Map<DeviceId, StpBridge>,
): StpBridge {
  let root: StpBridge | undefined;
  for (const id of component) {
    const bridge = bridges.get(id);
    if (!bridge) continue;
    if (!root || compareBridgeId(bridge, root) < 0) root = bridge;
  }
  if (!root) {
    throw new Error('STP component has no bridge');
  }
  return root;
}

function dijkstra(
  rootId: DeviceId,
  component: Set<DeviceId>,
  edges: DirectedEdge[],
  bridges: Map<DeviceId, StpBridge>,
): Map<DeviceId, PathRecord> {
  const dist = new Map<DeviceId, PathRecord>();
  for (const id of component) {
    dist.set(id, { cost: id === rootId ? 0 : Number.POSITIVE_INFINITY });
  }
  const remaining = new Set(component);
  const outgoing = new Map<DeviceId, DirectedEdge[]>();
  for (const edge of edges) {
    if (!component.has(edge.from) || !component.has(edge.to)) continue;
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  while (remaining.size > 0) {
    let bestId: DeviceId | undefined;
    let bestRec: PathRecord | undefined;
    for (const id of remaining) {
      const rec = dist.get(id);
      if (!rec) continue;
      if (!bestId || !bestRec || betterPath(rec, bestRec, bridges)) {
        bestId = id;
        bestRec = rec;
      }
    }
    if (bestId === undefined || bestRec === undefined) break;
    remaining.delete(bestId);
    if (!Number.isFinite(bestRec.cost)) break;
    for (const edge of outgoing.get(bestId) ?? []) {
      if (!remaining.has(edge.to)) continue;
      const current = dist.get(edge.to);
      if (!current) continue;
      const candidate: PathRecord = {
        cost: bestRec.cost + edge.cost,
        parent: bestId,
        parentPort: edge.fromPort,
        localPort: edge.toPort,
      };
      if (betterPath(candidate, current, bridges)) {
        dist.set(edge.to, candidate);
      }
    }
  }
  return dist;
}

function designatedOnSegment(
  seg: Segment,
  dist: Map<DeviceId, PathRecord>,
  bridges: Map<DeviceId, StpBridge>,
): Attachment | undefined {
  let best: Attachment | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  let bestBridge: StpBridge | undefined;
  for (const att of seg.attachments) {
    const rec = dist.get(att.device);
    const bridge = bridges.get(att.device);
    if (!rec || !bridge || !Number.isFinite(rec.cost)) continue;
    const better =
      !best ||
      rec.cost < bestCost ||
      (rec.cost === bestCost &&
        bestBridge !== undefined &&
        (compareBridgeId(bridge, bestBridge) < 0 ||
          (compareBridgeId(bridge, bestBridge) === 0 &&
            comparePortId(att.port, best.port) < 0)));
    if (better) {
      best = att;
      bestCost = rec.cost;
      bestBridge = bridge;
    }
  }
  return best;
}

export function computeStp(topology: Topology): StpStateMap {
  const links = upLinksOnly(topology);
  const bridges = collectBridges(links);
  const state: StpStateMap = new Map();
  if (bridges.size === 0) return state;

  const segs = segments(links, bridges);
  const cost = defaults.stp.pathCost;
  const edges = directedEdges(segs, cost);
  const comps = connectedComponents(bridges, edges);

  const rootPort = new Map<DeviceId, string>();
  const distAll = new Map<DeviceId, PathRecord>();

  for (const comp of comps) {
    const root = electRoot(comp, bridges);
    const dist = dijkstra(root.device, new Set(comp), edges, bridges);
    for (const [id, rec] of dist) {
      distAll.set(id, rec);
      if (rec.localPort !== undefined) rootPort.set(id, rec.localPort);
    }
  }

  const designated = new Set<string>();
  for (const seg of segs) {
    const att = designatedOnSegment(seg, distAll, bridges);
    if (att) designated.add(`${att.device}:${att.port}`);
  }

  for (const [device, bridge] of bridges) {
    const ports = new Map<string, StpPortState>();
    for (const port of bridge.ports) {
      const linked = linksOf(links, device, port).length > 0;
      if (!linked) {
        ports.set(port, 'disabled');
        continue;
      }
      if (rootPort.get(device) === port) {
        ports.set(port, 'forwarding');
        continue;
      }
      if (designated.has(`${device}:${port}`)) {
        ports.set(port, 'forwarding');
        continue;
      }
      ports.set(port, 'blocking');
    }
    state.set(device, ports);
  }

  return state;
}

function vlansOnLink(
  topology: Topology,
  devices: Map<DeviceId, Chassis>,
  link: Link,
): Set<VlanId> {
  const vlansFor = (end: { device: DeviceId; port: string }): Set<VlanId> => {
    const chassis = devices.get(end.device);
    if (!chassis) return new Set();
    const stp = stpFn(chassis);
    if (!stp) return new Set();
    const bridge = bridgingFn(chassis, stp.bridge);
    const member = bridge?.members.find((m) => m.port === end.port);
    if (!member) return new Set();
    return carriedVlans(member);
  };
  const a = vlansFor(link.a);
  const b = vlansFor(link.b);
  const common = new Set<VlanId>();
  for (const vlan of a) {
    if (b.has(vlan)) common.add(vlan);
  }
  return common;
}

function commonVlansOnLinks(
  topology: Topology,
  devices: Map<DeviceId, Chassis>,
  a: Link,
  b: Link,
): VlanId[] {
  const left = vlansOnLink(topology, devices, a);
  const right = vlansOnLink(topology, devices, b);
  const common: VlanId[] = [];
  for (const vlan of left) {
    if (right.has(vlan)) common.push(vlan);
  }
  common.sort((x, y) => x - y);
  return common;
}

/**
 * ADR 0011: any two direct links between the same pair of STP bridges that
 * carry two or more VLANs in common. A third link that does not share those
 * VLANs must not suppress the warning. Shared LANs through a chassis with no
 * stp function are one segment, not parallel trunks, and are not grouped
 * here. Not a Hop — the tool's fidelity, not a verdict on the user's network.
 */
export function detectSingleInstanceWarnings(
  topology: Topology,
  stp: StpStateMap,
): StpWarning[] {
  const upTopo = upLinksOnly(topology);
  const bridges = collectBridges(upTopo);
  const devices = deviceMap(upTopo);
  const grouped = new Map<string, Link[]>();

  for (const link of upTopo.links) {
    if (!bridges.has(link.a.device) || !bridges.has(link.b.device)) continue;
    const pair =
      link.a.device < link.b.device
        ? `${link.a.device}::${link.b.device}`
        : `${link.b.device}::${link.a.device}`;
    const list = grouped.get(pair) ?? [];
    list.push(link);
    grouped.set(pair, list);
  }

  const warnings: StpWarning[] = [];
  for (const [pair, links] of grouped) {
    if (links.length < 2) continue;
    let chosen: { pairLinks: [Link, Link]; vlans: VlanId[] } | undefined;
    for (let i = 0; i < links.length && !chosen; i++) {
      const first = links[i];
      if (!first) continue;
      for (let j = i + 1; j < links.length; j++) {
        const second = links[j];
        if (!second) continue;
        const common = commonVlansOnLinks(upTopo, devices, first, second);
        if (common.length < 2) continue;
        chosen = { pairLinks: [first, second], vlans: common };
        break;
      }
    }
    if (!chosen) continue;
    const fromVlan = chosen.vlans[0];
    const toVlan = chosen.vlans[1];
    if (fromVlan === undefined || toVlan === undefined) continue;

    const [left, right] = pair.split('::') as [DeviceId, DeviceId];
    const ends: Attachment[] = [];
    for (const item of chosen.pairLinks) {
      ends.push(item.a, item.b);
    }
    let blocked: Attachment | undefined;
    for (const att of ends) {
      if (stp.get(att.device)?.get(att.port) === 'blocking') {
        if (
          !blocked ||
          comparePortId(att.port, blocked.port) > 0 ||
          (att.port === blocked.port && att.device > blocked.device)
        ) {
          blocked = att;
        }
      }
    }
    if (!blocked) {
      const ports = ends.map((e) => e.port).sort(comparePortId);
      const port = ports[ports.length - 1];
      blocked = ends.find((e) => e.port === port);
    }
    if (!blocked) continue;

    warnings.push({
      observation: 'single-instance-stp',
      device: blocked.device,
      facts: {
        port: blocked.port,
        fromVlan,
        toVlan,
        devices: [left, right],
      },
    });
  }
  return warnings;
}
