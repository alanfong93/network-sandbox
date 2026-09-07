import type { Chassis, NameRecord } from './model';

export function matchRecord(
  records: readonly NameRecord[],
  name: string,
): string | undefined {
  const key = name.trim().toLowerCase();
  if (key === '') return undefined;
  return records.find((row) => row.name.trim().toLowerCase() === key)?.ip;
}

export function lookupRecord(chassis: Chassis, name: string): string | undefined {
  const fn = chassis.functions.find((item) => item.kind === 'resolver');
  if (fn?.kind !== 'resolver') return undefined;
  return matchRecord(fn.records, name);
}
