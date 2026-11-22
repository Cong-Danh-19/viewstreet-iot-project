// ---------- Kết nối ----------
// Token quản trị (nếu server đặt ADMIN_TOKEN) được gửi lúc bắt tay WebSocket.
const getToken = () => { try { return localStorage.getItem('adminToken') || ''; } catch (e) { return ''; } };
const socket = io({ auth: (cb) => cb({ token: getToken() }) });

const S = {
    nodes: [],        // [{id, name, online, lastSeen, source}]
    pending: [],      // [{id, via, firstSeen, count, sample}]
    states: {},       // nodeId -> trạng thái
    routing: {},      // nodeId -> kết quả định tuyến
    selected: null,
    isAdmin: false,
    schema: null,     // giới hạn giá trị lệnh do server gửi (controlService.schema)
    desired: {},      // nodeId -> cấu hình điều khiển đã đặt
    commands: {},     // nodeId -> nhật ký lệnh gần nhất (mới nhất đứng đầu)
};

const $ = (id) => document.getElementById(id);
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString('vi-VN') : '--');
const nodeName = (id) => (S.nodes.find((n) => n.id === id) || {}).name || id;

// Tạo phần tử DOM an toàn (tên node do người dùng/thiết bị nhập nên không dùng innerHTML)
function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
}
const svgEl = (tag, attrs = {}, text) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    return el;
};

// ---------- Nhật ký + thông báo ----------
let lastFrameLog = 0;
function log(text) {
    const pre = $('log');
    pre.textContent = `${new Date().toLocaleTimeString('vi-VN')}  ${text}\n` + pre.textContent;
    if (pre.textContent.length > 12000) pre.textContent = pre.textContent.slice(0, 10000);
}
let toastTimer;
function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

socket.onAny((ev, d) => {
    if (ev === 'camera_frame') {
        if (Date.now() - lastFrameLog < 2000) return; // ảnh đến nhanh, chỉ ghi thưa
        lastFrameLog = Date.now();
        return log(`camera_frame  ${d.nodeId}  (${d.frame.length} ký tự)`);
    }
    if (ev === 'state_update') return log(`state_update  ${d.nodeId}  temp=${d.newRecord.temp} bat=${d.newRecord.bat}  tuyến: ${d.routingInfo.optimalRoute}`);
    if (ev === 'init_dashboard') return log(`init_dashboard  ${d.nodes.length} node, ${d.pendingNodes.length} chờ, isAdmin=${d.isAdmin}`);
    if (ev === 'node_list') return log(`node_list  [${d.map((n) => n.id + (n.online ? '*' : '')).join(', ')}]  (* = online)`);
    if (ev === 'pending_nodes') return log(`pending_nodes  [${d.map((p) => p.id).join(', ')}]`);
    if (ev === 'node_selected') return log(`node_selected  ${d.nodeId}  (${d.history.length} bản ghi lịch sử)`);
    log(`${ev}  ${JSON.stringify(d)}`);
});

// Gửi sự kiện quản trị, hiện lỗi nếu bị từ chối
function act(ev, payload, done) {
    socket.emit(ev, payload, (r) => {
        r = r || { ok: false, message: 'Không có phản hồi từ server' };
        log(`${ev} -> ${r.ok ? 'OK' : 'LỖI ' + (r.error || '')}`);
        if (!r.ok) toast(r.message || r.error || 'Thao tác thất bại');
        if (done) done(r);
    });
}

// ---------- Biểu đồ ----------
const MAX_POINTS = 50;
const envChart = new Chart($('envChart').getContext('2d'), {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            { label: 'Nhiệt độ (°C)', data: [], borderColor: '#fb7185', tension: 0.3 },
            { label: 'Độ ẩm (%)', data: [], borderColor: '#38bdf8', tension: 0.3 },
        ],
    },
    options: { responsive: true, animation: false, scales: { y: { beginAtZero: false } } },
});

function loadChart(history) {
    const rows = history.slice(-MAX_POINTS);
    envChart.data.labels = rows.map((r) => r.time);
    envChart.data.datasets[0].data = rows.map((r) => r.temp ?? null);
    envChart.data.datasets[1].data = rows.map((r) => r.humi ?? null);
    envChart.update();
}

