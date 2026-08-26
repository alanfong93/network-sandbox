import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import { defaults } from './defaults';
import { format } from './format';
import type {
  BridgePort,
  Chassis,
  DeviceId,
  Link,
  MacAddr,
  Topology,
  VlanId,
} from './model';
import { createRunContext, portState, warningAsFormatInput } from './run';

function trunk(port: string, vlans: VlanId[], pvid = 1): BridgePort {
  return {
    port,
    mode: 'trunk',
    pvid,
    taggedVlans: new Set(vlans),
    untaggedVlans: new Set(),
    acceptableFrameTypes: 'all',
    ingressFiltering: true,
  };
}

function access(port: string, vlan: VlanId): BridgePort {
  return {
    port,
    mode: 'access',
    pvid: vlan,
    taggedVlans: new Set(),
    untaggedVlans: new Set([vlan]),
    acceptableFrameTypes: 'all',
    ingressFiltering: true,
  };
}

function managedSwitch(
  id: DeviceId,
  mac: MacAddr,
  ports: string[],
  vlans: VlanId[],
  priority = defaults.stp.priority,
): Chassis {
  return {
    id,
    label: id,
    ports: ports.map((port) => ({
      id: port,
      mtu: defaults.portMtu,
      ownedBy: 'br',
    })),
    radios: [],
    functions: [
      {
        kind: 'bridging',
        id: 'br',
        vlanAware: true,
        members: ports.map((port) => trunk(port, vlans)),
        fdb: new Map(),
      },
      {
        kind: 'stp',
        id: 'stp',
        bridge: 'br',
        priority,
        baseMac: mac,
        state: new Map(),
      },
    ],
    internal: [],
  };
}

function unmanagedSwitch(id: DeviceId, ports: string[]): Chassis {
  return {
    id,
    label: id,
    ports: ports.map((port) => ({
      id: port,
      mtu: defaults.portMtu,
      ownedBy: 'br',
    })),
    radios: [],
    functions: [
      {
        kind: 'bridging',
        id: 'br',
        vlanAware: false,
        members: ports.map((port) => access(port, 1)),
        fdb: new Map(),
      },
    ],
    internal: [],
  };
}

function link(
  id: string,
  a: { device: DeviceId; port: string },
  b: { device: DeviceId; port: string },
): Link {
  return { id, a, b, medium: 'wired' };
}

function topology(devices: Chassis[], links: Link[]): Topology {
  return { devices, links, profiles: [] };
}

const row19 = CATALOGUE.find((row) => row.id === 19);

