// mqttSubscriber.js

const mongoose = require('mongoose');
const Session = require('./models/session');
const Device = require('./models/device');
const mqttClient = require('./mqttClient'); // shared connection
const Receipt = require('./models/Receipt');
const DeviceTelemetry = require('./models/deviceTelemetry');
const DeviceProvision = require('./models/DeviceProvision');
const ProductionDevice = require("./models/ProductionDevice");
const DeviceMaintenanceLog =
  require("./models/DeviceMaintenanceLog");

const {
  handleProductionConfigAck,
  handleProductionAdminAck,
} = require("./services/productionV3Provisioning.service");

const {
  setLatestProductionTelemetry,
} = require("./services/productionTelemetryCache");
const {
  CONFIG_ACK_STATUS,
  PROVISION_STATUS,
  normalizeDeviceId,
} = require('./config/deviceProtocol');

// FIX 2: top-of-file import (no more inline require inside handlers)
const { completeSessionInternal } = require('./controllers/sessionController');

// Optional: simple duplicate filter
const processedMessages = new Set();

// ─── Grace / fault constants ──────────────────────────────────────────────────
// FIX 3: How many consecutive "Available + no sessionId" telemetry ticks
// must arrive before we auto-end a session.
const AUTO_END_CONSECUTIVE_TICKS_REQUIRED = 3;

// FIX 1 (cron): How long (ms) device must be Available/Offline before cron kills session.
const CRON_GRACE_MS = 5 * 60 * 1000;          // 5 minutes

// FIX 1 (cron): How long (ms) since last telemetry before cron considers session truly stale.
const CRON_STALE_TELEMETRY_MS = 5 * 60 * 1000; // 5 minutes

// In-memory counter per deviceId for consecutive "Available, no sessionId" ticks
// key: deviceId (uppercase), value: number of consecutive ticks seen
const availableNoSessionTicks = new Map();

const availableWithSessionSince = new Map();

const AVAILABLE_WITH_SESSION_GRACE_MS =
  3 * 60 * 1000; // 3 minutes