function pushChart(rec) {
    envChart.data.labels.push(rec.time);
    envChart.data.datasets[0].data.push(rec.temp ?? null);
    envChart.data.datasets[1].data.push(rec.humi ?? null);
    if (envChart.data.labels.length > MAX_POINTS) {
        envChart.data.labels.shift();
        envChart.data.datasets.forEach((d) => d.data.shift());
    }
    envChart.update();
}

// ---------- Hiển thị ----------
function renderStatus() {
    const connected = socket.connected;
    const c = $('conn-status');
    c.textContent = connected ? 'Đã kết nối' : 'Mất kết nối';
    c.className = `px-3 py-1 rounded-full font-semibold ${connected ? 'bg-emerald-600' : 'bg-rose-600'}`;
    const a = $('admin-status');
    a.textContent = S.isAdmin ? 'Quyền: quản trị' : 'Quyền: chỉ xem';
    a.className = `px-3 py-1 rounded-full font-semibold ${S.isAdmin ? 'bg-sky-600' : 'bg-slate-700'}`;
}

function renderNodeList() {
    $('node-count').textContent = `(${S.nodes.length})`;
    const ul = $('node-list');
    ul.replaceChildren();
    if (!S.nodes.length) ul.append(h('li', { class: 'text-xs text-slate-500', text: 'Chưa có node nào.' }));
    for (const n of S.nodes) {
        const sel = n.id === S.selected;
        ul.append(h('li', {
            class: `flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer border ${sel ? 'bg-sky-900/60 border-sky-500' : 'bg-slate-900 border-transparent hover:border-slate-600'}`,
            'data-node': n.id,
            onclick: () => selectNode(n.id),
        },
            h('span', { class: `w-2.5 h-2.5 rounded-full shrink-0 ${n.online ? 'bg-emerald-400' : 'bg-slate-500'}`, title: n.online ? 'online' : 'offline' }),
            h('div', { class: 'min-w-0 flex-1' },
                h('div', { class: 'text-sm font-medium truncate', text: n.name }),
                h('div', { class: 'text-xs text-slate-500 font-mono truncate', text: n.id })),
            h('button', {
                class: 'text-xs text-slate-400 hover:text-sky-300 disabled:opacity-30', title: 'Đổi tên', disabled: !S.isAdmin || null,
                onclick: (e) => {
                    e.stopPropagation();
                    const name = prompt('Tên hiển thị mới cho ' + n.id, n.name);
                    if (name && name.trim()) act('rename_node', { nodeId: n.id, name });
                },
            }, '✎'),
            h('button', {
                class: 'text-xs text-slate-400 hover:text-rose-400 disabled:opacity-30', title: 'Xoá khỏi danh sách', disabled: !S.isAdmin || null,
                onclick: (e) => {
                    e.stopPropagation();
                    if (confirm(`Xoá node "${n.name}" (${n.id}) khỏi danh sách?\nLịch sử vẫn được giữ trên đĩa.`)) act('remove_node', { nodeId: n.id });
                },
            }, '🗑')));
    }
}

function renderPending() {
    $('pending-count').textContent = S.pending.length ? `(${S.pending.length})` : '';
    const ul = $('pending-list');
    ul.replaceChildren();
    if (!S.pending.length) ul.append(h('li', { class: 'text-xs text-slate-500', text: 'Không có NodeID nào đang chờ.' }));
    for (const p of S.pending) {
        const nameInput = h('input', {
            class: 'w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs', placeholder: 'Tên hiển thị (tuỳ chọn)', maxlength: '40',
        });
        const sample = Object.entries(p.sample || {}).map(([k, v]) => `${k}=${v}`).join(' ');
        ul.append(h('li', { class: 'bg-slate-900 rounded p-2 space-y-1.5', 'data-pending': p.id },
            h('div', { class: 'flex justify-between items-baseline' },
                h('span', { class: 'font-mono text-sm text-amber-300', text: p.id }),
                h('span', { class: 'text-xs text-slate-500', text: `${p.via} · ${fmtTime(p.firstSeen)}` })),
            sample ? h('div', { class: 'text-xs text-slate-400 font-mono', text: sample }) : null,
            nameInput,
            h('div', { class: 'flex gap-2' },
                h('button', {
                    class: 'approve-btn flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded py-1 text-xs font-semibold', disabled: !S.isAdmin || null,
                    onclick: () => act('approve_node', { nodeId: p.id, name: nameInput.value }),
                }, 'Duyệt'),
                h('button', {
                    class: 'reject-btn flex-1 bg-slate-700 hover:bg-rose-600 disabled:opacity-40 rounded py-1 text-xs font-semibold', disabled: !S.isAdmin || null,
                    onclick: () => act('reject_node', { nodeId: p.id }),
                }, 'Từ chối'))));
    }
}

