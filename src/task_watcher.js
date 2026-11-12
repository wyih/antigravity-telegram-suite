/**
 * Task Watcher — Monitors transcript_full.jsonl / transcript.jsonl across active & bound conversations.
 *
 * Supports watching multiple bound conversations simultaneously so background tasks,
 * subagents, and Mac-side turns push progress/completion updates to their respective Telegram Topics.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_WATCHED_CONVERSATIONS = 25;

class TaskWatcher {
    constructor(options = {}) {
        this.appDataName = options.appDataName || 'antigravity-ide';
        this.brainPath = path.join(os.homedir(), '.gemini', this.appDataName, 'brain');
        this.onNotification = options.onNotification || (() => {});
        this.isAgentBusy = false; // legacy global flag
        this.busyConversations = new Set(); // conversationId set actively awaited by Telegram request
        this.watchers = new Map(); // conversationId -> { watcher, lastSize, transcriptPath, addedAt }
        this.activeConversationId = null;
        this.debounceTimer = null;
        this.debounceTimers = new Map(); // conversationId -> Timeout
        this.lastIdleTimes = new Map(); // conversationId -> timestamp
        this.DEBOUNCE_MS = 3500;
        this.enabled = true;
    }

    _resolveTranscriptPath(conversationId) {
        if (!conversationId) return null;
        const logsDir = path.join(this.brainPath, conversationId, '.system_generated', 'logs');
        const fullTranscriptPath = path.join(logsDir, 'transcript_full.jsonl');
        const compactTranscriptPath = path.join(logsDir, 'transcript.jsonl');
        if (fs.existsSync(fullTranscriptPath)) return fullTranscriptPath;
        if (fs.existsSync(compactTranscriptPath)) return compactTranscriptPath;
        return null;
    }

    /**
     * Watch a conversation concurrently alongside other bound conversations.
     */
    watchConversation(conversationId) {
        if (!conversationId) return false;
        if (this.watchers.has(conversationId)) {
            const existing = this.watchers.get(conversationId);
            existing.addedAt = Date.now();
            return true;
        }

        const transcriptPath = this._resolveTranscriptPath(conversationId);
        if (!transcriptPath) return false;

        // Evict oldest non-active watcher if over limit
        if (this.watchers.size >= MAX_WATCHED_CONVERSATIONS) {
            let oldestKey = null;
            let oldestTime = Infinity;
            for (const [id, entry] of this.watchers.entries()) {
                if (id === this.activeConversationId || this.busyConversations.has(id)) continue;
                if ((entry.addedAt || 0) < oldestTime) {
                    oldestTime = entry.addedAt || 0;
                    oldestKey = id;
                }
            }
            if (oldestKey) {
                const old = this.watchers.get(oldestKey);
                if (old?.watcher) {
                    try { old.watcher.close(); } catch (_) {}
                }
                this.watchers.delete(oldestKey);
            }
        }

        try {
            const stats = fs.statSync(transcriptPath);
            const lastSize = stats.size;
            const watcher = fs.watch(transcriptPath, (eventType) => {
                if (eventType === 'change' && this.enabled && !this.isConversationBusy(conversationId)) {
                    this._onFileChange(conversationId, transcriptPath);
                }
            });

            watcher.on('error', (err) => {
                console.error(`[TaskWatcher] Watcher error (${conversationId.substring(0, 8)}): ${err.message}`);
            });

            this.watchers.set(conversationId, {
                watcher,
                lastSize,
                transcriptPath,
                addedAt: Date.now()
            });
            console.log(`[TaskWatcher] Watching conversation: ${conversationId.substring(0, 8)} (baseline: ${lastSize} bytes, total watched: ${this.watchers.size})`);
            return true;
        } catch (e) {
            console.error('[TaskWatcher] Failed to watch:', e.message);
            return false;
        }
    }

    /**
     * Set the primary active conversation to watch (retains watchers on other bound conversations).
     */
    setActiveConversation(conversationId) {
        if (!conversationId) return;
        this.activeConversationId = conversationId;
        if (this.watchConversation(conversationId)) return;

        console.log(`[TaskWatcher] Transcript not found for ${conversationId.substring(0, 8)}, searching for most recent...`);
        const fallbackId = this._findMostRecentConversation();
        if (fallbackId && fallbackId !== conversationId) {
            console.log(`[TaskWatcher] Falling back to most recent conversation: ${fallbackId.substring(0, 8)}`);
            this.activeConversationId = fallbackId;
            this.watchConversation(fallbackId);
        }
    }

    isConversationBusy(conversationId) {
        if (conversationId && this.busyConversations.has(conversationId)) return true;
        if (this.isAgentBusy && (!conversationId || conversationId === this.activeConversationId)) return true;
        return false;
    }

    setConversationBusy(conversationId, busy) {
        if (!conversationId) {
            return this.setBusy(busy);
        }
        const wasBusy = this.busyConversations.has(conversationId);
        if (busy) {
            this.busyConversations.add(conversationId);
            const t = this.debounceTimers.get(conversationId);
            if (t) {
                clearTimeout(t);
                this.debounceTimers.delete(conversationId);
            }
        } else {
            this.busyConversations.delete(conversationId);
            if (wasBusy) {
                this.lastIdleTimes.set(conversationId, Date.now());
                this.syncBaseline(conversationId);
            }
        }
    }

    /**
     * Legacy global busy toggle (applies to activeConversationId).
     */
    setBusy(busy) {
        const wasBusy = this.isAgentBusy;
        this.isAgentBusy = busy;
        if (this.activeConversationId) {
            this.setConversationBusy(this.activeConversationId, busy);
        } else if (wasBusy && !busy) {
            this._lastIdleTime = Date.now();
        }
    }

    /**
     * Explicitly synchronize baseline with disk file size.
     */
    syncBaseline(conversationId = null) {
        const convId = conversationId || this.activeConversationId;
        if (!convId) return;
        if (!this.watchers.has(convId)) {
            this.watchConversation(convId);
        }
        const entry = this.watchers.get(convId);
        if (!entry) return;
        const freshPath = this._resolveTranscriptPath(convId) || entry.transcriptPath;
        entry.transcriptPath = freshPath;
        if (freshPath && fs.existsSync(freshPath)) {
            try {
                entry.lastSize = fs.statSync(freshPath).size;
                this.lastIdleTimes.set(convId, Date.now());
                console.log(`[TaskWatcher] Baseline synced for ${convId.substring(0, 8)}: ${entry.lastSize} bytes`);
            } catch (_) {}
        }
    }

    toggle(enable = null) {
        if (enable === null) {
            this.enabled = !this.enabled;
        } else {
            this.enabled = !!enable;
        }
        if (this.enabled) {
            for (const id of this.watchers.keys()) {
                this.syncBaseline(id);
            }
        }
        return this.enabled;
    }

    getStatus() {
        return {
            enabled: this.enabled,
            activeConversationId: this.activeConversationId,
            isAgentBusy: this.isAgentBusy || this.busyConversations.size > 0,
            watchingCount: this.watchers.size
        };
    }

    _onFileChange(conversationId, transcriptPath) {
        const existingTimer = this.debounceTimers.get(conversationId);
        if (existingTimer) clearTimeout(existingTimer);
        const timer = setTimeout(() => {
            this.debounceTimers.delete(conversationId);
            this._processNewContent(conversationId, transcriptPath);
        }, this.DEBOUNCE_MS);
        this.debounceTimers.set(conversationId, timer);
    }

    _processNewContent(conversationId, transcriptPath) {
        if (this.isConversationBusy(conversationId)) return;

        const lastIdle = this.lastIdleTimes.get(conversationId) || this._lastIdleTime || 0;
        if (lastIdle && (Date.now() - lastIdle) < 6000) {
            return;
        }

        const entry = this.watchers.get(conversationId);
        if (!entry) return;

        const resolvedPath = this._resolveTranscriptPath(conversationId) || transcriptPath;
        entry.transcriptPath = resolvedPath;

        try {
            const stats = fs.statSync(resolvedPath);
            if (stats.size <= entry.lastSize) return;

            const fd = fs.openSync(resolvedPath, 'r');
            const newBytes = stats.size - entry.lastSize;
            const buffer = Buffer.alloc(newBytes);
            fs.readSync(fd, buffer, 0, newBytes, entry.lastSize);
            fs.closeSync(fd);

            entry.lastSize = stats.size;

            const newContent = buffer.toString('utf8');
            const lines = newContent.split('\n').filter(l => l.trim());

            const modelResponses = [];
            const modelFeedbackRequests = [];

            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);

                    if (
                        parsed.source === 'MODEL' &&
                        parsed.type === 'PLANNER_RESPONSE' &&
                        parsed.content &&
                        parsed.status === 'DONE'
                    ) {
                        const cleaned = parsed.content
                            .replace(/<thought>[\s\S]*?<\/thought>\n?/g, '')
                            .replace(/\n{3,}/g, '\n\n')
                            .trim();
                        if (cleaned.length > 0) {
                            const hasTools = Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0;
                            modelResponses.push({ text: cleaned, hasTools });
                        }
                    }

                    if (
                        parsed.source === 'MODEL' &&
                        (parsed.type === 'WRITE_TO_FILE' || parsed.type === 'MULTI_REPLACE_FILE_CONTENT' || parsed.type === 'REPLACE_FILE_CONTENT') &&
                        parsed.status === 'DONE' &&
                        parsed.content &&
                        parsed.content.includes('requested user feedback')
                    ) {
                        modelFeedbackRequests.push(parsed.content);
                    }
                } catch (_) {}
            }

            if (modelFeedbackRequests.length > 0) {
                const feedbackText = modelFeedbackRequests[modelFeedbackRequests.length - 1];
                console.log(`[TaskWatcher] 📬 Feedback request detected, conv: ${conversationId.substring(0, 8)}`);
                this.onNotification({
                    conversationId,
                    text: feedbackText,
                    type: 'agent_proactive_feedback'
                });
            } else if (modelResponses.length > 0) {
                const lastResp = modelResponses[modelResponses.length - 1];
                console.log(`[TaskWatcher] 📬 Notification detected (${lastResp.text.length} chars, progress=${lastResp.hasTools}, conv: ${conversationId.substring(0, 8)})`);
                this.onNotification({
                    conversationId,
                    text: lastResp.text,
                    type: lastResp.hasTools ? 'agent_progress' : 'agent_proactive'
                });
            }
        } catch (e) {
            console.error('[TaskWatcher] Error processing:', e.message);
        }
    }

    _findMostRecentConversation() {
        try {
            if (!fs.existsSync(this.brainPath)) return null;

            let newestId = null;
            let newestMtime = 0;

            const entries = fs.readdirSync(this.brainPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (entry.name.length < 30) continue;

                const tPath = this._resolveTranscriptPath(entry.name);
                if (!tPath) continue;
                try {
                    const stats = fs.statSync(tPath);
                    if (stats.mtimeMs > newestMtime) {
                        newestMtime = stats.mtimeMs;
                        newestId = entry.name;
                    }
                } catch (_) {}
            }

            return newestId;
        } catch (e) {
            console.error('[TaskWatcher] Error finding recent conversation:', e.message);
            return null;
        }
    }

    stop() {
        for (const [, entry] of this.watchers) {
            if (entry.watcher) {
                try { entry.watcher.close(); } catch (_) {}
            }
        }
        this.watchers.clear();
        for (const [, timer] of this.debounceTimers) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        clearTimeout(this.debounceTimer);
        this.busyConversations.clear();
        this.activeConversationId = null;
        console.log('[TaskWatcher] All watchers stopped.');
    }
}

module.exports = TaskWatcher;
