const socket = io();

let networkState = {};
let pendingNodes = [];
let controlSchema = {};
let selectedNodeId = 'node_1';
let cameraStreamMode = 'latest'; // 'latest' | 'stream'
let sensorChart = null;

function logEvent(msg, level = 'info') {
    const box = document.getElementById('eventLog');
    const line = document.createElement('div');
    const color =
        level === 'alert' ? 'text-rose-400' :
        level === 'ok' ? 'text-emerald-400' :
        level === 'warn' ? 'text-amber-300' : 'text-slate-300';
    line.className = color;
    line.textContent = `[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`;
    box.prepend(line);
}

// Xác thực token
document.getElementById('btnAuth').addEventListener('click', () => {
    const token = document.getElementById('adminTokenInput').value.trim();
    socket.emit('auth', token, (res) => {
        if (res && res.ok) logEvent('Xác thực quyền quản trị thành công.', 'ok');
        else logEvent(`Lỗi xác thực: ${(res && res.error) || 'Sai token'}`, 'alert');
    });
});

// Thêm node mới
document.getElementById('addNodeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const nodeId = document.getElementById('newNodeId').value.trim();
    const name = document.getElementById('newNodeName').value.trim();
    if (!nodeId) return;

    socket.emit('add_node', { nodeId, name }, (res) => {
        if (res && res.ok) {
            logEvent(`Đã thêm node '${nodeId}' vào PostgreSQL.`, 'ok');
            document.getElementById('newNodeId').value = '';
            document.getElementById('newNodeName').value = '';
            selectNode(nodeId);
        } else {
            logEvent(`Thêm node thất bại: ${(res && res.error) || 'Lỗi'}`, 'alert');
        }
    });
});

function renderNodeList() {
    const container = document.getElementById('nodeList');
    container.innerHTML = '';
    const ids = Object.keys(networkState);
    if (ids.length === 0) {
        container.innerHTML = '<div class="text-xs text-slate-500">Chưa có node nào</div>';
        return;
    }
    if (!networkState[selectedNodeId]) selectedNodeId = ids[0];

    for (const id of ids) {
        const n = networkState[id];
        const isSelected = id === selectedNodeId;
        const btn = document.createElement('button');
        btn.className = `w-full text-left p-2.5 rounded-lg border transition flex items-center justify-between ${
            isSelected
                ? 'bg-indigo-600/20 border-indigo-500 text-white'
                : 'bg-slate-800/60 border-slate-800 text-slate-300 hover:bg-slate-800'
        }`;
        btn.innerHTML = `
            <div>
                <div class="text-xs font-semibold flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full ${n.online ? 'bg-emerald-400' : 'bg-rose-500'}"></span>
                    <span>${n.name}</span>
                </div>
                <div class="text-[11px] text-slate-400 font-mono mt-0.5">${id} • Pin ${n.bat}% • Tải ${n.load}%</div>
            </div>
        `;
        btn.onclick = () => selectNode(id);
        container.appendChild(btn);
    }
}

function renderPendingList() {
    const container = document.getElementById('pendingList');
    if (!pendingNodes || pendingNodes.length === 0) {
        container.innerHTML = 'Chưa có thiết bị lạ';
        return;
    }
    container.innerHTML = '';
    for (const item of pendingNodes) {
        const div = document.createElement('div');
        div.className = 'p-2 rounded bg-slate-800 flex items-center justify-between';
        div.innerHTML = `
            <span class="font-mono text-amber-200">${item.id}</span>
            <button class="bg-emerald-600 hover:bg-emerald-500 text-white px-2 py-0.5 rounded text-[11px]">Duyệt</button>
        `;
        div.querySelector('button').onclick = () => {
            socket.emit('approve_node', { nodeId: item.id }, (res) => {
                if (res && res.ok) logEvent(`Đã duyệt node '${item.id}'.`, 'ok');
            });
        };
        container.appendChild(div);
    }
}

