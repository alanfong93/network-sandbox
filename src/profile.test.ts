import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { builtinProfile, type EngineProfile } from './defaults';
import type { MacAddr, Topology, VlanId } from './model';
import {
  InvalidProfileError,
  MissingProfileIdError,
  MultipleNonBuiltinProfilesError,
  PROFILE_FORMAT,
  PROFILE_VERSION,
  ProfileMismatchError,
  UnknownCapabilityError,
  UnknownProfileFormatError,
  UnregisteredProfileError,
  UnsupportedProfileVersionError,
  createProfileRegistry,
  fromProfileJson,
  resolveProfile,
  toProfileJson,
  type ProfileEnvelope,
} from './profile';
import { createRunContext } from './run';
import { walkFrame } from './walk';
import { referenceScenario } from './wan.fixture';

const cheapSiliconPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'profiles',
  'cheap-silicon.json',
);

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function generatedProfile(seed: number): EngineProfile {
  const rng = mulberry32(seed);
  return {
    id: `p-${seed}`,
    version: String(1 + Math.floor(rng() * 9)),
    unmanagedTag: rng() < 0.5 ? 'pass' : 'strip',
  };
}

describe('profile JSON contract', () => {
  it('is the version-1 envelope {format, version, profile}', () => {
    const envelope = toProfileJson(builtinProfile);
    expect(envelope).toEqual({
      format: PROFILE_FORMAT,
      version: PROFILE_VERSION,
      profile: {
        id: 'ieee-defaults',
        version: '1',
        unmanagedTag: 'pass',
        capabilities: {},
      },
    });
    expectTypeOf<ProfileEnvelope>().toHaveProperty('format');
    expectTypeOf<ProfileEnvelope>().toHaveProperty('version');
    expectTypeOf<ProfileEnvelope>().toHaveProperty('profile');
    expectTypeOf<ProfileEnvelope>().not.toHaveProperty('topology');
  });

  it('round-trips the committed cheap-silicon document', () => {
    const raw = readFileSync(cheapSiliconPath, 'utf8');
    const parsed = fromProfileJson(raw);
    expect(parsed).toEqual({
      id: 'cheap-silicon',
      version: '1',
      unmanagedTag: 'strip',
    });
    expect(fromProfileJson(toProfileJson(parsed))).toEqual(parsed);
    const envelope = JSON.parse(raw) as ProfileEnvelope;
    expect(envelope.format).toBe(PROFILE_FORMAT);
    expect(envelope.version).toBe(PROFILE_VERSION);
    expect(envelope.profile.capabilities).toEqual({});
  });

  it('accepts empty capabilities', () => {
    expect(
      fromProfileJson({
        format: PROFILE_FORMAT,
        version: PROFILE_VERSION,
        profile: {
          id: 'ieee-defaults',
          version: '1',
          unmanagedTag: 'pass',
          capabilities: {},
        },
      }),
    ).toEqual(builtinProfile);
  });

  it('rejects an unknown format by name, not SyntaxError', () => {
    const envelope = { format: 'network-sandbox', version: 1, profile: { id: 'x' } };
    expect(() => fromProfileJson(envelope)).toThrow(UnknownProfileFormatError);
    try {
      fromProfileJson(envelope);
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownProfileFormatError);
      expect(err).not.toBeInstanceOf(SyntaxError);
      expect((err as UnknownProfileFormatError).name).toBe('UnknownProfileFormatError');
      expect((err as UnknownProfileFormatError).format).toBe('network-sandbox');
    }
  });

  it('rejects an unknown version by name, not SyntaxError', () => {
    const envelope = {
      format: PROFILE_FORMAT,
      version: 2,
      profile: { id: 'x', version: '1', unmanagedTag: 'pass', capabilities: {} },
    };
    expect(() => fromProfileJson(envelope)).toThrow(UnsupportedProfileVersionError);
    try {
      fromProfileJson(envelope);
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedProfileVersionError);
      expect(err).not.toBeInstanceOf(SyntaxError);
      expect((err as UnsupportedProfileVersionError).name).toBe(
        'UnsupportedProfileVersionError',
      );
      expect((err as UnsupportedProfileVersionError).version).toBe(2);
    }
  });

  it('rejects a missing id by name', () => {
    const envelope = {
      format: PROFILE_FORMAT,
      version: PROFILE_VERSION,
      profile: { version: '1', unmanagedTag: 'pass', capabilities: {} },
    };
    expect(() => fromProfileJson(envelope)).toThrow(MissingProfileIdError);
  });

  it('rejects an unknown capability key by name', () => {
    const envelope = {
      format: PROFILE_FORMAT,
      version: PROFILE_VERSION,
      profile: {
        id: 'x',
        version: '1',
        unmanagedTag: 'pass',
        capabilities: { pvst: true },
      },
    };
    expect(() => fromProfileJson(envelope)).toThrow(UnknownCapabilityError);
    try {
      fromProfileJson(envelope);
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownCapabilityError);
      expect((err as UnknownCapabilityError).key).toBe('pvst');
    }
  });
});

