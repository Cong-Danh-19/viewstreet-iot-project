const mqtt = require('mqtt');
const env = require('./env');

let client = null;
let connected = false;
const messageHandlers = [];

const FEEDS = {
    telemetry: env.AIO_USERNAME ? `${env.AIO_USERNAME}/feeds/viewstreet.telemetry` : 'viewstreet/telemetry',
    control: env.AIO_USERNAME ? `${env.AIO_USERNAME}/feeds/viewstreet.control` : 'viewstreet/control',
};

function onMessage(fn) {
    if (typeof fn === 'function') messageHandlers.push(fn);
}

function connect() {
    if (!env.AIO_USERNAME || !env.AIO_KEY || env.AIO_USERNAME === 'your_username') {
        console.log('[MQTT] Chưa cấu hình AIO_USERNAME/AIO_KEY trong .env — bỏ qua kết nối Adafruit IO (vẫn dùng được HTTP & WebSocket).');
        return;
    }

    const brokerUrl = 'mqtts://io.adafruit.com:8883';
    client = mqtt.connect(brokerUrl, {
        username: env.AIO_USERNAME,
        password: env.AIO_KEY,
        reconnectPeriod: 5000,
    });

    client.on('connect', () => {
        connected = true;
        console.log('[MQTT] Đã kết nối tới Adafruit IO.');
        client.subscribe([FEEDS.telemetry, FEEDS.control], (err) => {
            if (err) console.error('[MQTT] Lỗi subscribe:', err.message);
            else console.log(`[MQTT] Đã lắng nghe: ${FEEDS.telemetry}, ${FEEDS.control}`);
        });
    });

    client.on('message', (topic, payload) => {
        for (const handler of messageHandlers) {
            try {
                handler(topic, payload);
            } catch (err) {
                console.error('[MQTT] Lỗi xử lý gói tin:', err.message);
            }
        }
    });

    client.on('close', () => {
        connected = false;
    });

    client.on('error', (err) => {
        console.error('[MQTT] Lỗi kết nối:', err.message);
    });
}

function publishControl(nodeId, payload) {
    const message = JSON.stringify({ nodeId, ...payload, ts: Date.now() });
    if (!client || !connected) {
        console.log(`[MQTT][Offline-Mock] Gửi lệnh tới ${nodeId}:`, message);
        return false;
    }
    client.publish(FEEDS.control, message);
    return true;
}

module.exports = {
    FEEDS,
    connect,
    onMessage,
    publishControl,
    isConnected: () => connected,
};
