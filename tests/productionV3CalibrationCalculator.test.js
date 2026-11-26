const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateHlw8032Calibration,
} = require("../services/productionV3CalibrationCalculator");

const calibrationKeys = [
  "vf",
  "currentZero",
  "currentGain",
  "powerZero",
  "powerGain",
];

function buildSession() {
  return {
    serialNumber: "202600001",
    profileSnapshot: {
      meteringHardware: "HLW8032",
      referencePoints: [
        { code: "NO_LOAD", required: true },
        { code: "LOAD_1500W", required: true },
      ],
      calibrationValues: calibrationKeys.map((firmwareKey) => ({
        firmwareKey,
        minimumValue: null,
        maximumValue: null,
      })),
    },
    captures: [
      {
        pointCode: "NO_LOAD",
        condition: "no_load",
        telemetryRequestId: "req-no-load",
        sampleIds: ["sample-no-load"],
        reference: {
          voltage: 230,
          current: 0,
          power: 0,
        },
      },
      {
        pointCode: "LOAD_1500W",
        condition: "resistive_load",
        telemetryRequestId: "req-load",
        sampleIds: ["sample-load"],
        reference: {
          voltage: 230,
          current: 6.52,
          power: 1500,
        },
      },
    ],
  };
}

function fakeTelemetryModel(samples) {
  return {
    find(query) {
      const ids = new Set(query._id.$in.map(String));
      const matching = samples.filter(
        (sample) =>
          ids.has(String(sample._id)) &&
          sample.serialNumber === query.serialNumber &&
          sample.telemetryRequestId === query.telemetryRequestId &&
          sample.telemetryMode === "fast"
      );

      return {
        select() {
          return {
            lean: async () => matching,
          };
        },
      };
    },
  };
}

function buildSamples() {
  return [
    {
      _id: "sample-no-load",
      serialNumber: "202600001",
      telemetryRequestId: "req-no-load",
      telemetryMode: "fast",
      sampleFresh: true,
      sampleAgeMs: 120,
      rawVoltageRatio: 0.9,
      rawCurrentRatio: 0.001,
      rawPowerRatio: 0.002,
      capturedAt: new Date("2026-11-26T10:00:00.000Z"),
    },
    {
      _id: "sample-load",
      serialNumber: "202600001",
      telemetryRequestId: "req-load",
      telemetryMode: "fast",
      sampleFresh: true,
      sampleAgeMs: 110,
      rawVoltageRatio: 0.9,
      rawCurrentRatio: 0.05,
      rawPowerRatio: 0.5,
      capturedAt: new Date("2026-11-26T10:01:00.000Z"),
    },
  ];
}

test("calculates all five HLW8032 coefficients from two reference points", async () => {
  const result = await calculateHlw8032Calibration({
    session: buildSession(),
    ProductionTelemetry: fakeTelemetryModel(buildSamples()),
    meteringHardware: "HLW8032",
  });

  assert.ok(result.constants.vf > 0);
  assert.ok(Math.abs(result.constants.currentZero - 0.001) < 1e-7);
  assert.ok(result.constants.currentGain > 0);
  assert.ok(Math.abs(result.constants.powerZero - 0.002) < 1e-7);
  assert.ok(result.constants.powerGain > 0);
  assert.equal(result.calculation.referencePointCount, 2);
  assert.equal(result.calculation.totalSamplesUsed, 2);
  assert.equal(result.calculation.warnings.length, 1);
});

test("rejects a calculation when a required reference point is missing", async () => {
  const session = buildSession();
  session.captures = session.captures.slice(0, 1);

  await assert.rejects(
    () =>
      calculateHlw8032Calibration({
        session,
        ProductionTelemetry: fakeTelemetryModel(buildSamples()),
        meteringHardware: "HLW8032",
      }),
    /Capture all required reference points/
  );
});

test("rejects unsupported metering hardware", async () => {
  await assert.rejects(
    () =>
      calculateHlw8032Calibration({
        session: buildSession(),
        ProductionTelemetry: fakeTelemetryModel(buildSamples()),
        meteringHardware: "ATM90E26",
      }),
    /supports HLW8032 only/
  );
});

test("rejects stale raw telemetry", async () => {
  const samples = buildSamples();
  samples[1].sampleFresh = false;

  await assert.rejects(
    () =>
      calculateHlw8032Calibration({
        session: buildSession(),
        ProductionTelemetry: fakeTelemetryModel(samples),
        meteringHardware: "HLW8032",
      }),
    /contains stale telemetry/
  );
});
