import type { DeviceId } from '../src/index';

export function traceFromId(
  selected: DeviceId | null,
  sendFrom: DeviceId | null,
  devices: readonly { id: DeviceId }[],
): DeviceId | null {
  if (selected) return selected;
  if (sendFrom && devices.some((device) => device.id === sendFrom)) return sendFrom;
  return devices[0]?.id ?? null;
}
