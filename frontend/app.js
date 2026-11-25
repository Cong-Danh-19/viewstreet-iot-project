const socket = io();

const RELAY_IDS = ['node_1', 'node_2', 'node_3'];

let networkState = {};
let pendingNodes = [];
let controlSchema = {};
let selectedNodeId = 'node_1';
let cameraStreamMode = 'latest'; // 'latest' | 'stream'
let sensorChart = null;

function onEl(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
}

function logEvent(msg, level = 'info') {
    const box = document.getElementById('eventLog');
    if (!box) return;
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
onEl('btnAuth', 'click', () => {
    const input = document.getElementById('adminTokenInput');
    const token = input ? input.value.trim() : '';
    socket.emit('auth', token, (res) => {
        if (res && res.ok) logEvent('Xác thực quyền quản trị thành công.', 'ok');
        else logEvent(`Lỗi xác thực: ${(res && res.error) || 'Sai token'}`, 'alert');
    });
});

// Thêm node mới
onEl('addNodeForm', 'submit', (e) => {
    e.preventDefault();
    const idInput = document.getElementById('newNodeId');
    const nameInput = document.getElementById('newNodeName');
    const nodeId = idInput ? idInput.value.trim() : '';
    const name = nameInput ? nameInput.value.trim() : '';
    if (!nodeId) return;

    socket.emit('add_node', { nodeId, name }, (res) => {
        if (res && res.ok) {
            logEvent(`Đã thêm node '${nodeId}' vào PostgreSQL.`, 'ok');
            if (idInput) idInput.value = '';
            if (nameInput) nameInput.value = '';
            selectNode(nodeId);
        } else {
            logEvent(`Thêm node thất bại: ${(res && res.error) || 'Lỗi'}`, 'alert');
        }
    });
});

function renderNodeList() {
    const container = document.getElementById('nodeList');
    if (!container) return;
    container.innerHTML = '';

    const ids = Object.keys(networkState).filter((id) => id !== 'links' && id !== 'gateway');
    if (ids.length === 0) {
        container.innerHTML = '<div class="text-xs text-slate-500">Chưa có node nào</div>';
        return;
    }
    if (!networkState[selectedNodeId]) selectedNodeId = ids[0];

    for (const id of ids) {
        const n = networkState[id];
        const isSelected = id === selectedNodeId;
        const isRelay = RELAY_IDS.includes(id);

        const row = document.createElement('div');
        row.className = `w-full p-2.5 rounded-lg border transition flex items-center justify-between gap-2 cursor-pointer ${
            isSelected
                ? 'bg-indigo-600/20 border-indigo-500 text-white'
                : 'bg-slate-800/60 border-slate-800 text-slate-300 hover:bg-slate-800'
        }`;

        row.innerHTML = `
            <div class="min-w-0 flex-1">
                <div class="text-xs font-semibold flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full shrink-0 ${n.online ? 'bg-emerald-400' : 'bg-slate-500'}"></span>
                    <span class="truncate">${n.name || id}</span>
                </div>
                <div class="text-[11px] text-slate-400 font-mono mt-0.5">${id} • Pin ${n.bat ?? 100}% • Tải ${n.load ?? 0}%</div>
            </div>
            ${
                isRelay
                    ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-700/80 text-cyan-300 font-mono shrink-0">RELAY</span>'
                    : `<button type="button" data-del="${id}" title="Xóa node khỏi hệ thống và PostgreSQL"
                        class="text-[11px] px-2 py-1 rounded bg-rose-600/20 hover:bg-rose-600 text-rose-300 hover:text-white border border-rose-500/30 transition shrink-0">
                        Xóa
                       </button>`
            }
        `;

        row.onclick = () => selectNode(id);

        const delBtn = row.querySelector('[data-del]');
        if (delBtn) {
            delBtn.onclick = (e) => {
                e.stopPropagation();
                if (!confirm(`Xóa node '${id}' và toàn bộ dữ liệu của node này khỏi PostgreSQL?`)) return;
                socket.emit('delete_node', { nodeId: id }, (res) => {
                    if (res && res.ok) {
                        logEvent(`Đã xóa vĩnh viễn node '${id}' khỏi PostgreSQL & RAM.`, 'warn');
                        if (selectedNodeId === id) {
                            const nextId = Object.keys(networkState).find((k) => k !== id && k !== 'links' && k !== 'gateway') || 'node_1';
                            selectNode(nextId);
                        }
                    } else {
                        logEvent(`Xóa node thất bại: ${(res && res.error) || 'Cần xác thực ADMIN_TOKEN'}`, 'alert');
                    }
                });
            };
        }

        container.appendChild(row);
    }
}

function renderPendingList() {
    const container = document.getElementById('pendingList');
    if (!container) return;
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

    document.getElementById('selectedNodeTitle').textContent = `${n.name || n.id} (${n.id})`;
    const badge = document.getElementById('selectedNodeBadge');
    badge.textContent = n.online ? 'ONLINE' : 'OFFLINE';
    badge.className = `text-xs px-2 py-0.5 rounded font-semibold ${
        n.online ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700/60 text-slate-300'
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
    if (!img || !placeholder) return;

    if (mediaCount !== null) {
        const meta = document.getElementById('cameraMeta');
        if (meta) meta.textContent = `PostgreSQL Media (${selectedNodeId}): ${mediaCount} bản ghi`;
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

onEl('btnModeLatest', 'click', () => {
    cameraStreamMode = 'latest';
    document.getElementById('btnModeLatest').className = 'text-xs px-2 py-1 rounded bg-indigo-600 text-white';
    document.getElementById('btnModeStream').className = 'text-xs px-2 py-1 rounded bg-slate-800 text-slate-300';
    updateCameraDisplay();
});

onEl('btnModeStream', 'click', () => {
    cameraStreamMode = 'stream';
    document.getElementById('btnModeStream').className = 'text-xs px-2 py-1 rounded bg-indigo-600 text-white';
    document.getElementById('btnModeLatest').className = 'text-xs px-2 py-1 rounded bg-slate-800 text-slate-300';
    updateCameraDisplay();
});

// Nút test gửi ảnh JPEG qua HTTP POST /api/camera/upload
onEl('btnTestHttpUpload', 'click', async () => {
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
            const routeNote = json.routing && json.routing.optimalRoute ? ` | Tuyến: ${json.routing.optimalRoute}` : '';
            logEvent(`HTTP POST ảnh thành công -> PostgreSQL ID #${json.id || json.imageId} (${json.sizeBytes} bytes)${routeNote}`, 'ok');
            selectNode(selectedNodeId);
        } else {
            logEvent(`HTTP Upload lỗi: ${json.error}`, 'alert');
        }
    } catch (err) {
        logEvent(`Lỗi gửi HTTP camera: ${err.message}`, 'alert');
    }
});

