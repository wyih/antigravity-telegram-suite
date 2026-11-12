const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_TOPICS_FILE = path.join(os.homedir(), '.gemini', 'antigravity', 'telegram_topics.json');

class TopicRouter {
    constructor(filePath = DEFAULT_TOPICS_FILE) {
        this.filePath = filePath;
        this.topics = new Map(); // "${chatId}:${messageThreadId}" -> { chatId, messageThreadId, conversationId, title, workspace, updatedAt }
        this._load();
    }

    _key(chatId, messageThreadId) {
        return `${String(chatId)}:${Number(messageThreadId)}`;
    }

    _load() {
        try {
            if (!fs.existsSync(this.filePath)) return;
            const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            const entries = raw && typeof raw.topics === 'object' ? Object.values(raw.topics) : [];
            for (const item of entries) {
                if (!item || item.chatId === undefined || !item.messageThreadId || !item.conversationId) continue;
                const normalized = {
                    chatId: String(item.chatId),
                    messageThreadId: Number(item.messageThreadId),
                    conversationId: String(item.conversationId),
                    title: item.title || '',
                    workspace: item.workspace || '',
                    updatedAt: Number(item.updatedAt) || Date.now()
                };
                this.topics.set(this._key(normalized.chatId, normalized.messageThreadId), normalized);
            }
        } catch (err) {
            console.error('[TopicRouter] Failed to load topics file:', err.message);
        }
    }

    _save() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const obj = { topics: {} };
            for (const [k, v] of this.topics.entries()) {
                obj.topics[k] = v;
            }
            const tmpPath = `${this.filePath}.tmp.${process.pid}`;
            fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
            fs.renameSync(tmpPath, this.filePath);
        } catch (err) {
            console.error('[TopicRouter] Failed to save topics file:', err.message);
        }
    }

    getCtxThreadId(ctx) {
        if (!ctx) return null;
        const tid =
            ctx.message?.message_thread_id ??
            ctx.callbackQuery?.message?.message_thread_id ??
            ctx.editedMessage?.message_thread_id ??
            ctx.msg?.message_thread_id ??
            null;
        return typeof tid === 'number' && tid > 0 ? tid : null;
    }

    bindTopic(chatId, messageThreadId, { conversationId, title = '', workspace = '' } = {}) {
        if (chatId === undefined || chatId === null || !messageThreadId || !conversationId) return null;
        const key = this._key(chatId, messageThreadId);
        const prev = this.topics.get(key);
        const record = {
            chatId: String(chatId),
            messageThreadId: Number(messageThreadId),
            conversationId: String(conversationId),
            title: title || prev?.title || '',
            workspace: workspace || prev?.workspace || '',
            updatedAt: Date.now()
        };
        this.topics.set(key, record);
        this._save();
        return record;
    }

    unbindTopic(chatId, messageThreadId) {
        if (chatId === undefined || chatId === null || !messageThreadId) return false;
        const deleted = this.topics.delete(this._key(chatId, messageThreadId));
        if (deleted) this._save();
        return deleted;
    }

    updateConversationMeta(conversationId, { title, workspace } = {}) {
        if (!conversationId) return;
        let changed = false;
        for (const record of this.topics.values()) {
            if (record.conversationId === String(conversationId)) {
                if (title && title !== record.title) {
                    record.title = title;
                    changed = true;
                }
                if (workspace && workspace !== record.workspace) {
                    record.workspace = workspace;
                    changed = true;
                }
            }
        }
        if (changed) this._save();
    }

    getBinding(chatId, messageThreadId) {
        if (chatId === undefined || chatId === null || !messageThreadId) return null;
        return this.topics.get(this._key(chatId, messageThreadId)) || null;
    }

    getTopicForConversation(chatId, conversationId) {
        if (chatId === undefined || chatId === null || !conversationId) return null;
        const targetChat = String(chatId);
        const targetConv = String(conversationId);
        let best = null;
        for (const record of this.topics.values()) {
            if (record.chatId === targetChat && record.conversationId === targetConv) {
                if (!best || record.updatedAt >= best.updatedAt) {
                    best = record;
                }
            }
        }
        return best;
    }

    getAllBoundConversationIds() {
        const ids = new Set();
        for (const record of this.topics.values()) {
            if (record.conversationId) ids.add(record.conversationId);
        }
        return Array.from(ids);
    }

    listBindings(chatId = null) {
        const targetChat = chatId !== null && chatId !== undefined ? String(chatId) : null;
        return Array.from(this.topics.values())
            .filter(r => !targetChat || r.chatId === targetChat)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    formatTopicTitle(title = '', workspace = '') {
        let cleanTitle = String(title || '')
            .replace(/\s*-\s*Antigravity\s*$/i, '')
            .replace(/\s*-\s*Outside of Project\s*$/i, '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        let cleanWs = String(workspace || '')
            .replace(/\s*-\s*Antigravity\s*$/i, '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const genericWs = new Set(['', 'default', 'projects', 'outside of project', 'antigravity']);
        const hasRealWs = !genericWs.has(cleanWs.toLowerCase());

        if (!cleanTitle) {
            cleanTitle = hasRealWs ? cleanWs : 'New Chat';
        }

        let combined;
        if (hasRealWs && !cleanTitle.toLowerCase().includes(cleanWs.toLowerCase())) {
            const wsShort = cleanWs.length > 24 ? cleanWs.slice(0, 22) + '…' : cleanWs;
            combined = `📁 ${wsShort} · ${cleanTitle}`;
        } else {
            combined = `💬 ${cleanTitle}`;
        }

        if (combined.length > 120) {
            combined = combined.slice(0, 118) + '…';
        }
        return combined;
    }
}

module.exports = {
    TopicRouter,
    DEFAULT_TOPICS_FILE
};
