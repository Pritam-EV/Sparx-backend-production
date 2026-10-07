const mqttClient = require('../mqttClient');
const { normalizeDeviceId } = require('../config/deviceProtocol');

/**
 * Send MQTT command to device to start admin session
 * 
 * MQTT Topic: sparx/device/{deviceId}/command/admin_session
 * Payload: {
 *   command: 'start_session',
 *   sessionId: 'ADM_{timestamp}_{random}',
 *   amount: 100,
 *   energy: 100,
 *   userId: 'ADMIN',
 *   timestamp: ISO string
 * }
 */

async function sendAdminStartSessionCommand(deviceId, sessionData) {
  return new Promise((resolve, reject) => {
    try {
      const normalizedId = normalizeDeviceId(deviceId);
      
      if (!normalizedId) {
        return reject(new Error('Invalid device ID'));
      }

      const topic = `sparx/device/${normalizedId}/command/admin_session`;
      
      const payload = {
        command: 'start_session',
        sessionId: sessionData.sessionId,
        amount: sessionData.amount || 100,
        energy: sessionData.energy || 100,
        userId: 'ADMIN',
        timestamp: new Date().toISOString(),
        source: 'admin_dashboard'
      };

      const message = JSON.stringify(payload);

      console.log(`[ADMIN SESSION] Publishing to ${topic}:`, message);

      // Publish with QoS 1 (at least once delivery)
      mqttClient.publish(topic, message, { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error('[ADMIN SESSION] MQTT publish error:', err);
          return reject(new Error(`Failed to publish MQTT command: ${err.message}`));
        }
        
        console.log(`[ADMIN SESSION] Command published successfully to ${topic}`);
        resolve({
          success: true,
          topic,
          payload,
          publishedAt: new Date().toISOString()
        });
      });

    } catch (error) {
      console.error('[ADMIN SESSION] Error:', error);
      reject(error);
    }
  });
}

module.exports = {
  sendAdminStartSessionCommand
};