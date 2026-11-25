const { pgPool } = require('../config/db');

async function getApprovedNodes() {
    const res = await pgPool.query(
        `SELECT id, name, source, created_at AS "createdAt"
         FROM nodes WHERE status = 'approved' ORDER BY created_at ASC`
    );
    return res.rows;
}

async function getPendingNodes() {
    const res = await pgPool.query(
        `SELECT id, name, source, created_at AS "seenAt"
         FROM nodes WHERE status = 'pending' ORDER BY created_at DESC`
    );
    return res.rows;
}

async function upsertNode(id, name, source = 'manual', status = 'approved') {
    const res = await pgPool.query(
        `INSERT INTO nodes (id, name, source, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
         SET name = COALESCE(NULLIF($2, ''), nodes.name),
             status = EXCLUDED.status
         RETURNING id, name, source, status, created_at AS "createdAt"`,
        [id, name || id, source, status]
    );
    return res.rows[0];
}

async function renameNode(id, name) {
    const res = await pgPool.query(
        `UPDATE nodes SET name = $2 WHERE id = $1 RETURNING id, name, source, status`,
        [id, name]
    );
    return res.rows[0] || null;
}

async function deleteNode(id) {
    await pgPool.query(`DELETE FROM nodes WHERE id = $1`, [id]);
}

async function getLinks() {
    const res = await pgPool.query(`SELECT from_node, to_node FROM network_links ORDER BY from_node, to_node`);
    return res.rows.map((r) => [r.from_node, r.to_node]);
}

async function replaceLinks(pairs) {
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM network_links');
        for (const [from, to] of pairs) {
            await client.query(
                `INSERT INTO network_links (from_node, to_node) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [from, to]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

module.exports = {
    getApprovedNodes,
    getPendingNodes,
    upsertNode,
    renameNode,
    deleteNode,
    getLinks,
    replaceLinks,
};