function renderDetail() {
    const id = S.selected;
    const st = id ? S.states[id] : null;
    $('sel-title').textContent = id ? `${nodeName(id)}  (${id})` : 'Chưa chọn node';

    const set = (k, v) => { $('val-' + k).textContent = v; };
    const badge = $('mode-badge');
    if (!st) {
        ['temp', 'humi', 'light', 'bat', 'online', 'seen', 'motion', 'led', 'error'].forEach((k) => set(k, '--'));
        badge.textContent = 'MODE: --';
        badge.className = 'px-4 py-1.5 rounded-full font-bold text-sm bg-slate-600';
        return;
    }
    set('temp', `${st.temp} °C`);
    set('humi', `${st.humi} %`);
    set('light', `${st.light} Lux`);
    set('bat', `${st.bat} %`);
    set('online', st.online ? 'ONLINE' : 'OFFLINE');
    $('val-online').className = st.online ? 'text-emerald-400' : 'text-rose-400';
    set('seen', fmtTime(st.lastSeen));
    set('motion', st.motion ? 'CÓ NGƯỜI / XE' : 'Không có');
    set('led', `Mức ${st.ledLevel} / 4`);
    set('error', st.error);
    badge.textContent = `MODE: ${st.mode}`;
    badge.className = st.mode === 'DEBUG'
        ? 'px-4 py-1.5 rounded-full font-bold text-sm bg-rose-600 animate-pulse'
        : 'px-4 py-1.5 rounded-full font-bold text-sm bg-emerald-600';
}

// Vẽ các tuyến của node đang chọn: node nguồn bên trái, gateway bên phải, node trung gian ở giữa.
function renderTopology() {
    const svg = $('topo');
    svg.replaceChildren();
    const id = S.selected;
    const r = id ? S.routing[id] : null;
    $('routing-info').textContent = r ? `Tuyến: ${r.optimalRoute}  (cost ${Number.isFinite(r.totalCost) ? r.totalCost : '∞'})` : '--';
    if (!id) return;

    const alts = (r && r.alternatives) || [];
    const paths = alts.map((a) => a.path).filter((p) => p.length);
    const best = (r && r.optimalPath) || [];
    const maxHop = Math.max(1, ...paths.map((p) => p.length - 1));
    const X0 = 50, X1 = 350;
    const colOf = (nodeId, k) => (nodeId === 'gateway' ? maxHop : k);

    // gom node theo cột
    const cols = new Map();
    const place = (nodeId, k) => {
        const c = colOf(nodeId, k);
        if (!cols.has(c)) cols.set(c, []);
        if (!cols.get(c).includes(nodeId)) cols.get(c).push(nodeId);
    };
    place(id, 0);
    place('gateway', maxHop);
    paths.forEach((p) => p.forEach((n, k) => place(n, k)));

    const pos = {};
    for (const [c, ids] of cols) {
        ids.forEach((n, i) => {
            pos[n] = { x: X0 + (c * (X1 - X0)) / maxHop, y: ((i + 1) * 220) / (ids.length + 1) };
        });
    }

    // cạnh: tuyến tốt nhất xanh đậm, còn lại xám nét đứt
    const edges = new Map();
    paths.forEach((p) => p.slice(1).forEach((to, i) => edges.set(`${p[i]}>${to}`, [p[i], to])));
    const bestEdges = new Set(best.slice(1).map((to, i) => `${best[i]}>${to}`));
    for (const [key, [a, b]] of edges) {
        const on = bestEdges.has(key);
        svg.append(svgEl('line', {
            x1: pos[a].x, y1: pos[a].y, x2: pos[b].x, y2: pos[b].y,
            stroke: on ? '#10b981' : '#475569', 'stroke-width': on ? 4 : 2, 'stroke-dasharray': on ? '' : '5,5',
        }));
    }
    if (!edges.size) { // offline / không có đường
        svg.append(svgEl('line', { x1: pos[id].x, y1: pos[id].y, x2: pos.gateway.x, y2: pos.gateway.y, stroke: '#ef4444', 'stroke-width': 1, 'stroke-dasharray': '4,4' }));
    }
    for (const n of Object.keys(pos)) {
        const isGw = n === 'gateway';
        const online = isGw || (S.states[n] && S.states[n].online);
        const { x, y } = pos[n];
        if (isGw) svg.append(svgEl('rect', { x: x - 18, y: y - 18, width: 36, height: 36, rx: 6, fill: '#8b5cf6' }));
        else svg.append(svgEl('circle', { cx: x, cy: y, r: 16, fill: online ? (n === id ? '#3b82f6' : '#10b981') : '#ef4444' }));
        const label = isGw ? 'Gateway' : nodeName(n);
        svg.append(svgEl('text', { x, y: y + 32, fill: '#fff', 'font-size': 11, 'text-anchor': 'middle' }, label.length > 14 ? label.slice(0, 13) + '…' : label));
    }
}

