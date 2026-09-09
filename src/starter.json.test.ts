import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toJson } from './json';
import { missingReturnRoute } from '../ui/starters';

const jsonPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'ui',
  'starters',
  'missing-return-route.json',
);

describe('missing-return-route JSON document', () => {
  it('is the sandbox envelope of missingReturnRoute()', () => {
    const file = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
    expect(file).toEqual(JSON.parse(JSON.stringify(toJson(missingReturnRoute()))));
  });
});
