const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

module.exports = {
    PORT: Number(process.env.PORT) || 3000,
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
    OFFLINE_AFTER_MS: Number(process.env.OFFLINE_AFTER_MS) || 60000,
    LOW_BAT_THRESHOLD: Number(process.env.LOW_BAT_THRESHOLD) || 20,

    // PostgreSQL
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://viewstreet:viewstreet123@localhost:5432/viewstreet',
    MAX_MEDIA_PER_NODE: Number(process.env.MAX_MEDIA_PER_NODE) || 100,

    // InfluxDB
    INFLUX_URL: process.env.INFLUX_URL || 'http://localhost:8086',
    INFLUX_TOKEN: process.env.INFLUX_TOKEN || 'viewstreet-super-secret-influx-token',
    INFLUX_ORG: process.env.INFLUX_ORG || 'viewstreet',
    INFLUX_BUCKET: process.env.INFLUX_BUCKET || 'sensors',

    // MQTT & Telegram
    AIO_USERNAME: process.env.AIO_USERNAME || '',
    AIO_KEY: process.env.AIO_KEY || '',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

    FRONTEND_DIR: path.join(__dirname, '../../frontend'),
};