// ─────────────────────────────────────────────────────────────────────────────
function deviceIdCandidates(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return [];
  }

  return [
    ...new Set([
      raw,
      raw.toUpperCase(),
      raw.toLowerCase(),
      normalizeDeviceId(raw),
    ]),
  ].filter(Boolean);
}
// ─────────────────────────────────────────────────────────────────────────────
// MAIN SUBSCRIBER
// ─────────────────────────────────────────────────────────────────────────────
function startMqttSubscriber() {

  mqttClient.on('connect', () => {
    // console.log('✅ Backend connected to MQTT broker');

const topics = [
  'viz/+/Telemetry',
  'viz/+/status',
  'device/+/session/end',
  'viz/+/sessionend',
  'viz/+/adminAck',
  'viz/+/configAck',          // ← NEW: firmware ACK after receiving config payload
];
mqttClient.subscribe(topics, { qos: 1 }, (err) => {
  if (err) {
    console.error('MQTT subscribe failed:', err);
      } else {
        // console.log('✅ Subscribed to:', topics);
      }
    });
  });


  mqttClient.on('message', async (topic, buf) => {
    const payload = buf.toString();
    // console.log(`[MQTT RX] topic=${topic} payload=${payload}`);

    const parts = topic.split('/');

    // ─────────────────────────────────────────────────────────────────────────
    // BLOCK A: Firmware session/end event (device/<ID>/session/end  OR
    //          viz/<ID>/sessionend for legacy firmware bug)
    // ─────────────────────────────────────────────────────────────────────────
    const isCorrectEndTopic = topic.startsWith('device/') && topic.endsWith('/session/end');
    const isFirmwareBugTopic = topic.startsWith('viz/') && topic.endsWith('/sessionend');

    if (isCorrectEndTopic || isFirmwareBugTopic) {
      const deviceId = topic.split('/')[1]; // index 1 works for both topic formats

      let msg;
      try {
        msg = JSON.parse(payload);
      } catch (e) {
        console.error('[MQTT] Invalid JSON on session/end:', e);
        return;
      }

      const { sessionId, endTime, endTrigger } = msg;

      // Accept BOTH energy field names:
      //   energykWh  → current firmware sends this (known typo)
      //   energy_kWh → correct field name (fixed firmware)
      const energy_kWh = msg.energy_kWh !== undefined ? msg.energy_kWh : msg.energykWh;

      if (!sessionId || !endTime || !endTrigger) {
      //  console.warn('[MQTT] Incomplete session/end payload:', msg);
        return;
      }

      // console.log('[MQTT] session/end received:', { deviceId, sessionId, endTrigger, energy_kWh, topic });

      try {
        await completeSessionInternal({
          sessionId,
          endTime:          new Date(endTime).toISOString(),
          endTrigger,
          deltaEnergy:      Number(energy_kWh) || 0,
          deviceIdOverride: deviceId,
          sendStopMqtt:     false,
        });
        // console.log('[MQTT] ✅ Session auto-completed via session/end event:', sessionId);
      } catch (err) {
        console.error('[MQTT] ❌ Failed auto-completing session:', err);
      }
      return; // do NOT fall through to Telemetry handler
    }

    // --------------------------------------------------
// PRODUCTION ADMIN COMMAND ACK
// Topic: viz/<DEVICE_ID>/adminAck
//
// Expected payload:
// {
//   "requestId": "...",
//   "action": "relayStart",
//   "status": "ok",
//   "message": "Command executed"
// }
// --------------------------------------------------

if (
  parts.length === 3 &&
  parts[0] === "viz" &&
  parts[2] === "adminAck"
) {
  let ack;

  try {
    ack = JSON.parse(payload);
  } catch (error) {
    console.error(
      "[PRODUCTION ADMIN ACK] Invalid JSON:",
      error.message
    );
    return;
  }

  if (
    !ack ||
    typeof ack !== "object" ||
    Array.isArray(ack)
  ) {
    console.error(
      "[PRODUCTION ADMIN ACK] Invalid ACK payload."
    );
    return;
  }

  try {
    const result = await handleProductionAdminAck({
      deviceId: parts[1],
      ack,
    });

    if (result.requestId && result.status && result.status !== "pending") {
      await DeviceMaintenanceLog.updateOne(
        { requestId: result.requestId, status: "published" },
        {
          $set: {
            status: result.status === "failed" ? "failed" : "acknowledged",
            acknowledgement: { ...ack, receivedAt: new Date() },
            errorMessage: result.status === "failed"
              ? String(ack.message || "Device command failed").slice(0, 500)
              : null,
            completedAt: new Date(),
          },
        }
      );
    }

    if (!result.matched) {
      console.warn(
        "[PRODUCTION ADMIN ACK] No production device matched:",
        parts[1]
      );
    } else if (result.reason) {
      console.warn(
        "[PRODUCTION ADMIN ACK]",
        result.reason,
        parts[1]
      );
    }
  } catch (error) {
    console.error(
      "[PRODUCTION ADMIN ACK] Processing failed:",
      error
    );
  }

  // Never allow a production admin ACK to enter legacy handling.
  return;
}

    // ─────────────────────────────────────────────────────────────────────────
    // BLOCK A2: Config ACK — viz/<deviceId>/configAck
    // Firmware publishes this after successfully receiving + applying a config
    // push from the backend. Topic casing matches firmware exactly: "configAck".
    // Expected payload:
    //   { "status": "ok" | "error", "fwVersion": "<string>", "message": "<string>" }
    // ─────────────────────────────────────────────────────────────────────────
if (
  parts[0] === 'viz' &&
  parts[2] === 'configAck'
) {
  let ack;

  try {
    ack = JSON.parse(payload);
    if (
  !ack ||
  typeof ack !== "object" ||
  Array.isArray(ack)
) {
  console.error("[CONFIG ACK] Invalid ACK payload.");
  return;
}
  } catch (error) {
    console.error(
      '[CONFIG ACK] Invalid JSON:',
      error.message
    );
    return;
  }

  const serialNumber = String(
    ack.serialNumber || parts[1] || ''
  ).trim();

  const deviceId = normalizeDeviceId(
    ack.deviceId
  );

  const ackStatus = String(
    ack.status || ''
  ).toLowerCase();

  const nvsVersion =
    ack.nvsVersion !== undefined
      ? Number(ack.nvsVersion)
      : null;

  if (!serialNumber) {
    // console.warn(
    //   '[CONFIG ACK] Missing serialNumber'
    // );
    return;
  }

  if (
    ![
      CONFIG_ACK_STATUS.OK,
      CONFIG_ACK_STATUS.ERROR,
    ].includes(ackStatus)
  ) {
    // console.warn(
    //   '[CONFIG ACK] Invalid status:',
    //   ackStatus
    // );
    return;
  }

  const ackFields = {
    status: ackStatus,
    ackedAt: new Date(),
    message: ack.message || null,
    fwVersion: ack.fwVersion || null,
    nvsVersion:
      Number.isFinite(nvsVersion)
        ? nvsVersion
        : null,
        requestId: ack.requestId || null,
action: ack.action || "setConfig",
  };
const ackRequestId = String(ack.requestId || "").trim();

// Correlate config ACKs to this serial's pending maintenance request.
if (ackRequestId) {
  const matchingLog = await DeviceMaintenanceLog.findOne({
    requestId: ackRequestId,
    serialNumber,
    status: "published",
  }).lean();

  if (matchingLog) {
    const expectedVersion = Number(matchingLog.changes?.nvsVersion);
    const receivedVersion = Number(ack.nvsVersion);
    const isMigration = matchingLog.category === "deviceIdMigration";

    if (isMigration && (
      !Number.isFinite(expectedVersion) ||
      !Number.isFinite(receivedVersion) ||
      expectedVersion !== receivedVersion ||
      normalizeDeviceId(ack.deviceId) !== normalizeDeviceId(matchingLog.changes?.newDeviceId)
    )) {
      await DeviceMaintenanceLog.updateOne(
        { requestId: ackRequestId, status: "published" },
        {
          $set: {
            status: "failed",
            acknowledgement: ack,
            errorMessage: "Device ID migration ACK did not match requested ID/NVS version",
            completedAt: new Date(),
          },
        }
      );
      return;
    }

    await DeviceMaintenanceLog.updateOne(
      { requestId: ackRequestId, serialNumber, status: "published" },
      {
        $set: {
          status: ackStatus === CONFIG_ACK_STATUS.OK ? "acknowledged" : "failed",
          acknowledgement: {
            status: ackStatus,
            deviceId: ack.deviceId || null,
            action: ack.action || null,
            requestId: ackRequestId,
            message: String(ack.message || "").slice(0, 500),
            fwVersion: String(ack.fwVersion || "").slice(0, 100),
            nvsVersion: Number.isFinite(nvsVersion) ? nvsVersion : null,
            receivedAt: new Date(),
          },
          completedAt: new Date(),
          errorMessage: ackStatus === CONFIG_ACK_STATUS.ERROR
            ? String(ack.message || "Device rejected configuration").slice(0, 500)
            : null,
        },
      }
    );
  }
}
  try {
    // Production 3.0 config ACKs are handled by the V3 subscriber.
// Never mutate legacy Device / DeviceProvision records for V3 devices.
// Process Production ACK before legacy provisioning ACKs.
// Matching Production records must never fall through to legacy updates.
const productionAck = await handleProductionConfigAck({
  serialNumber,
  ack,
});

if (productionAck.matched) {
  const productionLink = await ProductionDevice.findOne({
    serialNumber,
  })
    .select("dispatch.liveDeviceId")
    .lean();

  if (productionLink?.dispatch?.liveDeviceId) {
    await Device.updateOne(
      {
        _id: productionLink.dispatch.liveDeviceId,
      },
      {
        $set: {
          configAck: ackFields,

          ...(ack.fwVersion
            ? {
                lastKnownFirmwareVersion:
                  String(ack.fwVersion).slice(0, 100),
              }
            : {}),

          ...(Number.isFinite(nvsVersion)
            ? { nvsVersion }
            : {}),
        },
      }
    );
  }
const migrationRequestId = String(ack.requestId || "").trim();

if (migrationRequestId && ackStatus === CONFIG_ACK_STATUS.OK) {
  const migration = await DeviceMaintenanceLog.findOne({
    requestId: migrationRequestId,
    serialNumber,
    category: "deviceIdMigration",
    firmwareProfile: "v3",
    status: "acknowledged",
  }).lean();

  if (migration) {
    const oldId = normalizeDeviceId(migration.changes?.oldDeviceId);
    const newId = normalizeDeviceId(migration.changes?.newDeviceId);
    const productionRecord = await ProductionDevice.findOne({
      serialNumber,
      "dispatch.liveDeviceId": { $exists: true },
    }).select("_id groupB.deviceId dispatch.liveDeviceId").lean();

    if (!productionRecord || normalizeDeviceId(productionRecord.groupB?.deviceId) !== oldId) {
      await DeviceMaintenanceLog.updateOne(
        { requestId: migrationRequestId },
        { $set: { status: "failed", errorMessage: "V3 production identity no longer matches migration source", completedAt: new Date() } }
      );
      return;
    }

    const duplicateProduction = await ProductionDevice.exists({
      "groupB.deviceId": newId, _id: { $ne: productionRecord._id },
    });
    const duplicateLiveDevice = await Device.exists({
      device_id: newId, _id: { $ne: productionRecord.dispatch.liveDeviceId },
    });

    if (duplicateProduction || duplicateLiveDevice) {
      await DeviceMaintenanceLog.updateOne(
        { requestId: migrationRequestId },
        { $set: { status: "failed", errorMessage: "New V3 Device ID is already assigned", completedAt: new Date() } }
      );
      return;
    }

    const productionUpdate = await ProductionDevice.updateOne(
      { _id: productionRecord._id, "groupB.deviceId": oldId },
      { $set: { "groupB.deviceId": newId, "groupB.nvsVersion": nvsVersion } }
    );
    const liveUpdate = await Device.updateOne(
      { _id: productionRecord.dispatch.liveDeviceId, device_id: oldId },
      { $set: { device_id: newId, nvsVersion } }
    );

    const productionMatched = productionUpdate.matchedCount ?? productionUpdate.n ?? 0;
    const liveMatched = liveUpdate.matchedCount ?? liveUpdate.n ?? 0;

    if (!productionMatched || !liveMatched) {
      await DeviceMaintenanceLog.updateOne(
        { requestId: migrationRequestId },
        { $set: { status: "failed", errorMessage: "V3 identity update did not match both linked records", completedAt: new Date() } }
      );
      return;
    }

    await DeviceMaintenanceLog.updateOne(
      { requestId: migrationRequestId },
      { $set: { status: "completed", acknowledgement: ack, completedAt: new Date(), errorMessage: null } }
    );
  }
}
  return;
}

    if (
      production &&
      oldId &&
      newId &&
      production.groupB?.deviceId === oldId
    ) {
      const duplicate = await ProductionDevice.exists({
        "groupB.deviceId": newId,
        _id: { $ne: production._id },
      });

      if (!duplicate) {
        await ProductionDevice.updateOne(
          { _id: production._id },
          {
            $set: {
              "groupB.deviceId": newId,
            },
          }
        );

        await Device.updateOne(
          { _id: production.dispatch.liveDeviceId },
          {
            $set: {
              device_id: newId,
            },
          }
        );

        await DeviceMaintenanceLog.updateOne(
          { requestId },
          {
            $set: {
              status: "completed",
              completedAt: new Date(),
            },
          }
        );
      } else {
        await DeviceMaintenanceLog.updateOne(
          { requestId },
          {
            $set: {
              status: "failed",
              errorMessage: "Duplicate V3 Device ID",
            },
          }
        );
      }
    }
  }
}
  return;
}
    const device = await Device.findOne({
      serialNumber,
    });

    const provision = await DeviceProvision.findOne({
      serialNumber,
    });

    // Commit legacy Device ID changes only after an exact successful ACK.
const legacyMigrationRequestId = String(ack.requestId || "").trim();

if (legacyMigrationRequestId && ackStatus === CONFIG_ACK_STATUS.OK && device) {
  const migration = await DeviceMaintenanceLog.findOne({
    requestId: legacyMigrationRequestId,
    serialNumber,
    category: "deviceIdMigration",
    firmwareProfile: "legacy",
    status: "acknowledged",
  }).lean();

  if (migration) {
    const oldId = normalizeDeviceId(migration.changes?.oldDeviceId);
    const newId = normalizeDeviceId(migration.changes?.newDeviceId);
    const expectedVersion = Number(migration.changes?.nvsVersion);
    const receivedVersion = Number(ack.nvsVersion);

    const validAck =
      normalizeDeviceId(device.device_id) === oldId &&
      normalizeDeviceId(ack.deviceId) === newId &&
      Number.isFinite(expectedVersion) &&
      Number.isFinite(receivedVersion) &&
      receivedVersion === expectedVersion;

    if (!validAck) {
      await DeviceMaintenanceLog.updateOne(
        { requestId: legacyMigrationRequestId },
        { $set: { status: "failed", errorMessage: "Legacy Device ID migration ACK validation failed", acknowledgement: ack, completedAt: new Date() } }
      );
      return;
    }

    const [duplicateDevice, duplicateProvision] = await Promise.all([
      Device.exists({ device_id: newId, _id: { $ne: device._id } }),
      DeviceProvision.exists({ deviceId: newId, serialNumber: { $ne: serialNumber } }),
    ]);

    if (duplicateDevice || duplicateProvision) {
      await DeviceMaintenanceLog.updateOne(
        { requestId: legacyMigrationRequestId },
        { $set: { status: "failed", errorMessage: "New Device ID is already assigned", acknowledgement: ack, completedAt: new Date() } }
      );
      return;
    }

    device.device_id = newId;
    device.nvsVersion = receivedVersion;
    await device.save();

    if (provision) {
      provision.deviceId = newId;
      provision.nvsVersion = receivedVersion;
      await provision.save();
    }

    await DeviceMaintenanceLog.updateOne(
      { requestId: legacyMigrationRequestId },
      { $set: { status: "completed", acknowledgement: ack, completedAt: new Date(), errorMessage: null } }
    );
  }
}

    if (!device && !provision) {
      // console.warn(
      //   `[CONFIG ACK] No record for serial ${serialNumber}`
      // );
      return;
    }

    if (device) {
      const deviceUpdate = {
        configAck: ackFields,
      };

      if (
        ack.fwVersion &&
        typeof ack.fwVersion === 'string'
      ) {
        deviceUpdate.lastKnownFirmwareVersion =
          ack.fwVersion;
      }

      await Device.updateOne(
        { _id: device._id },
        { $set: deviceUpdate }
      );
    }

    if (provision) {
      await DeviceProvision.updateOne(
        { _id: provision._id },
        {
          $set: {
            configAck: ackFields,
            provisionStatus:
              ackStatus === CONFIG_ACK_STATUS.OK
                ? PROVISION_STATUS.ACKNOWLEDGED
                : PROVISION_STATUS.FAILED,
            lastKnownFirmwareVersion:
              ack.fwVersion ||
              provision.lastKnownFirmwareVersion,
          },
        }
      );
    }

    // console.log(
    //   `[CONFIG ACK] serial=${serialNumber} ` +
    //   `deviceId=${deviceId} status=${ackStatus} ` +
    //   `nvsVersion=${nvsVersion}`
    // );
  } catch (error) {
    console.error(
      '[CONFIG ACK] Database update failed:',
      error.message
    );
  }

  return;
}

