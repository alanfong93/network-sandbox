import { describe, expect, it } from 'vitest';
import type { Chassis } from './model';
import { lookupRecord, matchRecord } from './resolver';
import { defaults } from './defaults';

function resolverBox(records: { name: string; ip: string }[]): Chassis {
  return {
    id: 'DNS1',
    label: 'DNS1',
    ports: [{ id: '1', mtu: defaults.portMtu, ownedBy: 'none' }],
    radios: [],
    functions: [{ kind: 'resolver', id: 'resolver', records }],
    internal: [],
  };
}

describe('matchRecord', () => {
  const records = [
    { name: 'google.com', ip: '192.0.2.1' },
    { name: 'nas.home', ip: '192.168.10.50' },
  ];

  it('matches the name exactly', () => {
    expect(matchRecord(records, 'google.com')).toBe('192.0.2.1');
  });

  it('is case-insensitive and trims', () => {
    expect(matchRecord(records, '  GOOGLE.COM ')).toBe('192.0.2.1');
    expect(matchRecord(records, 'Nas.Home')).toBe('192.168.10.50');
  });

  it('returns undefined for a name the table does not hold', () => {
    expect(matchRecord(records, 'example.com')).toBeUndefined();
  });

  it('never matches an empty or blank name', () => {
    expect(matchRecord(records, '')).toBeUndefined();
    expect(matchRecord(records, '   ')).toBeUndefined();
  });
});

describe('lookupRecord', () => {
  it('reads the table of the chassis that carries the resolver function', () => {
    expect(lookupRecord(resolverBox([{ name: 'nas.home', ip: '192.168.10.50' }]), 'nas.home')).toBe(
      '192.168.10.50',
    );
  });

  it('is undefined on a chassis with no resolver function', () => {
    const bare: Chassis = {
      id: 'RTR',
      label: 'RTR',
      ports: [],
      radios: [],
      functions: [],
      internal: [],
    };
    expect(lookupRecord(bare, 'nas.home')).toBeUndefined();
  });
});