function renderAll() {
    renderStatus();
    renderNodeList();
    renderPending();
    renderDetail();
    syncControlValues();
    renderCmdLog();
    renderTopology();
}

// ---------- Chọn node ----------
function showFrame(frame) {
    const img = $('cam-view');
    if (!frame) { img.classList.add('hidden'); $('cam-ph').classList.remove('hidden'); return; }
    img.src = frame.startsWith('data:image') ? frame : 'data:image/jpeg;base64,' + frame;
    img.classList.remove('hidden');
    $('cam-ph').classList.add('hidden');
}

function selectNode(id) {
    S.selected = id;
    showFrame(null);
    loadChart([]);
    renderAll();
    if (id) act('select_node', { nodeId: id });
}

// ---------- Điều khiển thiết bị ----------
// Ô điều khiển được dựng từ S.schema (server gửi), nên giới hạn giá trị chỉ định nghĩa ở controlService.js.
const CAM_LABELS = { off: 'Tắt camera', periodic: 'Chụp định kỳ', motion: 'Khi có chuyển động', continuous: 'Liên tục' };
const LED_LABELS = { auto: 'Tự động', manual: 'Thủ công' };
const STATUS_UI = {
    sent: ['Đã gửi', 'bg-amber-600'],
    acked: ['Node đã xác nhận', 'bg-emerald-600'],
    failed: ['Thất bại', 'bg-rose-600'],
    timeout: ['Chưa có xác nhận', 'bg-slate-600'],
};
const C = {}; // tham chiếu tới các ô điều khiển
const INPUT_CLS = 'bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm disabled:opacity-40';

function sendCmd(command, value, extra = {}) {
    if (!S.selected) return;
    act('cmd_hardware', { nodeId: S.selected, command, value, ...extra });
}

const ctlCard = (title, ...kids) => h('div', { class: 'bg-slate-900 rounded-lg p-3 space-y-2' },
    h('h4', { class: 'text-xs font-semibold uppercase text-slate-400', text: title }), ...kids);
const ctlBtn = (text, onclick, cls = 'bg-sky-600 hover:bg-sky-500') =>
    h('button', { 'data-ctl': '1', class: `${cls} disabled:opacity-40 rounded px-3 py-1.5 text-sm font-medium`, onclick, text });
const ctlInfo = () => h('p', { class: 'text-xs text-slate-500 font-mono min-h-4' });

