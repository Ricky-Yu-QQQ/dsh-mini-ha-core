"""Read the current Dreame cleaning map through the enrolled cloud session."""

import base64
import json
import time
from urllib.parse import urlsplit
import zlib

from dreame_wire.const import DEVICE_INFO
from dreame_wire.map import DreameVacuumMapDecoder
from dreame_wire.types import (
    DreameVacuumAction as Action,
    DreameVacuumActionMapping as Actions,
    DreameVacuumProperty as Property,
    DreameVacuumPropertyMapping as Properties,
)

_MAX_POINTS = 2200
_MAX_MAP = 8 * 1024 * 1024
_MAX_FRAME_AGE_MS = 180000
_ACTIVE_MODES = {"cleaning", "paused", "returning"}


def _piid(prop):
    return Properties[prop]["piid"]


def _model_iv():
    table = json.loads(zlib.decompress(base64.b64decode(DEVICE_INFO), zlib.MAX_WBITS | 32))
    model = table[0][table[3]["r520b1"]]
    return table[2][model[3]] if len(model) == 4 else None


def _progress(frame):
    segments = frame.segments or {}
    ordered = []
    for segment, order in (frame.cleaning_sequence or {}).items():
        if isinstance(segment, str) and segment.isascii() and segment.isdecimal():
            segment = int(segment)
        if segment in segments and type(order) is int and 0 < order < 64:
            ordered.append((order, segment))
    active = set(frame.active_segments or [])
    order = [segment for _, segment in sorted(ordered) if not active or segment in active]
    if len(order) != len(set(order)) or len({rank for rank, _ in ordered}) != len(ordered):
        order = []

    source = frame.path or []
    stride = max(1, (len(source) + _MAX_POINTS - 1) // _MAX_POINTS)
    points = []
    for index, point in enumerate(source):
        kind = point.path_type.value
        if kind == "L" and index % stride != 0 and index != len(source) - 1:
            continue
        if kind in ("L", "S", "M", "W") and all(
            type(value) is int and abs(value) <= 100000 for value in (point.x, point.y)
        ):
            points.append([point.x, point.y, kind])
    return {
        "mapId": frame.map_id,
        "frameId": frame.frame_id,
        "capturedAt": frame.timestamp_ms,
        "points": points[-_MAX_POINTS:],
        "roomOrder": order,
    }


def _matches_floor(frame, embedded, saved):
    floor_id = frame.saved_map_id or (embedded.map_id if embedded else None)
    if floor_id is not None:
        return floor_id == saved["mapId"]

    # Some clean-in-progress frames omit the saved map ID. Validate their
    # coordinate system and overlap before assigning them to the saved floor.
    dim = frame.dimensions
    grid = saved["grid"]
    if dim.grid_size != grid:
        return False
    left, bottom = saved["left"], saved["bottom"]
    right, top = left + saved["width"] * grid, bottom + saved["height"] * grid
    frame_right = dim.left + dim.width * grid
    frame_top = dim.top + dim.height * grid
    overlap_width = min(right, frame_right) - max(left, dim.left)
    overlap_height = min(top, frame_top) - max(bottom, dim.top)
    if (overlap_width <= 0 or overlap_height <= 0 or
            overlap_width * overlap_height < 0.70 * (right - left) * (top - bottom)):
        return False
    matching_rooms = 0
    for room in saved["rooms"]:
        segment = (frame.segments or {}).get(room["id"])
        if segment and segment.x is not None and segment.y is not None:
            dx, dy = room["x"] - segment.x, room["y"] - segment.y
            if dx * dx + dy * dy <= 1500 * 1500:
                matching_rooms += 1
    return matching_rooms >= max(3, len(saved["rooms"]) // 2)


def read_progress(cloud, saved):
    """Request one full current-map frame. This action does not move the robot."""
    response = cloud.send("action", {
        "did": str(cloud.device_id),
        **Actions[Action.REQUEST_MAP],
        "in": [{
            "piid": _piid(Property.FRAME_INFO),
            "value": '{"req_type":1,"frame_type":"I","force_type":1}',
        }],
    }, retry_count=0, timeout=5)
    if not isinstance(response, dict) or response.get("code") != 0:
        return {"available": False}
    out = {item.get("piid"): item.get("value") for item in response.get("out", [])}

    raw = out.get(_piid(Property.MAP_DATA))
    ref = out.get(_piid(Property.OBJECT_NAME))
    if not raw and not ref:
        legacy = out.get(_piid(Property.OLD_MAP_DATA))
        if isinstance(legacy, str):
            flag, _, body = legacy.partition(",")
            if flag == "0":
                raw = body
            else:
                ref = body

    key = None
    if not raw and isinstance(ref, str) and ref:
        name, _, key = ref.partition(",")
        url = cloud.get_interim_file_url(name)
        if not isinstance(url, str) or urlsplit(url).scheme != "https":
            return {"available": False}
        blob = cloud.get_file(url, retry_count=0)
        if blob and len(blob) <= _MAX_MAP:
            raw = blob.decode()
    if not isinstance(raw, str) or not raw or len(raw) > _MAX_MAP:
        return {"available": False}

    frame, embedded = DreameVacuumMapDecoder.decode_map(raw, 2, 0, _model_iv(), key or None)
    received_at = int(time.time() * 1000)
    if (frame is None or frame.saved_map or frame.recovery_map or frame.frame_type != ord("I")
            or type(frame.timestamp_ms) is not int
            or not received_at - _MAX_FRAME_AGE_MS <= frame.timestamp_ms <= received_at + 10000
            or not _matches_floor(frame, embedded, saved)):
        return {"available": False}
    return {"available": True, "floorMapId": saved["mapId"], **_progress(frame)}


class VacuumProgress:
    def __init__(self):
        self._sample = None
        self._sampled_at = 0.0
        self._last_frame = None
        self._revision = None

    async def read(self, appliances, state, get_saved):
        async with appliances.locks["dreame"]:
            mode = await state()
            saved = get_saved()
            if not saved or mode not in _ACTIVE_MODES:
                self._sample = None
                self._last_frame = None
                return {"available": False}
            if saved["revision"] != self._revision:
                self._revision = saved["revision"]
                self._sample = None
                self._last_frame = None
            if self._sample is not None and time.monotonic() - self._sampled_at < 8:
                return self._sample
            self._sample = await appliances.with_dreame(lambda cloud: read_progress(cloud, saved))
            self._sampled_at = time.monotonic()
            if self._sample["available"]:
                previous = self._last_frame
                if (not self._sample["roomOrder"] and previous
                        and self._sample["mapId"] == previous["mapId"]
                        and self._sample["frameId"] >= previous["frameId"]
                        and 0 <= self._sample["capturedAt"] - previous["capturedAt"] < _MAX_FRAME_AGE_MS):
                    self._sample["roomOrder"] = previous["roomOrder"]
                self._last_frame = self._sample
            return self._sample
