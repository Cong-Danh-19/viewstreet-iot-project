const fs = require('fs');
const path = require('path');
const registry = require('./nodeRegistry');

const DATA_DIR = path.join(__dirname, '../data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const LEGACY_HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const MAX_HISTORY = 50;

fs.mkdirSync(HISTORY_DIR, { recursive: true });

const nodes = new Map();
const historyCache = new Map();

function blankState(entry) {
    return {
        id: entry.id,
        name: entry.name,
        temp: 0,
        humi: 0,
        light: 0,
        motion: 0,
        bat: 0,
        mode: 'NORMAL',
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

const historyFile = (id) => path.join(HISTORY_DIR, `${id}.json`);

function readHistory(id) {
    try {
        return JSON.parse(fs.readFileSync(historyFile(id), 'utf8'));
    } catch (e) {
        return [];
    }
}

function getHistory(id) {
    if (!historyCache.has(id)) historyCache.set(id, readHistory(id));
    return historyCache.get(id);
}

function appendHistory(id, data) {
    const history = getHistory(id);
    const now = new Date();
    const record = {
        nodeId: id,
        ts: now.getTime(),
        time: now.toLocaleTimeString('vi-VN'),
        date: now.toLocaleDateString('vi-VN'),
        temp: data.temp,
        humi: data.humi,
        light: data.light,
        bat: data.bat,
        motion: data.motion,
        error: data.error || 'OK',
    };
    history.push(record);
    if (history.length > MAX_HISTORY) history.shift();
    fs.writeFileSync(historyFile(id), JSON.stringify(history, null, 2), 'utf8');
    return record;
}

function migrateLegacyHistory() {
    try {
        if (!registry.isRegistered('node_1') || fs.existsSync(historyFile('node_1'))) return;
        const legacy = JSON.parse(fs.readFileSync(LEGACY_HISTORY_FILE, 'utf8'));
        if (Array.isArray(legacy) && legacy.length) {
            fs.writeFileSync(historyFile('node_1'), JSON.stringify(legacy.slice(-MAX_HISTORY), null, 2), 'utf8');
        }
    } catch (e) { /* bỏ qua nếu không có file cũ */ }
}

function registerNode(entry) {
    if (!nodes.has(entry.id)) nodes.set(entry.id, blankState(entry));
    return nodes.get(entry.id);
}

function unregisterNode(id) {
    nodes.delete(id);
    historyCache.delete(id);
}

function renameNode(id, name) {
    const st = nodes.get(id);
    if (st) st.name = name;
}

const getState = () => Object.fromEntries(nodes);
const getNodeState = (id) => nodes.get(id) || null;

function updateNode(id, data) {
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
    if (fields.error === undefined && current.error === 'Đang chờ thiết bị...') next.error = 'OK';

    nodes.set(id, next);
    const newRecord = appendHistory(id, next);
    return { networkState: getState(), node: next, newRecord };
}

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
        if (st.online && now - st.lastSeen > timeoutMs) {
            st.online = false;
            changed.push(id);
        }
    }
    return changed;
}

for (const entry of registry.list()) registerNode(entry);
migrateLegacyHistory();

module.exports = {
    getState, getNodeState, getHistory, updateNode, simulateNode,
    registerNode, unregisterNode, renameNode, sweepOffline,
};