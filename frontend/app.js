const DEMO = new URLSearchParams(location.search).has('demo');
const socket = io();
const $ = (id) => document.getElementById(id);

// ================= Cấu hình =================
const LIGHT_DARK_THRESHOLD = 30;   // light < ngưỡng => trời tối (chỉnh theo cảm biến thực tế)
const DEVICES = [
    { key: 'dht',    name: 'DHT20 (nhiệt/ẩm)', match: /dht/i },
    { key: 'light',  name: 'Cảm biến ánh sáng', match: /light|ánh sáng|ldr|bh1750/i },
    { key: 'motion', name: 'Cảm biến vật cản',  match: /motion|vật cản|ir|obstacle|pir/i },
    { key: 'lcd',    name: 'Màn hình LCD',      match: /lcd/i },
    { key: 'led',    name: 'Cụm NeoPixel',      match: /led|neo|pixel/i },
    { key: 'cam',    name: 'Camera',            match: /cam/i },
];

let nodes = {};             // nodeId -> trạng thái live (từ server)
let pending = [];           // node lạ chờ xác nhận
let controlSchema = {};
let selectedNode = null;    // node đang xem (dùng chung cho Tổng quan / Camera / Lịch sử)
let state = null;           // trạng thái của selectedNode
let links = [];             // liên kết mạng [from, to]
let autoDirect = false;
let camMode = 'latest';     // 'latest' | 'stream'
let lastRouting = null;