function buildControlPanel() {
    const sc = S.schema;
    const root = $('control-panel');
    if (!sc || !root) return;
    root.replaceChildren();
    Object.keys(C).forEach((k) => delete C[k]);

    // Đèn: tự động / thủ công + độ sáng. Kéo thanh độ sáng sẽ chuyển sang thủ công.
    C.ledBtns = {};
    const seg = h('div', { class: 'flex gap-2' }, sc.led.modes.map((m) => {
        C.ledBtns[m] = ctlBtn(LED_LABELS[m] || m, () => sendCmd('led_mode', m), 'bg-slate-700 hover:bg-slate-600');
        return C.ledBtns[m];
    }));
    C.ledRange = h('input', {
        'data-ctl': '1', type: 'range', min: sc.led.brightness.min, max: sc.led.brightness.max, step: '1', value: '0',
        class: 'flex-1 accent-amber-400 disabled:opacity-40',
    });
    C.ledVal = h('span', { class: 'text-sm font-bold text-amber-300 w-12 text-right', text: '0%' });
    C.ledRange.addEventListener('input', () => { C.ledVal.textContent = `${C.ledRange.value}%`; });
    C.ledRange.addEventListener('change', () => sendCmd('led_brightness', Number(C.ledRange.value))); // gửi khi thả tay
    C.ledInfo = ctlInfo();

    // Camera: chế độ chụp, chu kỳ, chụp ngay
    C.camMode = h('select', { 'data-ctl': '1', class: `w-full ${INPUT_CLS}` },
        sc.cam.modes.map((m) => h('option', { value: m, text: CAM_LABELS[m] || m })));
    C.camMode.addEventListener('change', () => sendCmd('cam_mode', C.camMode.value));
    C.camInt = h('input', {
        'data-ctl': '1', type: 'number', min: sc.cam.interval.min, max: sc.cam.interval.max, placeholder: 'giây',
        class: `w-24 ${INPUT_CLS}`,
    });
    C.camInfo = ctlInfo();

    // Chế độ hệ thống
    C.mode = h('select', { 'data-ctl': '1', class: `w-full ${INPUT_CLS}` }, sc.modes.map((m) => h('option', { value: m, text: m })));
    C.mode.addEventListener('change', () => sendCmd('set_mode', C.mode.value));
    C.modeInfo = ctlInfo();

    // Ngưỡng (mục 3 tài liệu)
    C.th = {};
    const thRows = Object.entries(sc.thresholds).map(([key, t]) => {
        C.th[key] = h('input', {
            'data-ctl': '1', type: 'number', min: t.min, max: t.max, placeholder: `${t.min}–${t.max}`, class: `w-24 ${INPUT_CLS}`,
        });
        return h('div', { class: 'flex items-center gap-2 text-sm' },
            h('span', { class: 'flex-1 min-w-0 truncate', title: key, text: `${t.label} (${t.unit})` }),
            C.th[key],
            ctlBtn('Gửi', () => sendCmd('set_threshold', Number(C.th[key].value), { key }), 'bg-slate-700 hover:bg-slate-600'));
    });

    // Nhật ký lệnh
    C.log = h('div', { class: 'space-y-1 max-h-52 overflow-y-auto text-xs' });

    root.append(
        ctlCard('Đèn', seg,
            h('div', { class: 'flex items-center gap-2' }, C.ledRange, C.ledVal),
            h('p', { class: 'text-xs text-slate-500', text: 'Tự động: node tự chọn theo bảng logic. Kéo thanh độ sáng: chuyển sang thủ công.' }),
            C.ledInfo),
        ctlCard('Camera', C.camMode,
            h('div', { class: 'flex items-center gap-2' }, C.camInt,
                ctlBtn('Đặt chu kỳ (giây)', () => sendCmd('cam_interval', Number(C.camInt.value)), 'bg-slate-700 hover:bg-slate-600'),
                ctlBtn('Chụp ngay', () => sendCmd('capture', 1))),
            C.camInfo),
        ctlCard('Chế độ hệ thống', C.mode, C.modeInfo),
        ctlCard('Ngưỡng hoạt động', ...thRows),
    );

    if (sc.otaEnabled) {
        C.otaUrl = h('input', { 'data-ctl': '1', type: 'url', placeholder: sc.otaPrefix || 'https://…/firmware.bin', class: `w-full ${INPUT_CLS}` });
        C.otaSha = h('input', { 'data-ctl': '1', placeholder: 'sha256 (64 ký tự hex, khuyến nghị)', class: `w-full font-mono ${INPUT_CLS}` });
        root.append(ctlCard('Cập nhật firmware (OTA)', C.otaUrl, C.otaSha,
            ctlBtn('Cập nhật firmware', () => {
                if (!confirm(`Gửi lệnh cập nhật firmware cho "${nodeName(S.selected)}"?\nNode sẽ tải và khởi động lại.`)) return;
                sendCmd('ota', C.otaUrl.value.trim(), { sha256: C.otaSha.value.trim() });
            }, 'bg-rose-700 hover:bg-rose-600')));
    }

    root.append(h('div', { class: 'bg-slate-900 rounded-lg p-3 space-y-2 md:col-span-2 2xl:col-span-3' },
        h('h4', { class: 'text-xs font-semibold uppercase text-slate-400', text: 'Nhật ký lệnh' }), C.log,
        h('p', { class: 'text-xs text-slate-500', text: 'Trạng thái "Node đã xác nhận" cần firmware gửi lại "ack" trong telemetry (xem CONTROL_PROTOCOL.md).' })));
}