describe('profile JSON properties', () => {
  it('round-trips generated profiles', () => {
    for (let seed = 0; seed < 64; seed++) {
      const profile = generatedProfile(seed);
      expect(fromProfileJson(toProfileJson(profile)), `seed ${seed}`).toEqual(profile);
    }
  });

  it('rejects generated unknown formats by name', () => {
    for (let seed = 0; seed < 32; seed++) {
      const rng = mulberry32(seed);
      const format = `fmt-${rng().toString(36).slice(2)}`;
      expect(
        () =>
          fromProfileJson({
            format,
            version: PROFILE_VERSION,
            profile: toProfileJson(generatedProfile(seed)).profile,
          }),
        `seed ${seed}`,
      ).toThrow(UnknownProfileFormatError);
    }
  });

  it('rejects generated unknown versions by name', () => {
    for (let seed = 0; seed < 32; seed++) {
      const rng = mulberry32(seed);
      let version: unknown = 2 + Math.floor(rng() * 8);
      if (rng() < 0.3) version = String(version);
      if (rng() < 0.2) version = 0;
      expect(
        () =>
          fromProfileJson({
            format: PROFILE_FORMAT,
            version,
            profile: toProfileJson(generatedProfile(seed)).profile,
          }),
        `seed ${seed}`,
      ).toThrow(UnsupportedProfileVersionError);
    }
  });

  it('rejects generated missing ids by name', () => {
    const blanks: unknown[] = [undefined, '', 12, null];
    for (const id of blanks) {
      expect(
        () =>
          fromProfileJson({
            format: PROFILE_FORMAT,
            version: PROFILE_VERSION,
            profile: {
              ...(id === undefined ? {} : { id }),
              version: '1',
              unmanagedTag: 'pass',
              capabilities: {},
            },
          }),
        `id ${String(id)}`,
      ).toThrow(MissingProfileIdError);
    }
  });

  it('rejects generated extra capability keys by name', () => {
    for (let seed = 0; seed < 32; seed++) {
      const rng = mulberry32(seed);
      const key = `cap-${Math.floor(rng() * 1000)}`;
      try {
        fromProfileJson({
          format: PROFILE_FORMAT,
          version: PROFILE_VERSION,
          profile: {
            id: `p-${seed}`,
            version: '1',
            unmanagedTag: 'pass',
            capabilities: { [key]: rng() < 0.5 },
          },
        });
        expect.unreachable(`seed ${seed} accepted ${key}`);
      } catch (err) {
        expect(err, `seed ${seed}`).toBeInstanceOf(UnknownCapabilityError);
        expect((err as UnknownCapabilityError).key, `seed ${seed}`).toBe(key);
      }
    }
  });
});

