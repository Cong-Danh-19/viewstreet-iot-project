const { pgPool } = require('../config/db');

async function getAllDesiredStates() {
    const res = await pgPool.query(`SELECT node_id, desired_state FROM node_controls`);
    const map = new Map();
    for (const row of res.rows) {
        map.set(row.node_id, row.desired_state || {});
    }
    return map;
}

async function saveDesiredState(nodeId, desiredState) {
    await pgPool.query(
        `INSERT INTO node_controls (node_id, desired_state, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (node_id) DO UPDATE
         SET desired_state = EXCLUDED.desired_state, updated_at = NOW()`,
        [nodeId, JSON.stringify(desiredState)]
    );
}

async function appendLog({ cmdId, nodeId, command, payload, status }) {
    const res = await pgPool.query(
        `INSERT INTO control_logs (cmd_id, node_id, command, payload, status)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, cmd_id AS "cmdId", node_id AS "nodeId", command, payload, status, created_at AS "createdAt"`,
        [cmdId, nodeId, command, JSON.stringify(payload || {}), status]
    );
    return res.rows[0];
}

async function updateLogStatus(cmdId, status) {
    await pgPool.query(
        `UPDATE control_logs SET status = $2 WHERE cmd_id = $1`,
        [cmdId, status]
    );
}

async function getRecentLogs(limit = 50) {
    const res = await pgPool.query(
        `SELECT id, cmd_id AS "cmdId", node_id AS "nodeId", command, payload, status, created_at AS "createdAt"
         FROM control_logs
         ORDER BY created_at DESC, id DESC
         LIMIT $1`,
        [Math.min(Number(limit) || 50, 200)]
    );
    return res.rows;
}

module.exports = {
    getAllDesiredStates,
    saveDesiredState,
    appendLog,
    updateLogStatus,
    getRecentLogs,
};
