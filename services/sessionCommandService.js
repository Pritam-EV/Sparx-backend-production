const mqttClient = require('../mqttClient');
const { normalizeDeviceId } = require('../config/deviceProtocol');

function publishMqtt(topic, payload) {
  return new Promise((resolve, reject) => {
    if (!mqttClient || typeof mqttClient.publish !== 'function') {
      return reject(new Error('MQTT client is not available'));
    }

    const message = JSON.stringify(payload);

    console.log('[SESSION MQTT] Publishing command');
    console.log('[SESSION MQTT] Topic:', topic);
    console.log('[SESSION MQTT] Payload:', message);

    mqttClient.publish(
      topic,
      message,
      {
        qos: 1,
        retain: false,
      },
      (error) => {
        if (error) {
          console.error('[SESSION MQTT] Publish failed:', error);
          return reject(error);
        }

        console.log('[SESSION MQTT] Publish acknowledged by MQTT broker');

        resolve({
          topic,
          payload,
          publishedAt: new Date().toISOString(),
        });
      }
    );
  });
}

async function publishStartSession({
  deviceId,
  sessionId,
  userId,
  transactionId,
  selectedEnergy,
  amountPaid,
}) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);

  if (!normalizedDeviceId) {
    throw new Error('Invalid device ID');
  }

  const topic = `viz/${normalizedDeviceId}/sessionCommand`;

  const payload = {
    command: 'start',
    SessionId: sessionId,
    UserId: userId,
    TransactionId: transactionId,
    SelectedEnergy: Number(selectedEnergy),
    AmountPaid: Number(amountPaid),
  };

  return publishMqtt(topic, payload);
}

async function publishStopSession({
  deviceId,
  sessionId,
  userId,
}) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);

  if (!normalizedDeviceId) {
    throw new Error('Invalid device ID');
  }

  const topic = `viz/${normalizedDeviceId}/sessionCommand`;

  const payload = {
    command: 'stop',
    SessionId: sessionId,
    UserId: userId,
  };

  return publishMqtt(topic, payload);
}

module.exports = {
  publishStartSession,
  publishStopSession,
};