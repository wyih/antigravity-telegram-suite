const assert = require('assert');
const http = require('http');
const { ensureCdpReady, isCdpReachable, isConnectionRefusedError } = require('../src/cdp_health');

function withServer(handler, fn) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', async () => {
            const { port } = server.address();
            try {
                await fn(port);
                server.close(() => resolve());
            } catch (err) {
                server.close(() => reject(err));
            }
        });
    });
}

async function run() {
    assert.strictEqual(isConnectionRefusedError(new Error('connect ECONNREFUSED 127.0.0.1:9333')), true);
    assert.strictEqual(isConnectionRefusedError(new Error('HTTP 404 from http://127.0.0.1:51234/json')), true);
    assert.strictEqual(isConnectionRefusedError(new Error('other failure')), false);

    await withServer((req, res) => {
        res.writeHead(404);
        res.end();
    }, async (port) => {
        assert.strictEqual(await isCdpReachable(port, 1000), false);
    });

    await withServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 't1', type: 'page' }]));
    }, async (port) => {
        assert.strictEqual(await isCdpReachable(port, 1000), true);
    });

    const events = [];
    let reachable = false;
    await ensureCdpReady({
        port: 9333,
        app: 'agent',
        isReachable: async () => reachable,
        restartApp: async (app, port) => {
            events.push(`restart:${app}:${port}`);
            reachable = true;
        },
        waitMs: 0
    });
    assert.deepStrictEqual(events, ['restart:agent:9333']);

    events.length = 0;
    await ensureCdpReady({
        port: 9333,
        app: 'agent',
        isReachable: async () => true,
        restartApp: async () => events.push('restart'),
        waitMs: 0
    });
    assert.deepStrictEqual(events, []);

    console.log('✅ CDP health tests passed!');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
