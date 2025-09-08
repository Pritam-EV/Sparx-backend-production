// backend/mqttClient.js
const mqtt = require('mqtt');

// Load broker URL and credentials from environment variables
// You can define these in your .env:
// MQTT_URL=wss://v66ea9b1.ala.us-east-1.emqxsl.com:8084/mqtt
// MQTT_USER=pritam
// MQTT_PASS=Pritam123
const MQTT_URL = process.env.MQTT_URL || 'wss://v66ea9b1.ala.us-east-1.emqxsl.com:8084/mqtt';
const MQTT_OPTIONS = {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  protocol: 'wss',
  rejectUnauthorized: false,   // allow self-signed certificates if broker uses TLS
  reconnectPeriod: 2000,       // auto-reconnect every 2s if dropped
  connectTimeout: 30 * 1000    // 30s timeout
};

// Create a single MQTT client connection
const client = mqtt.connect(MQTT_URL, MQTT_OPTIONS);
console.log("MQTT_URL:", process.env.MQTT_URL);
console.log("MQTT_USER:", process.env.MQTT_USER);


// Connection event listeners
client.on('connect', () => {
  console.log(`✅ MQTT connected to broker at ${MQTT_URL}`);
});

client.on('reconnect', () => {
  console.warn('♻️  MQTT reconnecting...');
});

client.on('close', () => {
  console.warn('❌ MQTT connection closed');
});

client.on('offline', () => {
  console.warn('⚠️ MQTT client is offline');
});

client.on('error', (err) => {
  console.error('❌ MQTT error:', err.message || err);
});

// Export this shared client for use across backend modules
module.exports = client;
