import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toJson } from './json';
import { homeNetwork, missingReturnRoute } from '../ui/starters';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'starters');

describe('missing-return-route JSON document', () => {
  it('is the sandbox envelope of missingReturnRoute()', () => {
    const file = JSON.parse(readFileSync(join(uiDir, 'missing-return-route.json'), 'utf8')) as unknown;
    expect(file).toEqual(JSON.parse(JSON.stringify(toJson(missingReturnRoute()))));
  });
});

describe('home-network JSON document (#164)', () => {
  it('is the sandbox envelope of homeNetwork()', () => {
    const file = JSON.parse(readFileSync(join(uiDir, 'home-network.json'), 'utf8')) as unknown;
    expect(file).toEqual(JSON.parse(JSON.stringify(toJson(homeNetwork()))));
  });
});
