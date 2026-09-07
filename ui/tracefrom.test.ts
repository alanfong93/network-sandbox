import { describe, expect, it } from 'vitest';
import { addPreset, initialState, select } from './state';
import { traceFromId } from './tracefrom';

describe('Trace From follows the selected device (#115)', () => {
  it('click Host 9, From is Host 9, not devices[0] (the modem)', () => {
    let state = initialState;
    state = addPreset(state, 'modem');
    state = addPreset(state, 'host');
    const modem = state.topology.devices[0]!.id;
    const host = state.topology.devices[1]!.id;
    expect(modem).toMatch(/^modem-/);
    expect(traceFromId(null, null, state.topology.devices)).toBe(modem);
    state = select(state, host);
    expect(traceFromId(state.selected, null, state.topology.devices)).toBe(host);
  });

  it('dropdown sendFrom is used only when nothing is selected', () => {
    const devices = [{ id: 'modem-5' }, { id: 'host-9' }];
    expect(traceFromId(null, 'host-9', devices)).toBe('host-9');
    expect(traceFromId('host-9', 'modem-5', devices)).toBe('host-9');
  });
});
