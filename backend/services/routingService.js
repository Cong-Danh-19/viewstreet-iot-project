const fs = require('fs');
const path = require('path');

const LINKS_FILE = path.join(__dirname, '../data/links.json');

const DEFAULT_LINKS = [
    ['node_1', 'gateway'],
    ['node_1', 'node_2'],
    ['node_1', 'node_3'],
    ['node_2', 'gateway'],
    ['node_3', 'gateway'],
    ['node_2', 'node_3'],
    ['node_3', 'node_2'],
];

function loadLinks() {
    try {
        const parsed = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
        if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) { /* chưa có file links.json thì dùng mặc định */ }
    return DEFAULT_LINKS;
}

const defaultConfig = {
    weights: { hop: 1.0, battery: 2.0, rssi: 1.5, load: 1.0 },
    rssi: { good: -30, bad: -100 },
    defaults: { bat: 50, rssi: -85, load: 50 },
    gateway: 'gateway',
    autoDirectToGateway: false, // Tắt nối thẳng gateway để test định tuyến qua node trung gian
    links: loadLinks(),
    unreachableCost: Infinity,
};

defaultConfig.setLinks = function (newLinks) {
    if (!Array.isArray(newLinks)) return false;
    const valid = newLinks.filter(
        (pair) =>
            Array.isArray(pair) &&
            pair.length === 2 &&
            typeof pair[0] === 'string' &&
            typeof pair[1] === 'string' &&
            pair[0] !== pair[1]
    );
    defaultConfig.links = valid;
    fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true });
    fs.writeFileSync(LINKS_FILE, JSON.stringify(valid, null, 2), 'utf8');
    return true;
};

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

function rssiQuality(rssi, cfg) {
    const dbm = -Math.abs(num(rssi, cfg.defaults.rssi));
    return clamp01((dbm - cfg.rssi.bad) / (cfg.rssi.good - cfg.rssi.bad));
}

function calculateCost(node, hops = 1, { config = defaultConfig, rssi, isGateway = false } = {}) {
    const w = config.weights;
    const n = node || {};
    const quality = rssiQuality(rssi !== undefined ? rssi : n.rssi, config);
    const pinNorm = clamp01(num(n.bat, config.defaults.bat) / 100);
    const loadNorm = clamp01(num(n.load, config.defaults.load) / 100);

    const cost = w.hop * hops
        + (isGateway ? 0 : w.battery * (1 - pinNorm))
        + w.rssi * (1 - quality)
        + (isGateway ? 0 : w.load * loadNorm);
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
        const linkRssi = state.links && state.links[`${from}->${to}`]
            ? state.links[`${from}->${to}`].rssi
            : undefined;
        const rssi = linkRssi !== undefined ? linkRssi : state[from].rssi;
        const weight = calculateCost(to === gw ? {} : state[to], 1, {
            config, rssi, isGateway: to === gw,
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
        optimalPath: [], totalCost: unreachable, alternatives: [],
        costViaNode2: unreachable, costViaNode3: unreachable,
    };

    if (!state[source] || !state[source].online) {
        return { ...empty, optimalRoute: `${source} đang ngoại tuyến (Offline)` };
    }

    const first = buildGraph(state, config).get(source) || [];
    const alternatives = first.map(({ to, weight }) => {
        if (to === gw) return { via: to, path: [source, gw], cost: weight };
        const rest = dijkstra(buildGraph(state, config, new Set([source])), to, gw);
        return {
            via: to,
            path: rest.path.length ? [source, ...rest.path] : [],
            cost: weight + rest.cost,
        };
    }).filter((r) => Number.isFinite(r.cost))
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
        costViaNode2: viaCost('node_2'),
        costViaNode3: viaCost('node_3'),
        optimalRoute: best.path.join(' -> '),
    };
}

module.exports = { calculateCost, evaluateRoutes, dijkstra, buildGraph, rssiQuality, defaultConfig };