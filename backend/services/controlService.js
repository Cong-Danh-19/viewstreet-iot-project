const crypto = require('crypto');
const controlRepo = require('../repositories/controlRepo');

const CONTROL_SCHEMA = {
    set_mode: {
        label: 'Chế độ hoạt động đèn',
        params: {
            mode: { type: 'select', label: 'Chế độ', options: ['AUTO', 'MANUAL', 'ECO', 'EMERGENCY'], default: 'AUTO' },
        },
    },
    set_led: {
        label: 'Độ sáng đèn LED (%)',
        params: {
            ledLevel: { type: 'number', label: 'Mức sáng (0 - 100%)', min: 0, max: 100, default: 80 },
        },
    },
    set_camera: {
        label: 'Điều khiển Camera HTTP',
        params: {
            cameraMode: { type: 'select', label: 'Trạng thái Camera', options: ['PERIODIC', 'CONTINUOUS', 'OFF'], default: 'PERIODIC' },
            intervalSec: { type: 'number', label: 'Chu kỳ chụp (giây)', min: 1, max: 3600, default: 10 },
        },
    },
    set_threshold: {
        label: 'Cập nhật ngưỡng cảm biến',
        params: {
            lightThreshold: { type: 'number', label: 'Ngưỡng tối bật đèn (Lux)', min: 0, max: 5000, default: 150 },
            motionHoldSec: { type: 'number', label: 'Giữ sáng khi có người (giây)', min: 5, max: 600, default: 30 },
        },
    },
    ota_update: {
        label: 'Cập nhật Firmware OTA',
        params: {
            version: { type: 'text', label: 'Phiên bản', default: 'v2.1.0' },
            url: { type: 'text', label: 'URL Firmware (.bin)', default: 'http://192.168.1.100:3000/firmware/esp32.bin' },
        },
    },
};

const desiredStates = new Map();
const pendingAcks = new Map();
const lastSentAt = new Map();
let recentLogs = [];

async function init() {
    desiredStates.clear();
    const map = await controlRepo.getAllDesiredStates();
    for (const [k, v] of map) desiredStates.set(k, v);
    recentLogs = await controlRepo.getRecentLogs(50);
}

function validateCommand(command, params = {}) {
    const def = CONTROL_SCHEMA[command];
    if (!def) return { ok: false, error: `Lệnh không hợp lệ: ${command}` };

    const clean = {};
    for (const [key, spec] of Object.entries(def.params)) {
        const val = params[key] !== undefined ? params[key] : spec.default;
        if (spec.type === 'select') {
            if (!spec.options.includes(val)) {
                return { ok: false, error: `Giá trị '${val}' không hợp lệ cho ${key}` };
            }
            clean[key] = val;
        } else if (spec.type === 'number') {
            const num = Number(val);
            if (!Number.isFinite(num) || num < spec.min || num > spec.max) {
                return { ok: false, error: `${key} phải nằm trong khoảng [${spec.min}, ${spec.max}]` };
            }
            clean[key] = num;
        } else {
            clean[key] = String(val || '').trim();
        }
    }
    return { ok: true, params: clean };
}

async function sendCommand(nodeId, command, rawParams, publishFn, onTimeoutFn) {
    const now = Date.now();
    const prevTs = lastSentAt.get(nodeId) || 0;
    if (now - prevTs < 800) {
        return { ok: false, error: 'Gửi lệnh quá nhanh, vui lòng chờ 1 giây' };
    }

    const validated = validateCommand(command, rawParams);
    if (!validated.ok) return validated;

    lastSentAt.set(nodeId, now);
    const cmdId = `cmd_${crypto.randomBytes(4).toString('hex')}`;
    const payload = { cmdId, command, ...validated.params };

    // Lưu cấu hình mong muốn vào PostgreSQL (để đồng bộ lại khi node thức dậy sau deep sleep)
    const currentDesired = desiredStates.get(nodeId) || {};
    const nextDesired = { ...currentDesired, ...validated.params, lastCommand: command };
    desiredStates.set(nodeId, nextDesired);
    await controlRepo.saveDesiredState(nodeId, nextDesired);

    const logEntry = await controlRepo.appendLog({
        cmdId,
        nodeId,
        command,
        payload: validated.params,
        status: 'SENT',
    });
    recentLogs.unshift(logEntry);
    if (recentLogs.length > 50) recentLogs.pop();

    if (typeof publishFn === 'function') {
        publishFn(nodeId, payload);
    }

    const timer = setTimeout(async () => {
        if (pendingAcks.has(cmdId)) {
            pendingAcks.delete(cmdId);
            await controlRepo.updateLogStatus(cmdId, 'TIMEOUT_QUEUED');
            const item = recentLogs.find((l) => l.cmdId === cmdId);
            if (item) item.status = 'TIMEOUT_QUEUED';
            if (typeof onTimeoutFn === 'function') onTimeoutFn({ cmdId, nodeId, status: 'TIMEOUT_QUEUED' });
        }
    }, 15000);

    pendingAcks.set(cmdId, { nodeId, timer });
    return { ok: true, cmdId, log: logEntry, desiredState: nextDesired };
}

async function handleAck(nodeId, data) {
    const cmdId = data && data.cmdId;
    if (!cmdId) return null;

    const pending = pendingAcks.get(cmdId);
    if (pending) {
        clearTimeout(pending.timer);
        pendingAcks.delete(cmdId);
    }

    const status = data.ok === false ? 'FAILED' : 'ACKED';
    await controlRepo.updateLogStatus(cmdId, status);
    const item = recentLogs.find((l) => l.cmdId === cmdId);
    if (item) item.status = status;

    return { cmdId, nodeId, status };
}

function syncNode(nodeId, publishFn) {
    const desired = desiredStates.get(nodeId);
    if (!desired || Object.keys(desired).length === 0) return false;
    if (typeof publishFn === 'function') {
        publishFn(nodeId, { type: 'sync', config: desired });
    }
    return true;
}

module.exports = {
    CONTROL_SCHEMA,
    init,
    sendCommand,
    handleAck,
    syncNode,
    getLogs: () => recentLogs,
    getDesiredState: (nodeId) => desiredStates.get(nodeId) || {},
};
