// mqttSubscriber.js

const mongoose = require('mongoose');
const Session = require('./models/session');
const Device = require('./models/device');
const mqttClient = require('./mqttClient'); // shared connection
const Receipt = require('./models/Receipt');
const DeviceTelemetry = require('./models/deviceTelemetry');

// FIX 2: top-of-file import (no more inline require inside handlers)
const { completeSessionInternal } = require('./controllers/sessionController');

// Optional: simple duplicate filter
const processedMessages = new Set();


// ─────────────────────────────────────────────────────────────────────────────
// MAIN SUBSCRIBER
// ─────────────────────────────────────────────────────────────────────────────
function startMqttSubscriber() {

  mqttClient.on('connect', () => {
    console.log('✅ Backend connected to MQTT broker');

    const topics = ['viz/+/Telemetry', 'device/+/session/end', 'viz/+/sessionend'];
    mqttClient.subscribe(topics, { qos: 1 }, (err) => {
      if (err) {
        console.error('MQTT subscribe failed:', err);
      } else {
        console.log('✅ Subscribed to:', topics);
      }
    });
  });


  mqttClient.on('message', async (topic, buf) => {
    const payload = buf.toString();
    console.log(`[MQTT RX] topic=${topic} payload=${payload}`);

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
        console.warn('[MQTT] Incomplete session/end payload:', msg);
        return;
      }

      console.log('[MQTT] session/end received:', { deviceId, sessionId, endTrigger, energy_kWh, topic });

      try {
        await completeSessionInternal({
          sessionId,
          endTime:          new Date(endTime).toISOString(),
          endTrigger,
          deltaEnergy:      Number(energy_kWh) || 0,
          deviceIdOverride: deviceId,
          sendStopMqtt:     false,
        });
        console.log('[MQTT] ✅ Session auto-completed via session/end event:', sessionId);
      } catch (err) {
        console.error('[MQTT] ❌ Failed auto-completing session:', err);
      }
      return; // do NOT fall through to Telemetry handler
    }


    // ─────────────────────────────────────────────────────────────────────────
    // BLOCK B: Telemetry — viz/<deviceId>/Telemetry
    // ─────────────────────────────────────────────────────────────────────────
    if (parts.length < 3 || parts[0] !== 'viz' || parts[2] !== 'Telemetry') {
      console.warn('[MQTT RX] Ignoring unexpected topic:', topic);
      return;
    }

    const deviceId = parts[1];

    let msg;
    try {
      msg = JSON.parse(payload);
      console.log('[MQTT RX] Parsed Telemetry payload:', msg);
    } catch (e) {
      console.error('❌ Invalid JSON on Telemetry:', e, payload);
      return;
    }

    if (!msg || typeof msg !== 'object') {
      console.error('❌ Non-object Telemetry payload:', msg);
      return;
    }

    // Duplicate filter — skip if exact same message seen within 30s
    const msgKey = topic + JSON.stringify(msg);
    if (processedMessages.has(msgKey)) {
      console.log(`⏩ Skipped duplicate message on ${topic}`);
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

    try {

      // ── 1) Update Device document ────────────────────────────────────────
      const devResult = await Device.updateOne(
        { device_id: (deviceId || '').toUpperCase() },
        {
          $set: {
            status,
            relayOn,
            voltage:     v,
            current:     c,
            power:       p,
            totalenergy: totalEnergy,
            lastSeen:    now,
            updatedAt:   now,
          }
        }
      );

      console.log(
        '[MQTT DEBUG] Device update', deviceId,
        'matched=',  devResult?.matchedCount  ?? devResult?.n,
        'modified=', devResult?.modifiedCount ?? devResult?.nModified
      );


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
          console.log(`[MQTT] 📊 Telemetry stored for ${deviceId} @ ${roundedTime.toISOString()}`);
        }
      } catch (telemetryErr) {
        console.error('❌ Telemetry history save failed:', telemetryErr);
      }


      // ── 3) Update Session snapshot + ETA if sessionId is present ─────────
      if (sessionId) {
        const sessSet = {
          latestVoltage: v,
          latestCurrent: c,
          latestPower:   p,
          lastUpdate:    now,
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

        console.log(
          '[MQTT DEBUG] Session update', sessionId,
          'matched=',  sessResult?.matchedCount  ?? sessResult?.n,
          'modified=', sessResult?.modifiedCount ?? sessResult?.nModified
        );

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

                  console.log(
                    `[ETA] Session ${sessionId} | ` +
                    `Progress: ${currentPct.toFixed(1)}% | ` +
                    `Rate: ${(rateKwhPerMs * 3_600_000).toFixed(3)} kWh/h | ` +
                    `ETA: ${safeETA.toISOString()}`
                  );
                }
              }
            }
          } catch (etaErr) {
            console.error('[ETA] Estimation failed (non-fatal):', etaErr.message);
          }
        }
        // ── END ETA ENGINE ───────────────────────────────────────────────
      }


      // ── FIX 1: SERVER-SIDE AUTO-END on device → Available ────────────────
      // Fires when firmware sends Telemetry with state:"Available" and no
      // sessionId — meaning device finished charging on its own. Handles the
      // case where the user's browser tab is closed or the poll missed it.
      if (
        (status === 'Available' || status === 'available') &&
        !sessionId
      ) {
        try {
          const orphanSession = await Session.findOne({
            deviceId: deviceId.toUpperCase(),
            status:   { $in: ['active', 'paused'] },
          }).lean();

          if (orphanSession) {
            console.log(
              `[MQTT AUTO-END] Device ${deviceId} reported Available — ` +
              `orphan session found: ${orphanSession.sessionId}`
            );

            await completeSessionInternal({
              sessionId:        orphanSession.sessionId,
              endTime:          new Date().toISOString(),
              endTrigger:       'device_auto_available',
              deltaEnergy:      energyConsumed !== undefined
                                  ? energyConsumed
                                  : Number(orphanSession.energyConsumed || 0),
              deviceIdOverride: deviceId.toUpperCase(),
              sendStopMqtt:     false,
            });

            console.log(
              `[MQTT AUTO-END] ✅ Session ${orphanSession.sessionId} ` +
              `completed by device_auto_available`
            );
          }
        } catch (autoEndErr) {
          console.error('[MQTT AUTO-END] ❌ Failed to auto-complete session:', autoEndErr.message);
        }
      }
      // ── END FIX 1 ────────────────────────────────────────────────────────

    } catch (err) {
      console.error('❌ Error handling Telemetry:', err);
    }
  });


  mqttClient.on('error', (err) => console.error('❌ MQTT client error:', err));
}


