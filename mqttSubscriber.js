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
// ─────────────────────────────────────────────────────────────────────────────

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

// Device is actively reporting a sessionId — reset available-tick counter
availableNoSessionTicks.delete(deviceId.toUpperCase());

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

const isAvailable = status === 'Available' || status === 'available';

if (relayOn && !sessionId) {
  // ── CASE 1: Fault — relay ON but no session ───────────────────────────────
  console.warn(
    `[MQTT FAULT] Device ${deviceId} relay is ON but no sessionId in telemetry. ` +
    `Marking device as fault_no_session.`
  );
  await Device.updateOne(
    { device_id: deviceId.toUpperCase() },
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
  const devKey = deviceId.toUpperCase();
  const prev   = availableNoSessionTicks.get(devKey) || 0;
  const count  = prev + 1;
  availableNoSessionTicks.set(devKey, count);

  console.log(
    `[MQTT GRACE] Device ${devKey} Available+noSession tick ${count}/${AUTO_END_CONSECUTIVE_TICKS_REQUIRED}`
  );

  if (count >= AUTO_END_CONSECUTIVE_TICKS_REQUIRED) {
    availableNoSessionTicks.delete(devKey); // reset counter

    const orphanSession = await Session.findOne({
      deviceId: devKey,
      status:   { $in: ['active', 'paused'] },
    }).lean();

    if (orphanSession) {
      console.log(
        `[MQTT AUTO-END] ${count} consecutive Available+noSession ticks — ` +
        `ending orphan session ${orphanSession.sessionId}`
      );

      await completeSessionInternal({
        sessionId:        orphanSession.sessionId,
        endTime:          new Date().toISOString(),
        endTrigger:       'device_auto_available',
        deltaEnergy:      energyConsumed !== undefined
                            ? energyConsumed
                            : Number(orphanSession.energyConsumed || 0),
        deviceIdOverride: devKey,
        sendStopMqtt:     false,
      });

      console.log(`[MQTT AUTO-END] ✅ Session ${orphanSession.sessionId} completed`);
    }
  }

} else {
  // ── CASE 3: Device is in any active state — reset counter ────────────────
  availableNoSessionTicks.delete(deviceId.toUpperCase());
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
//   NEW: ALL of these must be true before killing:
//     1. device.status is Available or Offline
//     2. Device has been in that state for >= CRON_GRACE_MS (5 min)
//        — checked via device.lastSeen vs session.deviceAvailableSince
//     3. Session has not received any telemetry in >= CRON_STALE_TELEMETRY_MS (5 min)
//        — checked via session.lastTelemetryAt
//     4. Session is older than 2 minutes (ignore brand-new sessions)
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
        status:    { $in: ['active', 'paused'] },
        startTime: { $lte: minAgeCutoff },
      },
      { sessionId: 1, deviceId: 1, energyConsumed: 1, startTime: 1,
        lastTelemetryAt: 1, deviceAvailableSince: 1, _id: 0 }
    ).lean();

    if (!activeSessions.length) return;

    for (const sess of activeSessions) {
      const device = await Device.findOne(
        { device_id: sess.deviceId },
        { status: 1, lastSeen: 1, _id: 0 }
      ).lean();

      if (!device) continue;

      const devStatus = (device.status || '').toLowerCase();
      const isProblematic = devStatus === 'available' || devStatus === 'offline';

      if (!isProblematic) {
        // Device is actively charging — clear deviceAvailableSince if it was set
        if (sess.deviceAvailableSince) {
          await Session.updateOne(
            { sessionId: sess.sessionId },
            { $set: { deviceAvailableSince: null } }
          );
        }
        continue;
      }

      // ── Device IS Available or Offline ───────────────────────────────────

      // Condition 1: Has the session received telemetry recently?
      //   If lastTelemetryAt is null (session never got any telemetry),
      //   use startTime as the reference so very new sessions aren't killed.
      const lastActivity = sess.lastTelemetryAt || sess.startTime;
      const telemetryIsStale = lastActivity < staleCutoff;

      if (!telemetryIsStale) {
        // Session is still getting telemetry — not a true orphan yet
        console.log(
          `[CRON ORPHAN] Session ${sess.sessionId}: device=${device.status} ` +
          `but telemetry is fresh (${lastActivity.toISOString()}) — skipping`
        );
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
        console.log(
          `[CRON ORPHAN] Session ${sess.sessionId}: device=${device.status}, ` +
          `telemetry stale — starting grace period clock`
        );
        continue; // check again next run (3 min later)
      }

      const graceElapsed = sess.deviceAvailableSince < graceCutoff;

      if (!graceElapsed) {
        console.log(
          `[CRON ORPHAN] Session ${sess.sessionId}: grace period in progress ` +
          `(since ${sess.deviceAvailableSince.toISOString()}) — not yet`
        );
        continue;
      }

      // ── All conditions met — safe to kill ────────────────────────────────
      console.log(
        `[CRON ORPHAN] ✅ Session ${sess.sessionId} qualifies for cleanup:\n` +
        `  device=${device.status}, stale telemetry since ${lastActivity.toISOString()},\n` +
        `  deviceAvailableSince=${sess.deviceAvailableSince.toISOString()}`
      );

      try {
        await completeSessionInternal({
          sessionId:    sess.sessionId,
          endTime:      now.toISOString(),
          endTrigger:   'orphan_cleanup',
          deltaEnergy:  Number(sess.energyConsumed || 0),
          sendStopMqtt: false,
        });
        console.log(`[CRON ORPHAN] ✅ Completed orphan session: ${sess.sessionId}`);
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
  console.log('[CRON ORPHAN] Orphan session cleanup cron started (every 3 minutes)');
  cleanupOrphanSessions();
  setInterval(cleanupOrphanSessions, ORPHAN_CHECK_INTERVAL_MS);
}, 30_000);

module.exports = startMqttSubscriber;