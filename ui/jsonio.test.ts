import { describe, expect, it } from 'vitest';
import {
  SANDBOX_FORMAT,
  SANDBOX_VERSION,
  UnknownFunctionKindError,
  UnsupportedSandboxVersionError,
} from '../src/index';
import { addPreset, completeLink, initialState, setPvid, startLink } from './state';
import { exportSandbox, importSandbox } from './jsonio';

function builtTopology() {
  let state = initialState;
  state = addPreset(state, 'host');
  state = addPreset(state, 'switch');
  state = addPreset(state, 'host');
  const [h1, sw, h2] = state.topology.devices.map((d) => d.id);
  state = startLink(state, h1!);
  state = completeLink(state, sw!);
  state = startLink(state, sw!);
  state = completeLink(state, h2!);
  state = setPvid(state, sw!, '2', 20);
  return state.topology;
}

describe('sandbox JSON import/export (#57 envelope)', () => {
  it('export emits the version-1 envelope', () => {
    const text = exportSandbox(builtTopology());
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.format).toBe(SANDBOX_FORMAT);
    expect(parsed.version).toBe(SANDBOX_VERSION);
    expect(parsed.topology).toBeDefined();
  });

  it('export then import round-trips the topology', () => {
    const topology = builtTopology();
    const imported = importSandbox(exportSandbox(topology));
    expect(imported).toEqual(topology);
  });

  it('import rejects an unsupported version by name, not a bare SyntaxError', () => {
    expect(() =>
      importSandbox(JSON.stringify({ format: SANDBOX_FORMAT, version: 99 })),
    ).toThrow(UnsupportedSandboxVersionError);
  });

  it('import rejects an unknown function kind by name', () => {
    const text = exportSandbox(builtTopology());
    const parsed = JSON.parse(text) as {
      topology: { devices: { functions: { kind: string }[] }[] };
    };
    parsed.topology.devices[1]!.functions[0]!.kind = 'warp-drive';
    expect(() => importSandbox(JSON.stringify(parsed))).toThrow(
      UnknownFunctionKindError,
    );
  });
});
