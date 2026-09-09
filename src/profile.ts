import { builtinProfile, type EngineProfile } from './defaults';

export const PROFILE_FORMAT = 'network-sandbox-profile';
export const PROFILE_VERSION = 1;

export interface ProfileDocument {
  id: string;
  version: string;
  unmanagedTag: EngineProfile['unmanagedTag'];
  capabilities: Record<string, never>;
}

export interface ProfileEnvelope {
  format: typeof PROFILE_FORMAT;
  version: typeof PROFILE_VERSION;
  profile: ProfileDocument;
}

export type ProfileRegistry = ReadonlyMap<string, EngineProfile>;

export class UnknownProfileFormatError extends Error {
  override readonly name = 'UnknownProfileFormatError';
  readonly format: unknown;

  constructor(format: unknown) {
    super(`unknown profile format: ${String(format)}`);
    this.format = format;
  }
}

export class UnsupportedProfileVersionError extends Error {
  override readonly name = 'UnsupportedProfileVersionError';
  readonly version: unknown;

  constructor(version: unknown) {
    super(`unsupported profile version: ${String(version)}`);
    this.version = version;
  }
}

export class MissingProfileIdError extends Error {
  override readonly name = 'MissingProfileIdError';

  constructor() {
    super('profile id is required');
  }
}

export class InvalidProfileError extends Error {
  override readonly name = 'InvalidProfileError';
  readonly field: string;

  constructor(field: string) {
    super(`invalid profile field: ${field}`);
    this.field = field;
  }
}

export class UnknownCapabilityError extends Error {
  override readonly name = 'UnknownCapabilityError';
  readonly key: string;

  constructor(key: string) {
    super(`unknown capability: ${key}`);
    this.key = key;
  }
}

export class UnregisteredProfileError extends Error {
  override readonly name = 'UnregisteredProfileError';
  readonly id: string;

  constructor(id: string) {
    super(`unregistered profile id: ${id}`);
    this.id = id;
  }
}

export class MultipleNonBuiltinProfilesError extends Error {
  override readonly name = 'MultipleNonBuiltinProfilesError';
  readonly ids: readonly string[];

  constructor(ids: readonly string[]) {
    super(`multiple non-builtin profile ids: ${ids.join(', ')}`);
    this.ids = ids;
  }
}

export class ProfileMismatchError extends Error {
  override readonly name = 'ProfileMismatchError';
  readonly injected: string;
  readonly resolved: string;

  constructor(injected: string, resolved: string) {
    super(`profile mismatch: injected ${injected} !== resolved ${resolved}`);
    this.injected = injected;
    this.resolved = resolved;
  }
}

export function toProfileJson(profile: EngineProfile): ProfileEnvelope {
  return {
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    profile: {
      id: profile.id,
      version: profile.version,
      unmanagedTag: profile.unmanagedTag,
      capabilities: {},
    },
  };
}

export function fromProfileJson(input: unknown): EngineProfile {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UnknownProfileFormatError(undefined);
  }
  const rec = value as Record<string, unknown>;
  if (rec.format !== PROFILE_FORMAT) {
    throw new UnknownProfileFormatError(rec.format);
  }
  if (rec.version !== PROFILE_VERSION) {
    throw new UnsupportedProfileVersionError(rec.version);
  }
  if (typeof rec.profile !== 'object' || rec.profile === null || Array.isArray(rec.profile)) {
    throw new MissingProfileIdError();
  }
  const body = rec.profile as Record<string, unknown>;
  if (typeof body.id !== 'string' || body.id.length === 0) {
    throw new MissingProfileIdError();
  }
  const unmanagedTag = body.unmanagedTag;
  if (unmanagedTag !== 'pass' && unmanagedTag !== 'strip') {
    throw new InvalidProfileError('unmanagedTag');
  }
  if (body.capabilities !== undefined) {
    if (
      typeof body.capabilities !== 'object' ||
      body.capabilities === null ||
      Array.isArray(body.capabilities)
    ) {
      throw new InvalidProfileError('capabilities');
    }
    const keys = Object.keys(body.capabilities);
    const extra = keys[0];
    if (extra !== undefined) {
      throw new UnknownCapabilityError(extra);
    }
  }
  return {
    id: body.id,
    version: typeof body.version === 'string' && body.version.length > 0 ? body.version : '1',
    unmanagedTag,
  };
}

export function createProfileRegistry(
  extras: Iterable<EngineProfile> = [],
): Map<string, EngineProfile> {
  const map = new Map<string, EngineProfile>();
  for (const profile of extras) {
    map.set(profile.id, profile);
  }
  map.set(builtinProfile.id, builtinProfile);
  return map;
}

export function resolveProfile(
  ids: readonly string[],
  registry: ProfileRegistry,
  injected?: EngineProfile,
): EngineProfile {
  const map = createProfileRegistry(registry.values());
  const unique = [...new Set(ids)];
  const nonBuiltin = unique.filter((id) => id !== builtinProfile.id);
  if (nonBuiltin.length > 1) {
    throw new MultipleNonBuiltinProfilesError(nonBuiltin);
  }
  if (ids.length === 0) {
    return injected ?? builtinProfile;
  }
  const targetId = nonBuiltin[0] ?? builtinProfile.id;
  const resolved = map.get(targetId);
  if (resolved === undefined) {
    throw new UnregisteredProfileError(targetId);
  }
  if (injected !== undefined && !profilesAgree(injected, resolved)) {
    throw new ProfileMismatchError(injected.id, resolved.id);
  }
  return resolved;
}

function profilesAgree(a: EngineProfile, b: EngineProfile): boolean {
  return a.id === b.id && a.version === b.version && a.unmanagedTag === b.unmanagedTag;
}
