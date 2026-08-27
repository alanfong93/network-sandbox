import { describe, expect, it } from 'vitest';
import { builtinProfile, defaults } from './defaults';
import type { Chassis, Topology } from './model';
import {
  createRunContext,
  getResolvedMac,
  learn,
  lookup,
  portState,
  setResolvedMac,
} from './run';

function host(id: string): Chassis {
  return {
    id,
    label: id,
    ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'none' }],
    radios: [],
    functions: [],
    internal: [],
  };
}

const empty: Topology = { devices: [host('H1')], links: [], profiles: [] };

describe('run context', () => {
  it('computes the converged state before any frame exists', () => {
    const ctx = createRunContext(empty);
    expect(ctx.hopsLeft).toBe(defaults.maxHops);
    expect(ctx.profile).toBe(builtinProfile);
    expect(ctx.fdb.size).toBe(0);
    expect(ctx.resolvedMacs.size).toBe(0);
    expect(ctx.warnings).toEqual([]);
  });

  it('discards tables and counters when the caller drops the context', () => {
    const ctx1 = createRunContext(empty);
    learn(ctx1, 10, 'aa:bb:cc:dd:ee:01', 'H1', '1');
    setResolvedMac(ctx1, 'H1|192.168.10.1', 'aa:bb:cc:dd:ee:02');
    ctx1.hopsLeft = 3;

    const ctx2 = createRunContext(empty);
    expect(lookup(ctx2, 10, 'aa:bb:cc:dd:ee:01')).toBeUndefined();
    expect(getResolvedMac(ctx2, 'H1|192.168.10.1')).toBeUndefined();
    expect(ctx2.hopsLeft).toBe(defaults.maxHops);
    expect(ctx2.fdb.size).toBe(0);
    expect(ctx2.resolvedMacs.size).toBe(0);
    expect(lookup(ctx1, 10, 'aa:bb:cc:dd:ee:01')?.port).toBe('1');
  });

  it('does not share maps across runs', () => {
    const ctx1 = createRunContext(empty);
    const ctx2 = createRunContext(empty);
    expect(ctx1.fdb).not.toBe(ctx2.fdb);
    expect(ctx1.resolvedMacs).not.toBe(ctx2.resolvedMacs);
    expect(ctx1.pendingSends).not.toBe(ctx2.pendingSends);
    expect(ctx1.stp).not.toBe(ctx2.stp);
    expect(ctx1.warnings).not.toBe(ctx2.warnings);
  });

  it('returns forwarding for a chassis that never entered the stp map', () => {
    const ctx = createRunContext(empty);
    expect(ctx.stp.has('H1')).toBe(false);
    expect(portState(ctx, 'H1', '1')).toBe('forwarding');
  });
});