// ================= Biểu đồ =================
const envChart = new Chart($('envChart'), {
    type: 'line',
    data: { labels: [], datasets: [
        { label: 'Nhiệt độ (°C)', data: [], borderColor: '#b8322a', borderWidth: 1.5, pointRadius: 0, tension: 0.2, yAxisID: 'y' },
        { label: 'Độ ẩm (%)',     data: [], borderColor: '#1f5f8b', borderWidth: 1.5, pointRadius: 0, tension: 0.2, yAxisID: 'y' },
        { label: 'Ánh sáng',      data: [], borderColor: '#b7791f', borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [4, 3], yAxisID: 'y1' },
    ]},
    options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { align: 'end', labels: { color: '#75736d', boxWidth: 12, boxHeight: 2, font: { family: 'IBM Plex Sans', size: 11 } } } },
        scales: {
            x:  { ticks: { color: '#75736d', maxTicksLimit: 8, font: { family: 'IBM Plex Mono', size: 10 } }, grid: { display: false } },
            y:  { ticks: { color: '#75736d', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#eeece7' }, border: { display: false } },
            y1: { position: 'right', ticks: { color: '#75736d', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { display: false }, border: { display: false } },
        },
    },
});

function pushChart(label, d) {
    const ds = envChart.data.datasets;
    envChart.data.labels.push(label);
    ds[0].data.push(d.temp); ds[1].data.push(d.humi); ds[2].data.push(d.light);
    if (envChart.data.labels.length > 30) {
        envChart.data.labels.shift(); ds.forEach((x) => x.data.shift());
    }
    envChart.update();
}
function clearHistoryView() {
    envChart.data.labels = [];
    envChart.data.datasets.forEach((x) => { x.data = []; });
    envChart.update();
    $('history-body').innerHTML = '';
}

// ================= Lịch sử =================
function addHistoryRow(r, prepend = true) {
    const tr = document.createElement('tr');
    const err = r.error && r.error !== 'OK';
    tr.innerHTML = `<td>${esc(r.time)}</td><td>${esc(r.temp)}</td><td>${esc(r.humi)}</td><td>${esc(r.light)}</td>
        <td>${esc(r.bat)}</td><td>${r.motion ? 'có' : '–'}</td>
        <td class="${err ? 'err' : ''}">${err ? esc(r.error) : '–'}</td>`;
    const body = $('history-body');
    prepend ? body.prepend(tr) : body.append(tr);
    while (body.children.length > 50) body.lastChild.remove();
}

// ================= Tiện ích =================
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (t) => {
    if (!t) return 'chưa có dữ liệu';
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? `${s}s trước` : s < 3600 ? `${Math.round(s / 60)} phút trước` : new Date(t).toLocaleString('vi-VN');
};
const nodeLabel = (n) => (n.name && n.name !== n.id ? `${n.name} · ${n.id}` : n.id);

function logEvent(msg, level = '') {
    const li = document.createElement('li');
    li.className = level;
    li.textContent = `${new Date().toLocaleTimeString('vi-VN')}  ${msg}`;
    $('event-log').prepend(li);
    while ($('event-log').children.length > 100) $('event-log').lastChild.remove();
}

// ================= Render trạng thái =================
function deviceStatus(n) {
    // Ưu tiên object n.devices {dht:true,...} nếu firmware gửi; nếu không thì suy từ chuỗi error
    const errText = (n.error && n.error !== 'OK') ? String(n.error) : '';
    return DEVICES.map((d) => {
        let ok = true;
        if (n.devices && d.key in n.devices) ok = !!n.devices[d.key];
        else if (errText && d.match.test(errText)) ok = false;
        return { ...d, ok };
    });
}

function render(n) {
    if (!n) return;
    const online = n.online;
    $('val-temp').innerText = `${n.temp}°C`;
    $('val-humi').innerText = `${n.humi}%`;
    $('val-light').innerText = n.light;
    const dark = n.light < LIGHT_DARK_THRESHOLD;
    $('val-daynight').innerText = dark ? 'Trời tối' : 'Trời sáng';
    $('val-motion').innerText = n.motion ? 'Có người' : 'Trống';

    const bat = Math.max(0, Math.min(100, Number(n.bat) || 0));
    $('val-bat').innerText = `${bat}%`;
    $('bat-bar').style.width = bat + '%';
    $('bat-bar').style.background = bat < 20 ? 'var(--err)' : bat < 50 ? 'var(--warn)' : 'var(--ok)';

    // NeoPixel: firmware cũ gửi 0..4 đèn, firmware mới gửi 0..100%
    const raw = Math.max(0, Number(n.ledLevel) || 0);
    const pct = raw > 4 ? Math.min(100, raw) : null;
    const lvl = pct === null ? Math.min(4, raw) : Math.ceil(pct / 25);
    $('val-led').innerText = pct === null ? `${lvl}/4` : `${lvl}/4 · ${pct}%`;
    for (let i = 1; i <= 4; i++) $('px-' + i).classList.toggle('on', i <= lvl);
    $('led-reason').innerText = lvl === 0
        ? 'Tắt — trời sáng / tiết kiệm pin'
        : `${n.mode && n.mode !== 'AUTO' && n.mode !== 'NORMAL' ? `Chế độ ${n.mode}` : `${dark ? 'Trời tối' : 'Trời sáng'}${n.motion ? ', có người' : ', không có người'}`} → ${lvl} đèn`;

    // Mode + LED xanh/đỏ
    const debug = n.mode === 'DEBUG';
    $('mode-badge').innerText = n.mode || '--';
    $('led-green').classList.toggle('ok', !debug);
    $('led-red').classList.toggle('err', debug);
    $('debug-banner').classList.toggle('hidden', !debug);

    // Thiết bị
    const devs = deviceStatus(n);
    $('device-list').innerHTML = devs.map((d) => `
        <li><span>${d.name}</span>
            ${debug ? `<button class="sm" onclick="sendCmd('test_device','${d.key}')">Test</button>`
                    : `<span class="st ${!online ? '' : d.ok ? 'ok' : 'err'}">${online ? (d.ok ? 'OK' : 'LỖI') : '--'}</span>`}
        </li>`).join('');
    $('val-error').innerText = n.error || 'OK';
    $('val-error').style.color = (n.error && n.error !== 'OK') ? 'var(--err)' : '';

    // LCD 16x2
    const bad = devs.filter((d) => !d.ok).map((d) => d.key.toUpperCase());
    const l1 = `T:${Number(n.temp).toFixed(1)}C H:${Math.round(n.humi)}%`;
    const l2 = bad.length ? `ERR:${bad.join(',')}` : `L:${n.light} BAT:${bat}%`;
    $('lcd').innerText = (debug ? 'DEBUG ' : '') + l1.slice(0, 16) + '\n' + l2.slice(0, 16);

    const nErr = online ? devs.filter((d) => !d.ok).length : 0;
    $('err-count').innerText = nErr;
    $('err-count').classList.toggle('hidden', nErr === 0);
    renderCamRisk(n);
    $('last-update').innerText = n.lastSeen ? new Date(n.lastSeen).toLocaleTimeString('vi-VN') : '--';
    $('node-online').innerHTML = `<span class="dot ${online ? 'ok' : ''}"></span>${online ? 'online' : 'offline'} · ${ago(n.lastSeen)}`;
}

// Đánh giá nguy cơ camera lỗi dựa trên môi trường (lý do dùng DHT20)
function renderCamRisk(n) {
    const risks = [];
    if (n.temp >= 45) risks.push(`Nhiệt độ cao (${n.temp}°C) – ESP32-CAM dễ quá nhiệt, treo/reset`);
    else if (n.temp >= 38) risks.push(`Nhiệt độ khá cao (${n.temp}°C) – theo dõi camera`);
    if (n.humi >= 90) risks.push(`Độ ẩm rất cao (${n.humi}%) – nguy cơ đọng sương ống kính, chập mạch`);
    else if (n.humi >= 80) risks.push(`Độ ẩm cao (${n.humi}%) – ảnh có thể mờ`);
    if (n.bat > 0 && n.bat < 20) risks.push(`Pin yếu (${n.bat}%) – nên tắt phát liên tục`);
    const level = risks.length === 0 ? 0 : risks.some((r) => /cao \(|rất|yếu/.test(r) && !/khá/.test(r)) ? 2 : 1;
    const title = ['Môi trường an toàn cho camera', 'Camera cần theo dõi', 'Nguy cơ camera lỗi'][level];
    $('cam-risk').innerHTML = `<div class="row"><b style="font-weight:500">${title}</b><span class="dot ${['ok', 'warn', 'err'][level]}"></span></div>` +
        (risks.length ? `<ul>${risks.map((r) => `<li>${r}</li>`).join('')}</ul>` : '');
}

// ================= Danh sách Node =================
const nodeList = () => Object.values(nodes);

function renderNodeSelect() {
    const list = nodeList();
    $('node-select').innerHTML = list.length
        ? list.map((n) => `<option value="${esc(n.id)}" ${n.id === selectedNode ? 'selected' : ''}>${n.online ? '● ' : '○ '}${esc(nodeLabel(n))}</option>`).join('')
        : '<option value="">(chưa có node)</option>';
}

function renderNodeList() {
    const q = $('cam-search').value.trim().toLowerCase();
    const all = nodeList();
    const items = all.filter((n) => !q || n.id.toLowerCase().includes(q) || (n.name || '').toLowerCase().includes(q));
    $('cam-count').innerText = all.length;
    $('cam-list').innerHTML = items.length
        ? items.map((n) => `<li data-node="${esc(n.id)}" class="${n.id === selectedNode ? 'active' : ''}" title="${esc(ago(n.lastSeen))}">
              <span class="dot ${n.online ? 'ok' : ''}"></span>
              <span class="nm">${esc(n.name || n.id)}</span>${n.name && n.name !== n.id ? `<span class="id">${esc(n.id)}</span>` : ''}</li>`).join('')
        : `<li class="empty">${all.length ? 'Không có kết quả' : 'Chưa có Node nào. Xác nhận Node mới hoặc dùng Add Camera.'}</li>`;
    $('cam-list').querySelectorAll('li[data-node]').forEach((li) => li.onclick = () => selectNode(li.dataset.node));
}

// Node mới gửi về phải được xác nhận trên web mới được thêm vào danh sách
function renderPending() {
    $('cam-pending').classList.toggle('hidden', pending.length === 0);
    $('cam-pending-list').innerHTML = pending.map((p) => `<li>
        <span class="nm mono" title="Lần đầu: ${esc(new Date(p.seenAt || p.firstSeen || Date.now()).toLocaleString('vi-VN'))} · ${esc(p.source || '')}">${esc(p.id)}</span>
        <button class="sm" data-ok="${esc(p.id)}">Xác nhận</button>
        <button class="sm" data-no="${esc(p.id)}">Bỏ</button></li>`).join('');
    $('cam-pending-list').querySelectorAll('[data-ok]').forEach((b) => b.onclick = () => {
        const name = prompt(`Tên hiển thị cho ${b.dataset.ok} (để trống = dùng NodeID):`, '');
        if (name === null) return;
        request('approve_node', { nodeId: b.dataset.ok, name }, () => {
            logEvent(`Đã xác nhận node ${b.dataset.ok}`, 'ok');
            if (!selectedNode) selectNode(b.dataset.ok);
        });
    });
    $('cam-pending-list').querySelectorAll('[data-no]').forEach((b) => b.onclick = () => request('reject_node', { nodeId: b.dataset.no }));
    const tabBtn = document.querySelector('#tabbar button[data-go="camera"]');
    tabBtn.innerHTML = 'Camera' + (pending.length ? `<span class="count">${pending.length}</span>` : '');
}

function request(event, payload, onOk) {
    socket.emit(event, payload, (res) => {
        if (!res || !res.ok) return alert((res && res.error) || 'Lỗi không xác định');
        if (onOk) onOk(res);
    });
}

function refreshNodesUI() {
    if (selectedNode && !nodes[selectedNode]) selectedNode = null;
    if (!selectedNode && nodeList().length) {
        let saved = null; try { saved = localStorage.getItem('vs-node'); } catch (e) {}
        selectNode(nodes[saved] ? saved : nodeList()[0].id);
        return;
    }
    state = selectedNode ? nodes[selectedNode] : null;
    renderNodeSelect();
    renderNodeList();
    render(state);
    renderCamLabel();
}

/** Chọn node để xem: đổi Tổng quan, Lịch sử, Camera sang node đó. */
function selectNode(id) {
    if (!id || !nodes[id]) return;
    if (selectedNode && selectedNode !== id) socket.emit('leave_camera', selectedNode);
    selectedNode = id;
    state = nodes[id];
    try { localStorage.setItem('vs-node', id); } catch (e) {}
    socket.emit('join_camera', id);

    renderNodeSelect();
    renderNodeList();
    render(state);
    renderCamLabel();
    showLatestImage();
    loadGallery();

    clearHistoryView();
    socket.emit('select_node', id, (res) => {
        if (!res || !res.ok || res.nodeId !== selectedNode) return;
        (res.history || []).forEach((r) => { addHistoryRow(r); pushChart(r.time, r); });
        renderRouting(res.routing);
    });
}
$('node-select').onchange = (e) => selectNode(e.target.value);

// ================= Camera =================
function renderCamLabel() {
    const n = selectedNode && nodes[selectedNode];
    $('cam-label').innerText = n ? nodeLabel(n) : '--';
    $('cam-remove').disabled = !n;
    $('cam-rec').className = 'rec' + (n && n.online && n.lastSeen && Date.now() - n.lastSeen < 15000 ? ' on' : '');
}

function showImage(src) {
    $('cam-view').src = src;
    $('cam-view').classList.remove('hidden');
    $('cam-placeholder').classList.add('hidden');
}
function setCamMode(mode) {
    camMode = mode;
    $('cam-mode-latest').classList.toggle('active-btn', mode === 'latest');
    $('cam-mode-stream').classList.toggle('active-btn', mode === 'stream');
    showLatestImage();
}
function showLatestImage() {
    if (selectedNode && camMode === 'stream') {
        return showImage(`/api/camera/${encodeURIComponent(selectedNode)}/stream?t=${Date.now()}`);
    }
    $('cam-view').classList.add('hidden');
    $('cam-placeholder').classList.remove('hidden');
    $('cam-placeholder').innerText = selectedNode ? `Đang chờ ảnh từ ${selectedNode}…` : 'Chọn một Node trong danh sách';
    if (!selectedNode) return;
    const id = selectedNode;
    const img = new Image();
    img.onload = () => { if (id === selectedNode) showImage(img.src); };
    img.src = `/api/camera/${encodeURIComponent(id)}/latest?t=${Date.now()}`;
}

function loadGallery() {
    const id = selectedNode;
    $('cam-gallery').innerHTML = '';
    if (!id) return;
    fetch(`/api/camera/${encodeURIComponent(id)}/history?limit=12`)
        .then((r) => r.json())
        .then((res) => {
            if (id !== selectedNode) return;
            const imgs = (res.items || []).filter((it) => it.mediaType !== 'video');
            $('cam-gallery').innerHTML = imgs.length
                ? imgs.map((it) => `<img src="/api/camera/media/${encodeURIComponent(it.id)}" title="${esc(new Date(it.capturedAt).toLocaleString('vi-VN'))}" loading="lazy">`).join('')
                : '<span class="muted" style="font-size:12px">Chưa có ảnh</span>';
            $('cam-gallery').querySelectorAll('img').forEach((im) => im.onclick = () => showImage(im.src));
        })
        .catch(() => {});
}

socket.on('camera_frame', ({ nodeId, image, ts }) => {
    if (nodeId !== selectedNode || !image || camMode === 'stream') return;
    showImage(image);
    if (nodes[nodeId]) nodes[nodeId].lastSeen = ts;
    renderCamLabel();
    clearTimeout(loadGallery.t);
    loadGallery.t = setTimeout(loadGallery, 3000);
});

function camStatus(text) {
    $('cam-status').innerText = text;
    clearTimeout(camStatus.t);
    camStatus.t = setTimeout(() => $('cam-status').innerText = '', 4000);
}

// ================= Điều khiển (send_control có cmdId + ACK) =================
function control(command, params, okMsg, statusFn = camStatus) {
    if (!selectedNode) return statusFn('Chưa chọn Node.');
    const id = selectedNode;
    socket.emit('send_control', { nodeId: id, command, params }, (res) => {
        if (res && res.ok) {
            statusFn(`${okMsg} → ${id} (đang chờ ACK)`);
            logEvent(`${okMsg} → ${id} [${res.cmdId}]`);
        } else {
            const err = (res && res.error) || 'Lỗi';
            statusFn(`Gửi lệnh thất bại: ${err}`);
            logEvent(`Lệnh ${command} → ${id} thất bại: ${err}`, 'err');
        }
    });
}

const camInterval = () => Math.min(3600, Math.max(1, Math.round(Number($('burst-interval').value) || 10)));
// Firmware: CONTINUOUS = phát liên tục (~2 ảnh/giây), PERIODIC = chụp theo intervalSec, OFF = tắt
function setCameraPower(on) {
    control('set_camera', { cameraMode: on ? 'CONTINUOUS' : 'OFF', intervalSec: camInterval() }, on ? 'Bật camera' : 'Tắt camera');
}
function startBurst() {
    control('set_camera', { cameraMode: 'PERIODIC', intervalSec: camInterval() }, `Chụp liên tục mỗi ${camInterval()}s`);
}
function captureNow() { control('capture', {}, 'Chụp 1 ảnh'); }

function renameSelectedCam() {
    if (!selectedNode) return camStatus('Chưa chọn Node.');
    const name = $('cam-rename').value.trim();
    if (!name) return camStatus('Nhập tên mới trước.');
    request('rename_node', { nodeId: selectedNode, name }, () => { $('cam-rename').value = ''; camStatus('Đã đổi tên'); });
}

$('cam-search').addEventListener('input', renderNodeList);
$('cam-remove').onclick = () => {
    const id = selectedNode;
    if (!id || !confirm(`Xoá ${id} khỏi danh sách? Node sẽ phải xác nhận lại nếu gửi dữ liệu tiếp.`)) return;
    request('remove_node', { nodeId: id }, () => logEvent(`Đã xoá node ${id}`, 'warn'));
};
$('cam-add-form').onsubmit = (e) => {
    e.preventDefault();
    const nodeId = $('cam-add-id').value.trim(), name = $('cam-add-name').value.trim();
    request('add_node', { nodeId, name }, () => {
        $('cam-add-id').value = ''; $('cam-add-name').value = '';
        $('cam-add-msg').innerText = `Đã thêm ${nodeId}`;
        setTimeout(() => $('cam-add-msg').innerText = '', 3000);
        logEvent(`Đã thêm node ${nodeId}`, 'ok');
        selectNode(nodeId);
    });
};
setInterval(() => $('cam-time').innerText = new Date().toLocaleTimeString('vi-VN'), 1000);
setInterval(() => { renderNodeList(); renderCamLabel(); }, 10000);   // cập nhật chấm online

// ================= Độ sáng đèn & chế độ =================
function ledStatus(text) {
    $('led-status').innerText = text;
    clearTimeout(ledStatus.t);
    ledStatus.t = setTimeout(() => $('led-status').innerText = '', 4000);
}
function setLightMode(mode) { control('set_mode', { mode }, `Chế độ đèn ${mode}`, ledStatus); }

// Firmware chỉ dùng mức sáng tay ở chế độ MANUAL -> gửi MANUAL trước rồi đặt mức sáng
function applyLedBrightness(value) {
    const v = value === undefined ? Number($('led-slider').value) : value;
    $('led-slider').value = v;
    $('led-slider-val').innerText = v + '%';
    setLightMode('MANUAL');
    setTimeout(() => control('set_led', { ledLevel: v }, v === 0 ? 'Tắt đèn' : `Đặt đèn ${v}%`, ledStatus), 900);
}
$('led-slider').addEventListener('input', () => $('led-slider-val').innerText = $('led-slider').value + '%');

// Lệnh nâng cao sinh tự động từ CONTROL_SCHEMA của server
const QUICK = new Set(['set_mode', 'set_led', 'set_camera', 'capture']);
function renderControlForms() {
    const wrap = $('control-forms');
    wrap.innerHTML = '';
    for (const [cmd, def] of Object.entries(controlSchema)) {
        if (QUICK.has(cmd)) continue;
        const form = document.createElement('form');
        form.className = 'ctl-form';
        form.innerHTML = `<b>${esc(def.label)}</b>` + Object.entries(def.params).map(([key, spec]) => {
            const input = spec.type === 'select'
                ? `<select data-p="${key}" class="cam-input">${spec.options.map((o) => `<option ${o === spec.default ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
                : `<input data-p="${key}" class="cam-input" type="${spec.type === 'number' ? 'number' : 'text'}" value="${esc(spec.default)}"
                     ${spec.min !== undefined ? `min="${spec.min}" max="${spec.max}"` : ''}>`;
            return `<label>${esc(spec.label)}<br>${input}</label>`;
        }).join('') + '<button class="sm" type="submit">Gửi</button>';
        form.onsubmit = (e) => {
            e.preventDefault();
            const params = {};
            form.querySelectorAll('[data-p]').forEach((el) => { params[el.dataset.p] = el.type === 'number' ? Number(el.value) : el.value; });
            control(cmd, params, def.label, (t) => logEvent(t));
        };
        wrap.appendChild(form);
    }
}

// Lệnh kiểu cũ (toggle_mode, test_device) cho firmware cũ, kèm nodeId đang chọn
function sendCmd(command, value) {
    socket.emit('cmd_hardware', { command, value, nodeId: selectedNode });
}

// ================= Socket =================
socket.on('connect', () => { setConn(true); if (selectedNode) socket.emit('join_camera', selectedNode); });
socket.on('disconnect', () => setConn(false));
function setConn(ok) {
    if (DEMO) return;
    $('conn-badge').innerHTML = `<span class="dot ${ok ? 'ok' : 'err'}"></span>${ok ? 'Đã kết nối' : 'Mất kết nối'}`;
}

socket.on('init_state', (data) => {
    if (DEMO) return;
    nodes = data.networkState || {};
    pending = data.pendingNodes || [];
    controlSchema = data.controlSchema || {};
    links = data.links || [];
    autoDirect = !!data.autoDirectToGateway;
    renderAuth(data.authRequired, data.authorized);
    renderControlForms();
    renderPending();
    renderLinksEditor();
    (data.controlLogs || []).slice(0, 10).reverse()
        .forEach((l) => logEvent(`${l.command} → ${l.nodeId} [${l.cmdId}] ${l.status}`, l.status === 'ACKED' ? 'ok' : l.status === 'SENT' ? '' : 'warn'));
    const prev = selectedNode;
    selectedNode = null;
    if (prev && nodes[prev]) selectNode(prev); else refreshNodesUI();
});

socket.on('network_update', (all) => {
    if (DEMO) return;
    nodes = all;
    refreshNodesUI();
    if (activeTab === 'routing') refreshRouting();
});

socket.on('pending_nodes', (list) => {
    const isNew = list.some((p) => !pending.some((q) => q.id === p.id));
    pending = list;
    renderPending();
    if (isNew) logEvent(`Có node mới chờ xác nhận (${list.length}) — xem tab Camera`, 'warn');
});

// Repo gửi sensor_update = trạng thái node vừa cập nhật (đã ghi InfluxDB)
socket.on('sensor_update', (node) => {
    if (DEMO || !node || !node.id) return;
    nodes[node.id] = node;
    if (node.id !== selectedNode) return;
    state = node;
    render(state);
    const rec = { ...node, time: new Date(node.lastSeen || Date.now()).toLocaleTimeString('vi-VN') };
    addHistoryRow(rec); pushChart(rec.time, rec);
    refreshRouting();
});

socket.on('links_updated', (l) => { links = l || []; renderLinksEditor(); refreshRouting(); });

socket.on('control_ack', ({ cmdId, nodeId, status }) => {
    const text = { ACKED: 'node đã thực hiện', FAILED: 'node báo lỗi', TIMEOUT_QUEUED: 'không có phản hồi (node có thể đang ngủ, sẽ gửi bù khi online)' }[status] || status;
    logEvent(`[${cmdId}] ${nodeId}: ${text}`, status === 'ACKED' ? 'ok' : status === 'FAILED' ? 'err' : 'warn');
});

socket.on('system_alert', (a) => logEvent(`⚠ ${a.nodeId}: ${a.message}`, 'err'));

// ================= Quyền quản trị (ADMIN_TOKEN) =================
function renderAuth(required, authorized) {
    $('auth-box').classList.toggle('hidden', !required || authorized);
    $('auth-badge').innerText = !required ? '' : authorized ? 'Quản trị ✓' : 'Chỉ xem';
}
function authenticate() {
    const token = $('admin-token').value.trim();
    socket.emit('auth', token, (res) => {
        if (res && res.ok) {
            try { sessionStorage.setItem('vs-token', token); } catch (e) {}
            renderAuth(true, true);
            logEvent('Đăng nhập quản trị thành công', 'ok');
        } else {
            renderAuth(true, false);
            logEvent(`Đăng nhập thất bại: ${(res && res.error) || 'Sai token'}`, 'err');
        }
    });
}
// Tự đăng nhập lại sau khi mất kết nối (token giữ trong phiên trình duyệt)
socket.on('connect', () => {
    let token = null; try { token = sessionStorage.getItem('vs-token'); } catch (e) {}
    if (token) socket.emit('auth', token, (res) => { if (res && res.ok) renderAuth(true, true); });
});

// ================= Test gửi ảnh HTTP (thay cho ESP32) =================
async function testHttpUpload() {
    if (!selectedNode) return camStatus('Chưa chọn Node.');
    const cv = document.createElement('canvas');
    cv.width = 480; cv.height = 270;
    const g = cv.getContext('2d');
    g.fillStyle = '#1d1d1b'; g.fillRect(0, 0, 480, 270);
    g.fillStyle = '#e8b923'; g.font = 'bold 20px sans-serif'; g.fillText(`VIEWSTREET TEST · ${selectedNode}`, 24, 60);
    g.fillStyle = '#fff'; g.font = '16px monospace'; g.fillText(new Date().toLocaleString('vi-VN'), 24, 110);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.85));
    try {
        const res = await fetch(`/api/camera/upload?nodeId=${encodeURIComponent(selectedNode)}&type=image`, {
            method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob,
        });
        const json = await res.json();
        if (json.ok) {
            camStatus(`Đã gửi ảnh test (${json.sizeBytes} B)`);
            logEvent(`Ảnh test → ${selectedNode} lưu PostgreSQL #${json.id}${json.routing ? ` · tuyến ${json.routing.optimalRoute}` : ''}`, 'ok');
            loadGallery();
        } else {
            camStatus(`Lỗi: ${json.error}`);
        }
    } catch (e) {
        camStatus(`Lỗi gửi ảnh: ${e.message}`);
    }
}

// ================= Định tuyến =================
function refreshRouting() {
    if (!selectedNode) return;
    clearTimeout(refreshRouting.t);
    refreshRouting.t = setTimeout(() => socket.emit('select_node', selectedNode, (res) => {
        if (res && res.ok && res.nodeId === selectedNode) renderRouting(res.routing);
    }), 300);
}

const svgEl = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
};
function nodeColor(n) {
    if (!n || !n.online) return '#c9c6be';
    if ((n.bat > 0 && n.bat < 20) || n.load >= 80) return '#b8322a';
    if (n.load >= 50) return '#b7791f';
    return '#2f7d4f';
}

