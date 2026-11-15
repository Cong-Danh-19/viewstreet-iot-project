let networkState = {
    node_1: { id: 'Node 1 (Real)', temp: 28.0, humi: 70, light: 300, motion: 0, bat: 92, mode: 'NORMAL', ledLevel: 2, error: 'OK', online: true, rssi: -52, load: 20 },
    node_2: { id: 'Node 2 (Sim)',  bat: 85, rssi: -60, load: 25, online: true },
    node_3: { id: 'Node 3 (Sim)',  bat: 78, rssi: -65, load: 30, online: true },
    node_4: { id: 'Node 4 (Sim)',  bat: 95, rssi: -50, load: 15, online: true }
};

function getState() {
    return networkState;
}

function updateNode1(newData) {
    networkState.node_1 = { ...networkState.node_1, ...newData, online: true };
    return networkState;
}

function toggleNodeSim(nodeId) {
    if (networkState[nodeId]) {
        networkState[nodeId].online = !networkState[nodeId].online;
        networkState[nodeId].bat = networkState[nodeId].online ? 85 : 0;
        networkState[nodeId].load = networkState[nodeId].online ? 25 : 100;
    }
    return networkState;
}

module.exports = { getState, updateNode1, toggleNodeSim };