// ─────────────────────────────────────────────────────────────────────────────
// FIX 3: ORPHAN SESSION CLEANUP CRON
// Runs every 3 minutes. Catches sessions that are still "active" in MongoDB
// but whose device is already "Available" or "Offline" in the DB.
// Safety net for: missed MQTT events, server restarts, network drops.
// ─────────────────────────────────────────────────────────────────────────────
const ORPHAN_CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

async function cleanupOrphanSessions() {
  try {
    const activeSessions = await Session.find(
      { status: { $in: ['active', 'paused'] } },
      { sessionId: 1, deviceId: 1, energyConsumed: 1, _id: 0 }
    ).lean();

    if (!activeSessions.length) return;

    for (const sess of activeSessions) {
      const device = await Device.findOne(
        { device_id: sess.deviceId },
        { status: 1, _id: 0 }
      ).lean();

      if (!device) continue;

      const devStatus = (device.status || '').toLowerCase();

      if (devStatus === 'available' || devStatus === 'offline') {
        console.log(
          `[CRON ORPHAN] Session ${sess.sessionId} is ${sess.status} ` +
          `but device ${sess.deviceId} is "${device.status}" — auto-completing`
        );
        try {
          await completeSessionInternal({
            sessionId:    sess.sessionId,
            endTime:      new Date().toISOString(),
            endTrigger:   'orphan_cleanup',
            deltaEnergy:  Number(sess.energyConsumed || 0),
            sendStopMqtt: false,
          });
          console.log(`[CRON ORPHAN] ✅ Completed orphan session: ${sess.sessionId}`);
        } catch (e) {
          console.error(`[CRON ORPHAN] ❌ Failed for ${sess.sessionId}:`, e.message);
        }
      }
    }
  } catch (err) {
    console.error('[CRON ORPHAN] Cron error:', err.message);
  }
}

// Start cron after 30s delay so DB connection is fully ready on boot
setTimeout(() => {
  console.log('[CRON ORPHAN] Orphan session cleanup cron started (every 3 minutes)');
  cleanupOrphanSessions(); // run once immediately on start
  setInterval(cleanupOrphanSessions, ORPHAN_CHECK_INTERVAL_MS);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────


module.exports = startMqttSubscriber;