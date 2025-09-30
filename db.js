import fs from 'fs';
import path from 'path';

// Single JSON DB file holding all app data. We keep the arrays you specified
// and add a few app-specific collections needed by the dashboard (auth users,
// servers hosting metadata, console logs, and process state).

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'dexster.db');

function ensureDbFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_PATH)) {
        const empty = {
            servers: [],
            users: [],
            guildUsers: [],
            primes: [],
            promos: [],
            promoUsages: [],
            languages: [],
            logs: [],
            guildCommandSettings: [],
            guildPrefixes: [],
            reminders: [],
            shareWarnings: [],
            roomWarnings: [],
            serverEmojis: [],
            joinRewards: [],
            pendingRoles: [],
            weeklyGifts: [],
            weeklyGiftsProgress: [],
            // Dashboard specific
            appUsers: [], // { userId, username, password, isAdmin }
            appServers: [], // { id, name, ownerId, isSuspended, users_obj, files_obj, startup_obj }
            appEventLogs: [], // { id, timestamp, event, details }
            appConsoleLogs: [], // { userId, serverId, timestamp, content }
            appProcessState: [] // { userId, serverId, isRunning, startTime }
        };
        fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    } else {
        try {
            const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
            let updated = false;
            const ensureArray = (key) => { if (!Array.isArray(db[key])) { db[key] = []; updated = true; } };
            ['servers','users','guildUsers','primes','promos','promoUsages','languages','logs','guildCommandSettings','guildPrefixes','reminders','shareWarnings','roomWarnings','serverEmojis','joinRewards','pendingRoles','weeklyGifts','weeklyGiftsProgress','appUsers','appServers','appEventLogs','appConsoleLogs','appProcessState'].forEach(ensureArray);
            if (updated) fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
        } catch (e) { /* ignore */ }
    }
}

