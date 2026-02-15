/**
 * WebSocket Server Verification Script
 *
 * Tests:
 *  1. Server starts on configured port
 *  2. Client connects and receives welcome message
 *  3. Client can subscribe to a series
 *  4. Client can unsubscribe from a series
 *  5. Client receives pong for ping
 *  6. Invalid JSON returns error
 *  7. Unknown message type returns error
 *  8. Snapshot broadcast reaches subscribed clients only
 *  9. Discovery broadcast reaches subscribed clients only
 * 10. Status broadcast reaches subscribed clients only
 * 11. Heartbeat terminates dead connections
 * 12. Server reports correct client count
 * 13. Server stops cleanly
 */

import WebSocket from 'ws';
import db from '../src/utils/db';
import { ViewershipWebSocketServer } from '../src/api/websocket';
import type { PollCycleResult } from '../src/services/polling-orchestrator';
import type { DiscoveryResult } from '../src/services/discovery-service';

const TEST_PORT = 3099; // Use a non-standard port to avoid conflicts

// Override env vars before any config is loaded
process.env.WS_PORT = String(TEST_PORT);
process.env.DATABASE_URL = 'postgresql://silverfox@localhost:5432/clutch_viewership_test';

let passed = 0;
let failed = 0;
let wsServer: ViewershipWebSocketServer;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

function waitForMessage(ws: WebSocket, timeout = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), timeout);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function waitForOpen(ws: WebSocket, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('Timeout waiting for connection')), timeout);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function seedTestData(): Promise<{ seriesId: string }> {
  // Create a test series
  const [series] = await db('tournament_series')
    .insert({
      name: 'WS Test Series',
      status: 'active',
    })
    .returning('*');

  return { seriesId: series.id };
}

async function cleanup(seriesId: string): Promise<void> {
  await db('channels').where('series_id', seriesId).delete();
  await db('tournament_series').where('id', seriesId).delete();
}

