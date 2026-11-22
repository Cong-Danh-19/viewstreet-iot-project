const env = require('../config/env');

const cooldowns = new Map(); // `${nodeId}:${type}` -> timestamp gửi gần nhất

function canSend(nodeId, type) {
    const key = `${nodeId}:${type}`;
    const last = cooldowns.get(key) || 0;
    if (Date.now() - last < env.ALERT_COOLDOWN_MS) return false;
    cooldowns.set(key, Date.now());
    return true;
}

async function notify(nodeId, type, message, emit) {
    if (!canSend(nodeId, type)) return;

    const alertPayload = { nodeId, type, message, ts: Date.now() };
    console.warn(`[ALERT][${type.toUpperCase()}] ${message}`);
    if (emit) emit('system_alert', alertPayload);

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

    try {
        const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: env.TELEGRAM_CHAT_ID,
                text: `⚠️ [Viewstreets] ${message}`,
            }),
        });
    } catch (e) {
        console.error('[AlertService] Lỗi gửi Telegram:', e.message);
    }
}

function checkTelemetryAlerts(nodeState, desiredConfig = {}, emit) {
    const thresholds = desiredConfig.thresholds || {};
    const batLowLimit = Number.isFinite(thresholds.bat_low) ? thresholds.bat_low : 20;

    if (typeof nodeState.bat === 'number' && nodeState.bat > 0 && nodeState.bat <= batLowLimit) {
        notify(
            nodeState.id,
            'low_battery',
            `Node "${nodeState.name}" (${nodeState.id}) pin yếu: ${nodeState.bat}% (ngưỡng ${batLowLimit}%).`,
            emit
        );
    }

    if (nodeState.error && nodeState.error !== 'OK' && nodeState.error !== 'Đang chờ thiết bị...') {
        notify(
            nodeState.id,
            'device_error',
            `Node "${nodeState.name}" (${nodeState.id}) báo lỗi: ${nodeState.error}`,
            emit
        );
    }
}

function notifyOffline(nodeState, emit) {
    if (!nodeState) return;
    notify(
        nodeState.id,
        'offline',
        `Node "${nodeState.name}" (${nodeState.id}) đã mất kết nối (Offline).`,
        emit
    );
}

module.exports = { checkTelemetryAlerts, notifyOffline };