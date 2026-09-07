import { describe, expect, it } from 'vitest';
import { addPreset, initialState } from './state';
import { exportSandbox } from './jsonio';
import { fitContent, panCamera, viewBoxAttr, zoomAt } from './camera';

describe('canvas camera (#116)', () => {
  it('zoom toward a world point keeps that point stable', () => {
    const camera = { x: 0, y: 0, w: 200, h: 100 };
    const next = zoomAt(camera, 50, 25, 0.5);
    expect(next.w).toBe(100);
    expect(next.h).toBe(50);
    expect(next.x + ((50 - camera.x) / camera.w) * next.w).toBeCloseTo(50);
    expect(next.y + ((25 - camera.y) / camera.h) * next.h).toBeCloseTo(25);
  });

  it('pan shifts the view, not device layout', () => {
    const camera = { x: 10, y: 20, w: 100, h: 80 };
    expect(panCamera(camera, 5, -3)).toEqual({ x: 5, y: 23, w: 100, h: 80 });
  });

  it('fit covers content with padding', () => {
    const camera = fitContent(160, 120, 24);
    expect(camera.x).toBe(-24);
    expect(camera.y).toBe(-24);
    expect(camera.w).toBe(208);
    expect(camera.h).toBe(168);
  });

  it('camera is not written into the sandbox file', () => {
    const state = addPreset(initialState, 'host');
    const parsed = JSON.parse(exportSandbox(state.topology, state.layout));
    expect(parsed).not.toHaveProperty('camera');
    expect(parsed.topology).not.toHaveProperty('camera');
    expect(JSON.stringify(parsed)).not.toMatch(/viewBox|scale/);
  });

  it('viewBoxAttr serialises world units', () => {
    expect(viewBoxAttr({ x: 1, y: 2, w: 3, h: 4 })).toBe('1 2 3 4');
  });
});
