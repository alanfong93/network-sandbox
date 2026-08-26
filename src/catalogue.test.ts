import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import { format } from './format';

describe('catalogue', () => {
  it('carries all 23 rows with stable ids', () => {
    expect(CATALOGUE).toHaveLength(23);
    expect(CATALOGUE.map((row) => row.id)).toEqual(
      Array.from({ length: 23 }, (_, i) => i + 1),
    );
  });

  it('marks row 20 as stage 2 and every other row as stage 1', () => {
    for (const row of CATALOGUE) {
      if (row.id === 20) expect(row.stage).toBe(2);
      else expect(row.stage).toBe(1);
    }
  });

  it('renders every row verbatim from its structured example', () => {
    for (const row of CATALOGUE) {
      expect(format(row.example), `row ${row.id}`).toBe(row.expected);
    }
  });
});
