const { pgPool } = require('../config/db');
const env = require('../config/env');

async function saveMedia(nodeId, buffer, { mediaType = 'image', mimeType = 'image/jpeg' } = {}) {
    const res = await pgPool.query(
        `INSERT INTO camera_media (node_id, media_type, mime_type, size_bytes, binary_data)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, captured_at`,
        [nodeId, mediaType, mimeType, buffer.length, buffer]
    );

    await pgPool.query(
        `DELETE FROM camera_media
         WHERE id IN (
             SELECT id FROM camera_media
             WHERE node_id = $1
             ORDER BY captured_at DESC, id DESC
             OFFSET $2
         )`,
        [nodeId, env.MAX_MEDIA_PER_NODE]
    );

    return {
        id: res.rows[0].id,
        nodeId,
        mediaType,
        mimeType,
        sizeBytes: buffer.length,
        ts: new Date(res.rows[0].captured_at).getTime(),
    };
}

async function getLatestMedia(nodeId) {
    const res = await pgPool.query(
        `SELECT id, node_id, media_type, mime_type, size_bytes, binary_data, captured_at
         FROM camera_media
         WHERE node_id = $1
         ORDER BY captured_at DESC, id DESC
         LIMIT 1`,
        [nodeId]
    );
    return res.rows[0] || null;
}

async function getMediaById(id) {
    const res = await pgPool.query(
        `SELECT id, node_id, media_type, mime_type, size_bytes, binary_data, captured_at
         FROM camera_media WHERE id = $1`,
        [id]
    );
    return res.rows[0] || null;
}

async function listMedia(nodeId, limit = 20) {
    const res = await pgPool.query(
        `SELECT id, node_id AS "nodeId", media_type AS "mediaType",
                mime_type AS "mimeType", size_bytes AS "sizeBytes", captured_at AS "capturedAt"
         FROM camera_media
         WHERE node_id = $1
         ORDER BY captured_at DESC, id DESC
         LIMIT $2`,
        [nodeId, Math.min(Math.max(Number(limit) || 20, 1), 100)]
    );
    return res.rows;
}

module.exports = {
    saveMedia,
    getLatestMedia,
    getMediaById,
    listMedia,
};
