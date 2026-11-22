/**
 * Điều khiển thiết bị từ xa (mục 4 tài liệu: đổi chế độ đèn, bật/tắt camera, cập nhật ngưỡng, OTA).
 *
 * Toàn bộ danh sách lệnh, giới hạn giá trị và vòng đời lệnh nằm ở đây; server.js chỉ nối dây.
 * Định dạng gói gửi xuống ESP32 (feed CONTROL, JSON):
 *   { nodeId, cmdId, command, value, ...extra }
 * ESP32 xác nhận bằng cách gửi lại "ack": "<cmdId>" trong telemetry (xem CONTROL_PROTOCOL.md).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../data');
const DESIRED_FILE = path.join(DATA_DIR, 'control.json');

// Thêm ngay dưới dòng: const DESIRED_FILE = path.join(DATA_DIR, 'control.json');
const LOGS_FILE = path.join(DATA_DIR, 'control_logs.json');

function loadLogs() {
    try {
        const raw = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
        const map = new Map();
        if (raw && typeof raw === 'object') {
            for (const [nodeId, list] of Object.entries(raw)) {
                if (Array.isArray(list)) map.set(nodeId, list.slice(0, MAX_LOG));
            }
        }
        return map;
    } catch (e) {
        return new Map();
    }
}

function saveLogs(logsMap) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [nodeId, list] of logsMap.entries()) {
        // Loại bỏ thuộc tính `timer` trước khi ghi JSON
        obj[nodeId] = list.map(({ timer, ...rest }) => rest);
    }
    const tmp = `${LOGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, LOGS_FILE);
}

// --- Cấu hình (biến môi trường, đều tuỳ chọn) ---
const ACK_TIMEOUT_MS = Number(process.env.ACK_TIMEOUT_MS) || 15000; // chờ node xác nhận
const RATE_WINDOW_MS = 10000;
const RATE_MAX = Number(process.env.CONTROL_RATE_MAX) || 6;         // số lệnh tối đa / node / 10 giây
const RESYNC = process.env.CONTROL_RESYNC !== '0';                  // gửi lại cấu hình khi node online trở lại
const OTA_ENABLED = process.env.ALLOW_OTA === '1';                  // OTA mặc định TẮT
const OTA_URL_PREFIX = process.env.OTA_URL_PREFIX || '';            // nếu đặt: URL firmware phải bắt đầu bằng chuỗi này
const MAX_LOG = 20;

// --- Giá trị hợp lệ: sửa ở đây là giao diện tự cập nhật theo ---
const MODES = ['NORMAL', 'DEBUG'];
const LED_MODES = ['auto', 'manual'];                // auto = tự chọn theo bảng logic mục 3, manual = đặt tay
const CAM_MODES = ['off', 'periodic', 'motion', 'continuous'];
const LIMITS = {
    brightness: { min: 0, max: 100 },                // %
    interval: { min: 1, max: 3600 },                 // giây
};
// Ngưỡng cho logic mục 3 (ngày/đêm, pin yếu, giữ sáng sau chuyển động)
const THRESHOLDS = {
    lux_dark: { label: 'Ngưỡng trời tối', unit: 'lux', min: 0, max: 2000 },
    dim_level: { label: 'Độ sáng đèn mờ ban đêm', unit: '%', min: 0, max: 100 },
    bat_low: { label: 'Ngưỡng pin yếu', unit: '%', min: 5, max: 50 },
    motion_hold_s: { label: 'Giữ sáng sau chuyển động', unit: 's', min: 1, max: 600 },
};

const bad = (error, message) => ({ ok: false, error, message });

function oneOf(v, list, name) {
    return list.includes(v) ? { ok: true, value: v } : bad('invalid_value', `${name} phải là một trong: ${list.join(', ')}.`);
}

function intIn(v, min, max, name) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (!Number.isInteger(n) || n < min || n > max) return bad('invalid_value', `${name} phải là số nguyên từ ${min} đến ${max}.`);
    return { ok: true, value: n };
}

// Mỗi lệnh: nhận input từ web, trả { ok, value, extra?, patch? }.
// `patch(desired)` là phần cấu hình "mong muốn" được ghi nhớ để gửi lại khi node online trở lại.
const withPatch = (r, make) => (r.ok ? { ...r, patch: make(r.value) } : r);

const COMMANDS = {
    capture: () => ({ ok: true, value: 1 }),     // chụp một ảnh ngay
    toggle_mode: () => ({ ok: true, value: 1 }), // giữ lại cho firmware cũ
    set_mode: (i) => withPatch(oneOf(i.value, MODES, 'Chế độ'), (v) => () => ({ mode: v })),
    led_mode: (i) => withPatch(oneOf(i.value, LED_MODES, 'Chế độ đèn'), (v) => () => ({ ledMode: v })),
    // Đặt độ sáng đồng thời chuyển đèn sang thủ công
    led_brightness: (i) => withPatch(
        intIn(i.value, LIMITS.brightness.min, LIMITS.brightness.max, 'Độ sáng'),
        (v) => () => ({ ledBrightness: v, ledMode: 'manual' }),
    ),
    cam_mode: (i) => withPatch(oneOf(i.value, CAM_MODES, 'Chế độ camera'), (v) => () => ({ camMode: v })),
    cam_interval: (i) => withPatch(
        intIn(i.value, LIMITS.interval.min, LIMITS.interval.max, 'Chu kỳ chụp'),
        (v) => () => ({ camInterval: v }),
    ),
    set_threshold: (i) => {
        const key = i.key;
        if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(THRESHOLDS, key)) {
            return bad('invalid_value', `Ngưỡng không hợp lệ. Cho phép: ${Object.keys(THRESHOLDS).join(', ')}.`);
        }
        const t = THRESHOLDS[key];
        const r = intIn(i.value, t.min, t.max, t.label);
        if (!r.ok) return r;
        return { ok: true, value: r.value, extra: { key }, patch: (d) => ({ thresholds: { ...(d.thresholds || {}), [key]: r.value } }) };
    },
    ota: (i) => {
        if (!OTA_ENABLED) return bad('ota_disabled', 'OTA đang tắt trên server (đặt ALLOW_OTA=1 để bật).');
        const url = typeof i.value === 'string' ? i.value.trim() : '';
        if (!/^https:\/\/\S+$/.test(url) || url.length > 300) return bad('invalid_value', 'URL firmware phải bắt đầu bằng https:// (tối đa 300 ký tự).');
        if (OTA_URL_PREFIX && !url.startsWith(OTA_URL_PREFIX)) return bad('invalid_value', `URL firmware phải bắt đầu bằng ${OTA_URL_PREFIX}`);
        const extra = {};
        if (i.sha256 !== undefined && i.sha256 !== '') {
            if (typeof i.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(i.sha256)) return bad('invalid_value', 'sha256 phải gồm 64 ký tự hex.');
            extra.sha256 = i.sha256.toLowerCase();
        }
        return { ok: true, value: url, extra }; // OTA không ghi nhớ vào cấu hình mong muốn
    },
};

function loadDesired() {
    try {
        const d = JSON.parse(fs.readFileSync(DESIRED_FILE, 'utf8'));
        return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch (e) {
        return {};
    }
}

function saveDesired(desired) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DESIRED_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(desired, null, 2), 'utf8');
    fs.renameSync(tmp, DESIRED_FILE);
}

/**
 * @param {object} deps
 *  - publish(frame, cb): gửi gói xuống feed CONTROL (có thể ném lỗi nếu MQTT chưa kết nối)
 *  - emit(event, payload): phát sự kiện tới giao diện web
 *  - isRegistered(nodeId): node đã được xác nhận chưa
 */