// --------------------------------------------------
// PRODUCTION GROUP A STATUS BEACON
// Topic: viz/<SERIAL_NUMBER>/status
// Payload: { serial, status, fwVersion }
// --------------------------------------------------

if (
  parts.length === 3 &&
  parts[0] === "viz" &&
  parts[2] === "status"
) {
  let statusMessage;

  try {
    statusMessage = JSON.parse(payload);
  } catch (error) {
    console.error(
      "[PRODUCTION STATUS] Invalid JSON:",
      error.message
    );
    return;
  }

  if (
    !statusMessage ||
    typeof statusMessage !== "object" ||
    Array.isArray(statusMessage)
  ) {
    return;
  }

  const topicSerial = String(parts[1] || "")
    .trim()
    .toUpperCase();

  const payloadSerial = String(
    statusMessage.serial || ""
  ).trim().toUpperCase();

  // Both serial identifiers must agree.
  if (
    !topicSerial ||
    !payloadSerial ||
    topicSerial !== payloadSerial
  ) {
    console.warn(
      "[PRODUCTION STATUS] Serial mismatch:",
      { topicSerial, payloadSerial }
    );
    return;
  }

  if (
    String(statusMessage.status || "")
      .trim()
      .toUpperCase() !== "READY"
  ) {
    return;
  }

  try {
    const receivedAt = new Date();

    const update = await ProductionDevice.updateOne(
      {
        serialNumber: topicSerial,
        stage: ProductionDevice.STAGE.GROUP_A,
      },
      {
        $set: {
          "groupA.connection.status": "online",
          "groupA.connection.lastSeen": receivedAt,

          ...(statusMessage.fwVersion
            ? {
                "groupA.lastKnownFirmwareVersion":
                  String(statusMessage.fwVersion).slice(0, 100),
              }
            : {}),
        },
      }
    );

    if (update.matchedCount === 0) {
      console.warn(
        "[PRODUCTION STATUS] No Group A record found:",
        topicSerial
      );
    }
  } catch (error) {
    console.error(
      "[PRODUCTION STATUS] Database update failed:",
      error
    );
  }

  return;
}


    // ─────────────────────────────────────────────────────────────────────────
    // BLOCK B: Telemetry — viz/<deviceId>/Telemetry
    // ─────────────────────────────────────────────────────────────────────────
    if (parts.length < 3 || parts[0] !== 'viz' || parts[2] !== 'Telemetry') {
   //   console.warn('[MQTT RX] Ignoring unexpected topic:', topic);
      return;
    }
