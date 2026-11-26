const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateSerialNumbers,
  MAX_GROUP_A_ENTRIES,
} = require("../services/productionV3Serial.service");

test("generates sequential serials and preserves leading zeros", () => {
  const result = generateSerialNumbers({
    serialPrefix: "viz-",
    startingNumber: "0008",
    quantity: 4,
  });

  assert.deepEqual(result.serialNumbers, [
    "VIZ-0008",
    "VIZ-0009",
    "VIZ-0010",
    "VIZ-0011",
  ]);
  assert.deepEqual(result.sequenceNumbers, [8, 9, 10, 11]);
});

test("rejects invalid quantity", () => {
  assert.throws(
    () => generateSerialNumbers({
      serialPrefix: "VIZ",
      startingNumber: "0001",
      quantity: MAX_GROUP_A_ENTRIES + 1,
    }),
    /quantity must be an integer/
  );
});

test("rejects non-numeric starting number", () => {
  assert.throws(
    () => generateSerialNumbers({
      serialPrefix: "VIZ",
      startingNumber: "A001",
      quantity: 5,
    }),
    /startingNumber must contain/
  );
});