// Cập nhật giá trị hiển thị trên các ô điều khiển (không ghi đè ô đang gõ)
function syncControlValues() {
    if (!C.ledRange) return;
    const id = S.selected;
    const st = (id && S.states[id]) || {};
    const d = (id && S.desired[id]) || {};
    const usable = !!id && S.isAdmin;
    document.querySelectorAll('#control-panel [data-ctl]').forEach((el) => { el.disabled = !usable; });
    const setVal = (el, v) => { if (el && document.activeElement !== el) el.value = v ?? ''; };
    const show = (v, unit = '') => (v === undefined || v === null ? '--' : `${v}${unit}`);

    const ledMode = d.ledMode ?? st.ledMode;
    for (const [m, b] of Object.entries(C.ledBtns)) {
        b.classList.toggle('bg-amber-600', m === ledMode);
        b.classList.toggle('bg-slate-700', m !== ledMode);
    }
    setVal(C.ledRange, d.ledBrightness ?? st.ledBrightness ?? 0);
    C.ledVal.textContent = `${C.ledRange.value}%`;
    C.ledInfo.textContent = `Đã gửi: ${show(d.ledMode)} ${show(d.ledBrightness, '%')} · Node báo: ${show(st.ledMode)} ${show(st.ledBrightness, '%')}`;

    setVal(C.camMode, d.camMode ?? st.camMode);
    setVal(C.camInt, d.camInterval ?? st.camInterval);
    C.camInfo.textContent = `Đã gửi: ${show(d.camMode)} ${show(d.camInterval, 's')} · Node báo: ${show(st.camMode)} ${show(st.camInterval, 's')}`;

    setVal(C.mode, d.mode ?? st.mode);
    C.modeInfo.textContent = `Đã gửi: ${show(d.mode)} · Node báo: ${show(st.mode)}`;

    for (const [key, el] of Object.entries(C.th)) setVal(el, (d.thresholds || {})[key]);
}

function renderCmdLog() {
    if (!C.log) return;
    const list = (S.selected && S.commands[S.selected]) || [];
    C.log.replaceChildren();
    if (!list.length) {
        C.log.append(h('div', { class: 'text-slate-500', text: 'Chưa gửi lệnh nào cho node này.' }));
        return;
    }
    for (const c of list.slice(0, 12)) {
        const [label, cls] = STATUS_UI[c.status] || [c.status, 'bg-slate-600'];
        const v = typeof c.value === 'object' ? JSON.stringify(c.value) : String(c.value);
        C.log.append(h('div', { class: 'flex items-center gap-2 bg-slate-800 rounded px-2 py-1', title: c.message || '' },
            h('span', { class: 'text-slate-500 font-mono', text: fmtTime(c.ts) }),
            h('span', { class: 'font-mono text-slate-200 truncate', text: (c.key ? `${c.command} ${c.key}=${v}` : `${c.command} ${v}`).slice(0, 70) }),
            h('span', { class: `ml-auto shrink-0 px-2 py-0.5 rounded-full ${cls}`, text: label })));
    }
}

