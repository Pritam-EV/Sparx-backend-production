// mqttSubscriber.js V2.0 - 3 Topics Only (GLIDE V1.0.3)
const mongoose = require('mongoose');
const Session = require('./models/session');
const Device = require('./models/device');
const mqttClient = require('./mqttClient');
const Receipt = require('./models/Receipt');

function startMqttSubscriber() {
  mqttClient.on('connect', () => {
    console.log('✅ Backend V2.0 connected to MQTT - 3 topics only');
    
    const topics = [
      'device/+/telemetry',  // All real-time data (status + relay + telemetry)
      'device/+/health',     // Heartbeat + FW version
      'device/+/events'      // Session start/end + button events
    ];

    mqttClient.subscribe(topics, { qos: 1 }, (err, granted) => {
      if (err) {
        console.error('❌ MQTT subscribe failed:', err);
      } else {
        console.log('✅ V2.0 Subscribed to 3 topics:');
        granted.forEach(sub => console.log(`   ${sub.topic} (QoS ${sub.qos})`));
      }
    });
  });

  const processedMessages = new Set();

  mqttClient.on('message', async (topic, buf) => {
    const payload = buf.toString();
    console.log(`[MQTT V2.0] ${topic} → ${payload.substring(0, 100)}...`);

    const parts = topic.split('/');
    const deviceId = parts[1];

    if (!deviceId) {
      console.warn('[MQTT V2.0] No deviceId in topic:', topic);
      return;
    }

    // Duplicate filter
    const msgKey = topic + payload;
    if (processedMessages.has(msgKey)) {
      return; // Skip duplicates
    }
    processedMessages.add(msgKey);
    setTimeout(() => processedMessages.delete(msgKey), 30000);

    try {
      const msg = JSON.parse(payload);
      console.log(`[MQTT V2.0] Parsed ${topic}:`, msg);

      // === 1. TELEMETRY (All real-time data) ===
      if (parts[2] === 'telemetry') {
        await handleTelemetry(deviceId, msg);
      }
      // === 2. HEALTH (Heartbeat) ===
      else if (parts[2] === 'health') {
        await handleHealth(deviceId, msg);
      }
      // === 3. EVENTS (Session + State changes) ===
      else if (parts[2] === 'events') {
        await handleEvents(deviceId, msg);
      }

    } catch (err) {
      console.error(`❌ [MQTT V2.0] Parse error on ${topic}:`, err.message);
    }
  });
}

// === TELEMETRY HANDLER (Replaces status + relay + session/live) ===
async function handleTelemetry(deviceId, msg) {
  const updates = {
    lastSeen: new Date(),
    voltage: Number(msg.v) || 0,
    current: Number(msg.i) || 0,
    power: Number(msg.p) || 0,
    energy: Number(msg.e_total) || 0,
    hlw_ready: msg.hlw || false
  };

  // Relay state
  if (msg.relay) {
    updates.relayOn = msg.relay.toUpperCase() === 'ON';
  }

  // Device status from state field
  if (msg.state) {
    updates.status = msg.state;
  }

  // Update device document
  const devResult = await Device.updateOne(
    { device_id: deviceId.toUpperCase() },
    { $set: updates }
  );
  console.log(`[TELEMETRY] ${deviceId}: V=${updates.voltage} I=${updates.current} P=${updates.power} state=${updates.status}`);

  // === SESSION TELEMETRY (if active) ===
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
    console.log(`[SESSION] ${msg.session_id}: ${msg.e_session}kWh consumed`);
  }
}

// === HEALTH HANDLER (Heartbeat) ===
async function handleHealth(deviceId, msg) {
  await Device.updateOne(
    { device_id: deviceId.toUpperCase() },
    {
      lastSeen: new Date(),
      firmware_version: msg.fw || 'unknown',
      uptime: msg.uptime || 0,
      health_status: msg.status || 'unknown'
    }
  );
  console.log(`[HEALTH] ${deviceId}: ${msg.status} fw=${msg.fw}`);
}

// === EVENTS HANDLER (Replaces session/info + session/end) ===
async function handleEvents(deviceId, msg) {
  const eventType = msg.event;

  if (eventType === 'session_start') {
    // Create new session (replaces session/info)
    const sessionData = {
      sessionId: msg.sessionId,
      deviceId: deviceId,
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
        { 
          status: 'Occupied', 
          current_session_id: createdSession._id, 
          relayOn: true, 
          lastSeen: new Date() 
        },
        { session }
      );

      return createdSession;
    });

    console.log(`✅ [EVENT] Session START ${msg.sessionId} (${deviceId})`);
  }
  else if (eventType === 'session_end') {
    // End session (replaces session/end)
    const endedSession = await mongoose.connection.transaction(async session => {
      const sess = await Session.findOneAndUpdate(
        { sessionId: msg.sessionId },
        {
          endTime: new Date(msg.ts * 1000),
          energyConsumed: Number(msg.energy_kWh) || 0,
          status: 'completed',
          endTrigger: msg.endTrigger || 'auto'
        },
        { new: true, session }
      );

      if (sess) {
        await Device.findOneAndUpdate(
          { device_id: deviceId },
          {
            status: 'Available',
            current_session_id: null,
            relayOn: false,
            lastSeen: new Date()
          },
          { session }
        );
      }

      return sess;
    });

    if (endedSession) {
      console.log(`✅ [EVENT] Session END ${msg.sessionId} (${msg.energy_kWh}kWh, ${msg.endTrigger})`);
    }
  }
  // Button events + other state changes
  else {
    console.log(`[EVENT] ${deviceId}: ${eventType} (state=${msg.state})`);
    
    // Update device status for state changes
    if (msg.state) {
      await Device.updateOne(
        { device_id: deviceId.toUpperCase() },
        { 
          status: msg.state,
          lastSeen: new Date()
        }
      );
    }
  }
}

mqttClient.on('error', err => console.error('❌ MQTT client error:', err));

module.exports = startMqttSubscriber;
