// mqttSubscriber.js V2.0 - GLIDE V1.0.3 (3 topics only)
const mongoose = require('mongoose');
const Session = require('./models/session');
const Device = require('./models/device');
const mqttClient = require('./mqttClient');
const Receipt = require('./models/Receipt');

function startMqttSubscriber() {
  mqttClient.on('connect', () => {
    console.log('✅ V2.0: Subscribing to 3 NEW topics (GLIDE V1.0.3)');
    const topics = [
      'device/+/telemetry',  // Replaces: status + RelayState + session/live
      'device/+/health',     // Heartbeat + FW
      'device/+/events'      // Replaces: session/info + session/end
    ];
    mqttClient.subscribe(topics, { qos: 1 }, (err, granted) => {
      if (err) console.error('❌ V2.0 Subscribe failed:', err);
      else {
        console.log('✅ V2.0 Topics:');
        granted.forEach(sub => console.log(`   ${sub.topic}`));
      }
    });
  });

  const processedMessages = new Set();
  mqttClient.on('message', async (topic, buf) => {
    const payload = buf.toString();
    console.log(`[V2.0] ${topic} → ${payload.slice(0, 100)}`);

    const parts = topic.split('/');
    const deviceId = parts[1];
    if (!deviceId) return;

    const msgKey = topic + payload;
    if (processedMessages.has(msgKey)) return;
    processedMessages.add(msgKey);
    setTimeout(() => processedMessages.delete(msgKey), 30000);

    try {
      const msg = JSON.parse(payload);

      // === TELEMETRY: All real-time data ===
      if (parts[2] === 'telemetry') {
        const updates = {
          lastSeen: new Date(),
          voltage: Number(msg.v) || 0,
          current: Number(msg.i) || 0,
          power: Number(msg.p) || 0,
          energy: Number(msg.e_total) || 0,
          hlw_ready: msg.hlw || false
        };
        if (msg.relay) updates.relayOn = msg.relay.toUpperCase() === 'ON';
        if (msg.state) updates.status = msg.state;

        await Device.updateOne({ device_id: deviceId.toUpperCase() }, { $set: updates });
        console.log(`[TELEMETRY] ${deviceId}: ${updates.status} V=${updates.voltage} I=${updates.current}`);

        // Session telemetry
        if (msg.session_id && msg.e_session != null) {
          await Session.updateOne(
            { sessionId: msg.session_id },
            {
              latestVoltage: updates.voltage,
              latestCurrent: updates.current,
              latestPower: updates.power,
              energyConsumed: Number(msg.e_session),
              lastUpdate: new Date(),
              selectedEnergy: Number(msg.selected_kwh) || 0
            }
          );
        }
      }

      // === HEALTH: Heartbeat ===
      else if (parts[2] === 'health') {
        await Device.updateOne(
          { device_id: deviceId.toUpperCase() },
          {
            lastSeen: new Date(),
            firmware_version: msg.fw || 'unknown',
            uptime: msg.uptime || 0,
            health_status: msg.status || 'unknown'
          }
        );
      }

      // === EVENTS: Session + State changes ===
      else if (parts[2] === 'events') {
        await handleEvents(deviceId, msg);
      }
    } catch (err) {
      console.error(`❌ V2.0 Parse error ${topic}:`, err);
    }
  });

  async function handleEvents(deviceId, msg) {
    const eventType = msg.event;
    
    if (eventType === 'session_start') {
      const sessionData = {
        sessionId: msg.sessionId,
        deviceId,
        transactionId: msg.transactionId || '',
        startTime: new Date(msg.ts * 1000),
        startDate: new Date(msg.ts * 1000).toISOString().split('T')[0],
        energySelected: Number(msg.selected_kwh) || 0,
        amountPaid: Number(msg.amount_paid) || 0,
        status: 'active',
        startEnergy: Number(msg.start_energy) || 0
      };

      const sessionDoc = await mongoose.connection.transaction(async session => {
        const createdSession = await Session.findOneAndUpdate(
          { sessionId: msg.sessionId },
          { $setOnInsert: sessionData },
          { upsert: true, new: true, session }
        );
        await Device.findOneAndUpdate(
          { device_id: deviceId },
          { status: 'Occupied', current_session_id: createdSession._id, relayOn: true, lastSeen: new Date() },
          { session }
        );
        return createdSession;
      });
      console.log(`✅ EVENT session_start: ${msg.sessionId}`);
    }
    else if (eventType === 'session_end') {
      await mongoose.connection.transaction(async session => {
        const endedSession = await Session.findOneAndUpdate(
          { sessionId: msg.sessionId },
          {
            endTime: new Date(msg.ts * 1000),
            energyConsumed: Number(msg.energy_kWh) || 0,
            status: 'completed',
            endTrigger: msg.endTrigger || 'auto'
          },
          { new: true, session }
        );
        if (endedSession) {
          await Device.findOneAndUpdate(
            { device_id: deviceId },
            { status: 'Available', current_session_id: null, relayOn: false, lastSeen: new Date() },
            { session }
          );
        }
      });
      console.log(`✅ EVENT session_end: ${msg.sessionId}`);
    }
  }
}

module.exports = startMqttSubscriber;
