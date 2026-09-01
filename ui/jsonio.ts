import { fromJson, toJson } from '../src/index';
import type { Topology } from '../src/index';

/** The sandbox envelope from #57 is the format of record (ADR 0015). */
export function exportSandbox(topology: Topology): string {
  return JSON.stringify(toJson(topology), null, 2);
}

/** Throws the engine's named errors on an unknown version or function kind. */
export function importSandbox(text: string): Topology {
  return fromJson(text);
}
