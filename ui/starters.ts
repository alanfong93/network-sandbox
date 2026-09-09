import { defaults, type Topology } from '../src/index';

export function missingReturnRoute(): Topology {
  return {
    devices: [
      {
        id: 'H2',
        label: 'H2',
        ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'none' }],
        radios: [],
        functions: [],
        internal: [],
        mac: 'aa:00:00:00:00:20',
        ip: '192.168.50.10',
        prefix: 24,
        gateway: '192.168.50.1',
      },
      {
        id: 'R2',
        label: 'R2',
        ports: [
          { id: '1', mtu: defaults.portMtu, ownedBy: 'rt' },
          { id: '2', mtu: defaults.portMtu, ownedBy: 'rt' },
        ],
        radios: [],
        functions: [
          {
            kind: 'routing',
            id: 'rt',
            ifaces: [
              { id: '1', ip: '192.168.50.1', prefix: 24, mac: 'aa:00:00:00:02:01' },
              { id: '2', ip: '192.168.1.2', prefix: 24, mac: 'aa:00:00:00:02:02' },
            ],
            routes: [{ dest: '0.0.0.0', prefix: 0, via: '192.168.1.1' }],
            firewall: [],
          },
        ],
        internal: [],
      },
      {
        id: 'R1',
        label: 'R1',
        ports: [
          { id: '1', mtu: defaults.portMtu, ownedBy: 'rt' },
          { id: '2', mtu: defaults.portMtu, ownedBy: 'rt' },
        ],
        radios: [],
        functions: [
          {
            kind: 'routing',
            id: 'rt',
            ifaces: [
              { id: '1', ip: '192.168.1.1', prefix: 24, mac: 'aa:00:00:00:01:01' },
              { id: '2', ip: '10.20.0.1', prefix: 24, mac: 'aa:00:00:00:01:02' },
            ],
            routes: [],
            firewall: [],
          },
        ],
        internal: [],
      },
      {
        id: 'H1',
        label: 'H1',
        ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'none' }],
        radios: [],
        functions: [],
        internal: [],
        mac: 'aa:00:00:00:00:05',
        ip: '10.20.0.5',
        prefix: 24,
        gateway: '10.20.0.1',
      },
    ],
    links: [
      {
        id: 'h2',
        a: { device: 'H2', port: '1' },
        b: { device: 'R2', port: '1' },
        medium: 'wired',
      },
      {
        id: '12',
        a: { device: 'R2', port: '2' },
        b: { device: 'R1', port: '1' },
        medium: 'wired',
      },
      {
        id: 'h1',
        a: { device: 'H1', port: '1' },
        b: { device: 'R1', port: '2' },
        medium: 'wired',
      },
    ],
    profiles: [],
  };
}