// Extract Device ID from viz/<DEVICE_ID>/Telemetry
const deviceId = parts[1];

// Parse telemetry payload before Production or legacy processing.
let msg;

try {
  msg = JSON.parse(payload);
} catch (error) {
  console.error("[MQTT TELEMETRY] Invalid JSON:", error.message);
  return;
}

if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
  console.error("[MQTT TELEMETRY] Invalid telemetry payload");
  return;
}

// --------------------------------------------------
// PRODUCTION TELEMETRY
// Handle Production records BEFORE legacy duplicate
// filtering and legacy Device/Session updates.
//
// Topic: viz/<DEVICE_ID>/Telemetry
// --------------------------------------------------

const productionDeviceId = normalizeDeviceId(deviceId);
let productionRecordMatched = false;

try {
const productionDevice = await ProductionDevice.findOne({
  "groupB.deviceId": productionDeviceId,
})
  .select(
    "_id serialNumber groupB.deviceId dispatch.liveDeviceId"
  )
  .lean();

  if (productionDevice) {
    productionRecordMatched = true;
    const receivedAt = new Date();

    const toFiniteOrNull = (value) => {
      if (
        value === undefined ||
        value === null ||
        value === ""
      ) {
        return null;
      }

      const number = Number(value);

      return Number.isFinite(number) ? number : null;
    };

    let relayOn = null;

    if (typeof msg.relay === "boolean") {
      relayOn = msg.relay;
    } else {
      const relay = String(msg.relay || "").trim().toUpperCase();

      if (relay === "ON") relayOn = true;
      if (relay === "OFF") relayOn = false;
    }

    const sample = {
      serialNumber: productionDevice.serialNumber,
      deviceId: productionDeviceId,

      receivedAt,

      voltage: toFiniteOrNull(msg.voltage),
      current: toFiniteOrNull(msg.current),
      power: toFiniteOrNull(msg.power),

      relay: msg.relay ?? null,
      relayOn,

      state: msg.state || null,
      totalEnergyKwh: toFiniteOrNull(msg.totalEnergy_kWh),

      rawVoltageRatio: toFiniteOrNull(
        msg.rawVoltageRatio
      ),

      rawCurrentRatio: toFiniteOrNull(
        msg.rawCurrentRatio
      ),

      rawPowerRatio: toFiniteOrNull(
        msg.rawPowerRatio
      ),

      sampleAgeMs: toFiniteOrNull(msg.sampleAgeMs),

      sampleFresh:
        typeof msg.sampleFresh === "boolean"
          ? msg.sampleFresh
          : undefined,

      telemetryMode: msg.telemetryMode || null,
      telemetryRequestId: msg.telemetryRequestId || null,
      telemetrySequence: toFiniteOrNull(msg.telemetrySequence),

      fwVersion: msg.fwVersion || null,

      rawPayload: msg,
    };

    // Store only the latest production sample in memory.
    // Do NOT create DeviceTelemetry documents for every tick.
    setLatestProductionTelemetry(sample);

    // Persist connection metadata only.
    await ProductionDevice.updateOne(
      { _id: productionDevice._id },
      {
        $set: {
          "groupB.connection.status": "online",
          "groupB.connection.lastSeen": receivedAt,

          ...(msg.fwVersion
            ? {
                "groupB.lastKnownFirmwareVersion":
                  String(msg.fwVersion),
              }
            : {}),
        },
      }
    );

   
// Production 3.0 devices that have not been dispatched
// must not enter the legacy Device/session pipeline.
if (!productionDevice.dispatch?.liveDeviceId) {
  return;
}

// A dispatched Production 3.0 record must update its
// linked legacy Live Device before session processing.
const linkedDeviceUpdate = await Device.updateOne(
  {
    _id: productionDevice.dispatch.liveDeviceId,
  },
  {
    $set: {
      status: msg.state || "Unknown",
      relayOn: relayOn === true,

      lastKnownVoltage: sample.voltage ?? 0,
      lastKnownCurrent: sample.current ?? 0,

      totalenergy: sample.totalEnergyKwh ?? 0,
      lastSeen: receivedAt,

      ...(msg.fwVersion
        ? {
            lastKnownFirmwareVersion:
              String(msg.fwVersion).slice(0, 100),
          }
        : {}),
    },
  }
);

const linkedMatched =
  linkedDeviceUpdate?.matchedCount ??
  linkedDeviceUpdate?.n ??
  0;

// Never allow an invalid/broken migration link to
// create another Live Device through the old flow.
if (linkedMatched === 0) {
  console.error(
    "[PRODUCTION TELEMETRY] Linked Live Device not found:",
    productionDevice.dispatch.liveDeviceId
  );
  return;
}

// IMPORTANT:
// Do not return here.
// Continue to the existing legacy session-processing code.

  }

} catch (productionTelemetryError) {
  console.error(
    "[PRODUCTION TELEMETRY] Processing failed:",
    productionTelemetryError
  );

  // Fail closed: do not accidentally process uncertain
  // Production telemetry as a legacy charging device.
  return;
}


    // Duplicate filter — skip if exact same message seen within 30s
    const msgKey = topic + JSON.stringify(msg);
    if (processedMessages.has(msgKey)) {
      // console.log(`⏩ Skipped duplicate message on ${topic}`);
      return;
    }
    processedMessages.add(msgKey);
    setTimeout(() => processedMessages.delete(msgKey), 30_000);

    const now = new Date();

    // Normalize fields from telemetry payload
    const status         = msg.state || 'Unknown';
    const totalEnergy    = Number(msg.totalEnergy_kWh) || 0;
    const v              = Number(msg.voltage) || 0;
    const c              = Number(msg.current) || 0;
    const p              = Number(msg.power) || 0;
    const relayOn        = (msg.relay || '').toString().toUpperCase() === 'ON';
    const sessionId      = msg.sessionId || null;
