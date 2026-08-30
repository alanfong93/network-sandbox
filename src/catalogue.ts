import type { FormatInput } from './format';

export type CatalogueStage = 1 | 2 | 3;

export interface CatalogueRow {
  id: number;
  device: string;
  mistake: string;
  expected: string;
  stage: CatalogueStage;
  example: FormatInput;
}

export const CATALOGUE: readonly CatalogueRow[] = [
  {
    id: 1,
    device: 'Managed switch',
    mistake: "VLAN missing from the trunk's allowed list",
    expected:
      'Dropped at SW2 port 3 (egress): port is not a member of VLAN 20',
    stage: 1,
    example: {
      kind: 'hop',
      device: 'SW2',
      outPort: '3',
      vlan: 20,
      action: 'dropped',
      step: 'egress-membership',
      outcome: 'dropped',
    },
  },
  {
    id: 2,
    device: 'Managed switch',
    mistake: "Trunk's egress-untagged VLAN ≠ far end's ingress PVID",
    expected:
      'Untagged frame entered VLAN 10 at SW1, arrived as VLAN 20 at SW2 — VLAN leak',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'vlan-leak',
      facts: { fromVlan: 10, toVlan: 20, devices: ['SW1', 'SW2'] },
    },
  },
  {
    id: 3,
    device: 'Managed switch',
    mistake: 'Access port on the wrong PVID',
    expected: 'Host got 192.168.20.51 — expected VLAN 10',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'wrong-pvid-lease',
      facts: { ip: '192.168.20.51', expectedVlan: 10 },
    },
  },
  {
    id: 4,
    device: 'Managed switch',
    mistake: 'Ingress filtering off, tagged frame on an access port',
    expected: 'Admitted only because ingress filtering is disabled',
    stage: 1,
    example: {
      kind: 'hop',
      device: 'SW1',
      inPort: '1',
      vlan: 20,
      action: 'forwarded',
      step: 'ingress-filtering',
      outcome: 'admitted',
    },
  },
  {
    id: 5,
    device: 'Unmanaged switch',
    mistake: 'Expecting per-port VLANs on it',
    expected:
      'This device has no VLAN awareness — all 5 ports are one broadcast domain',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'unmanaged-flood',
      facts: { portCount: 5 },
    },
  },
  {
    id: 6,
    device: 'Unmanaged switch',
    mistake: 'Loop through two unmanaged switches',
    expected:
      'Frame has looped 50x — no BPDUs on this path, STP cannot break this loop',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'loop',
      facts: { count: 50 },
    },
  },
  {
    id: 7,
    device: 'Router',
    mistake: 'Gateway IP on the wrong VLAN subinterface',
    expected:
      'ARP for 192.168.10.1 flooded VLAN 10 — no reply; gateway is on VLAN 20',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'arp-no-reply',
      facts: { ip: '192.168.10.1', fromVlan: 10, otherVlan: 20 },
    },
  },
  {
    id: 8,
    device: 'Router',
    mistake: 'DHCP server on another VLAN, no relay',
    expected:
      'DHCP DISCOVER flooded VLAN 30 — no server is a member. Add a relay on the VLAN 30 interface',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'dhcp-no-server',
      facts: { fromVlan: 30 },
    },
  },
  {
    id: 9,
    device: 'Router',
    mistake: 'Firewall denies inter-VLAN return traffic',
    expected:
      'ICMP reached VLAN 20; reply dropped by rule VLAN20 -> VLAN10 deny',
    stage: 1,
    example: {
      kind: 'flow',
      observation: 'firewall-reply',
      facts: { reachedVlan: 20, fromVlan: 20, toVlan: 10 },
    },
  },
  {
    id: 10,
    device: 'Downstream router',
    mistake: 'Overlapping subnet with a tier above',
    expected:
      'Destination 192.168.1.50 matches the local subnet — never sent upstream',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'local-subnet',
      facts: { ip: '192.168.1.50' },
    },
  },
  {
    id: 11,
    device: 'Downstream router',
    mistake: 'Second DHCP server on the upstream LAN',
    expected: 'Two DHCP OFFERs for the same DISCOVER — from R1 and R2',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'dual-offer',
      facts: { devices: ['R1', 'R2'] },
    },
  },
  {
    id: 12,
    device: 'Downstream router',
    mistake: 'Double NAT',
    expected:
      'Two NAT translations on this path — inbound connections cannot be initiated',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'double-nat',
      facts: {},
    },
  },
  {
    id: 13,
    device: 'Downstream router',
    mistake: 'Missing return route (NAT off)',
    expected:
      'Reached 10.20.0.5 via R2. Reply to 192.168.50.10 dropped at R1: no route — add 192.168.50.0/24 via R2',
    stage: 1,
    example: {
      kind: 'flow',
      observation: 'missing-return-route',
      facts: {
        otherIp: '10.20.0.5',
        via: 'R2',
        ip: '192.168.50.10',
        devices: ['R1'],
        prefix: '192.168.50.0/24',
      },
    },
  },
  {
    id: 14,
    device: 'Multi-tier',
    mistake: 'DHCP relay chain broken at a middle tier',
    expected:
      'DISCOVER relayed R3->R2, stopped at R2: no helper address toward R1',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'relay-chain',
      facts: { path: ['R3', 'R2'], devices: ['R2'], toward: 'R1' },
    },
  },
  {
    id: 15,
    device: 'Multi-tier',
    mistake: 'Asymmetric path',
    expected: 'Request R1->R2->R4; reply R4->R3->R1 — return path differs',
    stage: 1,
    example: {
      kind: 'flow',
      observation: 'asymmetric-path',
      facts: { path: ['R1', 'R2', 'R4'], returnPath: ['R4', 'R3', 'R1'] },
    },
  },
  {
    id: 16,
    device: 'STP',
    mistake: 'Redundant link, STP off',
    expected:
      'MAC aa:..:01 seen on port 1 and port 2 within one step — MAC table is flapping',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'mac-flap',
      facts: {
        mac: 'aa:bb:cc:dd:ee:01',
        port: '1',
        otherPort: '2',
      },
    },
  },
  {
    id: 17,
    device: 'STP',
    mistake: 'Bridge priority makes the wrong switch root',
    expected:
      'Root is SW3 (priority 4096). Traffic SW1->SW2 now transits SW3',
    stage: 1,
    example: {
      kind: 'trace',
      observation: 'stp-root',
      facts: { devices: ['SW3'], priority: 4096, path: ['SW1', 'SW2'] },
    },
  },
  {
    id: 18,
    device: 'Managed switch',
    mistake: 'Trunk set to tag everything on egress, far end still sends untagged',
    expected:
      'SW1 port 2 admits tagged frames only; the untagged frame from SW2 was dropped at ingress',
    stage: 1,
    example: {
      kind: 'hop',
      device: 'SW1',
      inPort: '2',
      vlan: null,
      action: 'dropped',
      step: 'acceptable-frame-types',
      outcome: 'dropped',
      facts: { otherDevice: 'SW2' },
    },
  },
  {
    id: 19,
    device: 'STP',
    mistake: 'Two parallel trunks, two VLANs, expecting per-VLAN load balancing',
    expected:
      'This model runs one spanning tree: port 2 is blocked for every VLAN. Gear defaulting to Rapid PVST+ may forward VLAN 10 here and VLAN 20 on the other trunk',
    stage: 1,
    example: {
      kind: 'warning',
      observation: 'single-instance-stp',
      facts: { port: '2', fromVlan: 10, toVlan: 20 },
    },
  },
  {
    id: 20,
    device: 'Mesh AP',
    mistake: 'Consumer mesh in AP mode expected to carry tagged VLANs',
    expected:
      'Guest SSID maps to VLAN 30, but this node passes untagged only — clients landed in VLAN 10 with everything else',
    stage: 2,
    example: {
      kind: 'trace',
      observation: 'ssid-untagged',
      facts: { mappedVlan: 30, landedVlan: 10 },
    },
  },
  {
    id: 21,
    device: 'Downstream router',
    mistake:
      'Port forward set on the inner router only, behind a second NAT',
    expected:
      'Port forward on R2 was never reached — dropped at R1 NAT: no matching forward',
    stage: 1,
    example: {
      kind: 'hop',
      device: 'R1',
      vlan: null,
      action: 'dropped',
      step: 'port-forward',
      outcome: 'dropped',
      facts: { otherDevice: 'R2' },
    },
  },
  {
    id: 22,
    device: 'Router',
    mistake: 'Port forward points at a subnet the router cannot reach',
    expected:
      'Port forward to 10.99.0.10:443 dropped at R1: no interface on 10.99.0.0/24',
    stage: 1,
    example: {
      kind: 'hop',
      device: 'R1',
      vlan: null,
      action: 'dropped',
      step: 'port-forward',
      outcome: 'dropped',
      facts: { ip: '10.99.0.10', dstPort: 443, prefix: '10.99.0.0/24' },
    },
  },
  {
    id: 23,
    device: 'Router',
    mistake:
      "DHCP hands out a resolver the client's VLAN cannot reach",
    expected:
      'Query to 192.168.10.1:53 left VLAN 30; dropped by rule VLAN30 -> VLAN10 deny',
    stage: 1,
    example: {
      kind: 'hop',
      device: 'R1',
      vlan: 30,
      action: 'dropped',
      step: 'firewall',
      outcome: 'dropped',
      facts: {
        ip: '192.168.10.1',
        dstPort: 53,
        fromVlan: 30,
        toVlan: 10,
      },
    },
  },
  {
    id: 24,
    device: 'Multi-WAN router',
    mistake: 'Second WAN route added for VLAN 30 without its fromVlan selector',
    expected:
      'VLAN 30 frame forwarded via 198.51.100.1 by destination-only lookup - no route carries a VLAN 30 selector',
    stage: 3,
    example: {
      kind: 'hop',
      device: 'R1',
      outPort: 'wan1',
      vlan: 30,
      action: 'forwarded',
      step: 'route-lookup',
      outcome: 'forwarded',
      facts: { fromVlan: 30, via: '198.51.100.1' },
    },
  },
  {
    id: 25,
    device: 'Multi-WAN router',
    mistake: "WAN1 down and the only default route was WAN1's — no failover default",
    expected:
      'Default via 192.0.2.1 skipped: its link is down — no usable route to 203.0.113.1',
    stage: 3,
    example: {
      kind: 'hop',
      device: 'RTR',
      inPort: 'lan',
      vlan: 10,
      action: 'dropped',
      step: 'route-lookup',
      outcome: 'dropped',
      facts: { via: '192.0.2.1', ip: '203.0.113.1' },
    },
  },
];
