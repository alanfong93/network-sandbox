import { describe, expect, it } from 'vitest';
import {
  OUTCOMES,
  PIPELINE_STEPS,
  reasonCode,
  reasonCodeIsProduct,
  type ReasonCode,
} from './reasons';

describe('reason codes', () => {
  it('are exactly the product of steps × outcomes', () => {
    expect(reasonCodeIsProduct).toBe(true);
    expect(PIPELINE_STEPS.length * OUTCOMES.length).toBeGreaterThan(0);

    const product = new Set<ReasonCode>();
    for (const step of PIPELINE_STEPS) {
      for (const outcome of OUTCOMES) {
        product.add(reasonCode(step, outcome));
      }
    }
    expect(product.size).toBe(PIPELINE_STEPS.length * OUTCOMES.length);
  });

  it('builds a code from a step and an outcome, never a scenario name', () => {
    expect(reasonCode('egress-membership', 'dropped')).toBe(
      'egress-membership:dropped',
    );
    const code: ReasonCode = reasonCode('firewall', 'dropped');
    expect(code.includes('row')).toBe(false);
    expect(code.includes('catalogue')).toBe(false);
  });
});
