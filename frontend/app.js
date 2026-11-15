const socket = io();

const ctx = document.getElementById('envChart').getContext('2d');
const envChart = new Chart(ctx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            { label: 'Nhiệt độ (°C)', data: [], borderColor: '#fb7185', tension: 0.3 },
            { label: 'Độ ẩm (%)', data: [], borderColor: '#38bdf8', tension: 0.3 }
        ]
    },
    options: { responsive: true, scales: { y: { beginAtZero: false } } }
});

socket.on('state_update', (packet) => {
    const { currentState, routingInfo } = packet;
    const n1 = currentState.node_1;

    document.getElementById('val-temp').innerText = `${n1.temp} °C`;
    document.getElementById('val-humi').innerText = `${n1.humi} %`;
    document.getElementById('val-light').innerText = `${n1.light} Lux`;
    document.getElementById('val-bat').innerText = `${n1.bat} %`;
    document.getElementById('val-motion').innerText = n1.motion ? 'CÓ NGƯỜI / XE' : 'Không có';
    document.getElementById('val-led').innerText = `Mức ${n1.ledLevel} / 4`;
    document.getElementById('val-error').innerText = n1.error;

    const badge = document.getElementById('mode-badge');
    badge.innerText = `MODE: ${n1.mode}`;
    badge.className = n1.mode === 'DEBUG'
        ? 'px-4 py-1.5 rounded-full font-bold text-sm bg-rose-600 animate-pulse'
        : 'px-4 py-1.5 rounded-full font-bold text-sm bg-emerald-600';

    document.getElementById('routing-info').innerText = `Tuyến: ${routingInfo.optimalRoute}`;

    // Cập nhật biểu đồ
    const now = new Date().toLocaleTimeString();
    if (envChart.data.labels.length > 15) {
        envChart.data.labels.shift();
        envChart.data.datasets[0].data.shift();
        envChart.data.datasets[1].data.shift();
    }
    envChart.data.labels.push(now);
    envChart.data.datasets[0].data.push(n1.temp);
    envChart.data.datasets[1].data.push(n1.humi);
    envChart.update();

    updateTopologyUI(currentState);
});

socket.on('camera_frame', (imgData) => {
    document.getElementById('cam-view').src = imgData.startsWith('data:image')
        ? imgData
        : 'data:image/jpeg;base64,' + imgData;
});

function sendCmd(command, value) {
    socket.emit('cmd_hardware', { command, value });
}

function toggleSimNode(nodeId) {
    socket.emit('toggle_sim_node', nodeId);
}

function updateTopologyUI(state) {
    const n2Online = state.node_2.online;
    const svgN2 = document.getElementById('svg-node-2');
    const l12 = document.getElementById('link-1-2');
    const l2g = document.getElementById('link-2-gw');
    const l13 = document.getElementById('link-1-3');
    const l34 = document.getElementById('link-3-4');
    const l4g = document.getElementById('link-4-gw');

    if (n2Online) {
        svgN2.setAttribute('fill', '#10b981');
        l12.setAttribute('stroke', '#10b981'); l12.setAttribute('stroke-width', '4');
        l2g.setAttribute('stroke', '#10b981'); l2g.setAttribute('stroke-width', '4');
        [l13, l34, l4g].forEach(l => { l.setAttribute('stroke', '#475569'); l.setAttribute('stroke-dasharray', '5,5'); });
    } else {
        svgN2.setAttribute('fill', '#ef4444');
        l12.setAttribute('stroke', '#ef4444'); l12.setAttribute('stroke-width', '1');
        l2g.setAttribute('stroke', '#ef4444'); l2g.setAttribute('stroke-width', '1');
        [l13, l34, l4g].forEach(l => { l.setAttribute('stroke', '#38bdf8'); l.setAttribute('stroke-width', '4'); l.removeAttribute('stroke-dasharray'); });
    }
}
