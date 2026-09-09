import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../src/catalogue';
import { format } from '../src/format';
import { createRunContext } from '../src/run';
import { flowObservationAsFormatInput, runFlow } from '../src/flow';
import { PRESETS } from './presets';
import { loadTopology } from './state';
import { missingReturnRoute } from './starters';

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
