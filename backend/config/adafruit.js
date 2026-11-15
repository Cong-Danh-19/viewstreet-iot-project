const mqtt = require('mqtt');
require('dotenv').config();

const AIO_USERNAME = process.env.AIO_USERNAME;
const AIO_KEY = process.env.AIO_KEY;
const ADAFRUIT_MQTT_URL = `mqtt://${AIO_USERNAME}:${AIO_KEY}@io.adafruit.com:1883`;

const client = mqtt.connect(ADAFRUIT_MQTT_URL);

// Định nghĩa các Feed trên Adafruit IO
const FEEDS = {
    TELEMETRY: `${AIO_USERNAME}/feeds/viewstreet.telemetry`,
    CAMERA:    `${AIO_USERNAME}/feeds/viewstreet.camera`,
    CONTROL:   `${AIO_USERNAME}/feeds/viewstreet.control`
};

client.on('connect', () => {
    console.log('[Adafruit IO Config] Kết nối thành công tới io.adafruit.com');
    client.subscribe([FEEDS.TELEMETRY, FEEDS.CAMERA], (err) => {
        if (!err) console.log('[Adafruit IO Config] Đã Subcribe thành công các Feed.');
    });
});

module.exports = { client, FEEDS };
