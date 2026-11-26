const nodeRepo = require('../repositories/nodeRepo');

const RELAY_IDS = ['node_1', 'node_2', 'node_3'];

const defaultConfig = {
    weights: { hop: 1.0, battery: 2.0, rssi: 1.5, load: 1.0 },
    rssi: { good: -30, bad: -100 },
    defaults: { bat: 50, rssi: -85, load: 50 },
    gateway: 'gateway',
    autoDirectToGateway: false, // Bắt buộc gói tin đi qua 3 node trung gian tới gateway
    lowBatteryThreshold: 20,    // Ngưỡng pin yếu (%) kích hoạt phạt Cost
    links: [],
    unreachableCost: Infinity,
};

function normalizeLinks(rawLinks) {
    if (!Array.isArray(rawLinks)) return [];
    const seen = new Set();
    const result = [];
    for (const pair of rawLinks) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const a = String(pair[0] || '').trim();
        const b = String(pair[1] || '').trim();
        if (!a || !b || a === b) continue;
        const key = `${a}->${b}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push([a, b]);
        }
    }
    return result.sort((x, y) => `${x[0]}->${x[1]}`.localeCompare(`${y[0]}->${y[1]}`));
}

function isSameLinks(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
    }
    return true;
}

defaultConfig.setLinks = async function (newLinks) {
    if (!Array.isArray(newLinks)) return false;
    const deduped = normalizeLinks(newLinks);
    if (isSameLinks(defaultConfig.links, deduped)) return true;
    defaultConfig.links = deduped;
    await nodeRepo.replaceLinks(deduped);
    return true;
};

/**
 * Đánh thức các node trung gian đang nghỉ (standby) khi có gói tin cần chuyển tiếp.
 * Bỏ qua node đang bị gắn cờ simulatedDown (Giả lập sập).
 */
function wakeRelays(customStateManager = null) {
    const sm = customStateManager || require('./stateManager');
    const currentState = sm.getState ? sm.getState() : {};
    let wokeAny = false;

    for (const relayId of RELAY_IDS) {
        const nodeState = currentState[relayId];
        if (nodeState && nodeState.simulatedDown) continue;
        sm.touchOnline(relayId);
        wokeAny = true;
    }
    return wokeAny;
}

async function initRouting() {
    const links = await nodeRepo.getLinks();
    defaultConfig.links = normalizeLinks(links);

    wakeRelays();
    await syncTopology();
}

/**
 * Đồng bộ đồ thị định tuyến:
 * - 3 node trung gian (node_1, node_2, node_3) nối thẳng tới gateway.
 * - Tất cả các node khác được thêm vào bắt buộc đi qua 3 node trung gian này.
 */
async function syncTopology() {
    const gw = defaultConfig.gateway;
    const approvedNodes = await nodeRepo.getApprovedNodes();
    const allIds = new Set(approvedNodes.map((n) => n.id));
    for (const r of RELAY_IDS) allIds.add(r);

    const nextLinks = [];

    for (const relayId of RELAY_IDS) {
        if (allIds.has(relayId)) {
            nextLinks.push([relayId, gw]);
        }
    }

    for (const nodeId of allIds) {
        if (!nodeId || nodeId === gw || RELAY_IDS.includes(nodeId)) continue;
        for (const relayId of RELAY_IDS) {
            if (allIds.has(relayId)) {
                nextLinks.push([nodeId, relayId]);
            }
        }
    }

    await defaultConfig.setLinks(nextLinks);
    return defaultConfig.links;
}

async function ensureNodeLinks(nodeId) {
    if (!nodeId || nodeId === defaultConfig.gateway) return false;
    await syncTopology();
    return true;
}

async function removeNodeLinks(nodeId) {
    if (!nodeId) return false;
    await syncTopology();
    return true;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

function rssiQuality(rssi, cfg) {
    const dbm = -Math.abs(num(rssi, cfg.defaults.rssi));
    return clamp01((dbm - cfg.rssi.bad) / (cfg.rssi.good - cfg.rssi.bad));
}

function calculateCost(node, hops = 1, { config = defaultConfig, rssi, isGateway = false } = {}) {
    const w = config.weights;
    const n = node || {};
    const batPct = num(n.bat, config.defaults.bat);
    const quality = rssiQuality(rssi !== undefined ? rssi : n.rssi, config);
    const pinNorm = clamp01(batPct / 100);
    const loadNorm = clamp01(num(n.load, config.defaults.load) / 100);
    const lowBatPenalty = !isGateway && batPct < config.lowBatteryThreshold ? 3.0 : 0;

    const cost =
        w.hop * hops +
        (isGateway ? 0 : w.battery * (1 - pinNorm)) +
        w.rssi * (1 - quality) +
        (isGateway ? 0 : w.load * loadNorm) +
        lowBatPenalty;

    return Math.round(cost * 1000) / 1000;
}

function effectiveLinks(state, config) {
    const gw = config.gateway;
    const links = [...config.links];
    if (config.autoDirectToGateway === false) return links;
    const hasDirect = new Set(links.filter(([, to]) => to === gw).map(([from]) => from));
    for (const id of Object.keys(state)) {
        if (id === 'links' || id === gw || hasDirect.has(id)) continue;
        links.push([id, gw]);
    }
    return links;
}

function buildGraph(state, config, excluded = new Set()) {
    const gw = config.gateway;
    const alive = (id) => id === gw || (state[id] && state[id].online && !excluded.has(id));
    const graph = new Map();
    for (const [from, to] of effectiveLinks(state, config)) {
        if (!alive(from) || !alive(to) || from === gw) continue;
        const linkRssi =
            state.links && state.links[`${from}->${to}`]
                ? state.links[`${from}->${to}`].rssi
                : undefined;
        const rssi = linkRssi !== undefined ? linkRssi : state[from].rssi;
        const weight = calculateCost(to === gw ? {} : state[to], 1, {
            config,
            rssi,
            isGateway: to === gw,
        });
        if (!graph.has(from)) graph.set(from, []);
        graph.get(from).push({ to, weight });
    }
    return graph;
}

function dijkstra(graph, source, target) {
    const dist = new Map([[source, 0]]);
    const prev = new Map();
    const done = new Set();

    while (true) {
        let u = null;
        for (const [id, d] of dist) {
            if (!done.has(id) && (u === null || d < dist.get(u))) u = id;
        }
        if (u === null) break;
        if (u === target) break;
        done.add(u);
        for (const { to, weight } of graph.get(u) || []) {
            const nd = dist.get(u) + weight;
            if (!dist.has(to) || nd < dist.get(to)) {
                dist.set(to, nd);
                prev.set(to, u);
            }
        }
    }

    if (!dist.has(target)) return { cost: Infinity, path: [] };
    const path = [target];
    while (path[0] !== source) path.unshift(prev.get(path[0]));
    return { cost: dist.get(target), path };
}

const round = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

function evaluateRoutes(state, { source = 'node_1', config = defaultConfig } = {}) {
    const gw = config.gateway;
    const unreachable = config.unreachableCost;
    const empty = {
        optimalPath: [],
        totalCost: unreachable,
        alternatives: [],
        costViaNode1: unreachable,
        costViaNode2: unreachable,
        costViaNode3: unreachable,
        links: config.links,
    };

    if (!source || !state[source] || !state[source].online) {
        return { ...empty, optimalRoute: `${source || 'Node'} đang ngoại tuyến (Offline)` };
    }

    // Nếu node nguồn đang Online nhưng tất cả node trung gian đang ngủ (idle), tự đánh thức để định tuyến
    const anyRelayOnline = RELAY_IDS.some((r) => state[r] && state[r].online);
    if (!anyRelayOnline && !RELAY_IDS.includes(source)) {
        wakeRelays();
    }

    const first = buildGraph(state, config).get(source) || [];
    const alternatives = first
        .map(({ to, weight }) => {
            if (to === gw) return { via: to, path: [source, gw], cost: weight };
            const rest = dijkstra(buildGraph(state, config, new Set([source])), to, gw);
            return {
                via: to,
                path: rest.path.length ? [source, ...rest.path] : [],
                cost: weight + rest.cost,
            };
        })
        .filter((r) => Number.isFinite(r.cost))
        .sort((x, y) => x.cost - y.cost)
        .map((r) => ({ ...r, cost: round(r.cost) }));

    const best = alternatives[0];
    const viaCost = (id) => {
        const r = alternatives.find((x) => x.via === id);
        return r ? r.cost : unreachable;
    };

    if (!best) {
        return { ...empty, optimalRoute: `${source}: không có đường tới gateway` };
    }
    return {
        optimalPath: best.path,
        totalCost: best.cost,
        alternatives,
        costViaNode1: viaCost('node_1'),
        costViaNode2: viaCost('node_2'),
        costViaNode3: viaCost('node_3'),
        optimalRoute: best.path.join(' -> '),
        links: config.links,
    };
}

module.exports = {
    RELAY_IDS,
    initRouting,
    wakeRelays,
    syncTopology,
    ensureNodeLinks,
    removeNodeLinks,
    calculateCost,
    evaluateRoutes,
    dijkstra,
    buildGraph,
    rssiQuality,
    defaultConfig,
};