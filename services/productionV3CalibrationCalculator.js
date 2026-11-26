/**
 * VIZ Production 3.0 — HLW8032 automatic calibration calculator.
 *
 * The equations intentionally mirror the V3 firmware:
 *   voltage = rawVoltageRatio * vf
 *   current = (rawCurrentRatio - currentZero) * currentGain
 *   power   = (rawPowerRatio - powerZero) * powerGain
 *
 * This service calculates a proposed calibration from the raw telemetry
 * samples retained by each reference-point capture. It never applies
 * calibration to the device.
 */

const CALIBRATION_KEYS = [
  "vf",
  "currentZero",
  "currentGain",
  "powerZero",
  "powerGain",
];

const RAW_FIELDS = Object.freeze({
  voltage: "rawVoltageRatio",
  current: "rawCurrentRatio",
  power: "rawPowerRatio",
});

const MIN_RAW_SPAN = 1e-9;
const MIN_DENOMINATOR = 1e-18;

function makeError(message, statusCode = 409) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readFiniteNumber(value, label) {
  if (value === null || value === undefined || value === "") {
    throw makeError(`Missing numeric value for ${label}.`);
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw makeError(`Invalid numeric value for ${label}.`);
  }

  return number;
}

function mean(values, label) {
  if (!values.length) {
    throw makeError(`No samples available for ${label}.`);
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toFirmwareFloat(value, label) {
  if (!Number.isFinite(value)) {
    throw makeError(`Calculated ${label} is not finite.`, 422);
  }

  // ESP32 firmware stores the coefficients as IEEE-754 float values.
  const rounded = Math.fround(value);

  if (!Number.isFinite(rounded)) {
    throw makeError(`Calculated ${label} exceeds firmware float range.`, 422);
  }

  return Number(rounded.toPrecision(8));
}

function calculateFitStatistics(points, slope, intercept) {
  const residuals = points.map(({ raw, reference }) => {
    const predicted = slope * raw + intercept;
    return {
      predicted,
      error: predicted - reference,
      absoluteError: Math.abs(predicted - reference),
    };
  });

  const rmse = Math.sqrt(
    residuals.reduce((sum, item) => sum + item.error * item.error, 0) /
      residuals.length
  );

  const referenceMean =
    points.reduce((sum, point) => sum + point.reference, 0) /
    points.length;

  const totalSquares = points.reduce(
    (sum, point) => sum + Math.pow(point.reference - referenceMean, 2),
    0
  );

  const residualSquares = residuals.reduce(
    (sum, item) => sum + item.error * item.error,
    0
  );

  return {
    rmse,
    rSquared:
      totalSquares > MIN_DENOMINATOR
        ? 1 - residualSquares / totalSquares
        : null,
    pointErrors: points.map((point, index) => ({
      pointCode: point.pointCode,
      reference: point.reference,
      predicted: residuals[index].predicted,
      absoluteError: residuals[index].absoluteError,
      errorPercent:
        Math.abs(point.reference) > MIN_DENOMINATOR
          ? (residuals[index].absoluteError /
              Math.abs(point.reference)) *
            100
          : null,
    })),
  };
}

/**
 * Voltage firmware equation has no offset: voltage = rawVoltageRatio * vf.
 * Fit the gain through the origin using all available reference points.
 */
function fitThroughOrigin(points, label) {
  if (!points.length) {
    throw makeError(`At least one valid reference point is required for ${label}.`);
  }

  const denominator = points.reduce(
    (sum, point) => sum + point.raw * point.raw,
    0
  );

  if (!Number.isFinite(denominator) || denominator <= MIN_DENOMINATOR) {
    throw makeError(
      `Raw ${label} values are zero or too small to calculate a reliable gain.`
    );
  }

  const numerator = points.reduce(
    (sum, point) => sum + point.raw * point.reference,
    0
  );

  const gain = numerator / denominator;

  if (!Number.isFinite(gain) || gain <= 0) {
    throw makeError(`Calculated ${label} gain must be positive.`, 422);
  }

  return {
    gain,
    ...calculateFitStatistics(points, gain, 0),
  };
}

/**
 * Current and power firmware equations use an offset plus a gain:
 *   reference = (raw - zero) * gain
 *
 * Algebraically this is y = slope*x + intercept, with zero = -intercept/slope.
 */
function fitAffine(points, label) {
  if (points.length < 2) {
    throw makeError(
      `At least two reference points with different raw ${label} readings are required.`
    );
  }

  const meanRaw = mean(
    points.map((point) => point.raw),
    `${label} raw ratios`
  );

  const meanReference = mean(
    points.map((point) => point.reference),
    `${label} reference readings`
  );

  const minRaw = Math.min(...points.map((point) => point.raw));
  const maxRaw = Math.max(...points.map((point) => point.raw));

  if (maxRaw - minRaw <= MIN_RAW_SPAN) {
    throw makeError(
      `Raw ${label} readings did not change enough between reference points. Check the load and recapture.`
    );
  }

  const denominator = points.reduce(
    (sum, point) => sum + Math.pow(point.raw - meanRaw, 2),
    0
  );

  if (!Number.isFinite(denominator) || denominator <= MIN_DENOMINATOR) {
    throw makeError(`Cannot calculate a stable ${label} gain.`);
  }

  const numerator = points.reduce(
    (sum, point) =>
      sum +
      (point.raw - meanRaw) *
        (point.reference - meanReference),
    0
  );

  const gain = numerator / denominator;
  const intercept = meanReference - gain * meanRaw;

  if (!Number.isFinite(gain) || gain <= 0) {
    throw makeError(
      `Calculated ${label} gain is not positive. Check the raw readings and reference-meter values.`,
      422
    );
  }

  const zero = -intercept / gain;

  if (!Number.isFinite(zero)) {
    throw makeError(`Calculated ${label} zero offset is not finite.`, 422);
  }

  return {
    zero,
    gain,
    intercept,
    ...calculateFitStatistics(points, gain, intercept),
  };
}

function validateProfileLimits(profile, constants) {
  const definitions = new Map(
    (profile.calibrationValues || []).map((item) => [
      item.firmwareKey,
      item,
    ])
  );

  for (const key of CALIBRATION_KEYS) {
    const definition = definitions.get(key);

    if (!definition) {
      throw makeError(
        `Calibration Profile is missing the required firmware key: ${key}.`
      );
    }

    const value = constants[key];
    const minimum =
      definition.minimumValue === null ||
      definition.minimumValue === undefined
        ? null
        : Number(definition.minimumValue);
    const maximum =
      definition.maximumValue === null ||
      definition.maximumValue === undefined
        ? null
        : Number(definition.maximumValue);

    if (minimum !== null && value < minimum) {
      throw makeError(
        `Calculated ${key}=${value} is below the profile minimum ${minimum}. Update the calibration setup or review the captures.`,
        422
      );
    }

    if (maximum !== null && value > maximum) {
      throw makeError(
        `Calculated ${key}=${value} exceeds the profile maximum ${maximum}. Update the calibration setup or review the captures.`,
        422
      );
    }
  }
}

async function calculateHlw8032Calibration({
  session,
  ProductionTelemetry,
  meteringHardware,
}) {
  if (!session || !ProductionTelemetry) {
    throw makeError("Calibration session and telemetry model are required.", 500);
  }

  const normalizedHardware = String(meteringHardware || "")
    .trim()
    .toUpperCase();

  if (normalizedHardware !== "HLW8032") {
    throw makeError(
      `Automatic calibration calculation currently supports HLW8032 only. This device is configured as "${normalizedHardware || "unknown"}". Correct the Production Profile / batch hardware assignment before calculating.`,
      409
    );
  }

  const profile = session.profileSnapshot || {};
  const profilePoints = Array.isArray(profile.referencePoints)
    ? profile.referencePoints
    : [];

  const requiredPoints = profilePoints.filter(
    (point) => point.required !== false
  );

  if (!requiredPoints.length) {
    throw makeError(
      "The session profile has no required reference points. Add reference points to the Calibration Profile and create a new session."
    );
  }

  const latestCaptureByCode = new Map();

  for (const capture of session.captures || []) {
    latestCaptureByCode.set(String(capture.pointCode || ""), capture);
  }

  const missingPoints = requiredPoints
    .filter((point) => !latestCaptureByCode.has(String(point.code)))
    .map((point) => String(point.code));

  if (missingPoints.length) {
    throw makeError(
      `Capture all required reference points before calculating constants. Missing: ${missingPoints.join(", ")}.`
    );
  }

  // Include the latest captured observation for every configured profile point.
  // Optional points can improve the fit when an operator has captured them.
  const configuredCodes = new Set(
    profilePoints.map((point) => String(point.code))
  );

  const selectedCaptures = Array.from(latestCaptureByCode.entries())
    .filter(([pointCode]) => configuredCodes.has(pointCode))
    .map(([pointCode, capture]) => ({ pointCode, capture }));

  const observations = [];
  let totalSamplesUsed = 0;

  for (const { pointCode, capture } of selectedCaptures) {
    const sampleIds = Array.isArray(capture.sampleIds)
      ? capture.sampleIds
      : [];

    if (!sampleIds.length || !capture.telemetryRequestId) {
      throw makeError(
        `Reference point ${pointCode} has no retained telemetry sample IDs. Recapture this point using fresh fast telemetry.`
      );
    }

    const samples = await ProductionTelemetry.find({
      _id: { $in: sampleIds },
      serialNumber: String(session.serialNumber).trim().toUpperCase(),
      telemetryRequestId: capture.telemetryRequestId,
      telemetryMode: "fast",
    })
      .select(
        "_id serialNumber telemetryRequestId telemetryMode capturedAt sampleFresh sampleAgeMs rawVoltageRatio rawCurrentRatio rawPowerRatio"
      )
      .lean();

    if (samples.length !== sampleIds.length) {
      throw makeError(
        `Raw telemetry for ${pointCode} is incomplete or has expired (${samples.length}/${sampleIds.length} samples found). Recapture this point before calculating.`
      );
    }

    for (const sample of samples) {
      if (
        sample.sampleFresh !== true ||
        sample.sampleAgeMs === null ||
        sample.sampleAgeMs === undefined ||
        Number(sample.sampleAgeMs) < 0 ||
        Number(sample.sampleAgeMs) > 2000
      ) {
        throw makeError(
          `Reference point ${pointCode} contains stale telemetry. Recapture it with fresh meter samples.`
        );
      }
    }

    const rawMeans = {};

    for (const [channel, field] of Object.entries(RAW_FIELDS)) {
      rawMeans[channel] = mean(
        samples.map((sample) =>
          readFiniteNumber(sample[field], `${pointCode}.${field}`)
        ),
        `${pointCode}.${field}`
      );
    }

    const reference = {
      voltage: readFiniteNumber(
        capture.reference?.voltage,
        `${pointCode} reference voltage`
      ),
      current: readFiniteNumber(
        capture.reference?.current,
        `${pointCode} reference current`
      ),
      power: readFiniteNumber(
        capture.reference?.power,
        `${pointCode} reference power`
      ),
    };

    if (reference.voltage <= 0) {
      throw makeError(
        `Reference voltage for ${pointCode} must be greater than zero.`
      );
    }

    if (reference.current < 0 || reference.power < 0) {
      throw makeError(
        `Reference current and power for ${pointCode} cannot be negative.`
      );
    }

    observations.push({
      pointCode,
      condition: capture.condition || "",
      raw: rawMeans,
      reference,
      sampleCount: samples.length,
      sampleIds: samples.map((sample) => String(sample._id)),
      firstSampleAt: samples.reduce(
        (earliest, sample) =>
          !earliest || new Date(sample.capturedAt) < new Date(earliest)
            ? sample.capturedAt
            : earliest,
        null
      ),
      lastSampleAt: samples.reduce(
        (latest, sample) =>
          !latest || new Date(sample.capturedAt) > new Date(latest)
            ? sample.capturedAt
            : latest,
        null
      ),
    });

    totalSamplesUsed += samples.length;
  }

  const voltagePoints = observations.map((point) => ({
    pointCode: point.pointCode,
    raw: point.raw.voltage,
    reference: point.reference.voltage,
  }));

  const currentPoints = observations.map((point) => ({
    pointCode: point.pointCode,
    raw: point.raw.current,
    reference: point.reference.current,
  }));

  const powerPoints = observations.map((point) => ({
    pointCode: point.pointCode,
    raw: point.raw.power,
    reference: point.reference.power,
  }));

  const voltageFit = fitThroughOrigin(voltagePoints, "voltage");
  const currentFit = fitAffine(currentPoints, "current");
  const powerFit = fitAffine(powerPoints, "power");

  const constants = {
    vf: toFirmwareFloat(voltageFit.gain, "vf"),
    currentZero: toFirmwareFloat(currentFit.zero, "currentZero"),
    currentGain: toFirmwareFloat(currentFit.gain, "currentGain"),
    powerZero: toFirmwareFloat(powerFit.zero, "powerZero"),
    powerGain: toFirmwareFloat(powerFit.gain, "powerGain"),
  };

  validateProfileLimits(profile, constants);

  const warnings = [];

  if (observations.length === 2) {
    warnings.push(
      "Only two reference points were used. The current and power lines are determined by these two points but this does not independently prove linearity. Perform an independent post-calibration verification at another load."
    );
  } else if (observations.length > 2) {
    warnings.push(
      "The coefficients are least-squares fits across the captured reference points. Review fit residuals and perform independent post-calibration verification."
    );
  }

  return {
    constants,
    calculation: {
      algorithm: "HLW8032_LINEAR_LEAST_SQUARES",
      algorithmVersion: "1.0.0",
      calculatedAt: new Date(),
      meteringHardware: "HLW8032",
      method: {
        voltage: "through_origin_least_squares",
        current: "affine_least_squares",
        power: "affine_least_squares",
      },
      referencePointCount: observations.length,
      totalSamplesUsed,
      points: observations,
      fits: {
        voltage: {
          gain: constants.vf,
          rmse: voltageFit.rmse,
          rSquared: voltageFit.rSquared,
          pointErrors: voltageFit.pointErrors,
        },
        current: {
          zero: constants.currentZero,
          gain: constants.currentGain,
          intercept: currentFit.intercept,
          rmse: currentFit.rmse,
          rSquared: currentFit.rSquared,
          pointErrors: currentFit.pointErrors,
        },
        power: {
          zero: constants.powerZero,
          gain: constants.powerGain,
          intercept: powerFit.intercept,
          rmse: powerFit.rmse,
          rSquared: powerFit.rSquared,
          pointErrors: powerFit.pointErrors,
        },
      },
      warnings,
    },
  };
}

module.exports = {
  CALIBRATION_KEYS,
  calculateHlw8032Calibration,
};
