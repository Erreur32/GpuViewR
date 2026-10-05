import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueryBatcher, parseOutput } from "./gpu.js";
import { parseDmonPcie, parseSlowdownTemps } from "../../../server/services/parsers/nvidia.js";

test("createQueryBatcher: a repeated GPU index starts a new interval", () => {
  const batches: string[][] = [];
  const b = createQueryBatcher((lines) => batches.push(lines));
  b.push("0, RTX A, 40");
  b.push("1, RTX B, 41");
  b.push("0, RTX A, 50"); // next interval
  assert.deepEqual(batches, [["0, RTX A, 40", "1, RTX B, 41"]]);
  b.flush();
  assert.deepEqual(batches[1], ["0, RTX A, 50"]);
});

test("createQueryBatcher: single GPU yields one line per interval", () => {
  const batches: string[][] = [];
  const b = createQueryBatcher((lines) => batches.push(lines));
  b.push("0, RTX 3060 Ti, 40");
  b.push("0, RTX 3060 Ti, 41");
  b.push("0, RTX 3060 Ti, 42");
  b.flush();
  assert.equal(batches.length, 3);
});

test("createQueryBatcher: Windows CRLF line endings are stripped", () => {
  const batches: string[][] = [];
  const b = createQueryBatcher((lines) => batches.push(lines));
  b.push("0, 9, 2229\r");
  b.push("0, 8, 2229\r");
  b.flush();
  assert.deepEqual(batches, [["0, 9, 2229"], ["0, 8, 2229"]]);
});

test("createQueryBatcher: blank lines are ignored and an empty flush is a no-op", () => {
  const batches: string[][] = [];
  const b = createQueryBatcher((lines) => batches.push(lines));
  b.push("   ");
  b.flush();
  assert.equal(batches.length, 0);
});

// Captured on the RTX 3060 Ti of the .209 test box (driver 5xx), trimmed.
const CSV_3060TI =
  "0, NVIDIA GeForce RTX 3060 Ti, GPU-1, 570.00, 43, 7, 1200, 8192, 31.50, 30, 210, 405, 00000000:01:00.0, 1, 4, 16, 16, 200.00";
const Q_3060TI = `
==============NVSMI LOG==============

Attached GPUs                             : 1
GPU 00000000:01:00.0
    Product Name                          : NVIDIA GeForce RTX 3060 Ti
    Temperature
        GPU Current Temp                  : 43 C
        GPU T.Limit Temp                  : N/A
        GPU Shutdown Temp                 : 98 C
        GPU Slowdown Temp                 : 95 C
        GPU Max Operating Temp            : 93 C
`;

test("parseOutput: power.limit and the -q slowdown temp land on the sample", () => {
  const [s] = parseOutput(CSV_3060TI, new Map(), parseSlowdownTemps(Q_3060TI));
  assert.equal(s.power, 31.5);
  assert.equal(s.power_limit, 200);
  assert.equal(s.temp_limit, 95);
});

test("parseOutput: N/A power limit and no -q data give null limits", () => {
  const [s] = parseOutput(CSV_3060TI.replace(/200\.00$/, "[N/A]"), new Map());
  assert.equal(s.power_limit, null);
  assert.equal(s.temp_limit, null);
});

test("parseSlowdownTemps: an N/A slowdown temp is null, keyed by block order too", () => {
  const temps = parseSlowdownTemps(Q_3060TI.replace("GPU Slowdown Temp                 : 95 C", "GPU Slowdown Temp : N/A"));
  assert.equal(temps.get("idx:0"), null);
  assert.equal(parseSlowdownTemps(Q_3060TI).get("idx:0"), 95);
});

test("parseDmonPcie: MB/s per GPU index, converted to KB/s", () => {
  const out = "# gpu  rxpci  txpci \n# Idx   MB/s   MB/s \n    0   2048      3 \n    1      0      0 \n";
  const m = parseDmonPcie(out);
  assert.deepEqual(m.get("idx:0"), { rxKbps: 2048 * 1024, txKbps: 3 * 1024 });
  assert.deepEqual(m.get("idx:1"), { rxKbps: 0, txKbps: 0 });
});

test("parseDmonPcie: unsupported column is null, header-only output is empty", () => {
  assert.deepEqual(parseDmonPcie("    0      -      -\n").get("idx:0"), { rxKbps: null, txKbps: null });
  assert.equal(parseDmonPcie("# gpu  rxpci  txpci\n# Idx   MB/s   MB/s\n").size, 0);
});

test("parseOutput: dmon map attaches to the sample by GPU index", () => {
  const [s] = parseOutput(CSV_3060TI, parseDmonPcie("    0     12      1\n"));
  assert.equal(s.pcie_rx_kbps, 12 * 1024);
  assert.equal(s.pcie_tx_kbps, 1024);
});
