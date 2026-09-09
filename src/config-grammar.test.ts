import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SANDBOX_FORMAT, SANDBOX_VERSION, toJson } from './json';
import { createRunContext } from './run';
import { walkFrame } from './walk';
import {
  GRAMMAR_FORMAT,
  GRAMMAR_VERSION,
  UnknownGrammarFormatError,
  UnknownMappingTargetError,
  UnparseableConfigError,
  UnsupportedGrammarVersionError,
  importConfig,
} from './config-grammar';
import type { Frame } from './model';

const root = dirname(fileURLToPath(import.meta.url));
const grammar = JSON.parse(
  readFileSync(join(root, 'fixtures', 'kv-switch.grammar.json'), 'utf8'),
) as unknown;
const config = readFileSync(join(root, 'fixtures', 'kv-switch.config.txt'), 'utf8');

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('config grammar contract (#146)', () => {
  it('fixture grammar plus config builds a walkable Topology', () => {
    const topology = importConfig(grammar, config);
    expect(topology.devices).toHaveLength(1);
    const sw = topology.devices[0]!;
    expect(sw.id).toBe('sw-fixture');
    expect(sw.label).toBe('SW-fixture');
    const br = sw.functions.find((fn) => fn.kind === 'bridging');
    const member = br && br.kind === 'bridging' ? br.members[0] : undefined;
    expect(member?.pvid).toBe(20);
    expect(sw.provenance).toEqual({
      profile: 'fixture-kv-switch',
      version: '1',
      fields: ['chassis.id', 'chassis.label', 'access.pvid'],
    });
    expect(topology.profiles).toEqual([]);
    const ctx = createRunContext(topology);
    const frame: Frame = {
      srcMac: 'aa:00:00:00:00:01',
      dstMac: 'aa:00:00:00:00:02',
      vlan: null,
      size: 64,
      encapsulation: ['ethernet'],
      payload: { kind: 'icmp' },
      hops: [],
    };
    const result = walkFrame(ctx, {
      device: sw.id,
      inPort: '1',
      frame,
    });
    expect(result.hops.length).toBeGreaterThan(0);
  });

  it('sandbox JSON envelope is unchanged', () => {
    const topology = importConfig(grammar, config);
    const envelope = toJson(topology);
    expect(envelope.format).toBe(SANDBOX_FORMAT);
    expect(envelope.version).toBe(SANDBOX_VERSION);
    expect(envelope).toHaveProperty('topology');
  });

  it('unknown format, version, and mapping target throw named errors', () => {
    expect(() => importConfig({ format: 'nope', version: 1 }, 'hostname=a')).toThrow(
      UnknownGrammarFormatError,
    );
    expect(() =>
      importConfig({ format: GRAMMAR_FORMAT, version: 99, id: 'x', keys: {} }, 'hostname=a'),
    ).toThrow(UnsupportedGrammarVersionError);
    expect(() =>
      importConfig(
        {
          format: GRAMMAR_FORMAT,
          version: GRAMMAR_VERSION,
          id: 'x',
          grammarVersion: '1',
          keys: { hostname: 'pipeline.step' },
        },
        'hostname=a',
      ),
    ).toThrow(UnknownMappingTargetError);
  });

  it('generated config is Topology or UnparseableConfigError, never another error', () => {
    const rng = mulberry32(146);
    for (let i = 0; i < 64; i++) {
      const len = 1 + Math.floor(rng() * 40);
      let text = '';
      for (let j = 0; j < len; j++) {
        text += String.fromCharCode(32 + Math.floor(rng() * 95));
      }
      try {
        const topology = importConfig(grammar, text);
        expect(topology.devices.length).toBeGreaterThan(0);
      } catch (error) {
        expect(error).toBeInstanceOf(UnparseableConfigError);
      }
    }
  });
});