function renderSelectedDetails() {
    const n = networkState[selectedNodeId];
    if (!n) return;

    document.getElementById('selectedNodeTitle').textContent = `${n.name} (${n.id})`;
    const badge = document.getElementById('selectedNodeBadge');
    badge.textContent = n.online ? 'ONLINE' : 'OFFLINE';
    badge.className = `text-xs px-2 py-0.5 rounded font-semibold ${
        n.online ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
    }`;

    document.getElementById('valTemp').textContent = `${n.temp ?? 0} °C`;
    document.getElementById('valHumi').textContent = `${n.humi ?? 0} %`;
    document.getElementById('valLight').textContent = `${n.light ?? 0} Lux`;
    document.getElementById('valMotion').textContent = n.motion ? 'CÓ NGƯỜI/XE' : 'Không';
    document.getElementById('valWeather').textContent = `${n.rain ? 'Có mưa' : 'Khô ráo'} • Bụi ${n.dust ?? 0}`;
    document.getElementById('valBat').textContent = `${n.bat ?? 0} %`;
    document.getElementById('valNet').textContent = `${n.rssi ?? -50} dBm / ${n.load ?? 0}%`;
    document.getElementById('valPackets').textContent = n.packetCount || 0;
    document.getElementById('valError').textContent = n.error || 'OK';
}

function updateCameraDisplay(mediaCount = null) {
    const img = document.getElementById('cameraPreview');
    const placeholder = document.getElementById('cameraPlaceholder');

    if (mediaCount !== null) {
        document.getElementById('cameraMeta').textContent = `PostgreSQL Media (${selectedNodeId}): ${mediaCount} bản ghi`;
    }

    if (cameraStreamMode === 'stream') {
        img.src = `/api/camera/${encodeURIComponent(selectedNodeId)}/stream?t=${Date.now()}`;
        img.classList.remove('hidden');
        placeholder.classList.add('hidden');
    } else {
        img.onload = () => {
            img.classList.remove('hidden');
            placeholder.classList.add('hidden');
        };
        img.onerror = () => {
            img.classList.add('hidden');
            placeholder.classList.remove('hidden');
        };
        img.src = `/api/camera/${encodeURIComponent(selectedNodeId)}/latest?t=${Date.now()}`;
    }
}

document.getElementById('btnModeLatest').addEventListener('click', () => {
    cameraStreamMode = 'latest';
    document.getElementById('btnModeLatest').className = 'text-xs px-2 py-1 rounded bg-indigo-600 text-white';
    document.getElementById('btnModeStream').className = 'text-xs px-2 py-1 rounded bg-slate-800 text-slate-300';
    updateCameraDisplay();
});

document.getElementById('btnModeStream').addEventListener('click', () => {
    cameraStreamMode = 'stream';
    document.getElementById('btnModeStream').className = 'text-xs px-2 py-1 rounded bg-indigo-600 text-white';
    document.getElementById('btnModeLatest').className = 'text-xs px-2 py-1 rounded bg-slate-800 text-slate-300';
    updateCameraDisplay();
});

// Nút test gửi ảnh JPEG giả lập qua HTTP POST /api/camera/upload
document.getElementById('btnTestHttpUpload').addEventListener('click', async () => {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 270;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, 480, 270);
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 20px sans-serif';
        ctx.fillText(`VIEWSTREETS HTTP CAMERA - ${selectedNodeId}`, 24, 60);
        ctx.fillStyle = '#a3e635';
        ctx.font = '16px monospace';
        ctx.fillText(`Time: ${new Date().toLocaleString('vi-VN')}`, 24, 110);
        ctx.fillText(`Stored directly in PostgreSQL (BYTEA)`, 24, 150);

        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        const res = await fetch(`/api/camera/upload?nodeId=${encodeURIComponent(selectedNodeId)}&type=image`, {
            method: 'POST',
            headers: { 'Content-Type': 'image/jpeg' },
            body: blob,
        });
        const json = await res.json();
        if (json.ok) {
            logEvent(`HTTP POST ảnh thành công -> PostgreSQL ID #${json.imageId} (${json.sizeBytes} bytes).`, 'ok');
            selectNode(selectedNodeId);
        } else {
            logEvent(`HTTP Upload lỗi: ${json.error}`, 'alert');
        }
    } catch (err) {
        logEvent(`Lỗi gửi HTTP camera: ${err.message}`, 'alert');
    }
});

function renderChart(history) {
    const ctx = document.getElementById('sensorChart').getContext('2d');
    const labels = history.map((h) => h.time);
    const temps = history.map((h) => h.temp);
    const humis = history.map((h) => h.humi);
    const bats = history.map((h) => h.bat);

    if (sensorChart) sensorChart.destroy();
    sensorChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Nhiệt độ (°C)', data: temps, borderColor: '#fb7185', tension: 0.3 },
                { label: 'Độ ẩm (%)', data: humis, borderColor: '#38bdf8', tension: 0.3 },
                { label: 'Pin (%)', data: bats, borderColor: '#a3e635', tension: 0.3 },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { labels: { color: '#cbd5e1', font: { size: 11 } } } },
            scales: {
                x: { ticks: { color: '#94a3b8', maxTicksLimit: 8 } },
                y: { ticks: { color: '#94a3b8' } },
            },
        },
    });
}

