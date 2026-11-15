import {VendorDevices} from './vendor.js';

export function openVacuumProgress(config) {
  const vendor = new VendorDevices(config, new Map());
  return {
    async read(signal) {
      const result = await vendor.request('/api/vendor/dreame/progress', signal);
      if (result?.available !== true) return {available: false};
      const {mapId, floorMapId, frameId, capturedAt, points, roomOrder} = result;
      const now = Date.now();
      if (![mapId, floorMapId, frameId, capturedAt].every(Number.isSafeInteger)
        || capturedAt < now - 180000 || capturedAt > now + 10000
        || !Array.isArray(points) || points.length > 2200
        || !points.every(point => Array.isArray(point) && point.length === 3
          && point.slice(0, 2).every(n => Number.isInteger(n) && Math.abs(n) <= 100000)
          && ['L', 'S', 'M', 'W'].includes(point[2]))
        || !Array.isArray(roomOrder) || roomOrder.length >= 64
        || !roomOrder.every(room => Number.isInteger(room) && room > 0 && room < 64)
        || new Set(roomOrder).size !== roomOrder.length) {
        return {available: false};
      }
      return {available: true, mapId, floorMapId, frameId, capturedAt, points, roomOrder};
    },
  };
}
