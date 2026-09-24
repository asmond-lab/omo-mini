"""Validate the public corpus without a model or third-party dependencies."""

import base64
import csv
import importlib.util
import json
import struct
import sys
import tomllib
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parent
TASKS = json.loads((ROOT / "tasks.json").read_text(encoding="utf-8"))
ANSWERS = json.loads((ROOT / "oracle/answers.json").read_text(encoding="utf-8"))
FIXTURE = (ROOT / TASKS["fixture_root"]).resolve()


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def load_module(name, relative):
    spec = importlib.util.spec_from_file_location(name, FIXTURE / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def png_pixels(data):
    check(data.startswith(b"\x89PNG\r\n\x1a\n"), "invalid PNG signature")
    offset = 8
    chunks = {}
    while offset < len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        crc = struct.unpack_from(">I", data, offset + 8 + length)[0]
        check(zlib.crc32(kind + payload) & 0xFFFFFFFF == crc, "PNG CRC mismatch")
        chunks.setdefault(kind, []).append(payload)
        offset += 12 + length
    check(offset == len(data), "PNG trailing bytes")
    width, height, depth, color, compression, filtering, interlace = struct.unpack(
        ">IIBBBBB", chunks[b"IHDR"][0]
    )
    check((width, height, depth, color, compression, filtering, interlace) ==
          (2, 2, 8, 2, 0, 0, 0), "unexpected PNG format")
    raw = zlib.decompress(b"".join(chunks[b"IDAT"]))
    check(len(raw) == height * (1 + width * 3), "unexpected pixel length")
    check(raw[0] == raw[7] == 0, "unexpected PNG filter")
    return {"top_left": raw[1:4], "top_right": raw[4:7],
            "bottom_left": raw[8:11], "bottom_right": raw[11:14]}


def main():
    sys.dont_write_bytecode = True
    files = sorted(path for path in FIXTURE.rglob("*") if path.is_file())
    check(len(files) == 12, f"expected 12 fixture files, got {len(files)}")
    check(all(path.resolve().is_relative_to(FIXTURE) for path in files), "fixture escape")
    tasks = TASKS["tasks"]
    ids = [task["id"] for task in tasks]
    check(len(ids) == 12 and len(set(ids)) == 12, "task IDs not unique/count 12")
    check(set(ids) == set(ANSWERS), "task/oracle IDs differ")
    check(all(task["question"].strip() for task in tasks), "empty question")
    spans = 0
    for task_id, answer in ANSWERS.items():
        cited = []
        for citation in answer["citations"]:
            path = (FIXTURE / citation["path"]).resolve()
            check(path.is_relative_to(FIXTURE) and path in files,
                  f"{task_id}: missing or escaped citation path")
            lines = path.read_text(encoding="utf-8").splitlines()
            start, end = citation["start"], citation["end"]
            check(1 <= start <= end <= len(lines), f"{task_id}: bad line range")
            text = "\n".join(lines[start - 1:end])
            check(citation["contains"] in text, f"{task_id}: stale citation text")
            cited.append(text)
            spans += 1
        check(all(value in "\n".join(cited) for value in answer["values"]),
              f"{task_id}: value not supported by cited lines")
        if "absent_query" in answer:
            check(answer["status"] == "not_found" and not answer["citations"]
                  and not answer["values"], f"{task_id}: inconsistent no-match")
            check(all(answer["absent_query"].casefold() not in
                      path.read_text(encoding="utf-8").casefold() for path in files),
                  f"{task_id}: query found in fixture")

    active = tomllib.loads((FIXTURE / "config/runtime.toml").read_text())
    sample = tomllib.loads((FIXTURE / "config/runtime.sample.toml").read_text())
    regions = tomllib.loads((FIXTURE / "config/alerts.toml").read_text())["regions"]
    stations = {row["station_id"]: row for row in csv.DictReader(
        (FIXTURE / "data/stations.csv").open(encoding="utf-8", newline=""))}
    check(active["server"]["port"] == 4182 and
          active["server"]["bind"] == "127.0.0.1" and
          sample["server"]["bind"] == "0.0.0.0", "server facts differ")
    check(active["scheduler"]["dispatcher"] == "src/dispatcher.py" and
          active["delivery"] == {"channel": "slack", "export_enabled": False},
          "active routing facts differ")
    for station, river, threshold, severity in (
        ("ST-03", "Cedar", 180, "critical"),
        ("ST-02", "Brook", 240, "warning"),
    ):
        region = regions[stations[station]["region"]]
        check(stations[station]["river"] == river and
              region["threshold_cm"] == threshold and region["severity"] == severity,
              f"{station}: cross-file station facts differ")
    sys.path.insert(0, str(FIXTURE / "src"))
    try:
        live = load_module("tidewatch_live", active["scheduler"]["dispatcher"])
    finally:
        sys.path.pop(0)
    archive = load_module("tidewatch_archive", "archive/dispatcher.py")
    storage = load_module("tidewatch_storage", "src/storage.py")
    routes = load_module("tidewatch_routes", "src/routes.py")
    check(live.send_alert("north", "critical", active["delivery"]["channel"])
          ["destination"] == "#tide-critical", "critical destination differs")
    check(live.dispatch_count([1, 2]) == 2 and archive.dispatch_count([1, 2]) == 1,
          "live/archive delivery counts differ")
    check(storage.RETENTION_DAYS == 14 and
          tomllib.loads((FIXTURE / "archive/runtime.toml").read_text())
          ["scheduler"]["retention_days"] == 90, "retention facts differ")
    check(("GET", "/stations/summary", "analyst") in routes.ROUTES and
          ("POST", "/stations/export", "operator") in routes.ROUTES,
          "route facts differ")
    pixels = png_pixels(base64.b64decode(
        (FIXTURE / "assets/status.png.b64").read_text().strip(), validate=True))
    palette = {"red": bytes((255, 0, 0)), "blue": bytes((0, 0, 255))}
    check(all(pixels[position] == palette[color] for position, color in
              ANSWERS["T12"]["pixels"].items()), "image oracle differs")
    check(pixels["bottom_left"] == palette["blue"] and
          pixels["bottom_right"] == palette["red"], "quadrant image differs")
    print(f"PASS: {len(tasks)} tasks, {len(files)} fixture files, {spans} citation spans; "
          "cross-file facts, no-match, and PNG pixels verified")


if __name__ == "__main__":
    main()
