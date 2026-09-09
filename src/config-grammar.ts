import { defaults } from './defaults';
import type { Chassis, Topology, VlanId } from './model';

export const GRAMMAR_FORMAT = 'network-sandbox-config-grammar';
export const GRAMMAR_VERSION = 1;

const TARGETS = new Set(['chassis.id', 'chassis.label', 'access.pvid']);

export class UnknownGrammarFormatError extends Error {
  override readonly name = 'UnknownGrammarFormatError';
  readonly format: unknown;

  constructor(format: unknown) {
    super(`unknown config grammar format: ${String(format)}`);
    this.format = format;
  }
}

export class UnsupportedGrammarVersionError extends Error {
  override readonly name = 'UnsupportedGrammarVersionError';
  readonly version: unknown;

  constructor(version: unknown) {
    super(`unsupported config grammar version: ${String(version)}`);
    this.version = version;
  }
}

export class UnknownMappingTargetError extends Error {
  override readonly name = 'UnknownMappingTargetError';
  readonly target: string;

  constructor(target: string) {
    super(`unknown mapping target: ${target}`);
    this.target = target;
  }
}

export class UnparseableConfigError extends Error {
  override readonly name = 'UnparseableConfigError';

  constructor(message = 'unparseable device config') {
    super(message);
  }
}

interface GrammarDocument {
  id: string;
  grammarVersion: string;
  keys: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGrammar(value: unknown): GrammarDocument {
  if (!isRecord(value)) {
    throw new UnknownGrammarFormatError(undefined);
  }
  if (value.format !== GRAMMAR_FORMAT) {
    throw new UnknownGrammarFormatError(value.format);
  }
  if (value.version !== GRAMMAR_VERSION) {
    throw new UnsupportedGrammarVersionError(value.version);
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') {
    throw new UnparseableConfigError('grammar id is required');
  }
  if (typeof value.grammarVersion !== 'string' || value.grammarVersion.trim() === '') {
    throw new UnparseableConfigError('grammarVersion is required');
  }
  if (!isRecord(value.keys)) {
    throw new UnparseableConfigError('grammar keys are required');
  }
  const keys: Record<string, string> = {};
  for (const [key, target] of Object.entries(value.keys)) {
    if (typeof target !== 'string') {
      throw new UnparseableConfigError(`grammar key ${key} is not a target`);
    }
    if (!TARGETS.has(target)) {
      throw new UnknownMappingTargetError(target);
    }
    keys[key] = target;
  }
  return {
    id: value.id.trim(),
    grammarVersion: value.grammarVersion.trim(),
    keys,
  };
}

function parseAssignments(text: string): Map<string, string> {
  if (typeof text !== 'string') {
    throw new UnparseableConfigError();
  }
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new UnparseableConfigError();
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key === '' || val === '') throw new UnparseableConfigError();
    out.set(key, val);
  }
  return out;
}

export function importConfig(grammarJson: unknown, text: string): Topology {
  const grammar = parseGrammar(grammarJson);
  const raw = parseAssignments(text);
  const assigned = new Map<string, string>();
  for (const [key, target] of Object.entries(grammar.keys)) {
    const value = raw.get(key);
    if (value !== undefined) assigned.set(target, value);
  }
  const label = assigned.get('chassis.label');
  const pvidText = assigned.get('access.pvid');
  if (label === undefined || pvidText === undefined) {
    throw new UnparseableConfigError('hostname and pvid are required');
  }
  const pvid = Number(pvidText);
  if (!Number.isInteger(pvid) || pvid < 1 || pvid > 4094) {
    throw new UnparseableConfigError('pvid is not a VLAN id');
  }
  const id = assigned.get('chassis.id') ?? 'imported-1';
  const fields = [...new Set(assigned.keys())];
  const vlan: VlanId = pvid;
  const chassis: Chassis = {
    id,
    label,
    ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'br' }],
    radios: [],
    functions: [
      {
        kind: 'bridging',
        id: 'br',
        vlanAware: true,
        members: [
          {
            port: '1',
            mode: 'access',
            pvid: vlan,
            taggedVlans: new Set(),
            untaggedVlans: new Set([vlan]),
            acceptableFrameTypes: defaults.acceptableFrameTypes,
            ingressFiltering: defaults.ingressFiltering,
          },
        ],
        fdb: new Map(),
      },
    ],
    internal: [],
    provenance: {
      profile: grammar.id,
      version: grammar.grammarVersion,
      fields,
    },
  };
  return { devices: [chassis], links: [], profiles: [] };
}
