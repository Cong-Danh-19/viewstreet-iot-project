const mqtt = require('mqtt');
const env = require('./env');

const FEEDS = {
    TELEMETRY: `${env.AIO_USERNAME}/feeds/viewstreet.telemetry`,
    CAMERA:    `${env.AIO_USERNAME}/feeds/viewstreet.camera`,
    CONTROL:   `${env.AIO_USERNAME}/feeds/viewstreet.control`,
};

let client = null;

if (env.AIO_USERNAME && env.AIO_KEY) {
    const url = `mqtt://${env.AIO_USERNAME}:${env.AIO_KEY}@io.adafruit.com:1883`;
    client = mqtt.connect(url);

    client.on('connect', () => {
        console.log('[Adafruit IO] Đã kết nối broker thành công.');
        client.subscribe([FEEDS.TELEMETRY, FEEDS.CAMERA], (err) => {
            if (!err) console.log('[Adafruit IO] Đã Subscribe các Feed.');
        });
    });

    client.on('error', (err) => {
        console.error('[Adafruit IO Error]:', err.message);
    });
} else {
    console.warn('[Adafruit IO] Thiếu AIO_USERNAME hoặc AIO_KEY trong .env - chạy ở chế độ Offline/Mock.');
}

function publishControl(frame, cb) {
    if (!client || client.connected === false) {
        throw new Error('MQTT chưa kết nối');
    }
    client.publish(FEEDS.CONTROL, JSON.stringify(frame), cb);
}

module.exports = { client, FEEDS, publishControl };