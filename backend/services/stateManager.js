const registry = require('./nodeRegistry');
const sensorRepo = require('../repositories/sensorRepo');

const nodes = new Map();

function blankState(entry) {
    return {
        id: entry.id,
        name: entry.name,
        temp: 0,
        humi: 0,
        light: 0,
        motion: 0,
        rain: 0,
        dust: 0,
        bat: 100,
        mode: 'AUTO',
        ledLevel: 0,
        error: 'Đang chờ thiết bị...',
        online: false,
        rssi: -50,
        load: 0,
        lastSeen: null,
        packetCount: 0,
        simulated: false,
    };
}

function init() {
    nodes.clear();
    for (const entry of registry.list()) {
        nodes.set(entry.id, blankState(entry));
    }
}

function registerNode(entry) {
    if (!nodes.has(entry.id)) {
        nodes.set(entry.id, blankState(entry));
    }
    return nodes.get(entry.id);
}

function unregisterNode(id) {
    nodes.delete(id);
}

function renameNode(id, name) {
    const st = nodes.get(id);
    if (st) st.name = name;
}

const getState = () => Object.fromEntries(nodes);
const getNodeState = (id) => nodes.get(id) || null;

/**
 * Cập nhật số liệu cảm biến thực tế vào RAM và ghi chuỗi thời gian vào InfluxDB.
 */
async function updateNode(id, data) {
    const current = nodes.get(id);
    if (!current) return null;

    const { nodeId, id: _id, name: _name, online: _online, lastSeen: _lastSeen, ...fields } = data;
    const next = {
        ...current,
        ...fields,
        id,
        name: current.name,
        online: true,
        simulated: false,
        lastSeen: Date.now(),
        packetCount: (current.packetCount || 0) + 1,
    };
    if (fields.error === undefined && current.error === 'Đang chờ thiết bị...') {
        next.error = 'OK';
    }

    nodes.set(id, next);

    try {
        await sensorRepo.writeTelemetry(id, next);
    } catch (err) {
        console.error(`[InfluxDB] Không ghi được telemetry của ${id}:`, err.message);
    }

    return { networkState: getState(), node: next };
}

/**
 * Cập nhật thời gian hoạt động online khi node gửi ảnh/video qua HTTP.
 */
function touchOnline(id) {
    const current = nodes.get(id);
    if (!current) return null;
    current.online = true;
    current.lastSeen = Date.now();
    current.packetCount = (current.packetCount || 0) + 1;
    if (current.error === 'Đang chờ thiết bị...') current.error = 'OK';
    return getState();
}

/**
 * Giả lập trạng thái node (pin yếu, quá tải, offline, RSSI) để test định tuyến cân bằng tải.
 */
function simulateNode(id, patch = {}) {
    const current = nodes.get(id);
    if (!current) return null;

    const next = { ...current, simulated: true };
    if (typeof patch.online === 'boolean') {
        next.online = patch.online;
        if (patch.online) next.lastSeen = Date.now();
    }
    if (Number.isFinite(patch.bat)) next.bat = Math.max(0, Math.min(100, patch.bat));
    if (Number.isFinite(patch.load)) next.load = Math.max(0, Math.min(100, patch.load));
    if (Number.isFinite(patch.rssi)) next.rssi = patch.rssi;

    nodes.set(id, next);
    return { networkState: getState(), node: next };
}

function sweepOffline(timeoutMs) {
    const now = Date.now();
    const changed = [];
    for (const [id, st] of nodes) {
        if (st.online && st.lastSeen && now - st.lastSeen > timeoutMs) {
            st.online = false;
            changed.push(id);
        }
    }
    return changed;
}

async function getHistory(id, limit = 50) {
    return sensorRepo.getSensorHistory(id, limit);
}

module.exports = {
    init,
    getState,
    getNodeState,
    getHistory,
    updateNode,
    touchOnline,
    simulateNode,
    registerNode,
    unregisterNode,
    renameNode,
    sweepOffline,
};