function loadDb() {
    ensureDbFile();
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function saveDb(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Helpers
function upsert(array, predicate, newDoc) {
    const idx = array.findIndex(predicate);
    if (idx === -1) array.push(newDoc); else array[idx] = { ...array[idx], ...newDoc };
}

// User model compatible with index.js usage
export class JsonUserModel {
    constructor(data) { Object.assign(this, data); }
    static async countDocuments() {
        const db = loadDb();
        return db.appUsers.length;
    }
    static async findOne(query) {
        const db = loadDb();
        if (query.userId) return db.appUsers.find(u => u.userId === query.userId) || null;
        if (query.username) return db.appUsers.find(u => u.username === query.username) || null;
        return null;
    }
    static find() {
        const rows = loadDb().appUsers.slice();
        return { lean: async () => rows };
    }
    static async deleteOne(query) {
        const db = loadDb();
        db.appUsers = db.appUsers.filter(u => !(query.userId ? u.userId === query.userId : false));
        saveDb(db);
    }
    async save() {
        const db = loadDb();
        upsert(db.appUsers, u => u.userId === this.userId, { userId: this.userId, username: this.username, password: this.password, isAdmin: !!this.isAdmin });
        saveDb(db);
        return this;
    }
}

// Server model compatible with index.js usage
export class JsonServerModel {
    constructor(data) {
        this.id = data.id;
        this.name = data.name;
        this.ownerId = data.ownerId;
        this.isSuspended = !!data.isSuspended;
        this.users = data.users instanceof Map ? data.users : new Map(Object.entries(data.users || {}));
        this.files = data.files instanceof Map ? data.files : new Map(Object.entries(data.files || {}));
        this.startupSettings = data.startupSettings instanceof Map ? data.startupSettings : new Map(Object.entries(data.startupSettings || {}));
    }
    static async findOne(query) {
        const db = loadDb();
        if (!query.id) return null;
        const row = db.appServers.find(s => s.id === query.id);
        if (!row) return null;
        return new JsonServerModel({
            id: row.id,
            name: row.name,
            ownerId: row.ownerId,
            isSuspended: !!row.isSuspended,
            users: row.users_obj || {},
            files: row.files_obj || {},
            startupSettings: row.startup_obj || {}
        });
    }
    static find(query) {
        const db = loadDb();
        let rows = db.appServers.slice();
        if (query && query.$or && Array.isArray(query.$or)) {
            const ownerId = query.$or.find(c => c.ownerId)?.ownerId;
            const userKey = Object.keys(query.$or.find(c => typeof c === 'object' && Object.keys(c)[0]?.startsWith('users.')) || {})[0];
            const userId = userKey ? userKey.split('.')[1] : null;
            rows = rows.filter(r => (ownerId ? r.ownerId === ownerId : true) || (userId ? JSON.stringify(r.users_obj || {}).includes(userId) : false));
        }
        const result = rows.map(r => ({
            id: r.id,
            name: r.name,
            ownerId: r.ownerId,
            isSuspended: !!r.isSuspended,
            users: r.users_obj || {},
            files: r.files_obj || {},
            startupSettings: r.startup_obj || {}
        }));
        return { lean: async () => result };
    }
    static async deleteOne(query) {
        const db = loadDb();
        if (!query.id) return;
        db.appServers = db.appServers.filter(s => s.id !== query.id);
        saveDb(db);
    }
    async save() {
        const db = loadDb();
        const usersObj = Object.fromEntries(this.users);
        const filesObj = Object.fromEntries(this.files);
        const startupObj = Object.fromEntries(this.startupSettings);
        upsert(db.appServers, s => s.id === this.id, {
            id: this.id,
            name: this.name,
            ownerId: this.ownerId,
            isSuspended: !!this.isSuspended,
            users_obj: usersObj,
            files_obj: filesObj,
            startup_obj: startupObj
        });
        saveDb(db);
        return this;
    }
}

// Event logs compatible layer
export class JsonEventLogModel {
    static async create({ timestamp, event, details, detailsText }) {
        const db = loadDb();
        const id = (db.appEventLogs.at(-1)?.id || 0) + 1;
        db.appEventLogs.push({ id, timestamp: +(timestamp ? new Date(timestamp) : new Date()), event, details: details || (detailsText ? JSON.parse(detailsText) : null) });
        saveDb(db);
    }
    static async countDocuments(filter = {}) {
        const { rows } = await JsonEventLogModel._filter(filter);
        return rows.length;
    }
    static async _filter(filter = {}) {
        const db = loadDb();
        let rows = db.appEventLogs.slice();
        if (filter.timestamp) {
            const gte = filter.timestamp.$gte ? +new Date(filter.timestamp.$gte) : -Infinity;
            const lte = filter.timestamp.$lte ? +new Date(filter.timestamp.$lte) : Infinity;
            rows = rows.filter(r => r.timestamp >= gte && r.timestamp <= lte);
        }
        if (filter.event) rows = rows.filter(r => r.event === filter.event);
        return { rows };
    }
    static find(filter = {}) {
        const api = {
            _filter: filter,
            _skip: 0,
            _limit: 50,
            sort() { return this; },
            skip(n) { this._skip = n; return this; },
            limit(n) { this._limit = n; return this; },
            async lean() {
                const { rows } = await JsonEventLogModel._filter(this._filter);
                const sorted = rows.sort((a,b) => b.timestamp - a.timestamp);
                const paged = sorted.slice(this._skip, this._skip + this._limit).map(r => ({
                    timestamp: new Date(r.timestamp),
                    event: r.event,
                    details: r.details,
                    detailsText: r.details ? JSON.stringify(r.details) : null
                }));
                return paged;
            }
        };
        return api;
    }
}

// Console logs helpers
export function saveConsoleLog(userId, serverId, content) {
    const db = loadDb();
    db.appConsoleLogs.push({ userId, serverId, timestamp: Date.now(), content });
    const MAX = 5000;
    if (db.appConsoleLogs.length > MAX) db.appConsoleLogs.splice(0, db.appConsoleLogs.length - MAX);
    saveDb(db);
}

export function getRecentConsoleLogs(userId, serverId, limit = 100) {
    const db = loadDb();
    const rows = db.appConsoleLogs
        .filter(r => r.userId === userId && r.serverId === serverId)
        .sort((a,b) => a.timestamp - b.timestamp)
        .slice(-limit)
        .map(r => r.content);
    return rows;
}

export function clearConsoleLogs(userId, serverId) {
    const db = loadDb();
    db.appConsoleLogs = db.appConsoleLogs.filter(r => !(r.userId === userId && r.serverId === serverId));
    saveDb(db);
}

// Process state helpers
export function setProcessState(userId, serverId, running, startTime) {
    const db = loadDb();
    upsert(db.appProcessState, r => r.userId === userId && r.serverId === serverId, { userId, serverId, isRunning: !!running, startTime: startTime ?? null });
    saveDb(db);
}

export function clearProcessState(userId, serverId) {
    const db = loadDb();
    db.appProcessState = db.appProcessState.filter(r => !(r.userId === userId && r.serverId === serverId));
    saveDb(db);
}

export function getProcessState(userId, serverId) {
    const db = loadDb();
    const row = db.appProcessState.find(r => r.userId === userId && r.serverId === serverId);
    return row ? { isRunning: !!row.isRunning, startTime: row.startTime || null } : { isRunning: false, startTime: null };
}

export function connectDB() {
    ensureDbFile();
    return DB_PATH;
}