describe('profile registry', () => {
  it('always registers ieee-defaults v1', () => {
    const cheap = fromProfileJson(readFileSync(cheapSiliconPath, 'utf8'));
    const registry = createProfileRegistry([cheap]);
    expect(registry.get('ieee-defaults')).toBe(builtinProfile);
    expect(registry.get('cheap-silicon')).toEqual(cheap);
  });

  it('empty ids or only ieee-defaults resolve to builtin', () => {
    const registry = createProfileRegistry();
    expect(resolveProfile([], registry)).toBe(builtinProfile);
    expect(resolveProfile(['ieee-defaults'], registry)).toBe(builtinProfile);
  });

  it('injects a profile object only when the id list is empty', () => {
    const cheap = fromProfileJson(readFileSync(cheapSiliconPath, 'utf8'));
    const registry = createProfileRegistry([cheap]);
    expect(resolveProfile([], registry, cheap)).toEqual(cheap);
    expect(() => resolveProfile(['ieee-defaults'], registry, cheap)).toThrow(
      ProfileMismatchError,
    );
  });

  it('resolves a registered non-builtin id', () => {
    const cheap = fromProfileJson(readFileSync(cheapSiliconPath, 'utf8'));
    const registry = createProfileRegistry([cheap]);
    expect(resolveProfile(['cheap-silicon'], registry)).toEqual(cheap);
    expect(resolveProfile(['ieee-defaults', 'cheap-silicon'], registry)).toEqual(cheap);
  });

  it('rejects an unregistered id by name', () => {
    expect(() => resolveProfile(['no-such'], createProfileRegistry())).toThrow(
      UnregisteredProfileError,
    );
    try {
      resolveProfile(['no-such'], createProfileRegistry());
    } catch (err) {
      expect(err).toBeInstanceOf(UnregisteredProfileError);
      expect((err as UnregisteredProfileError).id).toBe('no-such');
    }
  });

  it('rejects more than one non-builtin id by name', () => {
    const a: EngineProfile = { id: 'a', version: '1', unmanagedTag: 'pass' };
    const b: EngineProfile = { id: 'b', version: '1', unmanagedTag: 'strip' };
    const registry = createProfileRegistry([a, b]);
    expect(() => resolveProfile(['a', 'b'], registry)).toThrow(
      MultipleNonBuiltinProfilesError,
    );
  });

  it('rejects generated pairs of non-builtin ids by name', () => {
    for (let seed = 0; seed < 32; seed++) {
      const a = generatedProfile(seed);
      const b = generatedProfile(seed + 100);
      if (a.id === b.id) continue;
      const registry = createProfileRegistry([a, b]);
      expect(
        () => resolveProfile([a.id, b.id], registry),
        `seed ${seed}`,
      ).toThrow(MultipleNonBuiltinProfilesError);
    }
  });
});

describe('createRunContext profile resolution', () => {
  const tagged = {
    srcMac: 'aa:00:00:00:00:10' as MacAddr,
    dstMac: 'aa:00:00:00:00:20' as MacAddr,
    vlan: 20 as VlanId,
    size: 64,
    encapsulation: ['ethernet', 'vlan-tag'] as const,
    payload: { kind: 'icmp' as const },
    hops: [],
  };

  it('selects strip vs pass from topology.profiles plus a registry', () => {
    const cheap = fromProfileJson(readFileSync(cheapSiliconPath, 'utf8'));
    const registry = createProfileRegistry([cheap]);
    const topology: Topology = referenceScenario();
    topology.profiles = ['cheap-silicon'];
    const ctx = createRunContext(topology, undefined, registry);
    expect(ctx.profile).toEqual(cheap);
    const result = walkFrame(ctx, {
      device: 'USW',
      inPort: '2',
      frame: { ...tagged, encapsulation: [...tagged.encapsulation] },
    });
    expect(
      result.hops.find((hop) => hop.device === 'USW' && hop.fn === 'br')?.provenance,
    ).toEqual({
      profile: 'cheap-silicon',
      version: '1',
      fields: ['unmanagedTag'],
    });
  });

  it('does not require a second-argument object when the id is registered', () => {
    const cheap = fromProfileJson(readFileSync(cheapSiliconPath, 'utf8'));
    const topology = referenceScenario();
    topology.profiles = ['cheap-silicon'];
    const ctx = createRunContext(topology, undefined, createProfileRegistry([cheap]));
    expect(ctx.profile.id).toBe('cheap-silicon');
  });
});
