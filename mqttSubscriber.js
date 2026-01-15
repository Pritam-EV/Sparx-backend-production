// mqttSubscriber.js

const mongoose = require('mongoose');
const Session = require('./models/session');
const Device = require('./models/device');
// const Telemetry = require('./models/telemetry');
const mqttClient = require('./mqttClient'); // shared connection
const Receipt = require('./models/Receipt');

// Optional: simple duplicate filter (can be kept or removed)
const processedMessages = new Set();

function startMqttSubscriber() {

  mqttClient.on('connect', () => {
    console.log('✅ Backend connected to MQTT broker');

    // Subscribe only to unified Telemetry topic from devices
  const topics = [
    'viz/+/Telemetry',           // Existing
    'device/+/session/end'       // ← ADD THIS (matches firmware)
  ];

  mqttClient.subscribe(topics.map(t => ({ topic: t, qos: 1 })), (err) => {
    if (err) console.error('MQTT subscribe failed:', err);
    else console.log('Subscribed to:', topics);
  });
  });

  mqttClient.on('message', async (topic, buf) => {
    const payload = buf.toString();
    console.log(`[MQTT RX] topic=${topic} payload=${payload}`);

    const parts = topic.split('/');
// device/<DEVICEID>/session/end  ← Firmware publishes here!
if (topic.startsWith('device/') && topic.endsWith('/session/end')) {
  const deviceId = topic.split('/')[1];  // "GLIDE01"
  let msg;
  try {
    msg = JSON.parse(payload.toString());
  } catch (e) {
    console.error('Invalid JSON on session/end:', e);
    return;
  }

  const { sessionId, endTime, energy_kWh, endTrigger } = msg;
  if (!sessionId || !endTime || !endTrigger) {
    console.warn('Incomplete session/end:', msg);
    return;
  }

  console.log('[MQTT] session/end received:', { deviceId, sessionId, endTrigger, energy_kWh });

  try {
    const { completeSessionInternal } = require('./controllers/sessionController');  // From previous fix
    const result = await completeSessionInternal({
      sessionId,
      endTime: new Date(endTime).toISOString(),  // Convert "2026-01-15 06:12:00" → ISO
      endTrigger,
      deltaEnergy: Number(energy_kWh),            // Firmware "energy_kWh" → deltaEnergy
      deviceIdOverride: deviceId
    });
    console.log('[MQTT] ✅ Session auto-completed + receipt created:', sessionId);
  } catch (err) {
    console.error('[MQTT] Failed auto-completing session:', err);
  }
  return;  // Skip telemetry processing
}



    // Expect: viz/{deviceId}/Telemetry
    if (parts.length < 3 || parts[0] !== 'viz' || parts[2] !== 'Telemetry') {
      console.warn('[MQTT RX] Ignoring unexpected topic', topic);
      return;
    }

    const deviceId = parts[1];
    let msg;
    try {
      msg = JSON.parse(payload);
      console.log('[MQTT RX] Parsed JSON payload:', msg);
    } catch (e) {
      console.error('❌ Invalid JSON on Telemetry:', e, payload);
      return;
    }

    if (!msg || typeof msg !== 'object') {
      console.error('❌ Non-object Telemetry payload:', msg);
      return;
    }

    // Optional duplicate filter
    const msgKey = topic + JSON.stringify(msg);
    if (processedMessages.has(msgKey)) {
      console.log(`⏩ Skipped duplicate message on ${topic}`);
      return;
    }
    processedMessages.add(msgKey);
    setTimeout(() => processedMessages.delete(msgKey), 30000);

    const now = new Date();

    // --- Normalize fields from telemetry payload ---
    const status = msg.state || 'Unknown';                     // ✅ "state"
    const totalEnergy = Number(msg.totalEnergy_kWh) || 0;      // ✅ "totalEnergy_kWh"
    const v = Number(msg.voltage) || 0;
    const c = Number(msg.current) || 0;
    const p = Number(msg.power) || 0;
    const relayOn = (msg.relay || '').toString().toUpperCase() === 'ON';  // ✅ "relay"

    const sessionId = msg.sessionId || null;
    const energyConsumed = msg.consumed_kWh != null 
      ? Number(msg.consumed_kWh) || 0 : undefined;

    try {
      // 1) Update Device document (used on home/charging pages)
      const devUpdate = {
        status,
        relayOn,
        voltage: v,
        current: c,
        power: p,
        totalenergy: totalEnergy,  // ✅ Schema: "totalenergy"
        lastSeen: now,
        updatedAt: now
      };

      const devResult = await Device.updateOne(
        { device_id: (deviceId || '').toUpperCase() },
        { $set: devUpdate }
      );

      console.log(
        '[MQTT DEBUG] Device update',
        deviceId,
        'matched=',
        devResult?.matchedCount ?? devResult?.n,
        'modified=',
        devResult?.modifiedCount ?? devResult?.nModified
      );

      // 2) If there is an active sessionId, update Session snapshot
      if (sessionId) {
        const sessSet = {
          latestVoltage: v,
          latestCurrent: c,
          latestPower: p,
          lastUpdate: now
        };
        if (energyConsumed !== undefined) {
          sessSet.energyConsumed = energyConsumed;
        }

        const sessResult = await Session.updateOne(
          { sessionId, status: 'active' },
          {
            $set: sessSet,
            $push: {
              telemetry: {
                timestamp: now,
                voltage: v,
                current: c,
                power_W: p
              }
            }
          }
        );

        console.log(
          '[MQTT DEBUG] Session update',
          sessionId,
          'matched=',
          sessResult?.matchedCount ?? sessResult?.n,
          'modified=',
          sessResult?.modifiedCount ?? sessResult?.nModified
        );
      }

      // 3) Optional: if status becomes Available/Offline and no sessionId,
      // you could auto-mark any lingering active session as completed here.
      // (Not implemented yet; behaviour matches your point 2 = keep same logic as now.)

    } catch (err) {
      console.error('❌ Error handling Telemetry:', err);
    }
  });

  mqttClient.on('error', err => console.error('❌ MQTT client error:', err));
}

module.exports = startMqttSubscriber;