function renderRouting(routing) {
    lastRouting = routing || lastRouting;
    const r = lastRouting;
    const svg = $('topology');
    svg.innerHTML = '';
    $('route-source').innerText = selectedNode || '--';
    if (!r) return;
    $('route-optimal').innerText = `Tuyến tối ưu: ${r.optimalRoute}${Number.isFinite(r.totalCost) ? ` (cost ${r.totalCost})` : ''}`;

    // Bố cục: nguồn bên trái, gateway bên phải, các node khác xếp theo cột ở giữa
    const allLinks = r.links || links;
    const ids = new Set([selectedNode, 'gateway']);
    allLinks.forEach(([a, b]) => { ids.add(a); ids.add(b); });
    const middle = [...ids].filter((id) => id !== selectedNode && id !== 'gateway');
    const pos = { [selectedNode]: { x: 70, y: 150 }, gateway: { x: 590, y: 150 } };
    const cols = Math.max(1, Math.ceil(middle.length / 4));
    middle.forEach((id, i) => {
        const col = Math.floor(i / 4), row = i % 4, inCol = Math.min(4, middle.length - col * 4);
        pos[id] = { x: 200 + (cols === 1 ? 130 : col * (260 / (cols - 1))), y: 150 + (row - (inCol - 1) / 2) * 62 };
    });
    const path = r.optimalPath || [];
    const onPath = (a, b) => path.some((id, i) => id === a && path[i + 1] === b);

    svg.appendChild(svgEl('defs', {})).innerHTML =
        '<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#9b988f"/></marker>' +
        '<marker id="arr-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#2f7d4f"/></marker>';
    for (const [a, b] of allLinks) {
        if (!pos[a] || !pos[b]) continue;
        const best = onPath(a, b);
        const dx = pos[b].x - pos[a].x, dy = pos[b].y - pos[a].y, len = Math.hypot(dx, dy) || 1;
        svg.appendChild(svgEl('line', {
            x1: pos[a].x + dx / len * 22, y1: pos[a].y + dy / len * 22,
            x2: pos[b].x - dx / len * 24, y2: pos[b].y - dy / len * 24,
            stroke: best ? '#2f7d4f' : '#c9c6be', 'stroke-width': best ? 3 : 1.2,
            'marker-end': best ? 'url(#arr-ok)' : 'url(#arr)',
        }));
    }
    for (const [id, p] of Object.entries(pos)) {
        const n = nodes[id];
        const isGw = id === 'gateway';
        svg.appendChild(svgEl('circle', {
            cx: p.x, cy: p.y, r: 20, fill: isGw ? '#1d1d1b' : nodeColor(n),
            stroke: id === selectedNode ? '#1f5f8b' : '#fff', 'stroke-width': id === selectedNode ? 3 : 2,
        }));
        const label = svgEl('text', { x: p.x, y: p.y + 36, 'text-anchor': 'middle', 'font-size': 11, 'font-family': 'IBM Plex Mono, monospace', fill: '#1d1d1b' });
        label.textContent = isGw ? 'GATEWAY' : id;
        svg.appendChild(label);
        if (n && !isGw) {
            const sub = svgEl('text', { x: p.x, y: p.y + 49, 'text-anchor': 'middle', 'font-size': 9.5, 'font-family': 'IBM Plex Mono, monospace', fill: '#75736d' });
            sub.textContent = n.online ? `pin ${n.bat}% · tải ${n.load}%` : 'offline';
            svg.appendChild(sub);
        }
    }

    $('route-alts').innerHTML = (r.alternatives || []).length
        ? r.alternatives.map((a, i) => `<li><span class="mono">${esc(a.path.join(' → '))}</span><span class="st ${i === 0 ? 'ok' : ''}">${a.cost}</span></li>`).join('')
        : '<li class="muted">Không có tuyến khả dụng</li>';
    const relays = ['node_1', 'node_2', 'node_3'].map((id) => nodes[id]).filter(Boolean);
    $('relay-list').innerHTML = relays.map((n) => `<li><span><span class="dot ${n.online ? 'ok' : ''}"></span>${esc(nodeLabel(n))}</span>
        <span class="mono">${n.online ? `RSSI ${n.rssi} · pin ${n.bat}% · tải ${n.load}%` : 'offline'}</span></li>`).join('');
}

