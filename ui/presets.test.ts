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
});
