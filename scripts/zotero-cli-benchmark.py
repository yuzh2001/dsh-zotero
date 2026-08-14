#!/usr/bin/env python3
"""Benchmark zotero-cli for reading collections & items (JSON subprocess mode).

Usage: python3 scripts/zotero-cli-benchmark.py [--iters N] [--cli zotero-cli]
       [--collection KEY] [--item KEY]
"""
import subprocess, time, statistics, os, argparse

AP = argparse.ArgumentParser()
AP.add_argument("--iters", type=int, default=7)
AP.add_argument("--cli", default=os.environ.get("ZOTERO_CLI", "zotero-cli"))
AP.add_argument("--collection", default="TKIQ65QA")
AP.add_argument("--item", default="9VEUFKQZ")
NS = AP.parse_args()

N = NS.iters
CLI = NS.cli
COLL = NS.collection
ITEM = NS.item

BENCH = {
    "collection list":            ["collection", "list"],
    "collection tree":            ["collection", "tree"],
    f"collection items ({COLL})": ["collection", "items", COLL],
    f"item get ({ITEM})":         ["item", "get", ITEM],
    "item find (reinforcement)":  ["item", "find", "reinforcement", "--limit", "10"],
}

def run_once(argv):
    t0 = time.perf_counter()
    pp = subprocess.run([CLI, "--json"] + argv, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL)
    return (time.perf_counter() - t0) * 1000, pp.returncode

print(f"zotero-cli: {CLI} | {N} iterations/op | JSON | backend=auto")
print("=" * 80)
print("%-44s%6s%10s%10s%10s%10s%9s" % ("operation", "ok", "best", "median", "mean", "p95", "std"))
print("-" * 80)
for name, argv in BENCH.items():
    ts = [run_once(a) for a in [argv] * N]
    dts = [t for t, _ in ts]
    ok = sum(1 for _, c in ts if c == 0)
    s = sorted(dts)
    print("%-44s%3d/%d%10.1f%10.1f%10.1f%10.1f%9.1f" % (
        name, ok, N, min(dts), statistics.median(dts), statistics.mean(dts),
        s[int(len(s) * 0.95) - 1], statistics.stdev(dts) if len(dts) > 1 else 0))

dts = []
for _ in range(N):
    t0 = time.perf_counter()
    subprocess.run([CLI, "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    dts.append((time.perf_counter() - t0) * 1000)
print("-" * 80)
print("%-44s%6s%10.1f%10.1f%10.1f" % ("PURE STARTUP (--version)", str(N) + "/" + str(N),
                                       min(dts), statistics.median(dts), statistics.mean(dts)))
print("=" * 80)