function renderChart(history) {
    const canvas = document.getElementById('sensorChart');
    if (!canvas || typeof Chart === 'undefined') return;
    const ctx = canvas.getContext('2d');
    const labels = (history || []).map((h) => h.time);
    const temps = (history || []).map((h) => h.temp);
    const humis = (history || []).map((h) => h.humi);
    const bats = (history || []).map((h) => h.bat);

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

function createSvgEl(tag, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
    }
    return el;
}

function renderTopology(routing) {
    const svg = document.getElementById('topologySvg');
    if (!svg) return;
    svg.innerHTML = '';
    if (!routing) return;

    document.getElementById('optimalRouteText').textContent =
        `Tuyến tối ưu: ${routing.optimalRoute} ${Number.isFinite(routing.totalCost) ? `(Cost: ${routing.totalCost})` : ''}`;

    const altBox = document.getElementById('routeAlternatives');
    if (altBox) {
        altBox.innerHTML = (routing.alternatives || []).map((r, idx) =>
            `<div class="p-2 rounded bg-slate-800/80 border ${idx === 0 ? 'border-emerald-500/50 text-emerald-300' : 'border-slate-700'}">
                ${idx === 0 ? '★ ' : ''}${r.path.join(' → ')} <span class="float-right font-mono">Cost: ${r.cost}</span>
            </div>`
        ).join('') || '<div>Không có tuyến khả dụng</div>';
    }

    const relayBox = document.getElementById('relayMetricsList');
    if (relayBox) {
        relayBox.innerHTML = RELAY_IDS.map((rid) => {
            const st = networkState[rid] || {};
            const online = Boolean(st.online);
            const bat = Math.round(st.bat ?? 100);
            const load = st.load ?? 0;
            const rssi = st.rssi ?? -50;
            const pkts = st.packetCount ?? 0;
            const dotColor = !online ? 'bg-slate-500' : (bat < 20 || load >= 80) ? 'bg-rose-500' : (bat < 40 || load >= 50) ? 'bg-amber-400' : 'bg-emerald-400';
            return `<div class="p-2 rounded bg-slate-800/60 border border-slate-800 flex items-center justify-between font-mono text-[11px]">
                <span class="flex items-center gap-1.5 text-slate-200"><span class="w-2 h-2 rounded-full ${dotColor}"></span>${rid}</span>
                <span>Tải ${load}% • Pin ${bat}% • ${rssi}dBm • ${pkts} gói</span>
            </div>`;
        }).join('');
    }

    const allIds = Object.keys(networkState).filter((id) => id !== 'links' && id !== 'gateway');
    const edgeNodes = allIds.filter((id) => !RELAY_IDS.includes(id));
    const relayNodes = RELAY_IDS;

    const maxRows = Math.max(edgeNodes.length, relayNodes.length, 1);
    const svgWidth = 660;
    const svgHeight = Math.max(270, maxRows * 90 + 40);
    svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
    svg.style.height = `${svgHeight}px`;

    const pos = {
        gateway: { x: 565, y: svgHeight / 2 },
    };

    edgeNodes.forEach((id, idx) => {
        const step = svgHeight / (edgeNodes.length + 1);
        pos[id] = { x: 95, y: step * (idx + 1) };
    });

    relayNodes.forEach((id, idx) => {
        const step = svgHeight / (relayNodes.length + 1);
        pos[id] = { x: 330, y: step * (idx + 1) };
    });

    const optimalEdges = new Set();
    const optPath = routing.optimalPath || [];
    for (let i = 0; i < optPath.length - 1; i++) {
        optimalEdges.add(`${optPath[i]}->${optPath[i + 1]}`);
    }

    const headers = [
        { text: 'NODE CẢM BIẾN / CAM', x: 95 },
        { text: 'NODE TRUNG GIAN (RELAY)', x: 330 },
        { text: 'GATEWAY / SERVER', x: 565 },
    ];
    for (const h of headers) {
        if (h.x === 95 && edgeNodes.length === 0) continue;
        const hdr = createSvgEl('text', {
            x: h.x,
            y: 16,
            'text-anchor': 'middle',
            fill: '#64748b',
            'font-size': '9',
            'font-weight': '600',
            'letter-spacing': '0.5',
        });
        hdr.textContent = h.text;
        svg.appendChild(hdr);
    }

    for (const [from, to] of (routing.links || [])) {
        if (!pos[from] || !pos[to]) continue;
        const isOpt = optimalEdges.has(`${from}->${to}`);
        const srcPkts = (networkState[from] && networkState[from].packetCount) || 0;
        const optWidth = Math.min(5.5, 3 + Math.log10(srcPkts + 1));

        const lineAttrs = {
            x1: pos[from].x,
            y1: pos[from].y,
            x2: pos[to].x,
            y2: pos[to].y,
            stroke: isOpt ? '#10b981' : '#334155',
            'stroke-width': isOpt ? String(optWidth.toFixed(1)) : '1.5',
        };
        if (isOpt) {
            lineAttrs.class = 'route-flow';
        } else {
            lineAttrs['stroke-dasharray'] = '4,5';
        }
        svg.appendChild(createSvgEl('line', lineAttrs));
    }

    for (const [id, p] of Object.entries(pos)) {
        const isGw = id === 'gateway';
        const isSelected = id === selectedNodeId;
        const st = networkState[id];
        const bat = st && Number.isFinite(st.bat) ? Math.round(st.bat) : 100;
        const load = st && Number.isFinite(st.load) ? st.load : 0;

        let color = '#64748b';
        if (isGw) {
            color = '#8b5cf6';
        } else if (st && st.online) {
            if (bat < 20 || load >= 80) color = '#ef4444';
            else if (bat < 40 || load >= 50) color = '#f59e0b';
            else color = '#10b981';
        }

        if (isSelected && !isGw) {
            svg.appendChild(createSvgEl('circle', {
                cx: p.x,
                cy: p.y,
                r: '20',
                fill: 'none',
                stroke: 'rgba(99, 102, 241, 0.75)',
                'stroke-width': '2.5',
            }));
        }

        svg.appendChild(createSvgEl('circle', {
            cx: p.x,
            cy: p.y,
            r: isGw ? '18' : '15',
            fill: color,
        }));

        const labelStr = isGw ? 'Gateway' : `${id} (${bat}%)`;
        const boxWidth = Math.max(66, labelStr.length * 6.8 + 14);
        const boxY = p.y + 21;

        svg.appendChild(createSvgEl('rect', {
            x: p.x - boxWidth / 2,
            y: boxY,
            width: boxWidth,
            height: 17,
            rx: 4,
            fill: 'rgba(2, 6, 23, 0.9)',
            stroke: isSelected ? 'rgba(99, 102, 241, 0.55)' : 'rgba(51, 65, 85, 0.5)',
            'stroke-width': '0.8',
        }));

        const label = createSvgEl('text', {
            x: p.x,
            y: boxY + 11.5,
            'text-anchor': 'middle',
            fill: '#f1f5f9',
            'font-size': '10.5',
            'font-family': 'monospace',
        });
        label.textContent = labelStr;
        svg.appendChild(label);
    }
}

function renderControls() {
    const container = document.getElementById('controlFormContainer');
    if (!container) return;
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

onEl('btnRefreshHistory', 'click', () => selectNode(selectedNodeId));

// Sự kiện Socket.IO
socket.on('connect', () => {
    const el = document.getElementById('connStatus');
    if (el) {
        el.textContent = 'WebSocket Online';
        el.className = 'text-xs px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300';
    }
});

socket.on('disconnect', () => {
    const el = document.getElementById('connStatus');
    if (el) {
        el.textContent = 'Mất kết nối';
        el.className = 'text-xs px-2.5 py-1 rounded bg-rose-500/20 text-rose-300';
    }
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
        if (img && placeholder) {
            img.src = frame.image;
            img.classList.remove('hidden');
            placeholder.classList.add('hidden');
        }
        logEvent(`Nhận khung hình mới qua HTTP từ ${frame.nodeId} (DB ID #${frame.id}).`, 'info');
    }
});

socket.on('system_alert', (alert) => {
    logEvent(`[CẢNH BÁO] ${alert.nodeId}: ${alert.message}`, 'alert');
});