function renderTopology(routing) {
    const svg = document.getElementById('topologySvg');
    svg.innerHTML = '';
    if (!routing) return;

    document.getElementById('optimalRouteText').textContent =
        `Tuyến tối ưu: ${routing.optimalRoute} ${Number.isFinite(routing.totalCost) ? `(Cost: ${routing.totalCost})` : ''}`;

    const altBox = document.getElementById('routeAlternatives');
    altBox.innerHTML = (routing.alternatives || []).map((r, idx) =>
        `<div class="p-2 rounded bg-slate-800/80 border ${idx === 0 ? 'border-emerald-500/50 text-emerald-300' : 'border-slate-700'}">
            ${idx === 0 ? '★ ' : ''}${r.path.join(' → ')} <span class="float-right font-mono">Cost: ${r.cost}</span>
        </div>`
    ).join('') || '<div>Không có tuyến khả dụng</div>';

    // Vị trí các node trên SVG
    const ids = Object.keys(networkState);
    const pos = { gateway: { x: 560, y: 110 } };
    pos[selectedNodeId] = { x: 80, y: 110 };

    const others = ids.filter((id) => id !== selectedNodeId);
    others.forEach((id, idx) => {
        const yStep = 180 / (others.length + 1);
        pos[id] = { x: 320, y: 20 + yStep * (idx + 1) };
    });

    const optimalEdges = new Set();
    const optPath = routing.optimalPath || [];
    for (let i = 0; i < optPath.length - 1; i++) {
        optimalEdges.add(`${optPath[i]}->${optPath[i + 1]}`);
    }

    // Vẽ liên kết
    for (const [from, to] of (routing.links || [])) {
        if (!pos[from] || !pos[to]) continue;
        const isOpt = optimalEdges.has(`${from}->${to}`);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', pos[from].x);
        line.setAttribute('y1', pos[from].y);
        line.setAttribute('x2', pos[to].x);
        line.setAttribute('y2', pos[to].y);
        line.setAttribute('stroke', isOpt ? '#10b981' : '#475569');
        line.setAttribute('stroke-width', isOpt ? '3.5' : '1.5');
        if (!isOpt) line.setAttribute('stroke-dasharray', '5,5');
        svg.appendChild(line);
    }

    // Vẽ nút
    for (const [id, p] of Object.entries(pos)) {
        const isGw = id === 'gateway';
        const st = networkState[id];
        const color = isGw ? '#8b5cf6' : (st && st.online ? (id === selectedNodeId ? '#3b82f6' : '#10b981') : '#ef4444');

        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', p.x);
        circle.setAttribute('cy', p.y);
        circle.setAttribute('r', isGw ? '18' : '15');
        circle.setAttribute('fill', color);
        svg.appendChild(circle);

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', p.x);
        label.setAttribute('y', p.y + 30);
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('fill', '#e2e8f0');
        label.setAttribute('font-size', '11');
        label.textContent = isGw ? 'Gateway' : `${id} (${st ? st.bat + '%' : ''})`;
        svg.appendChild(label);
    }
}

function renderControls() {
    const container = document.getElementById('controlFormContainer');
    container.innerHTML = '';
    for (const [cmd, def] of Object.entries(controlSchema)) {
        const card = document.createElement('div');
        card.className = 'p-2.5 rounded-lg bg-slate-800/60 border border-slate-800 flex flex-wrap items-end justify-between gap-2';

        const inputsHtml = Object.entries(def.params).map(([key, spec]) => {
            if (spec.type === 'select') {
                const opts = spec.options.map((o) => `<option value="${o}">${o}</option>`).join('');
                return `<div><label class="block text-[11px] text-slate-400">${spec.label}</label>
                        <select data-param="${key}" class="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs">${opts}</select></div>`;
            }
            return `<div><label class="block text-[11px] text-slate-400">${spec.label}</label>
                    <input data-param="${key}" type="${spec.type}" value="${spec.default}" class="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs w-28" /></div>`;
        }).join('');

        card.innerHTML = `
            <div class="space-y-1">
                <div class="text-xs font-semibold text-slate-200">${def.label}</div>
                <div class="flex flex-wrap gap-2">${inputsHtml}</div>
            </div>
            <button class="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-1.5 rounded">Gửi lệnh</button>
        `;

        card.querySelector('button').onclick = () => {
            const params = {};
            card.querySelectorAll('[data-param]').forEach((el) => {
                params[el.dataset.param] = el.type === 'number' ? Number(el.value) : el.value;
            });
            socket.emit('send_control', { nodeId: selectedNodeId, command: cmd, params }, (res) => {
                if (res && res.ok) logEvent(`Đã gửi lệnh '${cmd}' tới ${selectedNodeId} (ID: ${res.cmdId}).`, 'ok');
                else logEvent(`Gửi lệnh thất bại: ${(res && res.error) || 'Lỗi'}`, 'alert');
            });
        };
        container.appendChild(card);
    }
}

