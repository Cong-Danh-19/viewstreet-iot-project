const { Point } = require('@influxdata/influxdb-client');
const { influxWriteApi, influxQueryApi } = require('../config/db');
const env = require('../config/env');

async function writeTelemetry(nodeId, data) {
    const point = new Point('node_telemetry').tag('nodeId', nodeId);

    const numericFields = ['temp', 'humi', 'light', 'motion', 'rain', 'dust', 'bat', 'rssi', 'load'];
    let hasField = false;

    for (const key of numericFields) {
        if (data[key] !== undefined && Number.isFinite(Number(data[key]))) {
            point.floatField(key, Number(data[key]));
            hasField = true;
        }
    }

    if (typeof data.error === 'string' && data.error.length > 0) {
        point.stringField('error', data.error);
        hasField = true;
    }

    if (!hasField) return;

    influxWriteApi.writePoint(point);
    await influxWriteApi.flush();
}

async function getSensorHistory(nodeId, limit = 50) {
    const safeNodeId = String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '');
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);

    const fluxQuery = `
        from(bucket: "${env.INFLUX_BUCKET}")
          |> range(start: -7d)
          |> filter(fn: (r) => r._measurement == "node_telemetry" and r.nodeId == "${safeNodeId}")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
          |> sort(columns: ["_time"], desc: true)
          |> limit(n: ${safeLimit})
    `;

    const rows = [];
    return new Promise((resolve) => {
        influxQueryApi.queryRows(fluxQuery, {
            next(row, tableMeta) {
                const obj = tableMeta.toObject(row);
                const dt = new Date(obj._time);
                rows.push({
                    nodeId: safeNodeId,
                    ts: dt.getTime(),
                    time: dt.toLocaleTimeString('vi-VN'),
                    date: dt.toLocaleDateString('vi-VN'),
                    temp: obj.temp ?? 0,
                    humi: obj.humi ?? 0,
                    light: obj.light ?? 0,
                    motion: obj.motion ?? 0,
                    rain: obj.rain ?? 0,
                    dust: obj.dust ?? 0,
                    bat: obj.bat ?? 0,
                    rssi: obj.rssi ?? -50,
                    load: obj.load ?? 0,
                    error: obj.error || 'OK',
                });
            },
            error(err) {
                console.error('[InfluxDB] Lỗi truy vấn lịch sử cảm biến:', err.message);
                resolve([]);
            },
            complete() {
                resolve(rows.reverse());
            },
        });
    });
}

module.exports = {
    writeTelemetry,
    getSensorHistory,
};
