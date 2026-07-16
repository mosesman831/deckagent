// KV-only helpers for device registry. No polling state here.
export {
  getDevice,
  setDevice,
  removeDevice,
  updateDeviceStatus,
  isDeviceOnline,
  listOnlineDevices,
  resolveTargetDeviceId,
} from "./device-registry.js";
