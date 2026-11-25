const https = require('https');
const env = require('../config/env');

const COOLDOWN_MS = 5 * 60 * 1000;
const lastAlertAt = new Map();

function canSend(key) {
    const now = Date.now();
    const prev = lastAlertAt.get(key) || 0;
    if (now - prev < COOLDOWN_MS) return false;
    lastAlertAt.set(key, now);
    return true;
}

function sendTelegram(text) {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
    const payload = JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
    });

    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
        },
    });
    req.on('error', (err) => console.error('[Telegram] Lỗi gửi tin:', err.message));
    req.write(payload);
    req.end();
}

function emitAlert(type, nodeId, message) {
    const key = `${nodeId}:${type}`;
    if (!canSend(key)) return null;

    const alertObj = {
        type,
        nodeId,
        message,
        ts: Date.now(),
        time: new Date().toLocaleTimeString('vi-VN'),
    };
    console.warn(`[ALERT][${type.toUpperCase()}] ${nodeId}: ${message}`);
    sendTelegram(`[Viewstreets Alert] ${nodeId} - ${message}`);
    return alertObj;
}

function checkTelemetryAlerts(node) {
    const alerts = [];
    if (!node) return alerts;

    if (Number.isFinite(node.bat) && node.bat > 0 && node.bat < env.LOW_BAT_THRESHOLD) {
        const a = emitAlert('low_battery', node.id, `Pin yếu (${node.bat}% < ${env.LOW_BAT_THRESHOLD}%)`);
        if (a) alerts.push(a);
    }

    if (node.error && node.error !== 'OK' && node.error !== 'Đang chờ thiết bị...') {
        const a = emitAlert('device_error', node.id, `Lỗi thiết bị: ${node.error}`);
        if (a) alerts.push(a);
    }

    if (Number.isFinite(node.dust) && node.dust > 150) {
        const a = emitAlert('fog_dust', node.id, `Sương mù / bụi dày đặc (${node.dust} µg/m³), tăng độ sáng đèn`);
        if (a) alerts.push(a);
    }

    return alerts;
}

function alertOffline(nodeId) {
    return emitAlert('offline', nodeId, 'Node mất kết nối (Offline)');
}

module.exports = {
    checkTelemetryAlerts,
    alertOffline,
};
