const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const REGISTRY_FILE = path.join(DATA_DIR, 'nodes.json');

// NodeID: chữ thường, số, '_' và '-', tối đa 32 ký tự. Dùng làm tên file lịch sử nên phải chặt.
const NODE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Trùng tên với khoá đặc biệt của routingService / đối tượng JS nên không cho dùng làm NodeID.
const RESERVED_IDS = new Set(['gateway', 'links', 'constructor', 'prototype']);

const MAX_PENDING = Number(process.env.MAX_PENDING_NODES) || 50;
const PENDING_TTL_MS = Number(process.env.PENDING_TTL_MS) || 10 * 60 * 1000;

// Node đã có từ phiên bản một-node, tạo sẵn lần đầu để thiết bị đang chạy không bị mất.
const SEED_NODES = [{ id: 'node_1', name: 'Node 1 (Real)' }];

const registered = new Map(); // id -> { id, name, addedAt, source }
const pending = new Map();    // id -> { id, via, firstSeen, lastSeen, count, sample }
const rejected = new Set();   // id bị từ chối (chỉ trong bộ nhớ, mất khi khởi động lại)

const MESSAGES = {
    invalid_id: 'NodeID chỉ gồm chữ thường, số, "_" hoặc "-" (tối đa 32 ký tự, bắt đầu bằng chữ/số).',
    reserved_id: 'NodeID này là tên dành riêng của hệ thống.',
    already_registered: 'Node này đã có trong danh sách.',
    not_pending: 'Node này không nằm trong danh sách chờ xác nhận.',
    not_found: 'Không tìm thấy node.',
};
const fail = (error) => ({ ok: false, error, message: MESSAGES[error] || error });

function validateNodeId(raw) {
    if (typeof raw !== 'string') return fail('invalid_id');
    const id = raw.trim();
    if (!NODE_ID_RE.test(id)) return fail('invalid_id');
    if (RESERVED_IDS.has(id)) return fail('reserved_id');
    return { ok: true, id };
}

function save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${REGISTRY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ nodes: [...registered.values()] }, null, 2), 'utf8');
    fs.renameSync(tmp, REGISTRY_FILE); // ghi nguyên tử, tránh hỏng file khi mất điện giữa chừng
}

function load() {
    registered.clear();
    try {
        const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        for (const n of parsed.nodes || []) {
            if (validateNodeId(n.id).ok) registered.set(n.id, n);
        }
        return;
    } catch (e) {
        if (e.code !== 'ENOENT') console.error('[Registry] Không đọc được nodes.json, tạo mới:', e.message);
    }
    for (const s of SEED_NODES) {
        registered.set(s.id, { ...s, addedAt: Date.now(), source: 'seed' });
    }
    save();
}

function addEntry(id, name, source) {
    const node = { id, name: (typeof name === 'string' && name.trim()) || id, addedAt: Date.now(), source };
    registered.set(id, node);
    save();
    return { ok: true, node };
}

const isRegistered = (id) => registered.has(id);
const list = () => [...registered.values()];
const get = (id) => registered.get(id) || null;

/** Thêm trực tiếp từ web ("Add Camera"), không cần ESP32 gửi trước. */
function addManual(rawId, name) {
    const v = validateNodeId(rawId);
    if (!v.ok) return v;
    if (registered.has(v.id)) return fail('already_registered');
    pending.delete(v.id);
    rejected.delete(v.id);
    return addEntry(v.id, name, 'manual');
}

/** ESP32 gửi NodeID chưa đăng ký: đưa vào hàng chờ. Trả 'new' | 'seen' | 'ignored' | 'full'. */
function observeUnknown(id, via, sample) {
    if (rejected.has(id)) return 'ignored';
    const now = Date.now();
    const p = pending.get(id);
    if (p) {
        p.lastSeen = now;
        p.count += 1;
        if (sample) p.sample = sample;
        return 'seen';
    }
    prunePending();
    if (pending.size >= MAX_PENDING) return 'full';
    pending.set(id, { id, via, firstSeen: now, lastSeen: now, count: 1, sample: sample || null });
    return 'new';
}

function prunePending() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [id, p] of pending) if (p.lastSeen < cutoff) pending.delete(id);
}

function listPending() {
    prunePending();
    return [...pending.values()];
}

/** Xác nhận trên web: chuyển từ hàng chờ sang danh sách chính thức. */
function approve(id, name) {
    if (registered.has(id)) return fail('already_registered');
    if (!pending.has(id)) return fail('not_pending');
    pending.delete(id);
    return addEntry(id, name, 'approved');
}

function reject(id) {
    if (!pending.has(id)) return fail('not_pending');
    pending.delete(id);
    rejected.add(id);
    return { ok: true };
}

function rename(id, name) {
    const node = registered.get(id);
    if (!node) return fail('not_found');
    if (typeof name !== 'string' || !name.trim()) return fail('invalid_id');
    node.name = name.trim();
    save();
    return { ok: true, node };
}

function remove(id) {
    if (!registered.delete(id)) return fail('not_found');
    save();
    return { ok: true };
}

load();

module.exports = {
    validateNodeId, isRegistered, list, get,
    addManual, observeUnknown, listPending, approve, reject, rename, remove,
};