// ---------- Sự kiện từ server ----------
socket.on('connect', () => { renderStatus(); });
socket.on('disconnect', () => { renderStatus(); });
socket.on('connect_error', (e) => { log('connect_error ' + e.message); renderStatus(); });

socket.on('init_dashboard', (d) => {
    S.isAdmin = d.isAdmin;
    S.nodes = d.nodes;
    S.pending = d.pendingNodes;
    S.states = d.currentState;
    S.routing = d.routingInfo;
    S.schema = d.controlSchema;
    buildControlPanel();
    // giữ node đang chọn nếu còn, không thì chọn node đầu tiên
    const keep = S.selected && S.nodes.some((n) => n.id === S.selected) ? S.selected : (S.nodes[0] && S.nodes[0].id) || null;
    selectNode(keep);
});

socket.on('node_list', (list) => {
    S.nodes = list;
    renderNodeList();
    renderDetail();
});

socket.on('pending_nodes', (list) => {
    S.pending = list;
    renderPending();
});

socket.on('state_update', ({ nodeId, currentState, routingInfo, newRecord }) => {
    S.states = currentState;
    S.routing[nodeId] = routingInfo;
    const n = S.nodes.find((x) => x.id === nodeId);
    if (n) { n.online = true; n.lastSeen = currentState[nodeId].lastSeen; }
    renderNodeList();
    if (nodeId === S.selected) {
        pushChart(newRecord);
        renderDetail();
        syncControlValues(); // cập nhật phần "Node báo" trên ô điều khiển
        renderTopology();
    }
});

socket.on('node_offline', ({ nodeId, routingInfo }) => {
    if (S.states[nodeId]) S.states[nodeId].online = false;
    S.routing[nodeId] = routingInfo;
    renderDetail();
    renderTopology();
});

socket.on('routing_update', (allRoutes) => {
    S.routing = allRoutes;
    renderTopology();
});

socket.on('node_selected', ({ nodeId, state, routingInfo, history, desired, commands }) => {
    if (nodeId !== S.selected) return;
    S.states[nodeId] = state;
    S.routing[nodeId] = routingInfo;
    S.desired[nodeId] = desired || {};
    S.commands[nodeId] = commands || [];
    loadChart(history);
    renderDetail();
    syncControlValues();
    renderCmdLog();
    renderTopology();
});

// Trạng thái từng lệnh: sent -> acked | failed | timeout
socket.on('cmd_status', (c) => {
    const list = (S.commands[c.nodeId] = S.commands[c.nodeId] || []);
    const i = list.findIndex((x) => x.cmdId === c.cmdId);
    if (i >= 0) list[i] = c; else list.unshift(c);
    if (list.length > 20) list.length = 20;
    if (c.nodeId === S.selected) renderCmdLog();
    if (c.status === 'failed') toast(`Lệnh ${c.command} thất bại: ${c.message}`);
});

socket.on('control_state', ({ nodeId, desired }) => {
    S.desired[nodeId] = desired;
    if (nodeId === S.selected) syncControlValues();
});

socket.on('camera_frame', ({ nodeId, frame }) => {
    if (nodeId === S.selected) showFrame(frame);
});

socket.on('node_removed', ({ nodeId }) => {
    if (nodeId !== S.selected) return;
    toast(`Node ${nodeId} đã bị xoá`);
    const next = S.nodes.find((n) => n.id !== nodeId);
    selectNode(next ? next.id : null);
});

// ---------- Thao tác người dùng ----------
$('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = $('add-msg');
    act('add_node', { nodeId: $('add-id').value.trim(), name: $('add-name').value.trim() }, (r) => {
        msg.textContent = r.ok ? `Đã thêm ${r.node.id}` : r.message;
        msg.className = `text-xs min-h-4 ${r.ok ? 'text-emerald-400' : 'text-rose-400'}`;
        if (r.ok) { $('add-id').value = ''; $('add-name').value = ''; }
    });
});

$('token-input').value = getToken();
$('token-save').addEventListener('click', () => {
    try { localStorage.setItem('adminToken', $('token-input').value); } catch (e) { /* bỏ qua */ }
    socket.disconnect().connect(); // kết nối lại với token mới
});

renderAll();