function renderLinksEditor() {
    $('links-edit').value = links.map(([a, b]) => `${a} -> ${b}`).join('\n');
    $('auto-direct').checked = autoDirect;
}
function saveLinks() {
    const parsed = $('links-edit').value.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => l.split(/\s*(?:->|→|,)\s*/));
    if (parsed.some((p) => p.length !== 2 || !p[0] || !p[1])) {
        $('links-msg').innerText = 'Mỗi dòng dạng: node_a -> node_b';
        return;
    }
    request('update_links', { links: parsed }, (res) => {
        links = res.links || parsed;
        $('links-msg').innerText = 'Đã lưu';
        setTimeout(() => $('links-msg').innerText = '', 3000);
        refreshRouting();
    });
}
$('auto-direct').onchange = (e) => request('set_auto_direct', { enabled: e.target.checked }, (res) => {
    autoDirect = !!res.autoDirectToGateway;
    refreshRouting();
});

// ===== Chế độ DEMO (chưa có mạch): mở http://localhost:3000/?demo=1 =====
if (DEMO) {
    const fake = { id: 'demo_node', name: 'Node demo', temp: 31, humi: 65, light: 70, bat: 95, motion: 0, mode: 'AUTO', ledLevel: 0, error: 'OK', online: true };
    let tick = 0;
    nodes = { demo_node: fake };
    selectedNode = 'demo_node';
    setInterval(() => {
        tick++;
        fake.temp = +(31 + 8 * Math.sin(tick / 15) + Math.random()).toFixed(1);
        fake.humi = Math.round(70 + 20 * Math.sin(tick / 20));
        fake.light = Math.max(0, Math.round(50 + 50 * Math.sin(tick / 12)));
        fake.motion = Math.random() < 0.3 ? 1 : 0;
        fake.bat = Math.max(5, +(fake.bat - 0.2).toFixed(1));
        const dark = fake.light < LIGHT_DARK_THRESHOLD;
        fake.ledLevel = !dark ? 0 : fake.motion ? 100 : fake.light < 10 ? 50 : 25;
        fake.error = tick % 25 < 4 ? 'CAM timeout' : 'OK';
        fake.lastSeen = Date.now();
        state = fake;
        renderNodeSelect(); renderNodeList(); render(state);
        const rec = { ...fake, time: new Date().toLocaleTimeString('vi-VN') };
        addHistoryRow(rec); pushChart(rec.time, rec);
    }, 2000);
    $('conn-badge').innerHTML = '<span class="dot warn"></span>Dữ liệu demo';
}

// ================= Tab trang =================
let activeTab = 'overview';
function openTab(name) {
    activeTab = name;
    $('tab-grid').dataset.active = name;
    document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.go === name));
    try { localStorage.setItem('vs-tab', name); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search + '#' + name);
    if (name === 'routing') refreshRouting();
}
document.querySelectorAll('#tabbar button').forEach((b) => b.onclick = () => openTab(b.dataset.go));

{
    let saved = location.hash.slice(1);
    if (!saved) { try { saved = localStorage.getItem('vs-tab'); } catch (e) {} }
    openTab(['overview', 'camera', 'history', 'routing'].includes(saved) ? saved : 'overview');
}
