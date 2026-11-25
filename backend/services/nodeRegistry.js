const nodeRepo = require('../repositories/nodeRepo');

const ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const approvedMap = new Map();
const pendingMap = new Map();

const isValidId = (id) => typeof id === 'string' && ID_REGEX.test(id);
const isRegistered = (id) => approvedMap.has(id);
const list = () => Array.from(approvedMap.values());
const listPending = () => Array.from(pendingMap.values());

async function init() {
    approvedMap.clear();
    pendingMap.clear();
    const approved = await nodeRepo.getApprovedNodes();
    for (const row of approved) approvedMap.set(row.id, row);

    const pending = await nodeRepo.getPendingNodes();
    for (const row of pending) pendingMap.set(row.id, row);
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
    return row;
}

async function addManual(id, customName) {
    if (!isValidId(id)) return null;
    const name = (customName && customName.trim()) || id;
    const row = await nodeRepo.upsertNode(id, name, 'manual', 'approved');
    pendingMap.delete(id);
    approvedMap.set(id, row);
    return row;
}

async function rename(id, newName) {
    if (!approvedMap.has(id) || !newName || !newName.trim()) return null;
    const updated = await nodeRepo.renameNode(id, newName.trim());
    if (updated) approvedMap.set(id, updated);
    return updated;
}

async function remove(id) {
    await nodeRepo.deleteNode(id);
    approvedMap.delete(id);
    pendingMap.delete(id);
}

module.exports = {
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