describe('spanning tree', () => {
  it('leaves every port forwarding when the chassis has no stp function', () => {
    const topo = topology(
      [
        unmanagedSwitch('USW1', ['1', '2']),
        unmanagedSwitch('USW2', ['1', '2']),
      ],
      [
        link('l1', { device: 'USW1', port: '1' }, { device: 'USW2', port: '1' }),
        link('l2', { device: 'USW1', port: '2' }, { device: 'USW2', port: '2' }),
      ],
    );
    const ctx = createRunContext(topo);
    expect(ctx.stp.has('USW1')).toBe(false);
    expect(ctx.stp.has('USW2')).toBe(false);
    expect(portState(ctx, 'USW1', '1')).toBe('forwarding');
    expect(portState(ctx, 'USW1', '2')).toBe('forwarding');
    expect(portState(ctx, 'USW2', '1')).toBe('forwarding');
    expect(portState(ctx, 'USW2', '2')).toBe('forwarding');
  });

  it('forwards a single link between two stp bridges', () => {
    const topo = topology(
      [
        managedSwitch('SW1', 'aa:00:00:00:00:01', ['1'], [10]),
        managedSwitch('SW2', 'aa:00:00:00:00:02', ['1'], [10]),
      ],
      [link('l1', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' })],
    );
    const ctx = createRunContext(topo);
    expect(portState(ctx, 'SW1', '1')).toBe('forwarding');
    expect(portState(ctx, 'SW2', '1')).toBe('forwarding');
    expect(ctx.warnings).toEqual([]);
  });

  it('blocks the higher-numbered port on the non-root when two trunks run in parallel', () => {
    const topo = topology(
      [
        managedSwitch('SW1', 'aa:00:00:00:00:01', ['1', '2'], [10, 20]),
        managedSwitch('SW2', 'aa:00:00:00:00:02', ['1', '2'], [10, 20]),
      ],
      [
        link('l1', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' }),
        link('l2', { device: 'SW1', port: '2' }, { device: 'SW2', port: '2' }),
      ],
    );
    const ctx = createRunContext(topo);
    expect(portState(ctx, 'SW1', '1')).toBe('forwarding');
    expect(portState(ctx, 'SW1', '2')).toBe('forwarding');
    expect(portState(ctx, 'SW2', '1')).toBe('forwarding');
    expect(portState(ctx, 'SW2', '2')).toBe('blocking');
  });

  it('marks an unlinked member port disabled', () => {
    const topo = topology(
      [managedSwitch('SW1', 'aa:00:00:00:00:01', ['1', '2'], [10])],
      [],
    );
    const ctx = createRunContext(topo);
    expect(portState(ctx, 'SW1', '1')).toBe('disabled');
    expect(portState(ctx, 'SW1', '2')).toBe('disabled');
  });

  it('elects the lower priority as root and still forwards a line of switches', () => {
    const topo = topology(
      [
        managedSwitch('SW1', 'aa:00:00:00:00:01', ['1'], [10], 32768),
        managedSwitch('SW2', 'aa:00:00:00:00:02', ['1', '2'], [10], 32768),
        managedSwitch('SW3', 'aa:00:00:00:00:03', ['1'], [10], 4096),
      ],
      [
        link('l1', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' }),
        link('l2', { device: 'SW2', port: '2' }, { device: 'SW3', port: '1' }),
      ],
    );
    const ctx = createRunContext(topo);
    expect(portState(ctx, 'SW1', '1')).toBe('forwarding');
    expect(portState(ctx, 'SW2', '1')).toBe('forwarding');
    expect(portState(ctx, 'SW2', '2')).toBe('forwarding');
    expect(portState(ctx, 'SW3', '1')).toBe('forwarding');
  });

  it('blocks one port of a triangle of stp bridges', () => {
    const topo = topology(
      [
        managedSwitch('SW1', 'aa:00:00:00:00:01', ['1', '2'], [10]),
        managedSwitch('SW2', 'aa:00:00:00:00:02', ['1', '2'], [10]),
        managedSwitch('SW3', 'aa:00:00:00:00:03', ['1', '2'], [10]),
      ],
      [
        link('a', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' }),
        link('b', { device: 'SW2', port: '2' }, { device: 'SW3', port: '1' }),
        link('c', { device: 'SW3', port: '2' }, { device: 'SW1', port: '2' }),
      ],
    );
    const ctx = createRunContext(topo);
    const states = [
      portState(ctx, 'SW1', '1'),
      portState(ctx, 'SW1', '2'),
      portState(ctx, 'SW2', '1'),
      portState(ctx, 'SW2', '2'),
      portState(ctx, 'SW3', '1'),
      portState(ctx, 'SW3', '2'),
    ];
    expect(states.filter((s) => s === 'blocking')).toHaveLength(1);
    expect(states.filter((s) => s === 'forwarding')).toHaveLength(5);
  });

  it('does not write converged state onto the topology', () => {
    const sw = managedSwitch('SW1', 'aa:00:00:00:00:01', ['1', '2'], [10, 20]);
    const topo = topology(
      [sw, managedSwitch('SW2', 'aa:00:00:00:00:02', ['1', '2'], [10, 20])],
      [
        link('l1', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' }),
        link('l2', { device: 'SW1', port: '2' }, { device: 'SW2', port: '2' }),
      ],
    );
    createRunContext(topo);
    const stp = sw.functions.find((fn) => fn.kind === 'stp');
    expect(stp?.kind === 'stp' ? stp.state.size : -1).toBe(0);
  });

  it('treats an unmanaged switch as a shared LAN, not an stp bridge', () => {
    const topo = topology(
      [
        managedSwitch('SW1', 'aa:00:00:00:00:01', ['1', '2'], [10, 20]),
        managedSwitch('SW2', 'aa:00:00:00:00:02', ['1', '2'], [10, 20]),
        unmanagedSwitch('USW', ['1', '2']),
      ],
      [
        link('p2p', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' }),
        link('a', { device: 'SW1', port: '2' }, { device: 'USW', port: '1' }),
        link('b', { device: 'SW2', port: '2' }, { device: 'USW', port: '2' }),
      ],
    );
    const ctx = createRunContext(topo);
    expect(ctx.stp.has('USW')).toBe(false);
    expect(portState(ctx, 'USW', '1')).toBe('forwarding');
    const blocked = [
      portState(ctx, 'SW1', '1') === 'blocking',
      portState(ctx, 'SW1', '2') === 'blocking',
      portState(ctx, 'SW2', '1') === 'blocking',
      portState(ctx, 'SW2', '2') === 'blocking',
    ].filter(Boolean);
    expect(blocked).toHaveLength(1);
  });
});

describe('catalogue row 19', () => {
  const topo = topology(
    [
      managedSwitch('SW1', 'aa:00:00:00:00:01', ['1', '2'], [10, 20]),
      managedSwitch('SW2', 'aa:00:00:00:00:02', ['1', '2'], [10, 20]),
    ],
    [
      link('l1', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' }),
      link('l2', { device: 'SW1', port: '2' }, { device: 'SW2', port: '2' }),
    ],
  );

  it('is green structurally', () => {
    const ctx = createRunContext(topo);
    expect(portState(ctx, 'SW2', '2')).toBe('blocking');
    expect(ctx.warnings).toHaveLength(1);
    const warning = ctx.warnings[0];
    expect(warning?.observation).toBe('single-instance-stp');
    expect(warning?.facts.port).toBe('2');
    expect(warning?.facts.fromVlan).toBe(10);
    expect(warning?.facts.toVlan).toBe(20);
    expect(warning?.device).toBe('SW2');
  });

  it('is green verbatim against the catalogue table', () => {
    expect(row19).toBeDefined();
    const ctx = createRunContext(topo);
    const warning = ctx.warnings[0];
    expect(warning).toBeDefined();
    if (!warning || !row19) return;
    expect(format(warningAsFormatInput(warning))).toBe(row19.expected);
  });

  it('does not fire when the parallel links share only one VLAN', () => {
    const oneVlan = topology(
      [
        managedSwitch('SW1', 'aa:00:00:00:00:01', ['1', '2'], [10]),
        managedSwitch('SW2', 'aa:00:00:00:00:02', ['1', '2'], [10]),
      ],
      [
        link('l1', { device: 'SW1', port: '1' }, { device: 'SW2', port: '1' }),
        link('l2', { device: 'SW1', port: '2' }, { device: 'SW2', port: '2' }),
      ],
    );
    const ctx = createRunContext(oneVlan);
    expect(portState(ctx, 'SW2', '2')).toBe('blocking');
    expect(ctx.warnings).toEqual([]);
  });
});
