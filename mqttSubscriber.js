// mqttSubscriber.js
const mongoose = require('mongoose');
const Session = require('./models/session');
const Device = require('./models/device');
// const Telemetry = require('./models/telemetry');
const mqttClient = require('./mqttClient'); // shared connection
const Receipt = require('./models/Receipt');

function startMqttSubscriber() {
mqttClient.on('connect', () => {
  console.log('✅ Backend connected to MQTT broker');

  const topics = [
    'device/+/session/info',
    'device/+/session/live',
    'device/+/session/end',
    'device/+/status',
    'device/+/Status',
    'device/+/RelayState'
  ];

  mqttClient.subscribe(topics, { qos: 1 }, (err, granted) => {
    if (err) {
      console.error('❌ MQTT subscribe failed:', err);
    } else {
      console.log('Subscribed to topics:');
      granted.forEach(sub => {
        console.log(`  Topic: ${sub.topic}, QoS: ${sub.qos}`);
      });
    }
  });
});


  const processedMessages = new Set();

  mqttClient.on('message', async (topic, buf) => {
    const payload = buf.toString();

    // === DEBUG: first-line logging for topic/payload ===
    console.log(`[MQTT RX] topic=${topic} payload=${payload}`)
    
    const parts = topic.split('/');
    const deviceId = parts[1];
    // normalize section/action to handle case variations from firmware
    const section = (parts[2] || '').toLowerCase();

        // Add debug output on section/action:
    console.log(`[MQTT RX] Extracted Device ID: ${deviceId}`);
    console.log(`[MQTT RX] Section: ${section}`);

    // ─── HANDLE STATUS PAYLOADS FIRST ──────────────────
      if (section === 'status') {
        const statusText = payload.trim();                 // e.g. "AVAILABLE"
        console.log(`[MQTT] status update for ${deviceId} -> ${statusText}`);

        await Device.updateOne(
          { device_id: deviceId.toUpperCase() },
          { 
            $set: { 
              status:   statusText,
              lastSeen: new Date()                         // ← heartbeat
            }
          }
        );

        return;                                           // stop further processing
      }


    const action  = (parts[3] || '').toString();

    // --- RELAY STATE UPDATE (plain "ON"/"OFF") ---
    // Accept exact match "RelayState" and also lowercase fallback
    if (section.toLowerCase() === 'relaystate') {
      const txt = payload.trim();
      const isOn = (txt.toUpperCase() === 'ON');
      const devResult = await Device.updateOne(
        { device_id: (deviceId || '').toUpperCase() },
        { $set: { relayOn: isOn, lastSeen: new Date() } }
      );
      console.log(`🔄 RelayState for ${deviceId} updated to ${txt} (db matched=${devResult?.matchedCount ?? devResult?.n})`);
      return;
    }

    if (!payload) {
      console.warn(`⚠️ Empty payload on ${topic}`);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(payload);
      console.log('[MQTT RX] Parsed JSON payload:', msg);
    } catch {
      console.error(`❌ Invalid JSON on ${topic}:`, payload);
      console.warn('[MQTT RX] Payload is not valid JSON or is plain text.');
      return;
    }
    if (typeof msg !== 'object' || msg === null) {
      console.error(`❌ Non-object payload on ${topic}:`, msg);
      return;
    }

    // Duplicate filter
    const msgKey = topic + JSON.stringify(msg);
    if (processedMessages.has(msgKey)) {
      console.log(`⏩ Skipped duplicate message on ${topic}`);
      return;
    }
    processedMessages.add(msgKey);
    setTimeout(() => processedMessages.delete(msgKey), 30000);


    try {
      // --- SESSION START INFO ---
      if (section === 'session' && action === 'info') {
        const { sessionId, transactionId, startTime, energy_kWh, amountPaid, userId } = msg;
        if (!sessionId || !transactionId || !startTime) {
          console.error(`❌ Missing fields in session/info on ${topic}:`, msg);
          return;
        }

        const sessionUpdate = {
          sessionId,
          deviceId,
          transactionId,
          startTime: new Date(startTime),
          startDate: new Date(startTime).toISOString().split('T')[0],
          energySelected: Number(energy_kWh) || 0,
          amountPaid: Number(amountPaid) || 0,
          status: 'active'
        };

        if (userId) {
          try { sessionUpdate.userId = new mongoose.Types.ObjectId(userId); } catch {}
        }

        const sessionDoc = await mongoose.connection.transaction(async session => {
          const createdSession = await Session.findOneAndUpdate(
            { sessionId },
            { $setOnInsert: sessionUpdate },
            { upsert: true, new: true, session }
          );

          await Device.findOneAndUpdate(
            { device_id: deviceId },
            { status: 'Occupied', current_session_id: createdSession._id, relayOn: true, lastSeen: new Date() },
            { session }
          );
          return createdSession;
        });

        console.log(`✅ Session started: ${sessionDoc.sessionId}`);
      }

      // --- LIVE TELEMETRY ---
        else if (section === 'session' && action === 'live') {
          const { sessionId, voltage, current, power, energy_kWh } = msg;
          if (!sessionId || energy_kWh == null) {
            console.error(`❌ Missing fields in session/live on ${topic}:`, msg);
            return;
          }

          const v = Number(voltage) || 0;
          const c = Number(current) || 0;
          const p = Number(power) || 0;
          const e = Number(energy_kWh) || 0;

          // ✅ Update active session with latest snapshot + energy consumed
          const sessResult = await Session.updateOne(
            { sessionId },
            {
              latestVoltage: v,
              latestCurrent: c,
              latestPower: p,
              energyConsumed: e,
              lastUpdate: new Date()
            }
          );

          // ✅ Update linked device for API use
        const devResult = await Device.updateOne(
          { device_id: (deviceId || '').toUpperCase() }, // must match exactly what's in DB
          { $set: { voltage: v, current: c, power: p, energy: e } }
        );

          console.log(`[MQTT DEBUG] Session update: matched=${sessResult?.matchedCount ?? sessResult?.n} modified=${sessResult?.modifiedCount ?? sessResult?.nModified}`);
          console.log(`[MQTT DEBUG] Device update: matched=${devResult?.matchedCount ?? devResult?.n} modified=${devResult?.modifiedCount ?? devResult?.nModified}`);
        console.log(`[MQTT DEBUG] Updating Session ${sessionId} with voltage: ${v}, current: ${c}, power: ${p}`);
        console.log(`[MQTT DEBUG] Updating Device ${deviceId} with voltage: ${v}, current: ${c}, power: ${p}`);
        console.log(`[MQTT DEBUG] Updating Device relayOn to: ${isOn} from payload: ${txt}`);

        
        }


      // --- SESSION END ---
      else if (section === 'session' && action === 'end') {
        const { sessionId, endTime, energy_kWh, endTrigger } = msg;
        if (!sessionId) {
          console.error(`❌ Missing sessionId in session/end on ${topic}:`, msg);
          return;
        }

        const sess = await mongoose.connection.transaction(async session => {
          const endedSession = await Session.findOneAndUpdate(
            { sessionId },
            {
              endTime: new Date(endTime || Date.now()),
              energyConsumed: Number(energy_kWh) || 0,
              status: 'completed',
              endTrigger: endTrigger || 'auto'
            },
            { new: true, session }
          );

          if (endedSession) {
          await Device.findOneAndUpdate(
            { device_id: endedSession.deviceId },
            { 
              status: 'Available', 
              current_session_id: null, 
              relayOn: false,
              lastSeen: new Date()      // ← added
            },
            { session }
          );

          }
          return endedSession;
        });

        if (sess) {
          console.log(`✅ Session ended: ${sess.sessionId}`);
        }
      }

    } catch (err) {
      console.error(`❌ Error handling ${topic}:`, err);
    }
  });

  

  mqttClient.on('error', err => console.error('❌ MQTT client error:', err));
}

module.exports = startMqttSubscriber;
