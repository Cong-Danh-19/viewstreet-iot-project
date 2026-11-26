const nodeRepo = require('../repositories/nodeRepo');
const routingService = require('./routingService');
const alertService = require('./alertService');

const RELAY_NODES = [
    { id: 'node_1', name: 'Node Trung Gian 1 (Relay)' },
    { id: 'node_2', name: 'Node Trung Gian 2 (Relay)' },
    { id: 'node_3', name: 'Node Trung Gian 3 (Relay)' },
];
const RELAY_ID_SET = new Set(RELAY_NODES.map((n) => n.id));

const ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const approvedMap = new Map();
const pendingMap = new Map();

const isRelay = (id) => RELAY_ID_SET.has(id);
const isValidId = (id) => typeof id === 'string' && ID_REGEX.test(id);
const isRegistered = (id) => approvedMap.has(id);
const list = () => Array.from(approvedMap.values());
const listPending = () => Array.from(pendingMap.values());

async function init() {
    approvedMap.clear();
    pendingMap.clear();

    const approved = await nodeRepo.getApprovedNodes();
    for (const row of approved) approvedMap.set(row.id, row);

    for (const relay of RELAY_NODES) {
        if (!approvedMap.has(relay.id)) {
            const row = await nodeRepo.upsertNode(relay.id, relay.name, 'relay', 'approved');
            approvedMap.set(relay.id, row);
        }
    }

    const pending = await nodeRepo.getPendingNodes();
    for (const row of pending) {
        if (!approvedMap.has(row.id)) pendingMap.set(row.id, row);
    }
}

async function recordPending(id, source = 'auto') {
    if (!isValidId(id) || approvedMap.has(id)) return null;
    if (!pendingMap.has(id)) {
        const row = await nodeRepo.upsertNode(id, id, source, 'pending');
        pendingMap.set(id, { id: row.id, name: row.name, source: row.source, seenAt: row.createdAt });
    }
    return pendingMap.get(id);
}

async function approve(id, customName) {
    if (!isValidId(id)) return null;
    const existing = pendingMap.get(id) || approvedMap.get(id);
    const name = (customName && customName.trim()) || (existing && existing.name) || id;
    const row = await nodeRepo.upsertNode(id, name, (existing && existing.source) || 'approved', 'approved');
    pendingMap.delete(id);
    approvedMap.set(id, row);

    routingService.wakeRelays();
    await routingService.syncTopology();
    return row;
}

async function addManual(id, customName) {
    if (!isValidId(id)) return null;
    const name = (customName && customName.trim()) || id;
    const row = await nodeRepo.upsertNode(id, name, 'manual', 'approved');
    pendingMap.delete(id);
    approvedMap.set(id, row);

    routingService.wakeRelays();
    await routingService.syncTopology();
    return row;
}

async function rename(id, newName) {
    if (!approvedMap.has(id) || !newName || !newName.trim()) return null;
    const updated = await nodeRepo.renameNode(id, newName.trim());
    if (updated) approvedMap.set(id, updated);
    return updated;
}

async function remove(id) {
    if (!id || id === 'gateway' || isRelay(id)) {
        return { ok: false, error: 'Không thể xóa Gateway hoặc 3 node trung gian mặc định' };
    }
    const stateManager = require('./stateManager');

    await nodeRepo.deleteNode(id);
    approvedMap.delete(id);
    pendingMap.delete(id);
    stateManager.unregisterNode(id);
    alertService.clearNode(id);

    await routingService.syncTopology();
    return { ok: true };
}

module.exports = {
    RELAY_NODES,
    isRelay,
    init,
    isValidId,
    isRegistered,
    list,
    listPending,
    recordPending,
    approve,
    addManual,
    rename,
    remove,
};