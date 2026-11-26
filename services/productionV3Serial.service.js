
// services/productionV3Serial.service.js

const MAX_GROUP_A_ENTRIES = 10000;

function generateSerialNumbers({
  serialPrefix,
  startingNumber,
  quantity,
}) {
  const prefix = String(serialPrefix || "").trim().toUpperCase();
  const startText = String(startingNumber ?? "").trim();
  const count = Number(quantity);

  if (!/^[A-Z0-9_-]{1,32}$/.test(prefix)) {
    throw new Error("Serial prefix must contain 1-32 letters, numbers, hyphens or underscores.");
  }

  if (!/^\d{1,15}$/.test(startText)) {
    throw new Error("Starting number must contain 1-15 digits.");
  }

  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_GROUP_A_ENTRIES
  ) {
    throw new Error(
      `Quantity must be between 1 and ${MAX_GROUP_A_ENTRIES}.`
    );
  }

  const start = BigInt(startText);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);

  if (start + BigInt(count - 1) > maxSafe) {
    throw new Error("Generated sequence exceeds the safe integer range.");
  }

  const width = startText.length;
  const serialNumbers = [];
  const sequenceNumbers = [];

  for (let offset = 0; offset < count; offset += 1) {
    const sequence = start + BigInt(offset);

    serialNumbers.push(
      `${prefix}${sequence.toString().padStart(width, "0")}`
    );

    sequenceNumbers.push(Number(sequence));
  }

  return { serialNumbers, sequenceNumbers };
}

module.exports = {
  MAX_GROUP_A_ENTRIES,
  generateSerialNumbers,
};