const energyConsumed = msg.consumed_kWh != null
  ? Number(msg.consumed_kWh) || 0
  : undefined;

const isAvailable =
  status === "Available" ||
  status === "available";

const devKey = normalizeDeviceId(deviceId);

try {



      // If no Device document exists yet, auto-create from DeviceProvision

const deviceIds = deviceIdCandidates(deviceId);

const devResult = await Device.updateOne(
  { device_id: { $in: deviceIds } },
  {
    $set: {
      status,
      relayOn,
      voltage: v,
      current: c,
      power: p,
      totalenergy: totalEnergy,
      lastSeen: now,
      updatedAt: now,
    },
  }
);

const matched =
  devResult?.matchedCount ??
  devResult?.n ??
  0;

if (matched === 0 && !productionRecordMatched) {
  const provision =
    await DeviceProvision.findOne({
      deviceId: devKey,
      manufacturingStatus: {
        $in: ['group_b', 'dispatched'],
      },
    });

  if (provision) {
    try {
      const newDevice = await Device.create({
        device_id: devKey,
        serialNumber: provision.serialNumber,

        hardwareRevision:
          provision.hardwareRevision || '',

        project:
          provision.project || '',

        charger_type:
          provision.charger_type || '',

        location: provision.location,
        lat: provision.lat,
        lng: provision.lng,
        area: provision.area,
        city: provision.city,
        state: provision.state,

        meterType:
          provision.meterType || null,

        meterConsumerNumber:
          provision.meterConsumerNumber || null,

        cf: provision.cf,
        vf: provision.vf,
        currentRF: provision.currentRF,

        wifiSSID:
          provision.wifiSSID || null,

        wifiPassword:
          provision.wifiPassword || null,

        rate: provision.rate,
        rateHistory:
          provision.rateHistory || [],

        commercial:
          provision.commercial || {},

        targetFirmwareVersion:
          provision.targetFirmwareVersion || null,

        lastKnownFirmwareVersion:
          provision.lastKnownFirmwareVersion || null,

        nvsVersion:
          provision.nvsVersion || 0,

        onboardingStatus: 'pending',
        provisionRef: provision._id,

        status,
        relayOn,
        totalenergy: totalEnergy,
        lastSeen: now,
      });

      await DeviceProvision.updateOne(
        { _id: provision._id },
        {
          $set: {
            manufacturingStatus: 'live',
            linkedDeviceId: newDevice._id,
          },
        }
      );

      // console.log(
      //   `[AUTO DEVICE] Created ${devKey} ` +
      //   `from serial ${provision.serialNumber}`
      // );
    } catch (error) {
      // Duplicate-key errors can occur if two telemetry
      // packets arrive simultaneously.
      if (error.code === 11000) {
        // console.warn(
        //   `[AUTO DEVICE] Duplicate creation avoided for ${devKey}`
        // );
      } else {
        // console.error(
        //   '[AUTO DEVICE] Creation failed:',
        //   error.message
        // );
      }
    }
  } else {
    // console.warn(
    //   `[AUTO DEVICE] No Group B provision found for ${devKey}`
    // );
  }
}

      // console.log(
      //   '[MQTT DEBUG] Device update', deviceId,
      //   'matched=',  devResult?.matchedCount  ?? devResult?.n,
      //   'modified=', devResult?.modifiedCount ?? devResult?.nModified
      // );


      // ── 2) Store 1-minute telemetry history ──────────────────────────────
      try {
        const roundedTime = new Date(
          now.getFullYear(), now.getMonth(), now.getDate(),
          now.getHours(), now.getMinutes()
        );

        const exists = await DeviceTelemetry.findOne({
          deviceId:  deviceId.toUpperCase(),
          timestamp: roundedTime,
        });

        if (!exists) {
          await DeviceTelemetry.create({
            deviceId:  deviceId.toUpperCase(),
            voltage:   v,
            current:   c,
            power:     p,
            timestamp: roundedTime,
          });
          // console.log(`[MQTT] 📊 Telemetry stored for ${deviceId} @ ${roundedTime.toISOString()}`);
        }
      } catch (telemetryErr) {
        console.error('❌ Telemetry history save failed:', telemetryErr);
      }


      // ── 3) Update Session snapshot + ETA if sessionId is present ─────────
      if (sessionId) {
      const sessSet = {
        latestVoltage:        v,
        latestCurrent:        c,
        latestPower:          p,
        lastUpdate:           now,
        lastTelemetryAt:      now,   // ← NEW: stamp every time we get real telemetry
        deviceAvailableSince: null,  // ← NEW: clear the grace-period clock while session is live
      };
      if (energyConsumed !== undefined) {
        sessSet.energyConsumed = energyConsumed;
      }

        const sessResult = await Session.updateOne(
          { sessionId, status: 'active' },
          {
            $set:  sessSet,
            $push: {
              telemetry: {
                timestamp: now,
                voltage:   v,
                current:   c,
                power_W:   p,
              },
            },
          }
        );


        if (!isAvailable || relayOn) {
  availableWithSessionSince.delete(
    normalizeDeviceId(deviceId)
  );
}

        // Device is actively reporting a sessionId — reset available-tick counter
availableNoSessionTicks.delete(devKey);


        // console.log(
        //   '[MQTT DEBUG] Session update', sessionId,
        //   'matched=',  sessResult?.matchedCount  ?? sessResult?.n,
        //   'modified=', sessResult?.modifiedCount ?? sessResult?.nModified
        // );

        // ── ETA ESTIMATION ENGINE ────────────────────────────────────────
        // Recalculates estimatedEndTime only when a 5% milestone is crossed,
        // then every tick once above 90%.
        if (energyConsumed !== undefined && energyConsumed > 0) {
          try {
            const sessionSnap = await Session.findOne(
              { sessionId, status: 'active' },
              { energySelected: 1, startTime: 1, lastEstimationPct: 1, energyConsumed: 1 }
            ).lean();

            if (sessionSnap && sessionSnap.energySelected > 0) {
              const selected       = Number(sessionSnap.energySelected);
              const consumed       = Number(energyConsumed);
              const startTime      = new Date(sessionSnap.startTime);
              const lastPct        = Number(sessionSnap.lastEstimationPct || 0);
              const currentPct     = (consumed / selected) * 100;

              const currentMilestone = currentPct >= 90
                ? Math.floor(currentPct)
                : Math.floor(currentPct / 5) * 5;

              const shouldRecalculate =
                (lastPct === 0 && currentPct >= 1) ||
                currentMilestone > lastPct;

              if (shouldRecalculate) {
                const elapsedMs = now.getTime() - startTime.getTime();

                if (elapsedMs >= 30_000 && consumed > 0) {
                  const rateKwhPerMs     = consumed / elapsedMs;
                  const remainingKwh     = Math.max(0, selected - consumed);
                  const msToFinish       = remainingKwh / rateKwhPerMs;
                  const estimatedEndTime = new Date(now.getTime() + msToFinish);
                  const maxEnd           = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                  const safeETA          = estimatedEndTime > maxEnd ? maxEnd : estimatedEndTime;

                  await Session.updateOne(
                    { sessionId, status: 'active' },
                    {
                      $set: {
                        estimatedEndTime:  safeETA,
                        lastEstimationPct: currentMilestone || Math.floor(currentPct),
                      },
                    }
                  );

                  // console.log(
                  //   `[ETA] Session ${sessionId} | ` +
                  //   `Progress: ${currentPct.toFixed(1)}% | ` +
                  //   `Rate: ${(rateKwhPerMs * 3_600_000).toFixed(3)} kWh/h | ` +
                  //   `ETA: ${safeETA.toISOString()}`
                  // );
                }
              }
            }
          } catch (etaErr) {
            console.error('[ETA] Estimation failed (non-fatal):', etaErr.message);
          }
        }
        // ── END ETA ENGINE ───────────────────────────────────────────────
      }



// ── FIX 1 (REVISED): Grace-period auto-end + fault state ─────────────────────
//
// Case 1 — relay is ON but no sessionId in telemetry:
//   Hardware is physically charging with no session in DB → fault, do NOT kill.
//   Set device.faultCode so admin dashboard can surface it.
//
// Case 2 — state is Available AND no sessionId:
//   Device finished/stopped on its own. But we require N consecutive ticks
//   before ending the session to avoid premature ends from a single glitchy packet.
//
// Case 3 — state is anything other than Available (e.g. Charging, Occupied):
//   Reset the consecutive tick counter — device is alive and working.
// ─────────────────────────────────────────────────────────────────────────────



if (isAvailable && !relayOn && sessionId) {
  const firstAvailableAt =
    availableWithSessionSince.get(devKey) || now;

  availableWithSessionSince.set(
    devKey,
    firstAvailableAt
  );

  const availableDurationMs =
    now.getTime() - firstAvailableAt.getTime();

  // console.log("[MQTT AVAILABLE SESSION]", {
  //   deviceId: devKey,
  //   sessionId,
  //   relayOn,
  //   availableForSeconds: Math.floor(
  //     availableDurationMs / 1000
  //   ),
  //   requiredSeconds: Math.floor(
  //     AVAILABLE_WITH_SESSION_GRACE_MS / 1000
  //   ),
  // });

  if (
    availableDurationMs >=
    AVAILABLE_WITH_SESSION_GRACE_MS
  ) {
    availableWithSessionSince.delete(devKey);

    try {
      await completeSessionInternal({
        sessionId,
        endTime: now.toISOString(),
        endTrigger:
          "device_auto_available_session_active",
        deltaEnergy:
          energyConsumed !== undefined
            ? Number(energyConsumed)
            : 0,
        deviceIdOverride: devKey,
        sendStopMqtt: true,
      });

      // console.log(
      //   "[MQTT AUTO-END] Session completed " +
      //     "because device was Available with relay OFF:",
      //   {
      //     deviceId: devKey,
      //     sessionId,
      //   }
      // );
    } catch (error) {
      console.error(
        "[MQTT AUTO-END] Failed to complete " +
          "Available + relay OFF session:",
        {
          deviceId: devKey,
          sessionId,
          error,
        }
      );
    }
  }

} else if (relayOn && !sessionId) {
  // ── CASE 1: Fault — relay ON but no session ───────────────────────────────
  // console.warn(
  //   `[MQTT FAULT] Device ${deviceId} relay is ON but no sessionId in telemetry. ` +
  //   `Marking device as fault_no_session.`
  // );
await Device.updateOne(
  { device_id: { $in: deviceIdCandidates(deviceId) } },
    {
      $set: {
        faultCode:   'fault_no_session',
        faultSince:  now,
        faultDetails: `Relay ON reported at ${now.toISOString()} with no active sessionId`,
      }
    }
  );
  // Do NOT auto-end anything — let admin investigate.

} else if (isAvailable && !sessionId) {
  // ── CASE 2: Available with no sessionId — check consecutive ticks ─────────

  const prev   = availableNoSessionTicks.get(devKey) || 0;
  const count  = prev + 1;
  availableNoSessionTicks.set(devKey, count);

  // console.log(
  //   `[MQTT GRACE] Device ${devKey} Available+noSession tick ${count}/${AUTO_END_CONSECUTIVE_TICKS_REQUIRED}`
  // );

if (count >= AUTO_END_CONSECUTIVE_TICKS_REQUIRED) {
  availableNoSessionTicks.delete(devKey);

  const orphanSession = await Session.findOne({
    deviceId: { $in: deviceIdCandidates(deviceId) },
    status: "active",
  })
    .sort({ startTime: 1 })
    .lean();

  if (!orphanSession) {
    // console.warn(
    //   `[MQTT AUTO-END] No active session found for device ${devKey}`
    // );

    return;
  }

  if (relayOn) {
    // console.warn(
    //   `[MQTT AUTO-END] Refusing to end ${orphanSession.sessionId}: relay is ON`
    // );

    return;
  }

  try {
    await completeSessionInternal({
      sessionId: orphanSession.sessionId,
      endTime: new Date().toISOString(),
      endTrigger: "device_auto_available",
      deltaEnergy:
        energyConsumed !== undefined
          ? Number(energyConsumed)
          : Number(orphanSession.energyConsumed || 0),
      deviceIdOverride: orphanSession.deviceId,
      sendStopMqtt: false,
    });

    // console.log(
    //   `[MQTT AUTO-END] Completed orphan session ` +
    //   `${orphanSession.sessionId} for device ${devKey}`
    // );
  } catch (error) {
    console.error(
      `[MQTT AUTO-END] Failed to complete ` +
      `${orphanSession.sessionId}:`,
      error
    );
  }
}
  

} else {
  availableNoSessionTicks.delete(devKey);
  availableWithSessionSince.delete(devKey);
}
// ── END FIX 1 (REVISED) ──────────────────────────────────────────────────────


    } catch (err) {
      console.error('❌ Error handling Telemetry:', err);
    }
  });


  mqttClient.on('error', (err) => console.error('❌ MQTT client error:', err));
}


