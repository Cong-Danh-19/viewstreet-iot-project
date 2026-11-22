const path = require('path');

// Nạp .env ở thư mục gốc dự án (ngang hàng backend/ và frontend/)
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

module.exports = {
    PORT: Number(process.env.PORT) || 3000,
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
    OFFLINE_AFTER_MS: Number(process.env.OFFLINE_AFTER_MS) || 60 * 1000,
    LEGACY_NODE_ID: process.env.LEGACY_NODE_ID || 'node_1',

    // Đường dẫn dữ liệu (giữ nguyên vị trí cũ để tương thích nodes.json, control.json, history/)
    DATA_DIR: path.join(__dirname, '../data'),
    FRONTEND_DIR: path.join(__dirname, '../../frontend'),

    // Adafruit IO MQTT
    AIO_USERNAME: process.env.AIO_USERNAME || '',
    AIO_KEY: process.env.AIO_KEY || '',

    // Lưu trữ ảnh camera
    MAX_IMAGES_PER_NODE: Number(process.env.MAX_IMAGES_PER_NODE) || 50,

    // Cảnh báo Telegram (tuỳ chọn)
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    ALERT_COOLDOWN_MS: Number(process.env.ALERT_COOLDOWN_MS) || 5 * 60 * 1000,
};