import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueryBatcher } from "./gpu.js";

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

test("createQueryBatcher: blank lines are ignored and an empty flush is a no-op", () => {
  const batches: string[][] = [];
  const b = createQueryBatcher((lines) => batches.push(lines));
  b.push("   ");
  b.flush();
  assert.equal(batches.length, 0);
});