function selectNode(nodeId) {
    if (selectedNodeId) socket.emit('leave_camera', selectedNodeId);
    selectedNodeId = nodeId;
    socket.emit('join_camera', nodeId);

    renderNodeList();
    renderSelectedDetails();
    updateCameraDisplay();

    socket.emit('select_node', nodeId, (res) => {
        if (!res || !res.ok) return;
        renderChart(res.history || []);
        renderTopology(res.routing);
        updateCameraDisplay((res.mediaList || []).length);
    });
}

// Các nút giả lập cân bằng tải nhanh
document.getElementById('btnSimNormal').addEventListener('click', () => {
    socket.emit('simulate_node', { nodeId: 'node_1', online: true, bat: 95, rssi: -45, load: 10 });
    socket.emit('simulate_node', { nodeId: 'node_2', online: true, bat: 90, rssi: -50, load: 15 });
    socket.emit('simulate_node', { nodeId: 'node_3', online: true, bat: 85, rssi: -55, load: 20 });
    logEvent('Đã giả lập trạng thái Online tối ưu cho các node.', 'ok');
});

document.getElementById('btnSimOverload').addEventListener('click', () => {
    socket.emit('simulate_node', { nodeId: 'node_2', online: true, bat: 8, load: 95 });
    logEvent('Đã giả lập node_2 pin yếu (8%) & quá tải (95%) -> chuyển tải sang node_3.', 'warn');
});

document.getElementById('btnSimFail').addEventListener('click', () => {
    socket.emit('simulate_node', { nodeId: 'node_2', online: false });
    logEvent('Đã giả lập node_2 mất kết nối (Offline).', 'alert');
});

document.getElementById('btnRefreshHistory').addEventListener('click', () => selectNode(selectedNodeId));

// Sự kiện Socket.IO
socket.on('connect', () => {
    const el = document.getElementById('connStatus');
    el.textContent = 'WebSocket Online';
    el.className = 'text-xs px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300';
});

socket.on('disconnect', () => {
    const el = document.getElementById('connStatus');
    el.textContent = 'Mất kết nối';
    el.className = 'text-xs px-2.5 py-1 rounded bg-rose-500/20 text-rose-300';
});

socket.on('init_state', (data) => {
    networkState = data.networkState || {};
    pendingNodes = data.pendingNodes || [];
    controlSchema = data.controlSchema || {};
    renderNodeList();
    renderPendingList();
    renderControls();
    selectNode(selectedNodeId);
});

socket.on('network_update', (state) => {
    networkState = state || {};
    renderNodeList();
    renderSelectedDetails();
    socket.emit('select_node', selectedNodeId, (res) => {
        if (res && res.ok) renderTopology(res.routing);
    });
});

socket.on('pending_nodes', (list) => {
    pendingNodes = list || [];
    renderPendingList();
});

socket.on('camera_frame', (frame) => {
    if (frame.nodeId === selectedNodeId && cameraStreamMode === 'latest') {
        const img = document.getElementById('cameraPreview');
        const placeholder = document.getElementById('cameraPlaceholder');
        img.src = frame.image;
        img.classList.remove('hidden');
        placeholder.classList.add('hidden');
        logEvent(`Nhận khung hình mới qua HTTP từ ${frame.nodeId} (DB ID #${frame.id}).`, 'info');
    }
});

socket.on('system_alert', (alert) => {
    logEvent(`[CẢNH BÁO] ${alert.nodeId}: ${alert.message}`, 'alert');
});
