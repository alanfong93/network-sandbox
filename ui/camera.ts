export type Camera = { x: number; y: number; w: number; h: number };

export function fitContent(maxX: number, maxY: number, pad = 24): Camera {
  return {
    x: -pad,
    y: -pad,
    w: Math.max(1, maxX + pad * 2),
    h: Math.max(1, maxY + pad * 2),
  };
}

export function panCamera(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x - dx, y: camera.y - dy };
}

export function zoomAt(
  camera: Camera,
  worldX: number,
  worldY: number,
  factor: number,
): Camera {
  const scale = Math.min(8, Math.max(0.2, factor));
  const w = camera.w * scale;
  const h = camera.h * scale;
  const rx = camera.w === 0 ? 0 : (worldX - camera.x) / camera.w;
  const ry = camera.h === 0 ? 0 : (worldY - camera.y) / camera.h;
  return { x: worldX - rx * w, y: worldY - ry * h, w, h };
}

export function viewBoxAttr(camera: Camera): string {
  return `${camera.x} ${camera.y} ${camera.w} ${camera.h}`;
}

export function screenDeltaToWorld(
  camera: Camera,
  dx: number,
  dy: number,
  cssW: number,
  cssH: number,
): { x: number; y: number } {
  const scale = Math.min(cssW / camera.w, cssH / camera.h);
  const safe = Math.max(scale, 1e-6);
  return { x: dx / safe, y: dy / safe };
}
