import { describe, expect, it } from 'vitest';
import { PRESETS } from './presets';

const FN_KINDS = [
  'bridging',
  'stp',
  'routing',
  'nat',
  'dhcp-server',
  'dhcp-relay',
  'wireless',
  'isp-handoff',
] as const;

describe('presets', () => {
  it('every palette entry writes functions, not a device kind (ADR 0013)', () => {
    for (const preset of PRESETS) {
      const chassis = preset.build(`${preset.id}-1`, 1);
      expect(
        chassis,
        `${preset.id} must not carry a device kind`,
      ).not.toHaveProperty('kind');
      for (const fn of chassis.functions) {
        expect(
          FN_KINDS,
          `${preset.id} wrote unknown function kind ${String(
            (fn as { kind: unknown }).kind,
          )}`,
        ).toContain(fn.kind);
      }
    }
  });

  it('host is a chassis with no functions and one port', () => {
    const chassis = PRESETS.find((p) => p.id === 'host')?.build('h1', 1);
    expect(chassis).toBeDefined();
    expect(chassis?.functions).toEqual([]);
    expect(chassis?.internal).toEqual([]);
    expect(chassis?.ports).toHaveLength(1);
    expect(chassis?.ports[0]?.ownedBy).toBe('none');
    expect(chassis?.mac).toBeDefined();
    expect(chassis?.ip).toBeDefined();
    expect(chassis?.gateway).toBeDefined();
  });

  it('managed switch writes bridging and stp, members match ports', () => {
    const chassis = PRESETS.find((p) => p.id === 'switch')?.build('sw1', 1);
    expect(chassis).toBeDefined();
    const bridge = chassis?.functions.find((fn) => fn.kind === 'bridging');
    expect(bridge).toBeDefined();
    const stp = chassis?.functions.find((fn) => fn.kind === 'stp');
    expect(stp).toBeDefined();
    expect(chassis?.ports).toHaveLength(4);
    expect(bridge && bridge.kind === 'bridging' ? bridge.members : []).toEqual(
      chassis?.ports.map((port) => expect.objectContaining({ port: port.id })),
    );
    for (const member of bridge && bridge.kind === 'bridging' ? bridge.members : []) {
      expect(member.untaggedVlans).toEqual(new Set([member.pvid]));
    }
  });

  it('unmanaged switch is vlan-blind and has no stp (ADR 0007)', () => {
    const chassis = PRESETS.find((p) => p.id === 'unmanaged-switch')?.build(
      'usw1',
      1,
    );
    const bridge = chassis?.functions.find((fn) => fn.kind === 'bridging');
    expect(bridge && bridge.kind === 'bridging' ? bridge.vlanAware : null).toBe(
      false,
    );
    expect(chassis?.functions.some((fn) => fn.kind === 'stp')).toBe(false);
  });

  it('router writes routing plus nat', () => {
    const chassis = PRESETS.find((p) => p.id === 'router')?.build('rtr1', 1);
    const routing = chassis?.functions.find((fn) => fn.kind === 'routing');
    expect(routing && routing.kind === 'routing' ? routing.ifaces : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lan' }),
        expect.objectContaining({ id: 'wan', vlan: 500 }),
      ]),
    );
    expect(chassis?.functions.some((fn) => fn.kind === 'nat')).toBe(true);
  });

  it('access point writes a radio, a wireless function, and a bridge', () => {
    const chassis = PRESETS.find((p) => p.id === 'access-point')?.build(
      'ap1',
      1,
    );
    expect(chassis?.radios).toHaveLength(1);
    const wlan = chassis?.functions.find((fn) => fn.kind === 'wireless');
    expect(wlan && wlan.kind === 'wireless' ? wlan.mode : null).toBe('ap');
    expect(chassis?.functions.some((fn) => fn.kind === 'bridging')).toBe(true);
  });

  it('modem writes an isp-handoff', () => {
    const chassis = PRESETS.find((p) => p.id === 'modem')?.build('ont1', 1);
    const isp = chassis?.functions.find((fn) => fn.kind === 'isp-handoff');
    expect(isp && isp.kind === 'isp-handoff' ? isp.mode : null).toBe('pppoe');
    expect(isp && isp.kind === 'isp-handoff' ? isp.vlanTag : null).toBe(500);
  });

  it('l3-switch writes bridging + stp + routing with SVI-shaped ifaces (#71 composition)', () => {
    const chassis = PRESETS.find((p) => p.id === 'l3-switch')?.build('l3s1', 1);
    expect(chassis).toBeDefined();
    const bridge = chassis?.functions.find((fn) => fn.kind === 'bridging');
    expect(bridge && bridge.kind === 'bridging' ? bridge.vlanAware : null).toBe(
      true,
    );
    expect(chassis?.functions.some((fn) => fn.kind === 'stp')).toBe(true);
    const routing = chassis?.functions.find((fn) => fn.kind === 'routing');
    expect(routing).toBeDefined();
    if (routing?.kind !== 'routing') return;
    // Every routing iface is an SVI: an rt-owned port that is also a bridging
    // member of its VLAN (#71's composition shape).
    for (const iface of routing.ifaces) {
      expect(chassis?.ports.some((p) => p.id === iface.id && p.ownedBy === 'rt'))
        .toBe(true);
      expect(
        bridge &&
          bridge.kind === 'bridging' &&
          bridge.members.some((m) => m.port === iface.id),
      ).toBe(true);
    }
    // The rt->br InternalEdge carries routed egress back into the bridge.
    expect(
      chassis?.internal.some((edge) => edge.from === 'rt' && edge.to === 'br'),
    ).toBe(true);
  });

  it('dhcp-server writes a host-like chassis with one default scope', () => {
    const chassis = PRESETS.find((p) => p.id === 'dhcp-server')?.build(
      'srv1',
      1,
    );
    expect(chassis).toBeDefined();
    // Host-like addressing: its own identity answers the OFFER (#72).
    expect(chassis?.mac).toBeDefined();
    expect(chassis?.ip).toBeDefined();
    expect(chassis?.prefix).toBeDefined();
    expect(chassis?.vlan).toBe(10);
    const server = chassis?.functions.find((fn) => fn.kind === 'dhcp-server');
    expect(server && server.kind === 'dhcp-server' ? server.scopes : []).toEqual(
      [
        expect.objectContaining({
          vlan: 10,
          poolStart: '192.168.10.100',
          poolEnd: '192.168.10.199',
          gateway: '192.168.10.1',
          resolver: '192.168.10.1',
        }),
      ],
    );
    // The field is resolver, never dns (CONTEXT).
    expect(JSON.stringify(chassis)).not.toMatch(/"dns"/i);
  });
});