function createControlService({ publish, emit, isRegistered }) {
    const desired = loadDesired();   // nodeId -> cấu hình mong muốn, lưu đĩa
    const logs = new Map();          // nodeId -> các lệnh gần nhất (mới nhất đứng đầu)
    const pending = new Map();       // cmdId -> bản ghi đang chờ ack
    const sentAt = new Map();        // nodeId -> mốc thời gian các lệnh vừa gửi (giới hạn tốc độ)

    const view = (r) => ({
        cmdId: r.cmdId, nodeId: r.nodeId, command: r.command, key: r.key, value: r.value,
        status: r.status, message: r.message, ts: r.ts, updatedAt: r.updatedAt,
    });

    function setStatus(rec, status, message = '') {
        rec.status = status;
        rec.message = message;
        rec.updatedAt = Date.now();
        if (status !== 'sent') {
            clearTimeout(rec.timer);
            pending.delete(rec.cmdId);
        }
        emit('cmd_status', view(rec));
    }

    function rateLimited(nodeId) {
        const now = Date.now();
        const recent = (sentAt.get(nodeId) || []).filter((t) => now - t < RATE_WINDOW_MS);
        const limited = recent.length >= RATE_MAX;
        if (!limited) recent.push(now);
        sentAt.set(nodeId, recent);
        return limited;
    }

    /** Gửi một gói, ghi nhật ký và chờ ack. */
    function dispatch(nodeId, command, value, extra = {}) {
        const rec = {
            cmdId: crypto.randomBytes(4).toString('hex'),
            nodeId, command, key: extra.key, value, status: 'sent', message: '', ts: Date.now(), updatedAt: Date.now(),
        };
        try {
            publish({ nodeId, cmdId: rec.cmdId, command, value, ...extra }, (err) => {
                if (err) setStatus(rec, 'failed', `Không gửi được qua MQTT: ${err.message}`);
            });
        } catch (e) {
            return bad('mqtt_unavailable', e.message);
        }
        const list = logs.get(nodeId) || [];
        list.unshift(rec);
        if (list.length > MAX_LOG) list.length = MAX_LOG;
        logs.set(nodeId, list);

        if (rec.status === 'sent') {
            pending.set(rec.cmdId, rec);
            rec.timer = setTimeout(() => {
                if (pending.has(rec.cmdId)) {
                    setStatus(rec, 'timeout', 'Chưa nhận xác nhận (node đang ngủ/offline hoặc firmware chưa gửi ack).');
                }
            }, ACK_TIMEOUT_MS);
            rec.timer.unref();
        }
        emit('cmd_status', view(rec));
        return { ok: true, rec };
    }

    /** Lệnh từ giao diện web tới một node. */
    function send(nodeId, input) {
        if (typeof nodeId !== 'string' || !isRegistered(nodeId)) return bad('not_found', 'Chưa chọn node hợp lệ.');
        input = input && typeof input === 'object' ? input : {};
        const def = typeof input.command === 'string' && Object.prototype.hasOwnProperty.call(COMMANDS, input.command)
            ? COMMANDS[input.command] : null;
        if (!def) return bad('unknown_command', `Lệnh không hợp lệ: ${String(input.command).slice(0, 40)}`);

        const parsed = def(input);
        if (!parsed.ok) return parsed;
        if (rateLimited(nodeId)) return bad('rate_limited', 'Gửi lệnh quá nhanh, thử lại sau vài giây.');

        const sent = dispatch(nodeId, input.command, parsed.value, parsed.extra);
        if (!sent.ok) return sent;

        if (parsed.patch) {
            const cur = desired[nodeId] || {};
            desired[nodeId] = { ...cur, ...parsed.patch(cur) };
            saveDesired(desired);
            emit('control_state', { nodeId, desired: desired[nodeId] });
        }
        return { ok: true, cmdId: sent.rec.cmdId };
    }

    /**
     * Xử lý gói từ node: lấy ack ra khỏi dữ liệu cảm biến.
     * Trả { data: dữ liệu đã bỏ trường ack, ackOnly: gói chỉ chứa ack }.
     */
    function onDeviceMessage(nodeId, data) {
        const { ack, ackOk, ackError, ...rest } = data;
        if (ack !== undefined) {
            const rec = pending.get(String(ack).slice(0, 16));
            if (rec && rec.nodeId === nodeId) {
                if (ackOk === false) setStatus(rec, 'failed', ackError ? String(ackError).slice(0, 120) : 'Node từ chối lệnh.');
                else setStatus(rec, 'acked');
            }
        }
        const hasData = Object.keys(rest).some((k) => k !== 'nodeId');
        return { data: rest, ackOnly: ack !== undefined && !hasData };
    }

    /**
     * Node vừa online trở lại (có thể vừa deep sleep nên lỡ lệnh): gửi lại toàn bộ cấu hình mong muốn
     * trong MỘT gói "sync". Firmware không hiểu "sync" thì bỏ qua, không ảnh hưởng gì.
     */
    function resync(nodeId) {
        const d = desired[nodeId];
        if (!RESYNC || !d || !Object.keys(d).length) return null;
        return dispatch(nodeId, 'sync', JSON.parse(JSON.stringify(d)));
    }

    function forget(nodeId) {
        delete desired[nodeId];
        logs.delete(nodeId);
        sentAt.delete(nodeId);
        saveDesired(desired);
    }

    const getDesired = (nodeId) => (desired[nodeId] ? JSON.parse(JSON.stringify(desired[nodeId])) : {});
    const getCommands = (nodeId) => (logs.get(nodeId) || []).map(view);

    // Giao diện dựng ô điều khiển từ schema này, nên đổi giới hạn chỉ cần sửa một chỗ
    const schema = () => ({
        modes: MODES,
        led: { modes: LED_MODES, brightness: LIMITS.brightness },
        cam: { modes: CAM_MODES, interval: LIMITS.interval },
        thresholds: THRESHOLDS,
        otaEnabled: OTA_ENABLED,
        otaPrefix: OTA_URL_PREFIX,
        ackTimeoutMs: ACK_TIMEOUT_MS,
    });

    return { send, onDeviceMessage, resync, forget, getDesired, getCommands, schema };
}

module.exports = { createControlService };
