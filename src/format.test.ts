import { describe, expect, it } from 'vitest';
import { format, shortMac } from './format';

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
});