// ─────────────────────────────────────────────────────────────────────────────
// FIX 3 (REVISED): ORPHAN SESSION CLEANUP CRON
//
// Tightened conditions vs original:
//   OLD: device.status === Available OR Offline  →  kill immediately
// NEW: ALL of these must be true before killing:
//   1. device.status is Available
//   2. Device has been Available for >= CRON_GRACE_MS (5 min)
//      — tracked using session.deviceAvailableSince
//   3. Session has not received telemetry in >= CRON_STALE_TELEMETRY_MS (5 min)
//   4. Session is older than 2 minutes
//
// IMPORTANT:
//   Offline is not considered proof that charging has ended.
//   Offline devices must never be auto-completed by this cron.
//
// This prevents killing sessions during:
//   - Brief device reconnects / firmware reboots (device goes offline for <5 min)
//   - Race conditions where session starts but first telemetry hasn't arrived yet
//   - MQTT broker hiccups that cause a missed telemetry packet
// ─────────────────────────────────────────────────────────────────────────────
const ORPHAN_CHECK_INTERVAL_MS   = 3 * 60 * 1000;  // run every 3 min
const SESSION_MIN_AGE_MS         = 2 * 60 * 1000;  // ignore sessions < 2 min old

async function cleanupOrphanSessions() {
  try {
    const now            = new Date();
    const graceCutoff    = new Date(now.getTime() - CRON_GRACE_MS);           // 5 min ago
    const staleCutoff    = new Date(now.getTime() - CRON_STALE_TELEMETRY_MS); // 5 min ago
    const minAgeCutoff   = new Date(now.getTime() - SESSION_MIN_AGE_MS);      // 2 min ago

    // Only fetch sessions that are:
    //  - active or paused
    //  - started more than 2 minutes ago (skip brand-new sessions)
const activeSessions = await Session.find(
  {
    status: "active",
    startTime: { $lte: minAgeCutoff },
  },
      { sessionId: 1, deviceId: 1, energyConsumed: 1, startTime: 1,
        lastTelemetryAt: 1, deviceAvailableSince: 1, _id: 0 }
    ).lean();

    if (!activeSessions.length) return;

    for (const sess of activeSessions) {
const device = await Device.findOne(
  {
    device_id: {
      $in: deviceIdCandidates(sess.deviceId),
    },
  },
  {
    status: 1,
    lastSeen: 1,
    _id: 0,
  }
).lean();

      if (!device) continue;

const devStatus = (device.status || '').trim().toLowerCase();

// Only Available is allowed to start/continue orphan cleanup.
// Offline must never automatically end a session.
const isAvailable = devStatus === 'available';

if (!isAvailable) {
  // Includes:
  // - offline
  // - occupied
  // - charging
  // - paused
  // - faulty
  // - unknown
  //
  // Do not end the session for any of these states.
  // Clear any previously started Available grace-period clock.
  if (sess.deviceAvailableSince) {
    await Session.updateOne(
      { sessionId: sess.sessionId },
      { $set: { deviceAvailableSince: null } }
    );
  }

  continue;
}

// ── Device IS Available ──────────────────────────────────────────────

      // Condition 1: Has the session received telemetry recently?
      //   If lastTelemetryAt is null (session never got any telemetry),
      //   use startTime as the reference so very new sessions aren't killed.
      const lastActivity = sess.lastTelemetryAt || sess.startTime;
      const telemetryIsStale = lastActivity < staleCutoff;

      if (!telemetryIsStale) {
        // Session is still getting telemetry — not a true orphan yet
        // console.log(
        //   `[CRON ORPHAN] Session ${sess.sessionId}: device=${device.status} ` +
        //   `but telemetry is fresh (${lastActivity.toISOString()}) — skipping`
        // );
        continue;
      }

      // Condition 2: Has the device been in this state long enough?
      //   We use deviceAvailableSince on the session as the clock.
      //   If not set yet, stamp it now and wait for next cron run.
      if (!sess.deviceAvailableSince) {
        await Session.updateOne(
          { sessionId: sess.sessionId },
          { $set: { deviceAvailableSince: now } }
        );
        // console.log(
        //   `[CRON ORPHAN] Session ${sess.sessionId}: device=${device.status}, ` +
        //   `telemetry stale — starting grace period clock`
        // );
        continue; // check again next run (3 min later)
      }

      const graceElapsed = sess.deviceAvailableSince < graceCutoff;

      if (!graceElapsed) {
        // console.log(
        //   `[CRON ORPHAN] Session ${sess.sessionId}: grace period in progress ` +
        //   `(since ${sess.deviceAvailableSince.toISOString()}) — not yet`
        // );
        continue;
      }

      // ── All conditions met — safe to kill ────────────────────────────────
      // console.log(
      //   `[CRON ORPHAN] ✅ Session ${sess.sessionId} qualifies for cleanup:\n` +
      //   `  device=${device.status}, stale telemetry since ${lastActivity.toISOString()},\n` +
      //   `  deviceAvailableSince=${sess.deviceAvailableSince.toISOString()}`
      // );

      try {
        await completeSessionInternal({
          sessionId:    sess.sessionId,
          endTime:      now.toISOString(),
          endTrigger:   'orphan_cleanup',
          deltaEnergy:  Number(sess.energyConsumed || 0),
          sendStopMqtt: false,
        });
       // console.log(`[CRON ORPHAN] ✅ Completed orphan session: ${sess.sessionId}`);
      } catch (e) {
        console.error(`[CRON ORPHAN] ❌ Failed for ${sess.sessionId}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[CRON ORPHAN] Cron error:', err.message);
  }
}

// Start cron after 30s delay so DB connection is fully ready on boot
setTimeout(() => {
  // console.log('[CRON ORPHAN] Orphan session cleanup cron started (every 3 minutes)');
  cleanupOrphanSessions();
  setInterval(cleanupOrphanSessions, ORPHAN_CHECK_INTERVAL_MS);
}, 30_000);

module.exports = startMqttSubscriber;