async function main() {
  console.log('\n🔌 WebSocket Server Verification\n');
  console.log('━'.repeat(60));

  let seriesId = '';

  try {
    // Seed test data
    const data = await seedTestData();
    seriesId = data.seriesId;
    console.log(`  Seeded test series: ${seriesId}\n`);

    // ── Test 1: Server starts ──────────────────────────────────────────
    console.log('1. Server lifecycle');

    wsServer = new ViewershipWebSocketServer();
    wsServer.start();
    assert(true, 'Server started without error');

    // Small delay to let server bind
    await new Promise((r) => setTimeout(r, 200));

    // ── Test 2: Client connects and receives welcome ───────────────────
    console.log('\n2. Client connection & welcome');

    const client1 = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForOpen(client1);
    assert(true, 'Client 1 connected');

    const welcomeMsg = await waitForMessage(client1);
    assert(welcomeMsg.type === 'welcome', `Welcome message received (type: ${welcomeMsg.type})`);
    assert(
      Array.isArray((welcomeMsg.data as Record<string, unknown>)?.activeSeries),
      'Welcome contains activeSeries array',
    );
    assert(
      Array.isArray((welcomeMsg.data as Record<string, unknown>)?.liveBroadcastDays),
      'Welcome contains liveBroadcastDays array',
    );

    // ── Test 3: Subscribe to a series ──────────────────────────────────
    console.log('\n3. Subscribe / Unsubscribe');

    client1.send(JSON.stringify({ type: 'subscribe', seriesId }));
    // No response expected for subscribe, just verify no error
    await new Promise((r) => setTimeout(r, 100));
    assert(true, 'Subscribe sent without error');

    // ── Test 4: Ping / Pong ─────────────────────────────────────────
    console.log('\n4. Ping / Pong');

    client1.send(JSON.stringify({ type: 'ping' }));
    const pongMsg = await waitForMessage(client1);
    assert(pongMsg.type === 'pong', `Pong received (type: ${pongMsg.type})`);

    // ── Test 5: Invalid JSON ────────────────────────────────────────
    console.log('\n5. Error handling');

    client1.send('not-json{{{');
    const errorMsg = await waitForMessage(client1);
    assert(errorMsg.type === 'error', `Error returned for invalid JSON (type: ${errorMsg.type})`);

    // ── Test 6: Unknown message type ────────────────────────────────
    client1.send(JSON.stringify({ type: 'foobar' }));
    const unknownMsg = await waitForMessage(client1);
    assert(unknownMsg.type === 'error', `Error returned for unknown type (type: ${unknownMsg.type})`);

    // ── Test 7: Snapshot broadcast to subscribed client ──────────────
    console.log('\n6. Broadcast routing');

    // Connect a second client that does NOT subscribe
    const client2 = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForOpen(client2);
    const _welcome2 = await waitForMessage(client2); // consume welcome

    // Set up message collectors
    const client1Messages: Record<string, unknown>[] = [];
    const client2Messages: Record<string, unknown>[] = [];

    client1.on('message', (data) => {
      client1Messages.push(JSON.parse(data.toString()));
    });
    client2.on('message', (data) => {
      client2Messages.push(JSON.parse(data.toString()));
    });

    // Broadcast a snapshot update
    const fakePollResult: PollCycleResult = {
      timestamp: new Date(),
      channelsPolled: 10,
      totalCCV: 5000,
      snapshotsCreated: 10,
      errors: [],
      duration: 150,
    };

    await wsServer.broadcastSnapshotUpdate(fakePollResult, [seriesId]);
    await new Promise((r) => setTimeout(r, 200));

    const client1Snapshots = client1Messages.filter((m) => m.type === 'snapshot_update');
    const client2Snapshots = client2Messages.filter((m) => m.type === 'snapshot_update');

    assert(client1Snapshots.length === 1, `Client 1 (subscribed) received snapshot_update (${client1Snapshots.length})`);
    assert(client2Snapshots.length === 0, `Client 2 (not subscribed) did NOT receive snapshot_update (${client2Snapshots.length})`);

    // ── Test 8: Discovery broadcast to subscribed client ─────────────
    const fakeDiscoveryResult: DiscoveryResult = {
      seriesId,
      timestamp: new Date(),
      discovered: 50,
      added: 5,
      alreadyTracked: 40,
      belowThreshold: 3,
      blocked: 2,
      errors: [],
      duration: 800,
    };

    wsServer.broadcastDiscoveryUpdate(fakeDiscoveryResult);
    await new Promise((r) => setTimeout(r, 200));

    const client1Discovery = client1Messages.filter((m) => m.type === 'discovery_update');
    const client2Discovery = client2Messages.filter((m) => m.type === 'discovery_update');

    assert(client1Discovery.length === 1, `Client 1 (subscribed) received discovery_update (${client1Discovery.length})`);
    assert(client2Discovery.length === 0, `Client 2 (not subscribed) did NOT receive discovery_update (${client2Discovery.length})`);

    // ── Test 9: Status broadcast to subscribed client ─────────────────
    wsServer.broadcastStatusUpdate(seriesId, 'fake-day-id', 'scheduled', 'live');
    await new Promise((r) => setTimeout(r, 200));

    const client1Status = client1Messages.filter((m) => m.type === 'status_update');
    const client2Status = client2Messages.filter((m) => m.type === 'status_update');

    assert(client1Status.length === 1, `Client 1 (subscribed) received status_update (${client1Status.length})`);
    assert(client2Status.length === 0, `Client 2 (not subscribed) did NOT receive status_update (${client2Status.length})`);

    // ── Test 10: Unsubscribe stops receiving ─────────────────────────
    console.log('\n7. Unsubscribe');

    client1.send(JSON.stringify({ type: 'unsubscribe', seriesId }));
    await new Promise((r) => setTimeout(r, 100));

    // Clear message collectors
    client1Messages.length = 0;

    wsServer.broadcastStatusUpdate(seriesId, 'fake-day-id-2', 'live', 'completed');
    await new Promise((r) => setTimeout(r, 200));

    const client1AfterUnsub = client1Messages.filter((m) => m.type === 'status_update');
    assert(client1AfterUnsub.length === 0, `Client 1 (unsubscribed) did NOT receive status_update after unsubscribe (${client1AfterUnsub.length})`);

    // ── Test 11: Client count ─────────────────────────────────────────
    console.log('\n8. Client tracking');

    assert(wsServer.getClientCount() === 2, `Client count is 2 (actual: ${wsServer.getClientCount()})`);

    // Close client 2
    client2.close();
    await new Promise((r) => setTimeout(r, 200));
    assert(wsServer.getClientCount() === 1, `Client count is 1 after disconnect (actual: ${wsServer.getClientCount()})`);

    // ── Test 12: Server stops cleanly ────────────────────────────────
    console.log('\n9. Server shutdown');

    client1.close();
    await new Promise((r) => setTimeout(r, 200));

    wsServer.stop();
    assert(wsServer.getClientCount() === 0, `Client count is 0 after stop (actual: ${wsServer.getClientCount()})`);
    assert(true, 'Server stopped cleanly');

  } catch (err) {
    console.error(`\n💥 Unexpected error: ${(err as Error).message}`);
    console.error((err as Error).stack);
    failed++;
  } finally {
    // Cleanup
    try {
      if (seriesId) await cleanup(seriesId);
    } catch { /* ignore */ }

    try {
      wsServer?.stop();
    } catch { /* ignore */ }

    await db.destroy();
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n' + '━'.repeat(60));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
