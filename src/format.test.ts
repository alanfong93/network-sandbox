import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  format,
  formatEstimate,
  shortMac,
  type Estimate,
  type FormatInput,
} from './format';

describe('format', () => {
  it('abbreviates a MAC the way the catalogue does', () => {
    expect(shortMac('aa:bb:cc:dd:ee:01')).toBe('aa:..:01');
  });

  it('still produces a reason for a hop with no catalogue template', () => {
    expect(
      format({
        kind: 'hop',
        device: 'SW1',
        inPort: '1',
        vlan: 10,
        action: 'forwarded',
        step: 'egress-tagging',
        outcome: 'forwarded',
      }),
    ).toBe('forwarded at SW1 port 1 (egress-tagging)');
  });

  it('names the query and the device on a delivered udp/53 hop (#126)', () => {
    expect(
      format({
        kind: 'hop',
        device: 'DNS1',
        inPort: '1',
        vlan: 10,
        action: 'delivered',
        step: 'delivery',
        outcome: 'delivered',
        facts: { name: 'google.com', dstPort: 53, ip: '192.168.10.53' },
      }),
    ).toBe('Query for google.com delivered at DNS1');
  });

  it('states when the sender has no advertised resolver (#126)', () => {
    expect(format({ kind: 'flow', observation: 'no-resolver', facts: {} })).toBe(
      'Sender has no advertised resolver',
    );
  });

  it('names the table that lacked the record (#126)', () => {
    expect(
      format({
        kind: 'flow',
        observation: 'no-record',
        facts: { name: 'nas.home', devices: ['DNS1'] },
      }),
    ).toBe('No record for nas.home at DNS1');
  });
});

describe('Estimate seam (ADR 0006, ADR 0024)', () => {
  // Hand-authored fixture: a stage-4-style coverage estimate.
  const coverage: Estimate = {
    kind: 'estimate',
    assumptions: [
      'walls are drywall, not brick or concrete',
      'the AP sits at ceiling height, central in the floor plan',
      'no neighbouring networks contend for the band',
    ],
  };

  it('is not a FormatInput — format(estimate) is a type error', () => {
    expectTypeOf<FormatInput['kind']>().toEqualTypeOf<
      'hop' | 'trace' | 'flow' | 'warning'
    >();
    expectTypeOf<Estimate>().not.toExtend<FormatInput>();
  });

  it('cannot be constructed with empty assumptions', () => {
    expectTypeOf<Estimate['assumptions']>().toEqualTypeOf<
      [string, ...string[]]
    >();
    expectTypeOf<[]>().not.toExtend<Estimate['assumptions']>();
  });

  it('formatEstimate names itself and lists every assumption', () => {
    expect(formatEstimate(coverage)).toBe(
      'Estimate, not a trace — assuming: walls are drywall, not brick or concrete; ' +
        'the AP sits at ceiling height, central in the floor plan; ' +
        'no neighbouring networks contend for the band',
    );
  });

  it('formatEstimate uses none of the hop verbs', () => {
    expect(formatEstimate(coverage).toLowerCase()).not.toMatch(
      /\b(forwarded|flooded|dropped|delivered)\b/,
    );
  });
});
