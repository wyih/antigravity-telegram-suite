const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TopicRouter } = require('../src/topic_router');
const TaskWatcher = require('../src/task_watcher');

async function run() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-topic-test-'));
    try {
        // 1. TopicRouter persistence & mapping
        const topicsFile = path.join(tmpDir, 'telegram_topics.json');
        const router = new TopicRouter(topicsFile);

        assert.strictEqual(router.getCtxThreadId({ message: { message_thread_id: 42 } }), 42);
        assert.strictEqual(router.getCtxThreadId({ callbackQuery: { message: { message_thread_id: 99 } } }), 99);
        assert.strictEqual(router.getCtxThreadId({ message: {} }), null);

        router.bindTopic(833329817, 101, {
            conversationId: 'conv-aaaa-1111',
            title: 'Fix Carbon Model',
            workspace: 'antigravity-telegram-suite'
        });
        router.bindTopic(833329817, 202, {
            conversationId: 'conv-bbbb-2222',
            title: 'New Chat - Outside of Project',
            workspace: 'Outside of Project'
        });

        // Reload from disk
        const routerReloaded = new TopicRouter(topicsFile);
        const b1 = routerReloaded.getBinding(833329817, 101);
        assert.ok(b1);
        assert.strictEqual(b1.conversationId, 'conv-aaaa-1111');
        assert.strictEqual(b1.workspace, 'antigravity-telegram-suite');

        const rev1 = routerReloaded.getTopicForConversation(833329817, 'conv-aaaa-1111');
        assert.ok(rev1);
        assert.strictEqual(rev1.messageThreadId, 101);

        routerReloaded.updateConversationMeta('conv-aaaa-1111', { title: 'Fix Carbon & Topics' });
        assert.strictEqual(routerReloaded.getBinding(833329817, 101).title, 'Fix Carbon & Topics');

        assert.deepStrictEqual(
            routerReloaded.getAllBoundConversationIds().sort(),
            ['conv-aaaa-1111', 'conv-bbbb-2222']
        );

        assert.strictEqual(
            routerReloaded.formatTopicTitle('Fix Carbon Model - Antigravity', 'antigravity-telegram-suite'),
            '📁 antigravity-telegram-s… · Fix Carbon Model'
        );
        assert.strictEqual(
            routerReloaded.formatTopicTitle('Casual Chat - Outside of Project', 'Outside of Project'),
            '💬 Casual Chat'
        );

        assert.strictEqual(routerReloaded.unbindTopic(833329817, 202), true);
        assert.strictEqual(routerReloaded.getBinding(833329817, 202), null);

        // 2. TaskWatcher concurrent multi-conversation watching & progress/proactive distinction
        const brainDir = path.join(tmpDir, 'brain');
        const convA = '11111111-1111-1111-1111-111111111111';
        const convB = '22222222-2222-2222-2222-222222222222';
        const logsA = path.join(brainDir, convA, '.system_generated', 'logs');
        const logsB = path.join(brainDir, convB, '.system_generated', 'logs');
        fs.mkdirSync(logsA, { recursive: true });
        fs.mkdirSync(logsB, { recursive: true });

        const fileA = path.join(logsA, 'transcript_full.jsonl');
        const fileB = path.join(logsB, 'transcript_full.jsonl');
        fs.writeFileSync(fileA, JSON.stringify({ source: 'USER_EXPLICIT', content: 'init A' }) + '\n');
        fs.writeFileSync(fileB, JSON.stringify({ source: 'USER_EXPLICIT', content: 'init B' }) + '\n');

        const events = [];
        const watcher = new TaskWatcher({
            onNotification: (evt) => events.push(evt)
        });
        watcher.brainPath = brainDir;
        watcher.DEBOUNCE_MS = 80;

        assert.strictEqual(watcher.watchConversation(convA), true);
        assert.strictEqual(watcher.watchConversation(convB), true);
        assert.strictEqual(watcher.getStatus().watchingCount, 2);

        // Mark convA busy (e.g. Telegram wait loop active), leave convB idle (Mac-side or background subagent turn)
        watcher.setConversationBusy(convA, true);
        assert.strictEqual(watcher.isConversationBusy(convA), true);
        assert.strictEqual(watcher.isConversationBusy(convB), false);

        // Append intermediate tool call step to convB -> should emit agent_progress
        fs.appendFileSync(
            fileB,
            JSON.stringify({
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'Checking logs now.',
                tool_calls: [{ name: 'run_command' }]
            }) + '\n'
        );
        watcher._processNewContent(convB, fileB);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].conversationId, convB);
        assert.strictEqual(events[0].type, 'agent_progress');
        assert.strictEqual(events[0].text, 'Checking logs now.');

        // Append to convA while busy -> suppressed
        fs.appendFileSync(
            fileA,
            JSON.stringify({
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'Busy turn output',
                tool_calls: []
            }) + '\n'
        );
        watcher._processNewContent(convA, fileA);
        assert.strictEqual(events.length, 1);

        // Append final step (tool_calls: []) to convB -> should emit agent_proactive
        fs.appendFileSync(
            fileB,
            JSON.stringify({
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'All done on convB!',
                tool_calls: []
            }) + '\n'
        );
        watcher._processNewContent(convB, fileB);
        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[1].conversationId, convB);
        assert.strictEqual(events[1].type, 'agent_proactive');
        assert.strictEqual(events[1].text, 'All done on convB!');

        watcher.stop();
        assert.strictEqual(watcher.getStatus().watchingCount, 0);

        console.log('✅ TopicRouter and multi-conversation TaskWatcher tests passed!');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
