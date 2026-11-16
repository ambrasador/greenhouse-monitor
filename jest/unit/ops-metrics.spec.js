'use strict';
const { createOpsMetrics } = require('../../ops-metrics');

const state = { mqttConnected: true, lastReadingAt: 1_700_000_000_000 };
const feed = { size: () => 3 };

describe('операційні метрики', () => {
  test('результати приймання лягають у лічильники, причини відхилення — окремо', async () => {
    const ops = createOpsMetrics({ feed, state, defaults: false });
    ops.recordIngest('stored', 0.0004);
    ops.recordIngest('stored', 0.002);
    ops.recordIngest('duplicate', 0.0002);
    ops.recordIngest('out_of_range', 0.0001);
    ops.recordIngest('bad_json');                 // відхилено до перевірки: часу немає
    const text = await ops.registry.metrics();
    expect(text).toContain('greenhouse_readings_total{result="stored"} 2');
    expect(text).toContain('greenhouse_readings_total{result="duplicate"} 1');
    expect(text).toContain('greenhouse_readings_total{result="rejected"} 2');
    expect(text).toContain('greenhouse_rejected_total{reason="out_of_range"} 1');
    expect(text).toContain('greenhouse_rejected_total{reason="bad_json"} 1');
  });

  test('гістограма: кошик +Inf дорівнює _count, а повідомлення без часу не рахується', async () => {
    const ops = createOpsMetrics({ feed, state, defaults: false });
    for (const s of [0.0004, 0.002, 0.2]) ops.recordIngest('stored', s);
    ops.recordIngest('bad_json');
    const text = await ops.registry.metrics();
    expect(text).toContain('greenhouse_ingest_seconds_bucket{le="0.0005"} 1');
    expect(text).toContain('greenhouse_ingest_seconds_bucket{le="0.5"} 3');
    expect(text).toContain('greenhouse_ingest_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain('greenhouse_ingest_seconds_count 3');
  });

  test('стан береться під час опитування, а не під час запису', async () => {
    const live = { mqttConnected: true, lastReadingAt: null };
    const ops = createOpsMetrics({ feed, state: live, defaults: false });
    let sockets = 2;
    ops.trackSockets(() => sockets);
    expect(await ops.registry.metrics()).toContain('greenhouse_broker_connected 1');
    live.mqttConnected = false;
    live.lastReadingAt = 1_700_000_000_000;
    sockets = 5;
    const text = await ops.registry.metrics();
    expect(text).toContain('greenhouse_broker_connected 0');
    expect(text).toContain('greenhouse_last_reading_timestamp_seconds 1700000000');
    expect(text).toContain('greenhouse_feed_subscriptions 3');
    expect(text).toContain('greenhouse_ws_connections 5');
  });

  test('ряди для сповіщень існують із нуля ще до першої події', async () => {
    const text = await createOpsMetrics({ feed, state, defaults: false }).registry.metrics();
    expect(text).toContain('greenhouse_audit_events_total{action="refresh.reuse",outcome="revoked"} 0');
    expect(text).toContain('greenhouse_audit_events_total{action="webhook",outcome="rejected"} 0');
    expect(text).toContain('greenhouse_readings_total{result="rejected"} 0');
  });

  test('лічильники розсилника push стають метрикою й оновлюються разом зі stats', async () => {
    const stats = { sent: 4, unregistered: 0, invalid: 0, config: 0, retries: 2, expired: 1, gaveUp: 0, noRecipients: 0 };
    const ops = createOpsMetrics({ feed, state, defaults: false });
    ops.trackPush(stats);
    let text = await ops.registry.metrics();
    expect(text).toContain('greenhouse_push_total{result="sent"} 4');
    expect(text).toContain('greenhouse_push_total{result="expired"} 1');
    stats.gaveUp = 1;
    stats.sent = 5;
    text = await ops.registry.metrics();
    expect(text).toContain('greenhouse_push_total{result="gave_up"} 1');
    expect(text).toContain('greenhouse_push_total{result="sent"} 5');
  });
});
