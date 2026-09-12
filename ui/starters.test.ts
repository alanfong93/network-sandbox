import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../src/catalogue';
import { format } from '../src/format';
import { createRunContext } from '../src/run';
import { flowObservationAsFormatInput, runFlow } from '../src/flow';
import { PRESETS } from './presets';
import { loadTopology } from './state';
import {
  STARTERS,
  homeNetwork,
  missingReturnRoute,
  starterById,
} from './starters';
import { toJson } from '../src/json';
import { importSandbox } from './jsonio';
import { runTrace } from './trace';

const row13 = CATALOGUE.find((row) => row.id === 13);

describe('missing-return-route starter', () => {

  it('neither router carries a nat function', () => {
    for (const id of ['R1', 'R2'] as const) {
      const chassis = missingReturnRoute().devices.find((device) => device.id === id);
      expect(chassis?.functions.some((fn) => fn.kind === 'nat'), id).toBe(false);
    }
  });

  it('Send from H2 to 10.20.0.5 produces catalogue row 13 verbatim', () => {
    expect(row13).toBeDefined();
    if (!row13) return;
    const ctx = createRunContext(missingReturnRoute());
    const result = runFlow(ctx, {
      from: 'H2',
      dstIp: '10.20.0.5',
      payload: { kind: 'icmp', srcIp: '192.168.50.10', dstIp: '10.20.0.5' },
    });
    const entry = result.observations.find(
      (item) =>
        item.kind === 'flow' &&
        item.observation.observation === 'missing-return-route',
    );
    expect(entry?.kind).toBe('flow');
    if (entry?.kind !== 'flow') return;
    expect(format(flowObservationAsFormatInput(entry.observation))).toBe(row13.expected);
  });

  it('loadTopology replaces the editor with the starter', () => {
    const state = loadTopology(missingReturnRoute());
    expect(state.topology.devices.map((d) => d.id)).toEqual(['H2', 'R2', 'R1', 'H1']);
    expect(state.selected).toBeNull();
  });

  it('a newly placed router still writes nat (ADR 0005)', () => {
    const chassis = PRESETS.find((p) => p.id === 'router')?.build('rtr1', 1);
    expect(chassis?.functions.some((fn) => fn.kind === 'nat')).toBe(true);
  });
});

describe('starter registry (#164)', () => {
  it('lists the shipped starters in a stable order', () => {
    expect(STARTERS.map((starter) => starter.id)).toEqual([
      'home-network',
      'missing-return-route',
    ]);
    for (const starter of STARTERS) {
      expect(starter.label).not.toBe('');
    }
  });

  it('every starter round-trips through the sandbox envelope', () => {
    for (const starter of STARTERS) {
      const file = JSON.stringify(toJson(starter.load()));
      expect(importSandbox(file).topology).toEqual(starter.load());
    }
  });

  it('starterById finds each entry', () => {
    expect(starterById('home-network')).toBeDefined();
    expect(starterById('missing-return-route')?.load()).toEqual(missingReturnRoute());
    expect(starterById('no-such-starter')).toBeUndefined();
  });
});

describe('home-network starter (#164)', () => {
  it('devices[0] is H1 — the send form\'s default From (traceFromId falls back to devices[0])', () => {
    expect(homeNetwork().devices[0]?.id).toBe('H1');
  });

  it('H2 sits at 192.168.1.11 — the send form\'s shipped default destination (main.ts lastDst)', () => {
    const h2 = homeNetwork().devices.find((device) => device.id === 'H2');
    expect(h2?.ip).toBe('192.168.1.11');
  });

  it('is the specified topology: modem -> router (1 WAN, 4 LAN jacks) -> 2 hosts', () => {
    const topology = homeNetwork();
    expect(topology.devices.map((device) => device.id)).toEqual(['H1', 'H2', 'R1', 'M1']);
    const router = topology.devices.find((device) => device.id === 'R1');
    expect(router?.functions.some((fn) => fn.kind === 'nat')).toBe(true);
    const lanJacks = router?.ports.filter(
      (port) => /^lan\d*$/.test(port.id) && port.ownedBy === 'br',
    );
    expect(lanJacks?.map((port) => port.id)).toEqual(['lan', 'lan2', 'lan3', 'lan4']);
    expect(router?.ports.some((port) => port.id === 'wan' && port.ownedBy === 'rt')).toBe(true);
    const modem = topology.devices.find((device) => device.id === 'M1');
    const handoff = modem?.functions.find((fn) => fn.kind === 'isp-handoff');
    expect(handoff?.kind === 'isp-handoff' && handoff.mode).toBe('dhcp');
    // Link shape: modem customer port <-> router WAN, one LAN jack per host.
    expect(topology.links.map((link) => `${link.a.device}:${link.a.port}-${link.b.device}:${link.b.port}`).sort()).toEqual([
      'H1:1-R1:lan',
      'H2:1-R1:lan2',
      'M1:1-R1:wan',
    ]);
  });

  it('carries no credentials anywhere (#65 hygiene)', () => {
    expect(JSON.stringify(toJson(homeNetwork()))).not.toContain('credentials');
  });

  it('H1 pings H2 out of the box: Send unchanged reads a round-trip trace', () => {
    const trace = runTrace(homeNetwork(), { from: 'H1', dstIp: '192.168.1.11' });
    expect(trace.outcome).toBe('round-trip');
    expect(trace.requestHops.length).toBeGreaterThan(0);
  });
});
