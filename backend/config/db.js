const { Pool } = require('pg');
const { InfluxDB } = require('@influxdata/influxdb-client');
const env = require('./env');

const pgPool = new Pool({
    connectionString: env.DATABASE_URL,
});

const influxClient = new InfluxDB({
    url: env.INFLUX_URL,
    token: env.INFLUX_TOKEN,
});

const influxWriteApi = influxClient.getWriteApi(env.INFLUX_ORG, env.INFLUX_BUCKET, 'ms');
const influxQueryApi = influxClient.getQueryApi(env.INFLUX_ORG);

async function initDatabases(retries = 15, delayMs = 3000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await pgPool.query(`
                CREATE TABLE IF NOT EXISTS nodes (
                    id VARCHAR(64) PRIMARY KEY,
                    name VARCHAR(128) NOT NULL,
                    source VARCHAR(32) NOT NULL DEFAULT 'manual',
                    status VARCHAR(16) NOT NULL DEFAULT 'approved',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS node_controls (
                    node_id VARCHAR(64) PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
                    desired_state JSONB NOT NULL DEFAULT '{}'::jsonb,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS control_logs (
                    id SERIAL PRIMARY KEY,
                    cmd_id VARCHAR(64) NOT NULL,
                    node_id VARCHAR(64) NOT NULL,
                    command VARCHAR(64) NOT NULL,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    status VARCHAR(32) NOT NULL DEFAULT 'SENT',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS network_links (
                    from_node VARCHAR(64) NOT NULL,
                    to_node VARCHAR(64) NOT NULL,
                    PRIMARY KEY (from_node, to_node)
                );

                CREATE TABLE IF NOT EXISTS camera_media (
                    id SERIAL PRIMARY KEY,
                    node_id VARCHAR(64) NOT NULL,
                    media_type VARCHAR(16) NOT NULL DEFAULT 'image',
                    mime_type VARCHAR(32) NOT NULL DEFAULT 'image/jpeg',
                    size_bytes INTEGER NOT NULL,
                    binary_data BYTEA NOT NULL,
                    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE INDEX IF NOT EXISTS idx_camera_media_node_time
                ON camera_media (node_id, captured_at DESC);
            `);

            // Seed các node mẫu ban đầu nếu bảng nodes đang trống
            const countRes = await pgPool.query(`SELECT COUNT(*)::int AS cnt FROM nodes`);
            if (countRes.rows[0].cnt === 0) {
                await pgPool.query(`
                    INSERT INTO nodes (id, name, source, status) VALUES
                    ('node_1', 'Node Tuyến Đường 01', 'seed', 'approved'),
                    ('node_2', 'Node Trung Gian 02', 'seed', 'approved'),
                    ('node_3', 'Node Trung Gian 03', 'seed', 'approved')
                    ON CONFLICT (id) DO NOTHING;
                `);
                await pgPool.query(`
                    INSERT INTO network_links (from_node, to_node) VALUES
                    ('node_1', 'node_2'),
                    ('node_1', 'node_3'),
                    ('node_2', 'gateway'),
                    ('node_3', 'gateway'),
                    ('node_2', 'node_3'),
                    ('node_3', 'node_2')
                    ON CONFLICT DO NOTHING;
                `);
            }

            console.log('[DB] Đã kết nối PostgreSQL & khởi tạo schema thành công.');
            console.log(`[DB] Sẵn sàng ghi chuỗi thời gian vào InfluxDB (${env.INFLUX_URL}, bucket: ${env.INFLUX_BUCKET}).`);
            return;
        } catch (err) {
            console.warn(`[DB] Đang chờ Database sẵn sàng (lần ${attempt}/${retries}): ${err.message}`);
            if (attempt === retries) throw err;
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
}

module.exports = {
    pgPool,
    influxWriteApi,
    influxQueryApi,
    initDatabases,
};
