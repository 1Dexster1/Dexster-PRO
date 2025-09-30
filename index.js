import path from 'path';
import fs from 'fs-extra';
import express from 'express';
import session from 'express-session';
import os from 'os';
import { JsonUserModel as JsonUserModel, JsonServerModel as JsonServerModel, JsonEventLogModel as JsonEventLogModel, saveConsoleLog as jsonSaveConsoleLog, getRecentConsoleLogs as jsonGetRecentConsoleLogs, setProcessState as jsonSetProcessState, clearProcessState as jsonClearProcessState, getProcessState as jsonGetProcessState, connectDB as connectJsonDb, clearConsoleLogs as jsonClearConsoleLogs } from './db.js';
import chardet from 'chardet';
import chalk from 'chalk';
import { exec, spawn } from 'child_process';
import util from 'util';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { formidable } from 'formidable';
import { WebSocketServer } from 'ws';
import hljs from 'highlight.js';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { v4 as uuidv4 } from 'uuid';
import * as tar from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execPromise = util.promisify(exec);

// Initialize global variables
const tempDir = path.join(__dirname, 'temp');
const serverLogs = [];
const maxLogSize = 1000;
const consoleLogs = {};
const runningProcesses = {};
const serverStartTime = {};

// Ensure temp directory exists
fs.ensureDirSync(tempDir);

// Create Express app
const app = express();
const port = 7008;
const usedPorts = new Set([7008]);

// Format console output function
const formatConsoleOutput = (log) => {
    const timestamp = new Date().toLocaleTimeString('ar-EG');
    const formattedTimestamp = `<span class='text-gray-400'>[${timestamp}]</span>`;
    let icon = '';
    let colorClass = '';
    let cleanLog = log.trim();
    const lowerLog = cleanLog.toLowerCase();

    if (lowerLog.includes('error') || lowerLog.includes('خطأ') || lowerLog.includes('err')) {
        icon = `<i class='fas fa-times-circle text-red-500 mr-1'></i>`;
        colorClass = 'console-log-error';
    } else if (lowerLog.includes('warn') || lowerLog.includes('تحذير') || lowerLog.includes('warn')) {
        icon = `<i class='fas fa-exclamation-triangle text-yellow-400 mr-1'></i>`;
        colorClass = 'console-log-warn';
    } else if (lowerLog.includes('success') || lowerLog.includes('تم') || lowerLog.includes('completed') || lowerLog.includes('تثبيت الحزم')) {
        icon = `<i class='fas fa-check-circle text-green-500 mr-1'></i>`;
        colorClass = 'console-log-success';
    } else if (lowerLog.includes('info') || lowerLog.includes('معلومات')) {
        icon = `<i class='fas fa-info-circle text-blue-400 mr-1'></i>`;
        colorClass = 'console-log-info';
    } else {
        icon = `<i class='fas fa-terminal text-slate-400 mr-1'></i>`;
        colorClass = 'console-log-info';
    }
    // إرجاع HTML منسق للعرض في الواجهة
    return `<span class='${colorClass}'>${formattedTimestamp} ${icon} ${cleanLog}</span>`;
};

// Initialize console logs for a server
const initializeServerLogs = (userId, serverId) => {
    const logKey = `${userId}-${serverId}`;
    if (!consoleLogs[logKey]) {
        consoleLogs[logKey] = [];
    }
    if (!runningProcesses[userId]) {
        runningProcesses[userId] = {};
    }
    if (!serverStartTime[logKey]) {
        serverStartTime[logKey] = Date.now();
    }
};

// Trim logs to prevent memory issues
const trimLogs = (logs) => {
    if (logs && logs.length > maxLogSize) {
        logs.splice(0, logs.length - maxLogSize);
    }
};

// JSON DB initialization
connectJsonDb();

// Data access layer - using JSON DB directly

class ServerModel {
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
        const row = await JsonServerModel.findOne(query);
        return row ? new ServerModel(row) : null;
    }
    static find(query) {
        return { lean: async () => await JsonServerModel.find(query).lean() };
    }
    async save() { 
        await new JsonServerModel(this).save(); 
        return this; 
    }
    static async deleteOne(query) { 
        return JsonServerModel.deleteOne(query); 
    }
}

class EventLogModel {
    static async create({ timestamp, event, details, detailsText }) {
        return JsonEventLogModel.create({ timestamp, event, details, detailsText });
    }
    static async countDocuments(filter = {}) {
        return JsonEventLogModel.countDocuments(filter);
    }
    static find(filter = {}) {
        return JsonEventLogModel.find(filter);
    }
}

// buildLogFilter removed - now handled in JsonEventLogModel

// --- Helpers: console logs & process state ---
function saveConsoleLog(userId, serverId, content) { try { jsonSaveConsoleLog(userId, serverId, content); } catch (e) { /* ignore */ } }

function getRecentConsoleLogs(userId, serverId, limit = 100) { return jsonGetRecentConsoleLogs(userId, serverId, limit); }
function clearConsoleLogs(userId, serverId) { try { jsonClearConsoleLogs(userId, serverId); } catch (e) { /* ignore */ } }

function setProcessState(userId, serverId, running, startTime) { try { jsonSetProcessState(userId, serverId, running, startTime); } catch (e) { /* ignore */ } }

function clearProcessState(userId, serverId) { try { jsonClearProcessState(userId, serverId); } catch (e) { /* ignore */ } }

function getProcessState(userId, serverId) { return jsonGetProcessState(userId, serverId); }

// Bind JSON-backed models
const User = JsonUserModel;
const Server = JsonServerModel;
const EventLog = JsonEventLogModel;

// Seed admin user if needed
(async () => {
    try {
        const userCount = await User.countDocuments();
        if (userCount === 0) {
            const adminUser = new User({ userId: uuidv4(), username: 'Ebrahim', password: 'dexster12', isAdmin: true });
            await adminUser.save();
            console.log('Admin user created (JSON DB)');
        } else {
            const admin = await User.findOne({ username: 'Ebrahim' });
            if (admin && !admin.isAdmin) { admin.isAdmin = true; await admin.save(); }
        }
    } catch (err) {
        console.error('JSON DB admin seed error:', err);
    }
})();

// All data now uses JSON file-based storage

const logServerEvent = async (event, details) => {
    try {
        await EventLog.create({ timestamp: new Date(), event, details, detailsText: JSON.stringify(details || {}) });
    } catch (err) {
    serverLogs.push({ timestamp: new Date().toISOString(), event, details });
    if (serverLogs.length > maxLogSize) serverLogs.shift();
        console.error('Failed to persist event log to DB, stored in memory instead:', err.message);
    }
};

// Session store - using memory store instead of SQLite
const sessionParser = session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
    // Using memory store (no persistent session storage)
});

app.use(sessionParser);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Initialize server first
const server = app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

// Initialize WebSocket server
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
    sessionParser(request, {}, () => {
        if (!request.session.userId) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });
});

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'ws://localhost');
    const userId = url.searchParams.get('userId');
    const serverId = url.searchParams.get('serverId');

    ws.userId = userId;
    ws.serverId = serverId;

    // Initialize logs for this connection
    if (userId && serverId) {
        initializeServerLogs(userId, serverId);
        const recent = getRecentConsoleLogs(userId, serverId, 100);
        recent.forEach(log => { if (ws.readyState === ws.OPEN) ws.send(log); });
    }

    ws.on('close', () => {
        // Cleanup if needed
    });
});

const ensureLoggedIn = async (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login?error=' + encodeURIComponent('يرجى تسجيل الدخول أولاً'));
    }
    req.userId = req.session.impersonating || req.session.userId;
    req.originalUserId = req.session.userId;
    next();
};

const ensureAdmin = async (req, res, next) => {
    const user = await User.findOne({ userId: req.userId });
    if (!user?.isAdmin) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بالوصول إلى هذه الصفحة'));
    }
    next();
};

const ensureServerAccess = async (req, res, next) => {
    const source = req.method === 'GET' ? req.query : req.body;
    const serverId = source.serverId;
    const targetUserId = source.userId || req.userId;

    // --- Start Debug Log ---
    console.log(`[ensureServerAccess LOG] Method: ${req.method}, Path: ${req.path}`);
    console.log(`[ensureServerAccess LOG] Source ServerID: ${serverId}, Source UserID: ${source.userId}`);
    console.log(`[ensureServerAccess LOG] Target UserID: ${targetUserId}, Actual req.userId: ${req.userId}`);
    // --- End Debug Log ---

    if (!serverId) {
        console.log('[ensureServerAccess LOG] Error: serverId is missing from source.');
        return res.redirect('/?error=' + encodeURIComponent('معرف السيرفر غير محدد'));
    }

    const user = await User.findOne({ userId: req.userId });
    if (!user) {
        return res.redirect('/?error=' + encodeURIComponent('المستخدم غير موجود'));
    }

    const targetUser = await User.findOne({ userId: targetUserId });
    if (!targetUser) {
        return res.redirect('/?error=' + encodeURIComponent('المستخدم المستهدف غير موجود'));
    }

    const server = await Server.findOne({ id: serverId });
    if (!server) {
        // --- Start Debug Log ---
        console.log(`[ensureServerAccess LOG] Error: Server.findOne({ id: "${serverId}" }) returned null.`);
        // --- End Debug Log ---
        return res.redirect('/?error=' + encodeURIComponent('السيرفر غير موجود'));
    }

    if (server.ownerId !== targetUserId) {
        return res.redirect('/?error=' + encodeURIComponent('السيرفر لا ينتمي إلى هذا المستخدم'));
    }

    // Check for server suspension
    if (server.isSuspended && !user.isAdmin) {
        return res.redirect('/?error=' + encodeURIComponent('هذا السيرفر معلق. يرجى التواصل مع الإدارة'));
    }

    req.isServerOwner = server.ownerId === req.userId;
    req.isAdmin = user.isAdmin;
    req.server = server;
    req.targetUserId = targetUserId;

    const serverUsers = server.users || new Map();
    if (req.isServerOwner || req.isAdmin || serverUsers.get(req.userId)) {
        next();
    } else {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بالوصول إلى هذا السيرفر'));
    }
};

const errorPopup = (message) => `
    <div class="bg-red-600 text-white p-4 rounded-lg mb-6 shadow-lg animate-pulse">
        <p><i class="fas fa-exclamation-circle mr-2"></i>${message}</p>
    </div>
`;

const successPopup = (message) => `
    <div class="bg-green-600 text-white p-4 rounded-lg mb-6 shadow-lg animate-pulse">
        <p><i class="fas fa-check-circle mr-2"></i>${message}</p>
    </div>
`;

// Template for auth pages (login/register) without topbar
const authTemplate = (content, title) => `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🚀 Dexster Pro - ${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        * { 
            font-family: 'Inter', sans-serif; 
            box-sizing: border-box;
        }
        
        :root {
            --primary: #3b82f6;
            --primary-dark: #2563eb;
            --secondary: #64748b;
            --accent: #0ea5e9;
            --success: #22c55e;
            --warning: #f59e0b;
            --danger: #ef4444;
            --info: #06b6d4;
            
            --bg-primary: #0f172a;
            --bg-secondary: #1e293b;
            --bg-tertiary: #334155;
            --bg-card: #1e293b;
            --bg-hover: #334155;
            
            --text-primary: #f8fafc;
            --text-secondary: #cbd5e1;
            --text-muted: #94a3b8;
            
            --border: #334155;
            --border-light: #475569;
            
            --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
            --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
            --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
            --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
            --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
        }
        
        body { 
            background: var(--bg-primary); 
            color: var(--text-primary); 
            margin: 0; 
            overflow-x: hidden;
            min-height: 100vh;
        }
        
        /* Subtle Background */
        body::before {
            content: "";
            position: fixed;
            inset: 0;
            background: 
                radial-gradient(600px circle at 20% 30%, rgba(59, 130, 246, 0.05), transparent 50%),
                radial-gradient(400px circle at 80% 70%, rgba(14, 165, 233, 0.05), transparent 50%);
            pointer-events: none;
            z-index: 0;
        }
        
        /* Clean Cards */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
            transition: all 0.2s ease;
        }
        
        .card:hover {
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            border-color: var(--border-light);
        }
        
        /* Clean Buttons */
        .btn {
            padding: 10px 20px;
            border-radius: 8px;
            transition: all 0.2s ease;
            color: var(--text-primary);
            text-align: center;
            border: 1px solid transparent;
            background: transparent;
            font-weight: 500;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            text-decoration: none;
        }
        
        .btn:hover { 
            transform: translateY(-1px); 
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }
        
        .btn-primary { 
            background: var(--primary);
            border-color: var(--primary);
        }
        
        .btn-primary:hover { 
            background: var(--primary-dark);
            border-color: var(--primary-dark);
        }
        
        .btn-success { 
            background: var(--success);
            border-color: var(--success);
        }
        
        .btn-success:hover { 
            background: #16a34a;
            border-color: #16a34a;
        }
        
        /* Form Elements */
        .form-input {
            width: 100%;
            padding: 16px 20px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
            border-radius: 12px;
            color: var(--text-primary);
            margin-bottom: 20px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-size: 16px;
        }
        
        .form-input:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
            background: var(--bg-card);
        }
        
        .form-input::placeholder {
            color: var(--text-muted);
        }
        
        /* Animations */
        .animate-fade-in {
            animation: fadeIn 0.5s ease-out;
        }
        
        .animate-slide-up {
            animation: slideUp 0.5s ease-out;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        
        @keyframes slideUp {
            from { 
                opacity: 0; 
                transform: translateY(20px); 
            }
            to { 
                opacity: 1; 
                transform: translateY(0); 
            }
        }
        
        /* Error/Success Popups */
        .error-popup {
            background: linear-gradient(135deg, #ef4444, #dc2626);
            color: white;
            padding: 16px 20px;
            border-radius: 12px;
            margin-bottom: 24px;
            box-shadow: 0 10px 25px rgba(239, 68, 68, 0.3);
            animation: slideUp 0.3s ease-out;
        }
        
        .success-popup {
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
            padding: 16px 20px;
            border-radius: 12px;
            margin-bottom: 24px;
            box-shadow: 0 10px 25px rgba(16, 185, 129, 0.3);
            animation: slideUp 0.3s ease-out;
        }
        
        /* Responsive Design */
        @media (max-width: 768px) {
            .card { padding: 24px; }
            .form-input { padding: 14px 16px; font-size: 14px; }
        }
    </style>
</head>
<body class="flex flex-col min-h-screen">
    <main class="flex-1 flex items-center justify-center p-4">
        <div class="w-full max-w-md animate-fade-in">
            ${content}
        </div>
    </main>
    
    <footer class="text-center py-6 text-gray-500">
        <div class="flex items-center justify-center gap-2">
            <span>© 2024 Dexster Pro</span>
            <span class="text-xs bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-text text-transparent font-bold">v3.0</span>
        </div>
    </footer>
</body>
</html>`;

const baseTemplate = (content, activePage, user, showSidebar = true, serverId = null, serverName = null, userId = null, server = null, req = null, impersonatedUsername = null) => `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🚀 Dexster Pro - ${activePage}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/xterm/5.2.1/xterm.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/xterm/5.2.1/xterm.css">
    <style>
        * { 
            font-family: 'Inter', sans-serif; 
            box-sizing: border-box;
        }
        
        :root {
            --primary: #3b82f6;
            --primary-dark: #2563eb;
            --secondary: #64748b;
            --accent: #0ea5e9;
            --success: #22c55e;
            --warning: #f59e0b;
            --danger: #ef4444;
            --info: #06b6d4;
            
            --bg-primary: #0f172a;
            --bg-secondary: #1e293b;
            --bg-tertiary: #334155;
            --bg-card: #1e293b;
            --bg-hover: #334155;
            
            --text-primary: #f8fafc;
            --text-secondary: #cbd5e1;
            --text-muted: #94a3b8;
            
            --border: #334155;
            --border-light: #475569;
            
            --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
            --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
            --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
            --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
            --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
        }
        
        body { 
            background: var(--bg-primary); 
            color: var(--text-primary); 
            margin: 0; 
            overflow-x: hidden;
            min-height: 100vh;
        }
        
        /* Subtle Background */
        body::before {
            content: "";
            position: fixed;
            inset: 0;
            background: 
                radial-gradient(600px circle at 20% 30%, rgba(59, 130, 246, 0.05), transparent 50%),
                radial-gradient(400px circle at 80% 70%, rgba(14, 165, 233, 0.05), transparent 50%);
            pointer-events: none;
            z-index: 0;
        }
        
        /* Clean Navbar */
        .navbar {
            position: sticky;
            top: 0;
            z-index: 1000;
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border);
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }
        
        .navbar-inner { 
            max-width: 1400px; 
            margin: 0 auto; 
            padding: 16px 24px; 
            display: flex; 
            align-items: center; 
            justify-content: space-between; 
        }
        
        .brand { 
            display: flex; 
            align-items: center; 
            gap: 12px; 
            font-weight: 600; 
            font-size: 1.25rem;
            color: var(--text-primary);
        }
        
        .nav-links { 
            display: flex; 
            align-items: center; 
            gap: 8px; 
        }
        
        .nav-links a { 
            display: inline-flex; 
            align-items: center; 
            gap: 8px; 
            padding: 10px 16px; 
            border-radius: 8px; 
            color: var(--text-secondary); 
            transition: all 0.2s ease;
            font-weight: 500;
        }
        
        .nav-links a:hover, 
        .nav-links a.active { 
            color: var(--text-primary);
            background: var(--bg-hover);
        }
        
        .nav-links a span {
            position: relative;
            z-index: 1;
        }
        
        .container { 
            max-width: 1400px; 
            margin: 0 auto; 
            padding: 32px 24px; 
            position: relative; 
            z-index: 1; 
        }
        
        .icon {
            width: 20px;
            height: 20px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            z-index: 1;
            margin-left: 8px;
            margin-right: 8px;
        }
        
        .nav-links a:hover .icon { 
            transform: scale(1.1) rotate(5deg); 
        }
        
        /* Modern Cards */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 24px;
            box-shadow: var(--shadow-lg);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }
        
        .card::before {
            content: "";
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--primary), transparent);
            opacity: 0;
            transition: opacity 0.3s ease;
        }
        
        .card:hover {
            transform: translateY(-4px);
            box-shadow: var(--shadow-xl);
            border-color: var(--border-light);
        }
        
        .card:hover::before {
            opacity: 1;
        }
        
        /* Modern Buttons */
        .btn {
            padding: 12px 24px;
            border-radius: 12px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            color: var(--text-primary);
            text-align: center;
            border: 1px solid transparent;
            background: transparent;
            font-weight: 600;
            position: relative;
            overflow: hidden;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        
        .btn::before {
            content: "";
            position: absolute;
            inset: 0;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            opacity: 0;
            transition: opacity 0.3s ease;
            border-radius: 12px;
        }
        
        .btn:hover::before {
            opacity: 0.1;
        }
        
        .btn:hover { 
            transform: translateY(-2px); 
            box-shadow: var(--shadow-lg);
        }
        
        .btn-primary { 
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            border-color: var(--primary);
        }
        
        .btn-primary:hover { 
            background: linear-gradient(135deg, var(--primary-dark), var(--primary));
            box-shadow: 0 10px 25px rgba(99, 102, 241, 0.3);
        }
        
        .btn-success { 
            background: linear-gradient(135deg, var(--success), #059669);
            border-color: var(--success);
        }
        
        .btn-success:hover { 
            background: linear-gradient(135deg, #059669, var(--success));
            box-shadow: 0 10px 25px rgba(16, 185, 129, 0.3);
        }
        
        .btn-danger { 
            background: linear-gradient(135deg, var(--danger), #dc2626);
            border-color: var(--danger);
        }
        
        .btn-danger:hover { 
            background: linear-gradient(135deg, #dc2626, var(--danger));
            box-shadow: 0 10px 25px rgba(239, 68, 68, 0.3);
        }
        
        .btn-warning { 
            background: linear-gradient(135deg, var(--warning), #d97706);
            border-color: var(--warning);
        }
        
        .btn-warning:hover { 
            background: linear-gradient(135deg, #d97706, var(--warning));
            box-shadow: 0 10px 25px rgba(245, 158, 11, 0.3);
        }
        
        .btn-info { 
            background: linear-gradient(135deg, var(--info), #2563eb);
            border-color: var(--info);
        }
        
        .btn-info:hover { 
            background: linear-gradient(135deg, #2563eb, var(--info));
            box-shadow: 0 10px 25px rgba(59, 130, 246, 0.3);
        }
        
        /* Form Elements */
        .form-input {
            width: 100%;
            padding: 14px 18px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
            border-radius: 12px;
            color: var(--text-primary);
            margin-bottom: 16px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-size: 14px;
        }
        
        .form-input:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
            background: var(--bg-card);
        }
        
        .form-input::placeholder {
            color: var(--text-muted);
        }
        
        /* Console Styles */
        .console-container {
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 16px;
            overflow: hidden;
            box-shadow: var(--shadow-xl);
            position: relative;
        }
        
        .console-header {
            background: var(--bg-secondary);
            padding: 16px 20px;
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .console-title {
            display: flex;
            align-items: center;
            gap: 12px;
            font-weight: 600;
            color: var(--text-primary);
        }
        
        .console-controls {
            display: flex;
            gap: 8px;
        }
        
        .console-btn {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            border: none;
            cursor: pointer;
        }
        
        .console-btn.close { background: #ff5f57; }
        .console-btn.minimize { background: #ffbd2e; }
        .console-btn.maximize { background: #28ca42; }
        
        .console-body {
            padding: 20px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 14px;
            line-height: 1.6;
            max-height: 70vh;
            overflow-y: auto;
            background: #0d1117;
        }
        
        .console-log {
            margin-bottom: 8px;
            padding: 4px 0;
            word-wrap: break-word;
        }
        
        .console-log-error { color: #f85149; }
        .console-log-warn { color: #d29922; }
        .console-log-success { color: #3fb950; }
        .console-log-info { color: #58a6ff; }
        .console-log-debug { color: #8b949e; }
        
        /* Terminal Input */
        .terminal-input {
            background: transparent;
            border: none;
            outline: none;
            color: var(--text-primary);
            font-family: 'JetBrains Mono', monospace;
            font-size: 14px;
            width: 100%;
            padding: 8px 0;
        }
        
        .terminal-prompt {
            color: var(--success);
            margin-right: 8px;
        }
        
        /* Animations */
        .animate-fade-in {
            animation: fadeIn 0.5s ease-out;
        }
        
        .animate-slide-up {
            animation: slideUp 0.5s ease-out;
        }
        
        .animate-pulse {
            animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        
        @keyframes slideUp {
            from { 
                opacity: 0; 
                transform: translateY(20px); 
            }
            to { 
                opacity: 1; 
                transform: translateY(0); 
            }
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        /* Responsive Design */
        @media (max-width: 768px) {
            .container { padding: 20px 16px; }
            .navbar-inner { padding: 12px 16px; }
            .nav-links { gap: 4px; }
            .nav-links a { padding: 8px 12px; font-size: 14px; }
            .card { padding: 20px; }
            .console-body { padding: 16px; font-size: 13px; }
        }
        
        /* Scrollbar Styling */
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        
        ::-webkit-scrollbar-track {
            background: var(--bg-secondary);
        }
        
        ::-webkit-scrollbar-thumb {
            background: var(--border-light);
            border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
            background: var(--primary);
        }
        
        /* Loading States */
        .loading {
            position: relative;
            overflow: hidden;
        }
        
        .loading::after {
            content: "";
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
            animation: loading 1.5s infinite;
        }
        
        @keyframes loading {
            0% { left: -100%; }
            100% { left: 100%; }
        }
        
        /* Status Indicators */
        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
        }
        
        .status-online {
            background: rgba(16, 185, 129, 0.1);
            color: var(--success);
            border: 1px solid rgba(16, 185, 129, 0.3);
        }
        
        .status-offline {
            background: rgba(239, 68, 68, 0.1);
            color: var(--danger);
            border: 1px solid rgba(239, 68, 68, 0.3);
        }
        
        .status-loading {
            background: rgba(245, 158, 11, 0.1);
            color: var(--warning);
            border: 1px solid rgba(245, 158, 11, 0.3);
        }
        
        /* Footer */
        footer {
            background: var(--bg-secondary);
            padding: 20px 0;
            color: var(--text-muted);
            width: 100%;
            border-top: 1px solid var(--border);
            margin-top: auto;
        }
        
        .footer-inner { 
            max-width: 1400px; 
            margin: 0 auto; 
            padding: 0 24px; 
            display: flex; 
            align-items: center; 
            justify-content: space-between; 
        }
        
        /* Dropdown Menu */
        .dropdown-menu {
            position: absolute;
            top: 100%;
            right: 0;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 9999;
            padding: 8px 0;
            min-width: 180px;
            display: none;
            margin-top: 4px;
        }
        
        /* Centered variant for dropdown as a popup */
        .dropdown-menu.centered {
            position: fixed;
            top: 50%;
            left: 50%;
            right: auto;
            transform: translate(-50%, -50%);
            margin-top: 0;
            min-width: 260px;
        }
        
        .dropdown-menu.show {
            display: block;
        }
        
        .dropdown-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            color: var(--text-secondary);
            text-decoration: none;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s ease;
            border: none;
            background: none;
            width: 100%;
            text-align: right;
            cursor: pointer;
        }
        
        .dropdown-item:hover { 
            background: var(--bg-hover);
            color: var(--text-primary);
        }
        
        .dropdown-item:first-child {
            border-radius: 8px 8px 0 0;
        }
        
        .dropdown-item:last-child {
            border-radius: 0 0 8px 8px;
        }
        
        /* Modal */
        .modal { 
            position: fixed; 
            inset: 0; 
            background: rgba(0,0,0,0.8); 
            display: none; 
            align-items: center; 
            justify-content: center; 
            z-index: 2000;
            backdrop-filter: blur(10px);
        }
        
        .modal.show { display: flex; }
        
        .modal-content { 
            background: var(--bg-card); 
            border: 1px solid var(--border); 
            border-radius: 16px; 
            padding: 32px; 
            width: 90%;
            max-width: 500px; 
            box-shadow: var(--shadow-xl);
            animation: slideUp 0.3s ease-out;
        }
        
        /* Side Notifications */
        .notification-container {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 9999;
            display: flex;
            flex-direction: column;
            gap: 12px;
            max-width: 400px;
        }
        
        .notification {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 16px 20px;
            box-shadow: var(--shadow-xl);
            backdrop-filter: blur(20px);
            transform: translateX(100%);
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }
        
        .notification.show {
            transform: translateX(0);
            opacity: 1;
        }
        
        .notification::before {
            content: "";
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, var(--primary), var(--secondary));
        }
        
        .notification.success::before {
            background: linear-gradient(90deg, var(--success), #059669);
        }
        
        .notification.error::before {
            background: linear-gradient(90deg, var(--danger), #dc2626);
        }
        
        .notification.warning::before {
            background: linear-gradient(90deg, var(--warning), #d97706);
        }
        
        .notification.info::before {
            background: linear-gradient(90deg, var(--info), #2563eb);
        }
        
        .notification-content {
            display: flex;
            align-items: flex-start;
            gap: 12px;
        }
        
        .notification-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            margin-top: 2px;
        }
        
        .notification.success .notification-icon {
            background: rgba(16, 185, 129, 0.2);
            color: var(--success);
        }
        
        .notification.error .notification-icon {
            background: rgba(239, 68, 68, 0.2);
            color: var(--danger);
        }
        
        .notification.warning .notification-icon {
            background: rgba(245, 158, 11, 0.2);
            color: var(--warning);
        }
        
        .notification.info .notification-icon {
            background: rgba(59, 130, 246, 0.2);
            color: var(--info);
        }
        
        .notification-text {
            flex: 1;
        }
        
        .notification-title {
            font-weight: 600;
            color: var(--text-primary);
            margin-bottom: 4px;
        }
        
        .notification-message {
            color: var(--text-secondary);
            font-size: 14px;
            line-height: 1.4;
        }
        
        .notification-close {
            position: absolute;
            top: 8px;
            left: 8px;
            background: none;
            border: none;
            color: var(--text-muted);
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            transition: all 0.2s ease;
        }
        
        .notification-close:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
        }
        
        .notification-progress {
            position: absolute;
            bottom: 0;
            left: 0;
            height: 2px;
            background: linear-gradient(90deg, var(--primary), var(--secondary));
            border-radius: 0 0 12px 12px;
            animation: notificationProgress 5s linear forwards;
        }
        
        .notification.success .notification-progress {
            background: linear-gradient(90deg, var(--success), #059669);
        }
        
        .notification.error .notification-progress {
            background: linear-gradient(90deg, var(--danger), #dc2626);
        }
        
        .notification.warning .notification-progress {
            background: linear-gradient(90deg, var(--warning), #d97706);
        }
        
        .notification.info .notification-progress {
            background: linear-gradient(90deg, var(--info), #2563eb);
        }
        
        @keyframes notificationProgress {
            from { width: 100%; }
            to { width: 0%; }
        }
        
        /* Responsive notifications */
        @media (max-width: 768px) {
            .notification-container {
                top: 10px;
                right: 10px;
                left: 10px;
                max-width: none;
            }
            
            .notification {
                padding: 14px 16px;
            }
        }
    </style>
</head>
<body class="flex flex-col min-h-screen">
    ${impersonatedUsername ? `
        <div style="position: fixed; top: 0; left: 0; right: 0; z-index: 9999;" class="bg-gradient-to-r from-yellow-400 to-orange-500 text-black p-3 text-center shadow-lg">
            <div class="container mx-auto flex justify-between items-center">
                <span class="font-semibold"><i class="fas fa-user-secret mr-2"></i>أنت الآن تحاكي حساب: <strong>${impersonatedUsername}</strong></span>
                <form action="/stop-impersonating" method="POST" class="inline">
                    <button type="submit" class="bg-red-600 hover:bg-red-700 text-white text-sm py-2 px-4 rounded-lg font-medium transition-all">إنهاء المحاكاة</button>
                </form>
            </div>
        </div>
        <div style="padding-top: 60px;">
    ` : ''}

    <header class="navbar">
        <div class="navbar-inner">
            <div class="brand">
                <i class="fas fa-rocket"></i>
                <span>Dexster Pro</span>
            </div>
            <nav class="nav-links">
                ${serverId && server ? `
                    ${server.users.get(req?.userId)?.viewConsole || user?.isAdmin || server.ownerId === req?.userId ? `
                    <a href="/server?serverId=${serverId}${userId ? `&userId=${userId}` : ''}" class="${activePage === 'الكونسول' ? 'active' : ''}">
                        <i class="fas fa-terminal icon"></i>
                        <span>الكونسول</span>
                    </a>
                    ` : ''}
                    ${server.users.get(req?.userId)?.viewFiles || user?.isAdmin || server.ownerId === req?.userId ? `
                    <a href="/files?serverId=${serverId}${userId ? `&userId=${userId}` : ''}" class="${activePage === 'الملفات' ? 'active' : ''}">
                        <i class="fas fa-folder-open icon"></i>
                        <span>إدارة الملفات</span>
                    </a>
                    ` : ''}
                    ${server.users.get(req?.userId)?.viewSettings || user?.isAdmin || server.ownerId === req?.userId ? `
                    <a href="/settings?serverId=${serverId}${userId ? `&userId=${userId}` : ''}" class="${activePage === 'الإعدادات' ? 'active' : ''}">
                        <i class="fas fa-cog icon"></i>
                        <span>الإعدادات</span>
                    </a>
                    ` : ''}
                    ${server.users.get(req?.userId)?.viewStartup || user?.isAdmin || server.ownerId === req?.userId ? `
                    <a href="/startup?serverId=${serverId}${userId ? `&userId=${userId}` : ''}" class="${activePage === 'بدء التشغيل' ? 'active' : ''}">
                        <i class="fas fa-play-circle icon"></i>
                        <span>بدء التشغيل</span>
                    </a>
                    ` : ''}
                    ${server.users.get(req?.userId)?.viewUsers || user?.isAdmin || server.ownerId === req?.userId ? `
                    <a href="/users?serverId=${serverId}${userId ? `&userId=${userId}` : ''}" class="${activePage === 'المستخدمين' ? 'active' : ''}">
                        <i class="fas fa-users icon"></i>
                        <span>المستخدمين</span>
                    </a>
                    ` : ''}
                    <a href="/" class="text-red-400 hover:text-red-300">
                        <i class="fas fa-arrow-right icon"></i>
                        <span>العودة</span>
                    </a>
                ` : `
                    <a href="/" class="${activePage === 'الرئيسية' ? 'active' : ''}">
                        <i class="fas fa-home icon"></i>
                        <span>الرئيسية</span>
                    </a>
                    <a href="/create-server" class="${activePage === 'إنشاء سيرفر' ? 'active' : ''}">
                        <i class="fas fa-plus-circle icon"></i>
                        <span>إنشاء سيرفر</span>
                    </a>
                    ${user?.isAdmin ? `
                    <a href="/admin" class="${activePage === 'لوحة الإدارة' ? 'active' : ''}">
                        <i class="fas fa-shield-alt icon"></i>
                        <span>لوحة الإدارة</span>
                    </a>
                    ` : ''}
                    <a href="/profile" class="${activePage === 'الملف الشخصي' ? 'active' : ''}">
                        <i class="fas fa-user-circle icon"></i>
                        <span>الملف الشخصي</span>
                    </a>
                    <a href="/logout" class="text-red-400 hover:text-red-300">
                        <i class="fas fa-sign-out-alt icon"></i>
                        <span>تسجيل الخروج</span>
                    </a>
                `}
            </nav>
        </div>
    </header>
    
    <main class="container animate-fade-in">
            ${content}
    </main>

    ${impersonatedUsername ? `
        </div>
    ` : ''}

    <footer>
        <div class="footer-inner">
            <div class="flex items-center gap-4">
                <span>© 2024 Dexster Pro</span>
                <span class="text-xs bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-text text-transparent font-bold">v3.0</span>
            </div>
            <div class="flex items-center gap-4 text-sm">
                <span class="status-indicator status-online">
                    <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                    Online
                </span>
                <span>Powered by Ebrahim</span>
            </div>
        </div>
    </footer>
    
    <!-- Notification Container -->
    <div id="notification-container" class="notification-container"></div>

    <script>
        // Enhanced UI interactions
        document.addEventListener('DOMContentLoaded', function() {
            // Add smooth scrolling
            document.querySelectorAll('a[href^="#"]').forEach(anchor => {
                anchor.addEventListener('click', function (e) {
                    e.preventDefault();
                    document.querySelector(this.getAttribute('href')).scrollIntoView({
                        behavior: 'smooth'
                    });
                });
            });
            
            // Add loading states to buttons
            document.querySelectorAll('.btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    if (!this.classList.contains('loading')) {
                        this.classList.add('loading');
                        setTimeout(() => {
                            this.classList.remove('loading');
                        }, 2000);
                    }
                });
            });
            
            // Add hover effects to cards
            document.querySelectorAll('.card').forEach(card => {
                card.addEventListener('mouseenter', function() {
                    this.style.transform = 'translateY(-4px) scale(1.02)';
                });
                
                card.addEventListener('mouseleave', function() {
                    this.style.transform = 'translateY(0) scale(1)';
                });
            });
            
            // Initialize notification system
            initNotificationSystem();
        });
        
        // Notification System
        function initNotificationSystem() {
            // Check for URL parameters and show notifications
            const urlParams = new URLSearchParams(window.location.search);
            const error = urlParams.get('error');
            const success = urlParams.get('success');
            
            if (error) {
                showNotification('خطأ', decodeURIComponent(error), 'error');
                // Clean URL
                const newUrl = window.location.pathname;
                window.history.replaceState({}, document.title, newUrl);
            }
            
            if (success) {
                showNotification('نجح', decodeURIComponent(success), 'success');
                // Clean URL
                const newUrl = window.location.pathname;
                window.history.replaceState({}, document.title, newUrl);
            }
        }
        
        function showNotification(title, message, type = 'info', duration = 5000) {
            const container = document.getElementById('notification-container');
            if (!container) return;
            
            const notification = document.createElement('div');
            notification.className = \`notification \${type}\`;
            
            const icons = {
                success: 'fas fa-check-circle',
                error: 'fas fa-exclamation-circle',
                warning: 'fas fa-exclamation-triangle',
                info: 'fas fa-info-circle'
            };
            
            notification.innerHTML = \`
                <button class="notification-close" onclick="removeNotification(this)">
                    <i class="fas fa-times"></i>
                </button>
                <div class="notification-content">
                    <div class="notification-icon">
                        <i class="\${icons[type] || icons.info}"></i>
                    </div>
                    <div class="notification-text">
                        <div class="notification-title">\${title}</div>
                        <div class="notification-message">\${message}</div>
                    </div>
                </div>
                <div class="notification-progress"></div>
            \`;
            
            container.appendChild(notification);
            
            // Trigger animation
            setTimeout(() => {
                notification.classList.add('show');
            }, 100);
            
            // Auto remove after duration
            setTimeout(() => {
                removeNotification(notification.querySelector('.notification-close'));
            }, duration);
        }
        
        function removeNotification(closeBtn) {
            const notification = closeBtn.closest('.notification');
            if (!notification) return;
            
            notification.classList.remove('show');
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }
        
        // Global notification functions
        window.showNotification = showNotification;
        window.removeNotification = removeNotification;
    </script>
</body>
</html>
`;

// --- Start: API endpoint for dashboard servers ---
app.get('/api/dashboard-servers', ensureLoggedIn, async (req, res) => {
    const userId = req.userId;
    const user = await User.findOne({ userId: userId });
    if (!user) {
        return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    const showAllServers = req.query.showAll === 'true' && user.isAdmin;
    let serversToShow = [];

    try {
        if (showAllServers) {
            serversToShow = await Server.find().lean();
            serversToShow = await Promise.all(serversToShow.map(async server => {
                const owner = await User.findOne({ userId: server.ownerId });
                const state = getProcessState(server.ownerId, server.id);
                return { ...server, ownerUsername: owner?.username || 'غير معروف', isRunning: state.isRunning };
            }));
        } else {
            serversToShow = await Server.find({
                $or: [
                    { ownerId: userId },
                    { [`users.${userId}`]: { $exists: true } }
                ]
            }).lean();
            serversToShow = await Promise.all(serversToShow.map(async server => {
                const owner = await User.findOne({ userId: server.ownerId });
                const state = getProcessState(server.ownerId, server.id);
                return { ...server, ownerUsername: owner?.username || 'غير معروف', isRunning: state.isRunning };
            }));
        }
        res.json({
            user: { username: user.username, isAdmin: user.isAdmin },
            serversToShow,
            showAllServersQuery: showAllServers // To reflect the query param in response for client-side logic
        });
    } catch (error) {
        console.error('Error fetching dashboard servers API:', error);
        res.status(500).json({ error: 'خطأ في جلب بيانات السيرفرات' });
    }
});
// --- End: API endpoint for dashboard servers ---

app.get('/', ensureLoggedIn, async (req, res) => {
    const user = await User.findOne({ userId: req.userId }); // Needed for baseTemplate
    let impersonatedUsername = null;
    if (req.session.impersonating) {
        try {
            const impersonatedUser = await User.findOne({ userId: req.session.impersonating });
            impersonatedUsername = impersonatedUser ? impersonatedUser.username : 'مستخدم غير معروف';
        } catch (err) {
            console.error("Error fetching impersonated user:", err);
            impersonatedUsername = 'خطأ في جلب الاسم';
        }
    }

    const initialContent = `
        <!-- Hero Section -->
        <div class="text-center mb-8">
            <h1 class="text-4xl font-bold mb-4 text-white">
                <i class="fas fa-server mr-3 text-blue-400"></i>لوحة تحكم السيرفرات
            </h1>
            <p class="text-lg text-gray-400 mb-6">إدارة سيرفراتك بسهولة وأمان</p>
            
            <div class="flex justify-center gap-6 mb-6">
                <div class="flex items-center gap-2 text-sm text-gray-400">
                    <div class="w-2 h-2 bg-green-500 rounded-full"></div>
                    <span>نظام نشط</span>
                </div>
                <div class="flex items-center gap-2 text-sm text-gray-400">
                    <i class="fas fa-shield-alt"></i>
                    <span>أمان متقدم</span>
                </div>
            </div>
        </div>


        <!-- User Info & Controls -->
        <div class="card mb-8">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div class="flex items-center gap-4">
                    <div class="w-12 h-12 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center">
                        <i class="fas fa-user text-white text-xl"></i>
                    </div>
                    <div>
                        <div id="userInfoPlaceholder" class="text-lg font-semibold">
                            <i class="fas fa-spinner fa-spin mr-2"></i>جاري تحميل معلومات المستخدم...
                        </div>
                        <div class="text-sm text-gray-400">لوحة التحكم الرئيسية</div>
                    </div>
                </div>
                <div class="flex items-center gap-4">
            <div id="showAllServersTogglePlaceholder"></div>
                    <a href="/create-server" class="btn btn-primary">
                        <i class="fas fa-plus mr-2"></i>سيرفر جديد
                    </a>
        </div>
            </div>
        </div>

        <!-- Quick Stats -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div class="card text-center">
                <div class="text-2xl font-bold text-blue-400 mb-1" id="totalServers">-</div>
                <div class="text-sm text-gray-400">إجمالي السيرفرات</div>
            </div>
            <div class="card text-center">
                <div class="text-2xl font-bold text-green-400 mb-1" id="runningServers">-</div>
                <div class="text-sm text-gray-400">السيرفرات النشطة</div>
            </div>
            <div class="card text-center">
                <div class="text-2xl font-bold text-yellow-400 mb-1" id="uptime">-</div>
                <div class="text-sm text-gray-400">وقت التشغيل</div>
            </div>
            <div class="card text-center">
                <div class="text-2xl font-bold text-purple-400 mb-1" id="performance">-</div>
                <div class="text-sm text-gray-400">الأداء</div>
            </div>
        </div>

        <!-- Servers Section -->
        <div class="mb-8">
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-2xl font-bold flex items-center gap-3">
                    <i class="fas fa-server text-blue-400"></i>
                    سيرفراتك
                </h2>
                <div class="flex items-center gap-2">
                    <i class="fas fa-filter text-gray-400"></i>
                    <span class="text-sm text-gray-400">فلترة</span>
                </div>
            </div>
            
            <div id="serversListPlaceholder" class="text-center text-gray-400 py-12">
                <div class="animate-pulse">
                    <i class="fas fa-spinner fa-spin fa-3x mb-4 text-blue-400"></i>
                    <p class="text-lg">جاري تحميل السيرفرات...</p>
                </div>
            </div>
        </div>

        <!-- Features Section -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div class="card hover:scale-105 transition-transform duration-300">
                <div class="text-center">
                    <div class="w-16 h-16 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full flex items-center justify-center mx-auto mb-4">
                        <i class="fas fa-terminal text-white text-2xl"></i>
                    </div>
                    <h3 class="text-xl font-semibold mb-2">كونسول متقدم</h3>
                    <p class="text-gray-400">تحكم كامل في سيرفراتك عبر كونسول احترافي مع إمكانيات Terminal متقدمة</p>
                </div>
            </div>
            
            <div class="card hover:scale-105 transition-transform duration-300">
                <div class="text-center">
                    <div class="w-16 h-16 bg-gradient-to-r from-green-500 to-emerald-500 rounded-full flex items-center justify-center mx-auto mb-4">
                        <i class="fas fa-folder-open text-white text-2xl"></i>
                    </div>
                    <h3 class="text-xl font-semibold mb-2">إدارة الملفات</h3>
                    <p class="text-gray-400">نظام إدارة ملفات متطور مع دعم التحرير المباشر والرفع والتحميل</p>
                </div>
            </div>
            
            <div class="card hover:scale-105 transition-transform duration-300">
                <div class="text-center">
                    <div class="w-16 h-16 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full flex items-center justify-center mx-auto mb-4">
                        <i class="fas fa-shield-alt text-white text-2xl"></i>
                    </div>
                    <h3 class="text-xl font-semibold mb-2">أمان متقدم</h3>
                    <p class="text-gray-400">حماية شاملة لسيرفراتك مع نظام صلاحيات متطور ومراقبة مستمرة</p>
                </div>
            </div>
        </div>

        <script>
            document.addEventListener('DOMContentLoaded', async () => {
                const userInfoPlaceholder = document.getElementById('userInfoPlaceholder');
                const showAllServersTogglePlaceholder = document.getElementById('showAllServersTogglePlaceholder');
                const serversListPlaceholder = document.getElementById('serversListPlaceholder');
                
                // Function to fetch and render server data
                async function fetchAndRenderServers(showAll) {
                    serversListPlaceholder.innerHTML = '<i class="fas fa-spinner fa-spin fa-2x mr-2 icon"></i><p>جاري تحميل السيرفرات...</p>';
                    try {
                        const response = await fetch('/api/dashboard-servers?showAll=' + showAll);
                        if (!response.ok) {
                            throw new Error('فشل في جلب البيانات: ' + response.statusText);
                        }
                        const data = await response.json();

                        // Update user info
                        userInfoPlaceholder.innerHTML = \`<i class="fas fa-user mr-2 icon"></i>المستخدم: \${data.user.username}\`;

                        // Update "Show all servers" toggle
                        if (data.user.isAdmin) {
                            showAllServersTogglePlaceholder.innerHTML = \`
                                <label class="flex items-center text-sm">
                                    <input type="checkbox" id="showAllServers" \${data.showAllServersQuery ? 'checked' : ''} class="mr-2 accent-blue-500">
                                    عرض جميع السيرفرات
                                </label>
                            \`;
                            document.getElementById('showAllServers').addEventListener('change', function() {
                                localStorage.setItem('showAllServersPreference', this.checked);
                                fetchAndRenderServers(this.checked);
                            });
                        } else {
                            showAllServersTogglePlaceholder.innerHTML = ''; // Clear if not admin
                        }

                        // Update statistics
                        const totalServers = data.serversToShow.length;
                        const runningServers = data.serversToShow.filter(s => s.isRunning).length;
                        const uptime = runningServers > 0 ? '99.9%' : '0%';
                        const performance = runningServers > 0 ? 'ممتاز' : 'غير متاح';
                        
                        document.getElementById('totalServers').textContent = totalServers;
                        document.getElementById('runningServers').textContent = runningServers;
                        document.getElementById('uptime').textContent = uptime;
                        document.getElementById('performance').textContent = performance;

                        // Update servers list
                        if (data.serversToShow.length === 0) {
                            serversListPlaceholder.innerHTML = \`
                                <div class="text-center py-12">
                                    <div class="w-24 h-24 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-4">
                                        <i class="fas fa-server text-4xl text-gray-600"></i>
                                    </div>
                                    <h3 class="text-xl font-semibold mb-2">لا توجد سيرفرات بعد</h3>
                                    <p class="text-gray-400 mb-6">ابدأ رحلتك بإنشاء سيرفرك الأول</p>
                                    <a href="/create-server" class="btn btn-primary">
                                        <i class="fas fa-plus mr-2"></i>إنشاء سيرفر جديد
                                    </a>
                                </div>
                            \`;
                        } else {
                            serversListPlaceholder.innerHTML = \`
                                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                    \${data.serversToShow.map(server => \`
                                        <div class="card hover:scale-105 transition-all duration-300 group">
                                            <div class="flex items-center justify-between mb-4">
                                                <div class="flex items-center gap-3">
                                                    <div class="w-10 h-10 bg-gradient-to-r from-blue-500 to-purple-500 rounded-lg flex items-center justify-center">
                                                        <i class="fas fa-server text-white"></i>
                                            </div>
                                                    <div>
                                                        <h3 class="text-lg font-semibold">\${server.name}</h3>
                                                        \${data.showAllServersQuery ? \`<p class="text-xs text-gray-400">\${server.ownerUsername}</p>\` : ''}
                                                    </div>
                                                </div>
                                                <div class="flex items-center gap-2">
                                                    <div class="w-3 h-3 rounded-full \${server.isRunning ? 'bg-green-500 animate-pulse' : 'bg-red-500'}"></div>
                                                    <span class="text-xs \${server.isRunning ? 'text-green-400' : 'text-red-400'}">\${server.isRunning ? 'نشط' : 'متوقف'}</span>
                                                </div>
                                            </div>
                                            
                                            <div class="space-y-2 mb-4">
                                                <div class="flex justify-between text-sm">
                                                    <span class="text-gray-400">المعرف:</span>
                                                    <span class="text-gray-300 font-mono">\${server.id.substring(0, 8)}...</span>
                                                </div>
                                                <div class="flex justify-between text-sm">
                                                    <span class="text-gray-400">الحالة:</span>
                                                    <span class="\${server.isRunning ? 'text-green-400' : 'text-red-400'}">\${server.isRunning ? 'يعمل' : 'متوقف'}</span>
                                                </div>
                                            </div>
                                            
                                            <div class="flex gap-2">
                                                <a href="/server?serverId=\${server.id}\${data.showAllServersQuery ? \`&userId=\${server.ownerId}\` : ''}" 
                                                   class="flex-1 btn btn-primary text-center group-hover:bg-blue-600 transition-colors">
                                                    <i class="fas fa-cog mr-2"></i>إدارة
                                                </a>
                                                <a href="/files?serverId=\${server.id}\${data.showAllServersQuery ? \`&userId=\${server.ownerId}\` : ''}" 
                                                   class="btn btn-info">
                                                    <i class="fas fa-folder-open"></i>
                                                </a>
                                            </div>
                                        </div>
                                    \`).join('')}
                                </div>
                            \`;
                        }
                    } catch (error) {
                        console.error('Error fetching servers:', error);
                        serversListPlaceholder.innerHTML = '<p class="text-red-500"><i class="fas fa-exclamation-triangle mr-2"></i> خطأ في تحميل السيرفرات. حاول تحديث الصفحة.</p>';
                        userInfoPlaceholder.innerHTML = '<i class="fas fa-exclamation-triangle text-red-500 mr-2"></i> خطأ';
                    }
                }

                // Initial load
                let showAllPreference = localStorage.getItem('showAllServersPreference') === 'true';
                // If a query param is present, it overrides localStorage for the initial load
                const urlParams = new URLSearchParams(window.location.search);
                const showAllQueryParam = urlParams.get('showAll');

                if (showAllQueryParam !== null) {
                    fetchAndRenderServers(showAllQueryParam === 'true');
                } else {
                    fetchAndRenderServers(showAllPreference);
                }
                 // Clean the URL from showAll after processing
                if (showAllQueryParam !== null) {
                    const newUrl = window.location.pathname; // Keep other params if any, or modify to remove only showAll
                    window.history.replaceState({}, document.title, newUrl);
                }
            });
        </script>
    `;
    res.send(baseTemplate(initialContent, 'الرئيسية', user, true, null, null, null, null, req, impersonatedUsername));
});

app.get('/create-server', ensureLoggedIn, async (req, res) => {
    const user = await User.findOne({ userId: req.userId });

    // --- Fetch impersonated username --- Start
    let impersonatedUsername = null;
    if (req.session.impersonating) {
        try {
            const impersonatedUser = await User.findOne({ userId: req.session.impersonating });
            impersonatedUsername = impersonatedUser ? impersonatedUser.username : 'مستخدم غير معروف';
        } catch (err) {
            console.error("Error fetching impersonated user:", err);
            impersonatedUsername = 'خطأ في جلب الاسم'; 
        }
    }
    // --- Fetch impersonated username --- End

    res.send(baseTemplate(`
        <div class="max-w-4xl mx-auto">
            <!-- Header -->
            <div class="text-center mb-12">
                <h1 class="text-5xl font-bold mb-4 bg-gradient-to-r from-green-400 to-blue-500 bg-clip-text text-transparent">
                    <i class="fas fa-plus-circle mr-4"></i>إنشاء سيرفر جديد
                </h1>
                <p class="text-xl text-gray-400">ابدأ رحلتك مع سيرفرك الأول</p>
            </div>


            <!-- Main Form -->
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <!-- Form Section -->
                <div class="card">
                    <div class="mb-6">
                        <h2 class="text-2xl font-semibold mb-2 flex items-center gap-3">
                            <i class="fas fa-cog text-blue-400"></i>
                            إعدادات السيرفر
                        </h2>
                        <p class="text-gray-400">أدخل تفاصيل السيرفر الجديد</p>
                    </div>

                    <form action="/create-server" method="POST" class="space-y-6">
                        <div>
                            <label class="block text-sm font-medium mb-2 text-gray-300">
                                <i class="fas fa-server mr-2 text-blue-400"></i>
                                اسم السيرفر
                            </label>
                            <input type="text" 
                                   name="serverName" 
                                   class="form-input" 
                                   placeholder="أدخل اسم السيرفر..."
                                   required
                                   autocomplete="off">
                            <p class="text-xs text-gray-500 mt-1">اختر اسماً مميزاً لسيرفرك</p>
                        </div>

                        <div class="flex gap-4">
                            <button type="submit" class="btn btn-success flex-1">
                                <i class="fas fa-rocket mr-2"></i>
                                إنشاء السيرفر
                            </button>
                            <a href="/" class="btn btn-secondary">
                                <i class="fas fa-arrow-right mr-2"></i>
                                إلغاء
                            </a>
                        </div>
            </form>
                </div>

                <!-- Info Section -->
                <div class="space-y-6">
                    <!-- Features -->
                    <div class="card">
                        <h3 class="text-xl font-semibold mb-4 flex items-center gap-2">
                            <i class="fas fa-star text-yellow-400"></i>
                            المميزات المتاحة
                        </h3>
                        <div class="space-y-3">
                            <div class="flex items-center gap-3">
                                <i class="fas fa-check-circle text-green-400"></i>
                                <span>كونسول متقدم مع Terminal كامل</span>
                            </div>
                            <div class="flex items-center gap-3">
                                <i class="fas fa-check-circle text-green-400"></i>
                                <span>إدارة ملفات متطورة</span>
                            </div>
                            <div class="flex items-center gap-3">
                                <i class="fas fa-check-circle text-green-400"></i>
                                <span>نظام صلاحيات متقدم</span>
                            </div>
                            <div class="flex items-center gap-3">
                                <i class="fas fa-check-circle text-green-400"></i>
                                <span>مراقبة الأداء في الوقت الفعلي</span>
                            </div>
                            <div class="flex items-center gap-3">
                                <i class="fas fa-check-circle text-green-400"></i>
                                <span>دعم متعدد المستخدمين</span>
                            </div>
                        </div>
                    </div>

                    <!-- Quick Tips -->
                    <div class="card">
                        <h3 class="text-xl font-semibold mb-4 flex items-center gap-2">
                            <i class="fas fa-lightbulb text-yellow-400"></i>
                            نصائح سريعة
                        </h3>
                        <div class="space-y-3 text-sm text-gray-400">
                            <div class="flex items-start gap-3">
                                <i class="fas fa-info-circle text-blue-400 mt-1"></i>
                                <span>استخدم أسماء واضحة ومميزة لسهولة التعرف على السيرفرات</span>
                            </div>
                            <div class="flex items-start gap-3">
                                <i class="fas fa-info-circle text-blue-400 mt-1"></i>
                                <span>يمكنك إضافة مستخدمين آخرين لإدارة السيرفر بعد إنشائه</span>
                            </div>
                            <div class="flex items-start gap-3">
                                <i class="fas fa-info-circle text-blue-400 mt-1"></i>
                                <span>جميع السيرفرات محمية بنظام أمان متقدم</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `, 'إنشاء سيرفر', user, true, null, null, null, null, req, impersonatedUsername)); // Pass impersonatedUsername
});

app.post('/create-server', ensureLoggedIn, async (req, res) => {
    const { serverName } = req.body;
    const user = await User.findOne({ userId: req.userId });
    const serverId = uuidv4();

    if (!serverName || typeof serverName !== 'string' || serverName.trim() === '') {
        return res.redirect('/create-server?error=' + encodeURIComponent('اسم السيرفر غير صالح'));
    }

    const existingServer = await Server.findOne({ name: serverName, ownerId: req.userId });
    if (existingServer) {
        return res.redirect('/create-server?error=' + encodeURIComponent('اسم السيرفر موجود بالفعل'));
    }

    const newServer = new Server({
        id: serverId,
        name: serverName,
        ownerId: req.userId,
        users: new Map([
            [req.userId, {
                viewConsole: true,
                viewFiles: true,
                editFiles: true,
                viewSettings: true,
                editSettings: true,
                viewUsers: true,
                editUsers: true,
                viewStartup: true,
                editStartup: true
            }]
        ]),
        files: new Map(),
        startupSettings: new Map()
    });

    await newServer.save();
    logServerEvent('إنشاء سيرفر', { userId: req.userId, serverId, serverName });
    res.redirect('/?success=' + encodeURIComponent('تم إنشاء السيرفر بنجاح'));
});

app.post('/delete-server', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, userId } = req.body;
    const targetUserId = userId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    if (!req.isServerOwner && !user.isAdmin) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بحذف السيرفر'));
    }

    if (runningProcesses[targetUserId]?.[serverId]) {
        runningProcesses[targetUserId][serverId].kill();
        delete runningProcesses[targetUserId][serverId];
    }

    await Server.deleteOne({ id: serverId });
    logServerEvent('حذف سيرفر', { userId: req.userId, serverId });
    res.redirect('/?success=' + encodeURIComponent('تم حذف السيرفر بنجاح'));
});

app.get('/server', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.viewConsole) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بمشاهدة الكونسول'));
    }

    const persistedState = getProcessState(userId, serverId);
    const isRunning = persistedState.isRunning || !!runningProcesses[userId]?.[serverId];
    const startTime = persistedState.startTime || serverStartTime[`${userId}-${serverId}`];
    const recentLogs = getRecentConsoleLogs(userId, serverId, 100);

    const queryParams = new URLSearchParams({ serverId });
    if (targetUserId) queryParams.append('userId', targetUserId);

    // --- Fetch impersonated username --- Start
    let impersonatedUsername = null;
    if (req.session.impersonating) {
        try {
            const impersonatedUser = await User.findOne({ userId: req.session.impersonating });
            impersonatedUsername = impersonatedUser ? impersonatedUser.username : 'مستخدم غير معروف';
        } catch (err) {
            console.error("Error fetching impersonated user:", err);
            impersonatedUsername = 'خطأ في جلب الاسم'; 
        }
    }
    // --- Fetch impersonated username --- End

    res.send(baseTemplate(`
        <div class="mb-8">
            <div class="flex items-center justify-between mb-6">
                <div class="flex items-center gap-4">
                    <h1 class="text-4xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                        <i class="fas fa-terminal mr-3"></i>الكونسول 
                    </h1>
                    <div class="status-indicator ${isRunning ? 'status-online' : 'status-offline'}">
                        <div class="w-2 h-2 rounded-full ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-red-500'}"></div>
                        ${isRunning ? 'Online' : 'Offline'}
                    </div>
                </div>
                <div class="text-sm text-gray-400">
                    <i class="fas fa-server mr-2"></i>${server.name}
                </div>
            </div>
            
        </div>

        <!-- Server Control Panel -->
        <div class="card mb-6">
            <div class="flex items-center justify-between mb-4">
                <h2 class="text-xl font-semibold flex items-center gap-2">
                    <i class="fas fa-cogs text-blue-400"></i>
                    لوحة التحكم
                </h2>
                <div class="text-sm text-gray-400">
                    <i class="fas fa-clock mr-1"></i>
                    ${isRunning ? `يعمل منذ ${new Date(startTime).toLocaleString('ar-EG')}` : 'متوقف'}
                </div>
            </div>
            
            <div class="flex flex-wrap gap-3">
                <form action="/start-server" method="POST" class="flex-1 min-w-32">
                <input type="hidden" name="userId" value="${userId}">
                <input type="hidden" name="serverId" value="${serverId}">
                    <button type="submit" class="btn btn-success w-full" ${isRunning ? 'disabled' : ''}>
                        <i class="fas fa-play mr-2"></i>
                        ${isRunning ? 'يعمل' : 'تشغيل'}
                    </button>
            </form>
                
                <form action="/restart-server" method="POST" class="flex-1 min-w-32">
                <input type="hidden" name="userId" value="${userId}">
                <input type="hidden" name="serverId" value="${serverId}">
                    <button type="submit" class="btn btn-primary w-full">
                        <i class="fas fa-redo mr-2"></i>
                        إعادة تشغيل
                    </button>
            </form>
                
                <form action="/stop-server" method="POST" class="flex-1 min-w-32">
                <input type="hidden" name="userId" value="${userId}">
                <input type="hidden" name="serverId" value="${serverId}">
                    <button type="submit" class="btn btn-danger w-full" ${!isRunning ? 'disabled' : ''}>
                        <i class="fas fa-stop mr-2"></i>
                        إيقاف
                    </button>
            </form>
                
                <form action="/kill-server" method="POST" onsubmit="return confirm('⚠️ تحذير: هل أنت متأكد من إيقاف السيرفر قسراً؟\\n\\nقد يؤدي هذا لفقدان بيانات غير محفوظة!');" class="flex-1 min-w-32">
                <input type="hidden" name="userId" value="${userId}">
                <input type="hidden" name="serverId" value="${serverId}">
                    <button type="submit" class="btn btn-warning w-full">
                        <i class="fas fa-skull-crossbones mr-2"></i>
                        قتل العملية
                    </button>
            </form>
        </div>
        </div>

        <!-- Advanced Terminal Console -->
        <div class="console-container">
            <div class="console-header">
                <div class="console-title">
                    <i class="fas fa-terminal text-green-400"></i>
                    <span>Terminal Console</span>
                    <div class="flex items-center gap-2 ml-4">
                        <div class="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                        <span class="text-xs text-gray-400">Live</span>
                    </div>
                </div>
                <div class="console-controls">
                    <button class="console-btn close" onclick="clearConsole()" title="مسح الكونسول"></button>
                    <button class="console-btn minimize" onclick="minimizeConsole()" title="تصغير"></button>
                    <button class="console-btn maximize" onclick="maximizeConsole()" title="تكبير"></button>
                </div>
            </div>
            
            <div class="console-body" id="terminal-container">
                <div id="console-output" class="min-h-96">
                    ${recentLogs.map(log => {
            let className = 'console-log-info';
            if (log.includes('[خطأ]') || log.toLowerCase().includes('error')) className = 'console-log-error';
            else if (log.includes('[تحذير]') || log.toLowerCase().includes('warn')) className = 'console-log-warn';
            else if (log.includes('[تثبيت الحزم]') || log.includes('completed')) className = 'console-log-success';
                        return `<div class="console-log ${className}">${log}</div>`;
                    }).join('')}
                </div>
                
                <!-- Terminal Input Line -->
                <div class="flex items-center mt-4 pt-4 border-t border-gray-700">
                    <span class="terminal-prompt">$</span>
                    <input type="text" id="terminal-input" class="terminal-input" placeholder="أدخل الأمر هنا..." autocomplete="off">
                    <button id="send-command" class="btn btn-primary ml-2 px-4 py-2">
                        <i class="fas fa-paper-plane"></i>
                    </button>
                </div>
            </div>
        </div>

        <!-- Console Tools -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
            <div class="card">
                <h3 class="text-lg font-semibold mb-3 flex items-center gap-2">
                    <i class="fas fa-tools text-blue-400"></i>
                    أدوات سريعة
                </h3>
                <div class="space-y-2">
                    <button onclick="sendQuickCommand('ls -la')" class="btn btn-info w-full text-sm">
                        <i class="fas fa-list mr-2"></i>عرض الملفات
                    </button>
                    <button onclick="sendQuickCommand('pwd')" class="btn btn-info w-full text-sm">
                        <i class="fas fa-map-marker-alt mr-2"></i>المجلد الحالي
                    </button>
                    <button onclick="sendQuickCommand('ps aux')" class="btn btn-info w-full text-sm">
                        <i class="fas fa-tasks mr-2"></i>العمليات النشطة
                    </button>
                    <button onclick="sendQuickCommand('df -h')" class="btn btn-info w-full text-sm">
                        <i class="fas fa-hdd mr-2"></i>مساحة القرص
                    </button>
                </div>
            </div>
            
            <div class="card">
                <h3 class="text-lg font-semibold mb-3 flex items-center gap-2">
                    <i class="fas fa-chart-line text-green-400"></i>
                    إحصائيات
                </h3>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                        <span class="text-gray-400">الحالة:</span>
                        <span class="${isRunning ? 'text-green-400' : 'text-red-400'}">${isRunning ? 'نشط' : 'متوقف'}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-400">وقت التشغيل:</span>
                        <span class="text-white">${isRunning ? Math.floor((Date.now() - startTime) / 1000 / 60) + ' دقيقة' : '0 دقيقة'}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-400">عدد الرسائل:</span>
                        <span class="text-white" id="message-count">${recentLogs.length}</span>
                    </div>
                </div>
            </div>
            
            <div class="card">
                <h3 class="text-lg font-semibold mb-3 flex items-center gap-2">
                    <i class="fas fa-cog text-purple-400"></i>
                    إعدادات الكونسول
                </h3>
                <div class="space-y-3">
                    <label class="flex items-center gap-2">
                        <input type="checkbox" id="auto-scroll" checked class="rounded">
                        <span class="text-sm">التمرير التلقائي</span>
                    </label>
                    <label class="flex items-center gap-2">
                        <input type="checkbox" id="show-timestamps" class="rounded">
                        <span class="text-sm">عرض الطوابع الزمنية</span>
                    </label>
                    <button onclick="exportLogs()" class="btn btn-warning w-full text-sm">
                        <i class="fas fa-download mr-2"></i>تصدير السجلات
                    </button>
                </div>
            </div>
        </div>

        <script>
            // WebSocket connection
            const ws = new WebSocket('ws://' + location.host + '/ws?userId=${userId}&serverId=${serverId}');
            let messageCount = ${recentLogs.length};
            
            // Terminal elements
            const terminalInput = document.getElementById('terminal-input');
            const consoleOutput = document.getElementById('console-output');
            const sendButton = document.getElementById('send-command');
            
            // WebSocket event handlers
            ws.onopen = () => {
                console.log('WebSocket connected');
                addConsoleMessage('تم الاتصال بالكونسول بنجاح', 'console-log-success');
            };
            
            ws.onmessage = (event) => {
                const message = event.data;
                if (message === '__CLEAR_CONSOLE__') {
                    clearConsole();
                    return;
                }
                addConsoleMessage(message);
                messageCount++;
                document.getElementById('message-count').textContent = messageCount;
                
                if (document.getElementById('auto-scroll').checked) {
                    scrollToBottom();
                }
            };
            
            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                addConsoleMessage('خطأ في الاتصال بالكونسول', 'console-log-error');
            };
            
            ws.onclose = () => {
                console.log('WebSocket closed');
                addConsoleMessage('تم قطع الاتصال بالكونسول', 'console-log-warn');
            };
            
            // Terminal input handling
            terminalInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    sendCommand();
                }
            });
            
            sendButton.addEventListener('click', sendCommand);
            
            // Command history
            let commandHistory = [];
            let historyIndex = -1;
            
            terminalInput.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (historyIndex < commandHistory.length - 1) {
                        historyIndex++;
                        terminalInput.value = commandHistory[commandHistory.length - 1 - historyIndex];
                    }
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (historyIndex > 0) {
                        historyIndex--;
                        terminalInput.value = commandHistory[commandHistory.length - 1 - historyIndex];
                    } else if (historyIndex === 0) {
                        historyIndex = -1;
                        terminalInput.value = '';
                    }
                }
            });
            
            function sendCommand() {
                const command = terminalInput.value.trim();
                if (command) {
                    // Add to history
                    commandHistory.push(command);
                    if (commandHistory.length > 50) {
                        commandHistory.shift();
                    }
                    historyIndex = -1;
                    
                    // Send command via WebSocket
                    ws.send(command);
                    
                    // Add to console
                    addConsoleMessage('$ ' + command, 'console-log-info');
                    
                    // Clear input
                    terminalInput.value = '';
                }
            }
            
            function sendQuickCommand(command) {
                terminalInput.value = command;
                sendCommand();
            }
            
            function addConsoleMessage(message, className = 'console-log-info') {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'console-log ' + className;
                
                if (message.includes('<span') || message.includes('<i')) {
                    messageDiv.innerHTML = message;
                } else {
                    messageDiv.textContent = message;
                }
                
                consoleOutput.appendChild(messageDiv);
            }
            
            function scrollToBottom() {
                consoleOutput.scrollTop = consoleOutput.scrollHeight;
            }
            
            function clearConsole() {
                consoleOutput.innerHTML = '';
                messageCount = 0;
                document.getElementById('message-count').textContent = messageCount;
            }
            
            function minimizeConsole() {
                const container = document.getElementById('terminal-container');
                container.style.maxHeight = container.style.maxHeight === '200px' ? '70vh' : '200px';
            }
            
            function maximizeConsole() {
                const container = document.getElementById('terminal-container');
                container.style.maxHeight = container.style.maxHeight === '90vh' ? '70vh' : '90vh';
            }
            
            function exportLogs() {
                const logs = Array.from(consoleOutput.children).map(div => div.textContent).join('\\n');
                const blob = new Blob([logs], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'console-logs-' + new Date().toISOString().slice(0, 19) + '.txt';
                a.click();
                URL.revokeObjectURL(url);
            }
            
            // Auto-focus terminal input
            terminalInput.focus();
            
            // Initial scroll to bottom
            document.addEventListener('DOMContentLoaded', () => {
                scrollToBottom();
            });
        </script>
    `, 'الكونسول', user, true, serverId, server.name, targetUserId, server, req, impersonatedUsername));
});

// --- Start: Helper functions for encoding/decoding file path keys ---
const encodeFilePathKey = (filePath) => filePath.replace(/\./g, '__DOT__');
const decodeFilePathKey = (encodedKey) => encodedKey.replace(/__DOT__/g, '.');
// --- End: Helper functions ---

// --- Add safeId definition for server-side usage ---
const safeId = (str) => str.replace(/[^a-zA-Z0-9_\-]/g, '_');

app.get('/files', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, dir = '', userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.viewFiles) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بمشاهدة الملفات'));
    }

    const files = [];
    const currentPath = dir ? dir.replace(/\\/g, '/') : '';
    const encodedCurrentPath = encodeFilePathKey(currentPath);

    // Store decoded keys to avoid duplicates and easily check for directories
    const decodedEntries = new Set();
    const potentialDirs = new Set();

    for (const encodedFilePath of server.files.keys()) {
        const filePath = decodeFilePathKey(encodedFilePath);
        const relativePath = filePath.replace(/\\/g, '/');

        if (currentPath === '' || relativePath.startsWith(currentPath + '/')) {
            const parts = relativePath.substring(currentPath.length).split('/').filter(p => p);
            if (parts.length > 0) {
                const entryName = parts[0];
                const entryPath = currentPath ? `${currentPath}/${entryName}` : entryName;
                decodedEntries.add(entryPath);
                if (parts.length > 1) {
                    potentialDirs.add(entryPath); // Mark as potential directory
                }
            }
        }
    }

    // Process the unique entries found
    for (const decodedPath of decodedEntries) {
        const name = path.basename(decodedPath);
        const isDir = potentialDirs.has(decodedPath);
                files.push({
                    name,
                    isDir,
            relativePath: decodedPath, // Use decoded path for links/actions
            isZip: !isDir && name.endsWith('.zip')
                });
            }

    // Sort files (optional: folders first, then alphabetically)
    files.sort((a, b) => {
        if (a.isDir !== b.isDir) {
            return a.isDir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });

    const parentDir = dir ? path.dirname(dir).replace(/\\/g, '/') : null;
    const queryParams = new URLSearchParams({ serverId });
    if (targetUserId) queryParams.append('userId', targetUserId);

    // --- Fetch impersonated username --- Start
    let impersonatedUsername = null;
    if (req.session.impersonating) {
        try {
            const impersonatedUser = await User.findOne({ userId: req.session.impersonating });
            impersonatedUsername = impersonatedUser ? impersonatedUser.username : 'مستخدم غير معروف';
        } catch (err) {
            console.error("Error fetching impersonated user:", err);
            impersonatedUsername = 'خطأ في جلب الاسم'; 
        }
    }
    // --- Fetch impersonated username --- End

    res.send(baseTemplate(`
        <h1 class="text-3xl font-bold mb-6"><i class="fas fa-folder-open mr-2 icon"></i>${server.name}</h1>
        ${(req.isServerOwner || user.isAdmin || permissions.editFiles) ? `
            <div class="flex flex-wrap gap-4 mb-6">
                <button onclick="document.getElementById('uploadForm').classList.toggle('hidden')" class="btn btn-primary"><i class="fas fa-upload mr-2 icon"></i>رفع ملف</button>
                <button onclick="document.getElementById('newFileForm').classList.toggle('hidden')" class="btn btn-primary"><i class="fas fa-file mr-2 icon"></i>ملف جديد</button>
                <button onclick="document.getElementById('newFolderForm').classList.toggle('hidden')" class="btn btn-primary"><i class="fas fa-folder-plus mr-2 icon"></i>مجلد جديد</button>
            </div>
            <div id="uploadForm" class="card mb-6 hidden">
                <form id="uploadFormInner" action="/upload-file" method="POST" enctype="multipart/form-data">
                    <input type="hidden" name="userId" value="${userId}">
                    <input type="hidden" name="serverId" value="${serverId}">
                    <input type="hidden" name="dir" value="${dir}">
                    <input type="file" name="file" id="fileInput" class="form-input" required>
                    <button type="submit" class="mt-4 btn btn-success"><i class="fas fa-upload mr-2 icon"></i>رفع</button>
                </form>
                <div id="progressBar" class="hidden w-full bg-slate-600 rounded h-4 mt-2">
                    <div id="progress" class="bg-green-600 h-full rounded" style="width: 0%"></div>
                </div>
            </div>
            <div id="newFileForm" class="card mb-6 hidden">
                <form action="/create-file" method="POST">
                    <input type="hidden" name="userId" value="${userId}">
                    <input type="hidden" name="serverId" value="${serverId}">
                    <input type="hidden" name="dir" value="${dir}">
                    <label class="block text-sm mb-2">اسم الملف</label>
                    <input type="text" name="fileName" class="form-input" required>
                    <button type="submit" class="mt-4 btn btn-success"><i class="fas fa-save mr-2 icon"></i>إنشاء</button>
                </form>
            </div>
            <div id="newFolderForm" class="card mb-6 hidden">
                <form action="/create-folder" method="POST">
                    <input type="hidden" name="userId" value="${userId}">
                    <input type="hidden" name="serverId" value="${serverId}">
                    <input type="hidden" name="dir" value="${dir}">
                    <label class="block text-sm mb-2">اسم المجلد</label>
                    <input type="text" name="folderName" class="form-input" required>
                    <button type="submit" class="mt-4 btn btn-success"><i class="fas fa-save mr-2 icon"></i>إنشاء</button>
                </form>
            </div>
        ` : ''}
        <div class="card relative">
            ${parentDir !== null ? `
                <a href="/files?${queryParams.toString()}&dir=${encodeURIComponent(parentDir)}" class="block p-2 text-blue-400 hover:text-blue-500">
                    <i class="fas fa-arrow-right mr-2 icon"></i>العودة للمجلد الأصلي
                </a>
            ` : ''}
            ${files.length === 0 ? `
                <p class="text-slate-400"><i class="fas fa-exclamation-circle mr-2 icon"></i>لا توجد ملفات</p>
            ` : files.map(file => `
                <div class="flex items-center justify-between p-2 hover:bg-slate-700 rounded file-item" data-path="${file.relativePath}">
                    <div class="flex items-center">
                        ${(req.isServerOwner || user.isAdmin || permissions.editFiles) ? `
                            <input type="checkbox" name="selectedFiles" value="${file.relativePath}" class="mr-2 accent-blue-500" onchange="toggleActionButtons()">
                        ` : ''}
                        <span>
                            ${file.isDir ? `
                                <a href="/files?${queryParams.toString()}&dir=${encodeURIComponent(file.relativePath)}" class="text-blue-400 hover:text-blue-500">
                                    <i class="fas fa-folder mr-2 icon"></i>${file.name}
                                </a>
                            ` : `
                                <a href="/view-file?${queryParams.toString()}&filePath=${encodeURIComponent(file.relativePath)}" class="text-blue-400 hover:text-blue-500">
                                    <i class="fas fa-file mr-2 icon"></i>${file.name}
                                </a>
                            `}
                        </span>
                    </div>
                    ${(req.isServerOwner || user.isAdmin || permissions.editFiles) ? `
                        <div class="relative">
                            <button class="text-slate-400 hover:text-white p-2 rounded-lg hover:bg-gray-700 transition-colors" onclick="toggleDropdown('${safeId(file.relativePath)}')">
                                <i class="fas fa-ellipsis-v icon"></i>
                            </button>
                            <!-- Dropdown Menu -->
                            <div id="dropdown-${safeId(file.relativePath)}" class="dropdown-menu">
                                <a href="/rename-file?${queryParams.toString()}&filePath=${encodeURIComponent(file.relativePath)}" class="dropdown-item">
                                    <i class="fas fa-edit mr-2"></i>إعادة تسمية
                                </a>
                                ${!file.isDir ? `
                                    <a href="/archive-files?${queryParams.toString()}&files=${encodeURIComponent(JSON.stringify([file.relativePath]))}" class="dropdown-item">
                                        <i class="fas fa-file-archive mr-2"></i>أرشفة
                                    </a>
                                    <a href="/download-file?${queryParams.toString()}&filePath=${encodeURIComponent(file.relativePath)}" class="dropdown-item">
                                        <i class="fas fa-download mr-2"></i>تنزيل
                                    </a>
                                ` : ''}
                                ${file.isZip ? `
                                    <a href="/unzip-file?${queryParams.toString()}&filePath=${encodeURIComponent(file.relativePath)}" class="dropdown-item">
                                        <i class="fas fa-file-zipper mr-2"></i>فك الضغط
                                    </a>
                                ` : ''}
                                <button onclick="deleteFile('${file.relativePath}')" class="dropdown-item text-red-400 hover:text-red-300">
                                    <i class="fas fa-trash mr-2"></i>حذف
                                </button>
                            </div>
                        </div>
                    ` : ''}
                </div>
            `).join('')}
            <div id="actionButtons" class="hidden fixed bottom-10 left-1/2 transform -translate-x-1/2 flex space-x-4 z-50">
                <button onclick="archiveSelected()" class="btn btn-primary"><i class="fas fa-file-archive mr-2 icon"></i>أرشفة المحدد</button>
                <button onclick="downloadSelected()" class="btn btn-success"><i class="fas fa-download mr-2 icon"></i>تنزيل المحدد</button>
                <button onclick="deleteSelected()" class="btn btn-danger"><i class="fas fa-trash mr-2 icon"></i>حذف المحدد</button>
            </div>
        </div>
        <script>
            // Keep safeId here for client-side usage
            const safeId = (str) => str.replace(/[^a-zA-Z0-9_\-]/g, '_');

            function toggleDropdown(fileId) {
                // Hide all other dropdowns
                const allDropdowns = document.querySelectorAll('.dropdown-menu');
                allDropdowns.forEach(dropdown => {
                    if (dropdown.id !== "dropdown-" + fileId) {
                        dropdown.classList.remove('show');
                        dropdown.classList.remove('centered');
                    }
                });
                
                // Toggle current dropdown
                const dropdown = document.getElementById("dropdown-" + fileId);
                if (dropdown) {
                    dropdown.classList.toggle('show');
                    if (dropdown.classList.contains('show')) {
                        dropdown.classList.add('centered');
                    } else {
                        dropdown.classList.remove('centered');
                    }
                }
            }
            
            // Close dropdowns when clicking outside
            document.addEventListener('click', function(event) {
                if (!event.target.closest('.dropdown-menu') && !event.target.closest('button[onclick*="toggleDropdown"]')) {
                    const allDropdowns = document.querySelectorAll('.dropdown-menu');
                    allDropdowns.forEach(dropdown => {
                        dropdown.classList.remove('show');
                        dropdown.classList.remove('centered');
                    });
                }
            });
            function toggleActionButtons() {
                const checkboxes = document.querySelectorAll('input[name="selectedFiles"]:checked');
                document.getElementById('actionButtons').classList.toggle('hidden', checkboxes.length === 0);
            }
            function archiveSelected() {
                const selectedFiles = Array.from(document.querySelectorAll('input[name="selectedFiles"]:checked')).map(cb => cb.value);
                if (selectedFiles.length === 0) return alert('يرجى تحديد ملفات أو مجلدات للأرشفة');
                window.location.href = '/archive-files?${queryParams.toString()}&files=' + encodeURIComponent(JSON.stringify(selectedFiles));
            }
            function downloadSelected() {
                const selectedFiles = Array.from(document.querySelectorAll('input[name="selectedFiles"]:checked')).map(cb => cb.value);
                if (selectedFiles.length === 0) return alert('يرجى تحديد ملفات أو مجلدات للتنزيل');
                window.location.href = '/download-files?${queryParams.toString()}&files=' + encodeURIComponent(JSON.stringify(selectedFiles));
            }
            function deleteSelected() {
                const selectedFiles = Array.from(document.querySelectorAll('input[name="selectedFiles"]:checked')).map(cb => cb.value);
                if (selectedFiles.length === 0) return alert('يرجى تحديد ملفات أو مجلدات للحذف');
                if (confirm('هل أنت متأكد من حذف العناصر المحددة؟')) {
                    window.location.href = '/delete-files?${queryParams.toString()}&files=' + encodeURIComponent(JSON.stringify(selectedFiles));
                }
            }
            function deleteFile(filePath) {
                if (confirm('هل أنت متأكد من حذف هذا العنصر؟')) {
                    window.location.href = '/delete-file?${queryParams.toString()}&filePath=' + encodeURIComponent(filePath);
                }
            }
        </script>
    `, 'الملفات', user, true, serverId, server.name, targetUserId, server, req, impersonatedUsername)); // Pass impersonatedUsername
});

app.get('/download-file', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, filePath, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const server = req.server;
    const encodedFilePath = encodeFilePathKey(filePath);

    if (!server.files.has(encodedFilePath)) {
        return res.redirect(`/files?serverId=${serverId}&userId=${userId}&error=الملف غير موجود`);
    }

    const content = Buffer.from(server.files.get(encodedFilePath), 'base64');
    logServerEvent('تنزيل ملف', { userId: req.userId, serverId, file: filePath });
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.send(content);
});

app.get('/unzip-file', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, filePath, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId }); 
    const server = req.server;
    const permissions = server.users.get(req.userId) || {};
    if (!permissions.editFiles && !user.isAdmin && !req.isServerOwner) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بتعديل الملفات'));
    }

    const encodedFilePath = encodeFilePathKey(filePath);
    if (!server.files.has(encodedFilePath)) {
        return res.redirect(`/files?serverId=${serverId}&userId=${userId}&dir=${path.dirname(filePath)}&error=${encodeURIComponent('الملف غير موجود')}`);
    }

    try {
        const fileContent = Buffer.from(server.files.get(encodedFilePath), 'base64');
        const outputDir = path.dirname(filePath);
        const tempDir = path.join(__dirname, 'temp', 'unzip', Date.now().toString());
        await fs.ensureDir(tempDir);
        const tempArchivePath = path.join(tempDir, 'temp-archive');
        await fs.writeFile(tempArchivePath, fileContent);

        // دعم zip و tar.gz
        if (filePath.endsWith('.zip')) {
            await new Promise((resolve, reject) => {
                fs.createReadStream(tempArchivePath)
                    .pipe(unzipper.Extract({ path: tempDir }))
                    .on('close', resolve)
                    .on('error', reject);
            });
        } else if (filePath.endsWith('.tar.gz') || filePath.endsWith('.tgz')) {
            await tar.x({ file: tempArchivePath, cwd: tempDir });
        } else {
            await fs.remove(tempDir);
            return res.redirect(`/files?serverId=${serverId}&userId=${userId}&dir=${outputDir}&error=${encodeURIComponent('صيغة الأرشيف غير مدعومة')}`);
        }

        // قراءة جميع الملفات المستخرجة وإضافتها إلى server.files
        const processExtractedFiles = async (dir) => {
            const files = await fs.readdir(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = await fs.stat(fullPath);
                if (stat.isDirectory()) {
                    await processExtractedFiles(fullPath);
                } else {
                    const relativePath = path.relative(tempDir, fullPath);
                    const serverPath = path.join(outputDir, relativePath).replace(/\\/g, '/');
                    const content = await fs.readFile(fullPath);
                    const encodedServerPath = encodeFilePathKey(serverPath);
                    server.files.set(encodedServerPath, content.toString('base64'));
                }
            }
        };
        await processExtractedFiles(tempDir);
        await fs.remove(tempDir);
                     await server.save(); 
                     logServerEvent('فك ضغط ملف', { userId: req.userId, serverId, filePath });
        res.redirect(`/files?serverId=${serverId}&userId=${userId}&dir=${outputDir}&success=${encodeURIComponent('تم فك الضغط بنجاح')}`);
    } catch (err) {
        console.error('Error unzipping file:', err);
        res.redirect(`/files?serverId=${serverId}&userId=${userId}&dir=${path.dirname(filePath)}&error=${encodeURIComponent('خطأ أثناء فك الضغط')}`);
    }
});

app.get('/rename-file', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, filePath, userId: targetUserIdQuery } = req.query; // Parameters from query for GET
    const userIdToUse = targetUserIdQuery || req.userId; // Determine the user ID to use (target or session)
    const actingUser = await User.findOne({ userId: req.userId }); // The user making the request
    const server = req.server; // Populated by ensureServerAccess

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !actingUser.isAdmin && !permissions.editFiles) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بتعديل الملفات'));
    }

    if (!filePath) {
        const queryParams = new URLSearchParams({ serverId });
        if (targetUserIdQuery) queryParams.append('userId', targetUserIdQuery);
        return res.redirect(`/files?${queryParams.toString()}&error=${encodeURIComponent('مسار الملف غير محدد لإعادة التسمية')}`);
    }

    const encodedFilePath = encodeFilePathKey(filePath);
    const fileExists = server.files.has(encodedFilePath);
    const dirExists = Array.from(server.files.keys()).some(k => k.startsWith(encodedFilePath + encodeFilePathKey('/')));

    if (!fileExists && !dirExists) {
        const queryParams = new URLSearchParams({ serverId });
        if (targetUserIdQuery) queryParams.append('userId', targetUserIdQuery);
        queryParams.append('dir', encodeURIComponent(path.dirname(filePath)));
        return res.redirect(`/files?${queryParams.toString()}&error=${encodeURIComponent('الملف أو المجلد غير موجود')}`);
    }
    
    const currentName = path.basename(filePath);
    const queryParamsForPageLinks = new URLSearchParams({ serverId });
    if (targetUserIdQuery) queryParamsForPageLinks.append('userId', targetUserIdQuery);

    let impersonatedUsername = null;
    if (req.session.impersonating) {
        try {
            const impersonatedUser = await User.findOne({ userId: req.session.impersonating });
            impersonatedUsername = impersonatedUser ? impersonatedUser.username : 'مستخدم غير معروف';
        } catch (err) {
            console.error("Error fetching impersonated user for rename:", err);
            impersonatedUsername = 'خطأ في جلب الاسم';
        }
    }

    res.send(baseTemplate(`
        <h1 class="text-3xl font-bold mb-6"><i class="fas fa-edit mr-2 icon"></i>إعادة تسمية ${currentName}</h1>
        <div class="card max-w-md mx-auto">
            <form action="/rename-file" method="POST">
                <input type="hidden" name="serverId" value="${serverId}">
                <input type="hidden" name="userId" value="${userIdToUse}"> 
                <input type="hidden" name="filePath" value="${filePath}">
                <label class="block text-sm mb-2">الاسم الحالي:</label>
                <input type="text" class="form-input bg-slate-600" value="${currentName}" readonly>
                <label class="block text-sm mb-2 mt-4">الاسم الجديد:</label>
                <input type="text" name="newName" class="form-input" required>
                <div class="flex space-x-4 mt-6">
                    <button type="submit" class="btn btn-success w-full"><i class="fas fa-save mr-2 icon"></i>حفظ الاسم الجديد</button>
                    <a href="/files?${queryParamsForPageLinks.toString()}&dir=${encodeURIComponent(path.dirname(filePath))}" class="btn btn-danger w-full"><i class="fas fa-times mr-2 icon"></i>إلغاء</a>
                </div>
            </form>
        </div>
    `, 'إعادة تسمية', actingUser, true, serverId, server.name, targetUserIdQuery, server, req, impersonatedUsername));
});

app.post('/rename-file', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { filePath, newName, userId: targetUserIdFromInput } = req.body;
    const userIdForLinksAndDb = targetUserIdFromInput || req.userId;
    const actingUser = await User.findOne({ userId: req.userId });
    const server = req.server;

    if (!server || !server.id) {
        console.error('[POST /rename-file CRITICAL] req.server.id is missing! This indicates a problem with ensureServerAccess for POST.');
        return res.redirect('/?error=' + encodeURIComponent('خطأ داخلي حرج، معرف السيرفر مفقود بعد التحقق'));
    }
    const currentServerId = server.id;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !actingUser.isAdmin && !permissions.editFiles) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بتعديل الملفات'));
    }

    if (!newName || typeof newName !== 'string' || newName.trim() === '' || newName.includes('/') || newName.includes('\\\\')) {
        const queryParams = new URLSearchParams({ serverId: currentServerId, filePath });
        if (targetUserIdFromInput) queryParams.append('userId', targetUserIdFromInput);
        return res.redirect(`/rename-file?${queryParams.toString()}&error=${encodeURIComponent('اسم الملف الجديد غير صالح')}`);
    }

    const trimmedNewName = newName.trim();
    const oldPathDir = path.dirname(filePath);
    const newFullFilePath = path.join(oldPathDir, trimmedNewName).replace(/\\\\/g, '/');

    const encodedOldFilePath = encodeFilePathKey(filePath);
    const encodedNewFullFilePath = encodeFilePathKey(newFullFilePath);

    const isFile = server.files.has(encodedOldFilePath);
    const isDirectory = !isFile && Array.from(server.files.keys()).some(k => k.startsWith(encodedOldFilePath + encodeFilePathKey('/')));

    if (!isFile && !isDirectory) {
        const queryParams = new URLSearchParams({ serverId: currentServerId });
        if (targetUserIdFromInput) queryParams.append('userId', targetUserIdFromInput);
        queryParams.append('dir', encodeURIComponent(oldPathDir));
        return res.redirect(`/files?${queryParams.toString()}&error=${encodeURIComponent('الملف أو المجلد الأصلي غير موجود')}`);
    }

    const newPathExistsAsFile = server.files.has(encodedNewFullFilePath);
    const newPathExistsAsDirectory = Array.from(server.files.keys()).some(k => k.startsWith(encodedNewFullFilePath + encodeFilePathKey('/')));

    if (newPathExistsAsFile || newPathExistsAsDirectory) {
        const queryParams = new URLSearchParams({ serverId: currentServerId, filePath });
        if (targetUserIdFromInput) queryParams.append('userId', targetUserIdFromInput);
        return res.redirect(`/rename-file?${queryParams.toString()}&error=${encodeURIComponent('الاسم الجديد موجود بالفعل')}`);
    }
    
    const redirectQueryParams = new URLSearchParams({ serverId: currentServerId });
    if (targetUserIdFromInput) redirectQueryParams.append('userId', targetUserIdFromInput);

    try {
        if (isFile) {
            server.files.set(encodedNewFullFilePath, server.files.get(encodedOldFilePath));
            server.files.delete(encodedOldFilePath);
        } else if (isDirectory) {
            const oldPrefix = encodedOldFilePath + encodeFilePathKey('/');
            const newPrefix = encodedNewFullFilePath + encodeFilePathKey('/');
            const keysToRename = Array.from(server.files.keys()).filter(fp => fp.startsWith(oldPrefix));
            for (const oldKey of keysToRename) {
                const newKey = newPrefix + oldKey.substring(oldPrefix.length);
                server.files.set(newKey, server.files.get(oldKey));
                server.files.delete(oldKey);
            }
        }

        await server.save();
        logServerEvent('إعادة تسمية ملف/مجلد', { userId: req.userId, serverId: currentServerId, oldPath: filePath, newPath: newFullFilePath });
        redirectQueryParams.append('dir', encodeURIComponent(path.dirname(newFullFilePath)));
        redirectQueryParams.append('success', encodeURIComponent('تمت إعادة التسمية بنجاح'));
        res.redirect(`/files?${redirectQueryParams.toString()}`);
    } catch (err) {
        console.error('Error renaming file/folder:', err);
        const errorRedirectParams = new URLSearchParams({ serverId: currentServerId, filePath });
        if (targetUserIdFromInput) errorRedirectParams.append('userId', targetUserIdFromInput);
        errorRedirectParams.append('error',encodeURIComponent('خطأ أثناء إعادة التسمية'));
        res.redirect(`/rename-file?${errorRedirectParams.toString()}`);
    }
});

app.get('/view-file', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, filePath, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId }); // Ensure this is correct
    const server = req.server;
    const permissions = server.users.get(req.userId) || {};
    if (!permissions.viewFiles && !user.isAdmin && !req.isServerOwner) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بمشاهدة الملفات'));
    }

    // Use encoded key for has and get
    const encodedFilePath = encodeFilePathKey(filePath);
    if (!server.files.has(encodedFilePath)) {
        return res.redirect(`/files?serverId=${serverId}&userId=${userId}&dir=${path.dirname(filePath)}&error=الملف غير موجود`);
    }

    // Decode the Base64 content using the encoded key
    const fileBuffer = Buffer.from(server.files.get(encodedFilePath), 'base64');
 
    // Check if the file is likely binary (Keep your isBinaryContent function)
    // function isBinaryContent(buffer) { ... return true/false ... }
    // Assume isBinaryContent function exists elsewhere or define it
    const isBinaryContent = (buffer) => {
        // Simple check: Look for null bytes or common non-text bytes
        // This is not foolproof but a common heuristic.
        const len = Math.min(buffer.length, 512); // Check first 512 bytes
        for (let i = 0; i < len; i++) {
            if (buffer[i] === 0) return true; // Null byte often indicates binary
        }
        // Could add more checks here (e.g., percentage of non-printable ASCII)
        return false;
    };

    if (isBinaryContent(fileBuffer)) {
        // Binary file: Show a message and provide a download link
        const queryParams = new URLSearchParams({ serverId, filePath });
        if (targetUserId) queryParams.append('userId', targetUserId);
        return res.send(baseTemplate(`
            <h1 class="text-3xl font-bold mb-6"><i class="fas fa-file-code mr-2 icon"></i>${path.basename(filePath)}</h1>
            <div class="card">
                <p class="text-slate-400"><i class="fas fa-exclamation-circle mr-2 icon"></i>هذا الملف غير نصي (ملف ثنائي مثل صورة أو ملف تنفيذي) ولا يمكن عرضه مباشرة.</p>
                <a href="/download-file?${queryParams.toString()}" class="mt-4 btn btn-success inline-block"><i class="fas fa-download mr-2 icon"></i>تنزيل الملف</a>
                <a href="/files?serverId=${serverId}&userId=${userId}&dir=${path.dirname(filePath)}" class="mt-4 btn btn-danger inline-block ml-4"><i class="fas fa-arrow-right mr-2 icon"></i>العودة</a>
            </div>
        `, 'عرض ملف', user, true, serverId, server.name, targetUserId, server, req));
    }
 
    // Attempt to detect encoding for text files
    const detectedEncoding = chardet.detect(fileBuffer);
    let fileContent;
    try {
        // If encoding is UTF-8 or similar, decode directly
        if (detectedEncoding && detectedEncoding.toLowerCase().includes('utf-8')) {
            fileContent = fileBuffer.toString('utf8');
        } else if (detectedEncoding && detectedEncoding.toLowerCase().includes('windows-1256')) {
            // Handle Arabic text in Windows-1256 encoding
            const iconv = require('iconv-lite');
            fileContent = iconv.decode(fileBuffer, 'windows-1256');
        } else {
            // Fallback to UTF-8, but log a warning
            console.warn(`Unknown or unsupported encoding detected for file ${filePath}: ${detectedEncoding}. Falling back to UTF-8.`);
            fileContent = fileBuffer.toString('utf8'); // Best guess
        }
    } catch (err) {
        console.error(`Error decoding file ${filePath} with encoding ${detectedEncoding}:`, err);
        // If decoding fails, treat as binary/unviewable
        const queryParams = new URLSearchParams({ serverId, filePath });
        if (targetUserId) queryParams.append('userId', targetUserId);
        return res.send(baseTemplate(`
            <h1 class="text-3xl font-bold mb-6"><i class="fas fa-file-code mr-2 icon"></i>${path.basename(filePath)}</h1>
            <div class="card">
                <p class="text-slate-400"><i class="fas fa-exclamation-circle mr-2 icon"></i>لا يمكن عرض محتوى هذا الملف بسبب مشكلة في الترميز أو لأنه ملف ثنائي.</p>
                <a href="/download-file?${queryParams.toString()}" class="mt-4 btn btn-success inline-block"><i class="fas fa-download mr-2 icon"></i>تنزيل الملف</a>
                <a href="/files?serverId=${serverId}&userId=${userId}&dir=${path.dirname(filePath)}" class="mt-4 btn btn-danger inline-block ml-4"><i class="fas fa-arrow-right mr-2 icon"></i>العودة</a>
            </div>
        `, 'عرض ملف', user, true, serverId, server.name, targetUserId, server, req));
    }
 
    // Highlight the content if it's text
    const highlighted = hljs.highlightAuto(fileContent).value;
    const queryParams = new URLSearchParams({ serverId, filePath });
    if (targetUserId) queryParams.append('userId', targetUserId);
    res.send(baseTemplate(`
        <h1 class="text-3xl font-bold mb-6"><i class="fas fa-file-code mr-2 icon"></i>${path.basename(filePath)}</h1>
        <div class="bg-slate-800 p-4 rounded-lg mb-6">
            <pre><code class="hljs">${highlighted}</code></pre>
        </div>
        ${(permissions.editFiles || user.isAdmin || req.isServerOwner) ? `
            <div class="flex space-x-4">
                <a href="/edit-file?${queryParams.toString()}" class="btn btn-primary"><i class="fas fa-edit mr-2 icon"></i>تعديل</a>
                <a href="/files?serverId=${serverId}&userId=${userId}&dir=${path.dirname(filePath)}" class="btn btn-danger"><i class="fas fa-arrow-right mr-2 icon"></i>العودة</a>
            </div>
        ` : `
            <a href="/files?serverId=${serverId}&userId=${userId}&dir=${path.dirname(filePath)}" class="btn btn-danger"><i class="fas fa-arrow-right mr-2 icon"></i>العودة</a>
        `}
    `, 'عرض ملف', user, true, serverId, server.name, targetUserId, server, req));
});


app.get('/edit-file', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, filePath, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;
    const permissions = server.users.get(req.userId) || {};
    if (!permissions.editFiles && !user.isAdmin && !req.isServerOwner) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بتعديل الملفات'));
    }
    const encodedFilePath = encodeFilePathKey(filePath);

    if (!server.files.has(encodedFilePath)) {
        return res.redirect(`/files?serverId=${serverId}&userId=${userId}&dir=${path.dirname(filePath)}&error=الملف غير موجود`);
    }

    const fileContent = Buffer.from(server.files.get(encodedFilePath), 'base64').toString('utf8');
    const queryParams = new URLSearchParams({ serverId, filePath });
    if (targetUserId) queryParams.append('userId', targetUserId);

    // --- Fetch impersonated username --- Start
    let impersonatedUsername = null;
    if (req.session.impersonating) {
        try {
            const impersonatedUser = await User.findOne({ userId: req.session.impersonating });
            impersonatedUsername = impersonatedUser ? impersonatedUser.username : 'مستخدم غير معروف';
        } catch (err) {
            console.error("Error fetching impersonated user:", err);
            impersonatedUsername = 'خطأ في جلب الاسم'; 
        }
    }
    // --- Fetch impersonated username --- End

    res.send(baseTemplate(`
        <h1 class="text-3xl font-bold mb-6"><i class="fas fa-file-code mr-2 icon"></i>تعديل ${path.basename(filePath)}</h1>
        <form action="/edit-file" method="POST">
            <input type="hidden" name="userId" value="${userId}">
            <input type="hidden" name="serverId" value="${serverId}">
            <input type="hidden" name="filePath" value="${filePath}">
            <textarea name="content" class="w-full h-96 p-4 bg-slate-800 rounded-lg text-white font-mono" required>${fileContent}</textarea>
            <div class="flex space-x-4 mt-4">
                <button type="submit" class="btn btn-success"><i class="fas fa-save mr-2 icon"></i>حفظ</button>
                <a href="/view-file?${queryParams.toString()}" class="btn btn-danger"><i class="fas fa-times mr-2 icon"></i>إلغاء</a>
            </div>
        </form>
    `, 'تعديل ملف', user, true, serverId, server.name, targetUserId, server, req, impersonatedUsername)); // Pass impersonatedUsername
});

app.post('/edit-file', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { userId, serverId, filePath, content } = req.body;
    const targetUserId = userId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;
    const permissions = server.users.get(req.userId) || {};
    if (!permissions.editFiles && !user.isAdmin && !req.isServerOwner) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بتعديل الملفات'));
    }
    const encodedFilePath = encodeFilePathKey(filePath);

    if (!server.files.has(encodedFilePath)) {
        return res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${path.dirname(filePath)}&error=الملف غير موجود`);
    }

    try {
        server.files.set(encodedFilePath, Buffer.from(content, 'utf8').toString('base64'));
        await server.save();
        logServerEvent('تعديل ملف', { userId: req.userId, serverId, filePath });
        res.redirect(`/view-file?serverId=${serverId}&userId=${targetUserId}&filePath=${encodeURIComponent(filePath)}&success=تم تعديل الملف بنجاح`);
    } catch (err) {
        console.error('Error editing file:', err);
        res.redirect(`/edit-file?serverId=${serverId}&userId=${targetUserId}&filePath=${encodeURIComponent(filePath)}&error=خطأ أثناء تعديل الملف`);
    }
});

app.get('/archive-files', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, files, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;
    const permissions = server.users.get(req.userId) || {};
    if (!permissions.editFiles && !user.isAdmin && !req.isServerOwner) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بتعديل الملفات'));
    }

    let filesToArchivePaths; // Decoded paths
    try {
        filesToArchivePaths = JSON.parse(files);
    } catch (err) {
        return res.redirect(`/files?serverId=${serverId}&userId=${userId}&error=خطأ في تحديد الملفات`);
    }

    // Use a fixed directory or ensure /tmp exists and is writable
    const tempDir = path.join(__dirname, 'temp'); 
    await fs.ensureDir(tempDir);
    const zipName = `archive-${Date.now()}.zip`;
    const zipPath = path.join(tempDir, zipName); 
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', async () => {
        try {
            const zipContent = await fs.readFile(zipPath, 'base64');
            const encodedZipName = encodeFilePathKey(zipName); // Encode the archive name itself if storing in root
            server.files.set(encodedZipName, zipContent);
            await server.save();
            await fs.unlink(zipPath);
            logServerEvent('أرشفة ملفات', { userId: req.userId, serverId, files: filesToArchivePaths });
        res.redirect(`/files?serverId=${serverId}&userId=${userId}&success=${encodeURIComponent('تم إنشاء الأرشيف بنجاح')}`);
         } catch(err) {
             console.error('Error processing archive:', err);
             // Attempt to clean up zip file if it exists
             if (await fs.pathExists(zipPath)) { await fs.unlink(zipPath); }
             res.redirect(`/files?serverId=${serverId}&userId=${userId}&error=${encodeURIComponent('خطأ أثناء معالجة الأرشيف')}`);
         }
    });

    archive.on('error', async (err) => {
        console.error('Error archiving files:', err);
         // Attempt to clean up zip file if it exists
        if (await fs.pathExists(zipPath)) { await fs.unlink(zipPath); }
        res.redirect(`/files?serverId=${serverId}&userId=${userId}&error=${encodeURIComponent('خطأ أثناء الأرشفة')}`);
    });

    archive.pipe(output);
    for (const filePath of filesToArchivePaths) {
        const encodedFilePath = encodeFilePathKey(filePath);
        if (server.files.has(encodedFilePath)) {
            // Add file
            archive.append(Buffer.from(server.files.get(encodedFilePath), 'base64'), { name: filePath }); // Use original path in archive
        } else {
            // Check if it's a directory by looking for keys starting with its prefix
            const prefix = encodedFilePath + encodeFilePathKey('/');
            const isDir = Array.from(server.files.keys()).some(fp => fp.startsWith(prefix));
            if (isDir) {
                // Add directory contents
                for (const [key, value] of server.files) {
                    if (key.startsWith(prefix)) {
                        const decodedKey = decodeFilePathKey(key);
                        archive.append(Buffer.from(value, 'base64'), { name: decodedKey }); // Use original path in archive
                    }
                }
            }
        }
    }
    archive.finalize();
});

app.get('/download-files', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, files, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;
    const permissions = server.users.get(req.userId) || {};
    if (!permissions.viewFiles && !user.isAdmin && !req.isServerOwner) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بمشاهدة الملفات'));
    }

    let filesToDownloadPaths; // Decoded paths
    try {
        filesToDownloadPaths = JSON.parse(files);
    } catch (err) {
        return res.redirect(`/files?serverId=${serverId}&userId=${userId}&error=خطأ في تحديد الملفات`);
    }

    // Handle single file download directly
    if (filesToDownloadPaths.length === 1) {
         const singleFilePath = filesToDownloadPaths[0];
         const encodedSingleFilePath = encodeFilePathKey(singleFilePath);
         // Check if it's a file (not a directory)
         if (server.files.has(encodedSingleFilePath)) {
            const content = Buffer.from(server.files.get(encodedSingleFilePath), 'base64');
            logServerEvent('تنزيل ملف', { userId: req.userId, serverId, file: singleFilePath });
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(singleFilePath)}"`);
        return res.send(content);
         }
         // If it's not a file or doesn't exist as a key, it might be a directory, proceed to zipping.
    }

    // Use a fixed directory or ensure /tmp exists and is writable
    const tempDir = path.join(__dirname, 'temp'); 
    await fs.ensureDir(tempDir);
    const zipName = `download-${Date.now()}.zip`;
    const zipPath = path.join(tempDir, zipName); 
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', async () => {
        logServerEvent('تنزيل ملفات', { userId: req.userId, serverId, files: filesToDownloadPaths });
        res.download(zipPath, zipName, async (err) => {
            if (err) {
                console.error('Error sending download:', err);
                 // Optional: send an error message if headers weren't sent
            }
            // Clean up the zip file
            try {
               await fs.unlink(zipPath);
            } catch (unlinkErr) {
                console.error('Error deleting temporary download zip:', unlinkErr);
            }
        });
    });

    archive.on('error', async (err) => {
        console.error('Error archiving files for download:', err);
        // Attempt to clean up zip file if it exists
        try {
            if (await fs.pathExists(zipPath)) { await fs.unlink(zipPath); }
        } catch (unlinkErr) {
            console.error('Error deleting temporary download zip after error:', unlinkErr);
        }
        res.redirect(`/files?serverId=${serverId}&userId=${userId}&error=${encodeURIComponent('خطأ أثناء التنزيل')}`);
    });

    archive.pipe(output);
    for (const filePath of filesToDownloadPaths) {
        const encodedFilePath = encodeFilePathKey(filePath);
        if (server.files.has(encodedFilePath)) {
            // Add file
             archive.append(Buffer.from(server.files.get(encodedFilePath), 'base64'), { name: filePath }); // Use original path in archive
        } else {
             // Check if it's a directory by looking for keys starting with its prefix
            const prefix = encodedFilePath + encodeFilePathKey('/');
            const isDir = Array.from(server.files.keys()).some(fp => fp.startsWith(prefix));
            if (isDir) {
                 // Add directory contents
                for (const [key, value] of server.files) {
                    if (key.startsWith(prefix)) {
                        const decodedKey = decodeFilePathKey(key);
                        archive.append(Buffer.from(value, 'base64'), { name: decodedKey }); // Use original path in archive
                    }
                }
            }
        }
    }
    archive.finalize();
});

app.get('/delete-file', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, filePath, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;
    const permissions = server.users.get(req.userId) || {};
    if (!permissions.editFiles && !user.isAdmin && !req.isServerOwner) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بتعديل الملفات'));
    }
    const encodedFilePath = encodeFilePathKey(filePath);

    // Check if file or directory exists
     const prefix = encodedFilePath + encodeFilePathKey('/');
     const fileExists = server.files.has(encodedFilePath);
     const dirExists = Array.from(server.files.keys()).some(fp => fp.startsWith(prefix));

    if (!fileExists && !dirExists) {
        return res.redirect(`/files?serverId=${serverId}&userId=${userId}&dir=${path.dirname(filePath)}&error=الملف أو المجلد غير موجود`);
    }

    try {
        let deletedCount = 0;
        // Delete the file itself if it exists
        if (fileExists) {
            server.files.delete(encodedFilePath);
            deletedCount++;
        }
        // Delete all files within the directory (if it's a directory)
        const keysToDelete = Array.from(server.files.keys()).filter(fp => fp.startsWith(prefix));
        keysToDelete.forEach(fp => {
            server.files.delete(fp);
            deletedCount++;
        });
        
        if (deletedCount > 0) {
           await server.save();
           logServerEvent('حذف ملف/مجلد', { userId: req.userId, serverId, filePath });
        }
        res.redirect(`/files?serverId=${serverId}&userId=${userId}&dir=${path.dirname(filePath)}&success=تم الحذف بنجاح`);
    } catch (err) {
        console.error('Error deleting file/folder:', err);
        res.redirect(`/files?serverId=${serverId}&userId=${userId}&dir=${path.dirname(filePath)}&error=خطأ أثناء الحذف`);
    }
});

app.get('/delete-files', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, files, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;
    const permissions = server.users.get(req.userId) || {};
    if (!permissions.editFiles && !user.isAdmin && !req.isServerOwner) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بتعديل الملفات'));
    }

    let filesToDeletePaths; // Decoded paths
    try {
        filesToDeletePaths = JSON.parse(files);
    } catch (err) {
        return res.redirect(`/files?serverId=${serverId}&userId=${userId}&error=خطأ في تحديد الملفات`);
    }

    try {
        let deletedCount = 0;
        for (const filePath of filesToDeletePaths) {
            const encodedFilePath = encodeFilePathKey(filePath);
            const prefix = encodedFilePath + encodeFilePathKey('/');
            
            // Delete the file itself
            if (server.files.has(encodedFilePath)) {
                server.files.delete(encodedFilePath);
                deletedCount++;
            }
            // Delete directory contents
            const keysToDelete = Array.from(server.files.keys()).filter(fp => fp.startsWith(prefix));
            keysToDelete.forEach(fp => {
                 server.files.delete(fp);
                 deletedCount++;
             });
        }

        if (deletedCount > 0) {
            await server.save();
            logServerEvent('حذف ملفات/مجلدات', { userId: req.userId, serverId, files: filesToDeletePaths });
        }
        // Redirect to the parent directory of the first deleted item, or root
        const parentDir = filesToDeletePaths.length > 0 ? path.dirname(filesToDeletePaths[0]) : '';
        res.redirect(`/files?serverId=${serverId}&userId=${userId}&dir=${encodeURIComponent(parentDir)}&success=${encodeURIComponent('تم حذف الملفات بنجاح')}`);
    } catch (err) {
        console.error('Error deleting files/folders:', err);
        res.redirect(`/files?serverId=${serverId}&userId=${userId}&error=${encodeURIComponent('خطأ أثناء الحذف')}`);
    }
});

app.post('/upload-file', ensureLoggedIn, async (req, res) => {
    try {
        const form = formidable({
            uploadDir: path.join(__dirname, 'temp'),
            keepExtensions: true,
            maxFileSize: 50 * 1024 * 1024 // Example: 50MB limit
        });

        const [fields, files] = await new Promise((resolve, reject) => {
            form.parse(req, (err, fields, files) => {
                if (err) reject(err);
                else resolve([fields, files]);
            });
        });

        const userId = fields.userId?.[0] || req.originalUserId;
        const serverId = fields.serverId?.[0];
        const dir = fields.dir?.[0] || '';
        const targetUserId = userId; // For checking server ownership

        // --- Start: Added Access Control Logic --- 
        if (!serverId) {
            console.error('Upload Error: No serverId provided in form fields');
             // Clean up temp file if it exists
            if (files.file && files.file[0] && await fs.pathExists(files.file[0].filepath)) { await fs.unlink(files.file[0].filepath); }
            return res.redirect(`/files?error=${encodeURIComponent('معرف السيرفر غير محدد في الطلب')}`);
        }

        const requestingUser = await User.findOne({ userId: req.originalUserId }); // Use originalUserId for permission check
        if (!requestingUser) {
            console.error(`Upload Error: Requesting user ${req.originalUserId} not found`);
             // Clean up temp file if it exists
            if (files.file && files.file[0] && await fs.pathExists(files.file[0].filepath)) { await fs.unlink(files.file[0].filepath); }
            return res.redirect('/?error=' + encodeURIComponent('المستخدم الطالب غير موجود'));
        }

        const server = await Server.findOne({ id: serverId }); // Keep this declaration
        if (!server) {
            console.error(`Upload Error: Server ${serverId} not found`);
             // Clean up temp file if it exists
            if (files.file && files.file[0] && await fs.pathExists(files.file[0].filepath)) { await fs.unlink(files.file[0].filepath); }
            return res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&error=${encodeURIComponent('السيرفر غير موجود')}`);
        }

        // Re-check ownership if targetUserId is different from requesting user (impersonation)
        if (server.ownerId !== targetUserId) {
             console.error(`Upload Error: Server ${serverId} does not belong to target user ${targetUserId}`);
              // Clean up temp file if it exists
             if (files.file && files.file[0] && await fs.pathExists(files.file[0].filepath)) { await fs.unlink(files.file[0].filepath); }
             return res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&error=${encodeURIComponent('السيرفر لا ينتمي إلى هذا المستخدم')}`);
        }

        const isServerOwner = server.ownerId === req.originalUserId;
        const isAdmin = requestingUser.isAdmin;
        const userPermissions = server.users.get(req.originalUserId) || {}; // Renamed to avoid conflict
        const canEditFiles = isServerOwner || isAdmin || userPermissions.editFiles;

        if (!canEditFiles) {
            console.error(`Upload Error: User ${req.originalUserId} not authorized to edit files for server ${serverId}`);
             // Clean up temp file if it exists
            if (files.file && files.file[0] && await fs.pathExists(files.file[0].filepath)) { await fs.unlink(files.file[0].filepath); }
            return res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&error=غير مصرح لك بتعديل الملفات`);
        }
        // --- End: Added Access Control Logic ---

        if (!files.file || files.file.length === 0) {
            return res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&error=لم يتم تحديد ملف للرفع`);
        }

        const file = files.file[0];
        const newPath = path.join(dir, file.originalFilename || path.basename(file.filepath)).replace(/\\/g, '/');
        // Use encoded key for set
        const encodedNewPath = encodeFilePathKey(newPath); 

        try {
            const content = fs.readFileSync(file.filepath);
            // Use encoded key for set
            server.files.set(encodedNewPath, content.toString('base64')); 
            await server.save();
            fs.unlinkSync(file.filepath); // Clean up temp file
        } catch (err) {
            console.error(`Failed to process file ${newPath}:`, err);
             // Clean up temp file if it exists
            if (await fs.pathExists(file.filepath)) { await fs.unlink(file.filepath); }
            return res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&error=خطأ أثناء رفع الملف`);
        }

        logServerEvent('رفع ملف', {
            userId: req.originalUserId, // Log the actual user who performed the action
            serverId,
            file: file.originalFilename || path.basename(newPath)
        });

        res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&success=تم رفع الملف بنجاح`);
    } catch (error) {
        console.error('Error uploading file:', error);
        // Attempt to clean up temp file if form parsing failed early or fields/files are unavailable
        // This part is tricky as req.files might not be populated depending on where error occurred
        res.redirect(`/files?error=${encodeURIComponent('حدث خطأ أثناء رفع الملف')}`);
    }
});

app.post('/create-file', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { userId, serverId, dir, fileName } = req.body;
    const targetUserId = userId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;
    const permissions = server.users.get(req.userId) || {};
    if (!permissions.editFiles && !user.isAdmin && !req.isServerOwner) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بتعديل الملفات'));
    }

    const newFilePath = path.join(dir, fileName).replace(/\\/g, '/');
    const encodedNewFilePath = encodeFilePathKey(newFilePath);

    if (server.files.has(encodedNewFilePath)) {
        return res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&error=الملف موجود بالفعل`);
    }

    try {
        server.files.set(encodedNewFilePath, Buffer.from('').toString('base64'));
        await server.save();
        logServerEvent('إنشاء ملف', { userId: req.userId, serverId, filePath: newFilePath });
        res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&success=تم إنشاء الملف بنجاح`);
    } catch (err) {
        console.error('Error creating file:', err);
        res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&error=خطأ أثناء إنشاء الملف`);
    }
});

app.post('/create-folder', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { userId, serverId, dir, folderName } = req.body;
    const targetUserId = userId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;
    const permissions = server.users.get(req.userId) || {};
    if (!permissions.editFiles && !user.isAdmin && !req.isServerOwner) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بتعديل الملفات'));
    }

    const newFolderPath = path.join(dir, folderName).replace(/\\/g, '/');
    const encodedFolderPath = encodeFilePathKey(newFolderPath);
    const prefix = encodedFolderPath + encodeFilePathKey('/');

    // Check if folder (or a file with the same name) exists
    if (server.files.has(encodedFolderPath) || Array.from(server.files.keys()).some(fp => fp.startsWith(prefix))) {
        return res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&error=المجلد أو الملف موجود بالفعل`);
    }

    try {
        // No need to add a placeholder file for Map type
        // Simply creating paths starting with the folder path implies its existence.
        // We might add an empty entry if we really need to represent empty folders,
        // but the listing logic handles it implicitly now.
        // server.files.set(prefix + '.keep', Buffer.from('').toString('base64'));
        // await server.save(); // No save needed if nothing is added
        logServerEvent('إنشاء مجلد', { userId: req.userId, serverId, folderPath: newFolderPath });
        res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&success=تم إنشاء المجلد بنجاح (فارغ)`);
    } catch (err) {
        console.error('Error creating folder (log only):', err); // Log error but proceed
        res.redirect(`/files?serverId=${serverId}&userId=${targetUserId}&dir=${dir}&error=خطأ أثناء إنشاء المجلد`);
    }
});

app.get('/settings', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.viewSettings) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بمشاهدة الإعدادات'));
    }

    const queryParams = new URLSearchParams({ serverId });
    if (targetUserId) queryParams.append('userId', targetUserId);

    // --- Fetch impersonated username --- Start
    let impersonatedUsername = null;
    if (req.session.impersonating) {
        try {
            const impersonatedUser = await User.findOne({ userId: req.session.impersonating });
            impersonatedUsername = impersonatedUser ? impersonatedUser.username : 'مستخدم غير معروف';
        } catch (err) {
            console.error("Error fetching impersonated user:", err);
            impersonatedUsername = 'خطأ في جلب الاسم'; 
        }
    }
    // --- Fetch impersonated username --- End

    res.send(baseTemplate(`
        <h1 class="text-3xl font-bold mb-6"><i class="fas fa-cog mr-2 icon"></i>إعدادات ${server.name}</h1>
        <div class="card max-w-md mx-auto">
            ${(req.isServerOwner || user.isAdmin || permissions.editSettings) ? `
                <form action="/update-settings" method="POST">
                    <input type="hidden" name="userId" value="${userId}">
                    <input type="hidden" name="serverId" value="${serverId}">
                    <label class="block text-sm mb-2">اسم السيرفر</label>
                    <input type="text" name="serverName" class="form-input" value="${server.name}" required>
                    <button type="submit" class="mt-4 btn btn-success w-full"><i class="fas fa-save mr-2 icon"></i>حفظ</button>
                </form>
                <form action="/delete-server" method="POST" class="mt-4" onsubmit="return confirm('هل أنت متأكد من حذف هذا السيرفر؟');">
                    <input type="hidden" name="userId" value="${userId}">
                    <input type="hidden" name="serverId" value="${serverId}">
                    <button type="submit" class="btn btn-danger w-full"><i class="fas fa-trash mr-2 icon"></i>حذف السيرفر</button>
                </form>
            ` : `
                <p class="text-slate-400"><i class="fas fa-exclamation-circle mr-2 icon"></i>لا يمكنك تعديل الإعدادات</p>
            `}
        </div>
    `, 'الإعدادات', user, true, serverId, server.name, targetUserId, server, req, impersonatedUsername)); // Pass impersonatedUsername
});

app.post('/update-settings', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { userId, serverId, serverName } = req.body;
    const targetUserId = userId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.editSettings) {
        return res.redirect('/?error=' + encodeURIComponent('غير مصرح لك بتعديل الإعدادات'));
    }

    if (!serverName || typeof serverName !== 'string' || serverName.trim() === '') {
        return res.redirect(`/settings?serverId=${serverId}&userId=${targetUserId}&error=اسم السيرفر غير صالح`);
    }

    const existingServer = await Server.findOne({ name: serverName, ownerId: targetUserId, id: { $ne: serverId } });
    if (existingServer) {
        return res.redirect(`/settings?serverId=${serverId}&userId=${targetUserId}&error=اسم السيرفر موجود بالفعل`);
    }

    try {
    server.name = serverName;
        await server.save();
    logServerEvent('تعديل إعدادات السيرفر', { userId: req.userId, serverId, serverName });
    res.redirect(`/settings?serverId=${serverId}&userId=${targetUserId}&success=تم تحديث الإعدادات بنجاح`);
    } catch (err) {
        console.error('Error updating settings:', err);
        res.redirect(`/settings?serverId=${serverId}&userId=${targetUserId}&error=خطأ أثناء تحديث الإعدادات`);
    }
});

app.get('/users', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.viewUsers) {
        return res.redirect('/?error=غير مصرح لك بمشاهدة المستخدمين');
    }

    const queryParams = new URLSearchParams({ serverId });
    if (targetUserId) queryParams.append('userId', targetUserId);

    // --- Fetch impersonated username --- Start
    let impersonatedUsername = null;
    if (req.session.impersonating) {
        try {
            const impersonatedUser = await User.findOne({ userId: req.session.impersonating });
            impersonatedUsername = impersonatedUser ? impersonatedUser.username : 'مستخدم غير معروف';
        } catch (err) {
            console.error("Error fetching impersonated user:", err);
            impersonatedUsername = 'خطأ في جلب الاسم'; 
        }
    }
    // --- Fetch impersonated username --- End

    res.send(baseTemplate(`
        <h1 class="text-3xl font-bold mb-6"><i class="fas fa-users mr-2 icon"></i>مستخدمو ${server.name}</h1>
        ${(req.isServerOwner || user.isAdmin || permissions.editUsers) ? `
            <div class="mb-6">
                <button onclick="document.getElementById('addUserForm').classList.toggle('hidden')" class="btn btn-primary"><i class="fas fa-user-plus mr-2 icon"></i>إضافة مستخدم</button>
            </div>
            <div id="addUserForm" class="card mb-6 hidden max-w-md mx-auto">
                <form action="/add-user" method="POST">
                    <input type="hidden" name="userId" value="${userId}">
                    <input type="hidden" name="serverId" value="${serverId}">
                    <label class="block text-sm mb-2">اسم المستخدم</label>
                    <input type="text" name="username" class="form-input" required>
                    <label class="block text-sm mb-2 mt-4">الأذونات</label>
                    <div class="grid grid-cols-2 gap-4">
                        <label class="flex items-center"><input type="checkbox" name="viewConsole" class="mr-2 accent-blue-500">عرض الكونسول</label>
                        <label class="flex items-center"><input type="checkbox" name="viewFiles" class="mr-2 accent-blue-500">عرض الملفات</label>
                        <label class="flex items-center"><input type="checkbox" name="editFiles" class="mr-2 accent-blue-500">تعديل الملفات</label>
                        <label class="flex items-center"><input type="checkbox" name="viewSettings" class="mr-2 accent-blue-500">عرض الإعدادات</label>
                        <label class="flex items-center"><input type="checkbox" name="editSettings" class="mr-2 accent-blue-500">تعديل الإعدادات</label>
                        <label class="flex items-center"><input type="checkbox" name="viewUsers" class="mr-2 accent-blue-500">عرض المستخدمين</label>
                        <label class="flex items-center"><input type="checkbox" name="editUsers" class="mr-2 accent-blue-500">تعديل المستخدمين</label>
                        <label class="flex items-center"><input type="checkbox" name="viewStartup" class="mr-2 accent-blue-500">عرض بدء التشغيل</label>
                        <label class="flex items-center"><input type="checkbox" name="editStartup" class="mr-2 accent-blue-500">تعديل بدء التشغيل</label>
                    </div>
                    <button type="submit" class="mt-4 btn btn-success w-full"><i class="fas fa-user-plus mr-2 icon"></i>إضافة</button>
                </form>
            </div>
        ` : ''}
        <div class="card">
            <h2 class="text-xl font-semibold mb-4">المستخدمون الحاليون</h2>
            ${server.users.size === 0 ? `
                <p class="text-slate-400"><i class="fas fa-exclamation-circle mr-2 icon"></i>لا يوجد مستخدمون</p>
            ` : `
                <div class="space-y-4">
                    ${await Promise.all(Array.from(server.users.entries()).map(async ([uid, perms]) => {
                        const u = await User.findOne({ userId: uid });
                        const username = u?.username || 'مستخدم غير معروف';
                        return `
                            <div class="flex items-center justify-between p-4 bg-slate-700 rounded-lg">
                                <div>
                                    <p class="font-semibold">${username}</p>
                                    <p class="text-sm text-slate-400">الأذونات: ${
                                        [
                                            perms.viewConsole ? 'عرض الكونسول' : '',
                                            perms.viewFiles ? 'عرض الملفات' : '',
                                            perms.editFiles ? 'تعديل الملفات' : '',
                                            perms.viewSettings ? 'عرض الإعدادات' : '',
                                            perms.editSettings ? 'تعديل الإعدادات' : '',
                                            perms.viewUsers ? 'عرض المستخدمين' : '',
                                            perms.editUsers ? 'تعديل المستخدمين' : '',
                                            perms.viewStartup ? 'عرض بدء التشغيل' : '',
                                            perms.editStartup ? 'تعديل بدء التشغيل' : ''
                                        ].filter(p => p).join(', ') || 'لا توجد أذونات'
                                    }</p>
                                </div>
                                ${(req.isServerOwner || user.isAdmin || permissions.editUsers) && uid !== server.ownerId ? `
                                    <div class="flex space-x-2">
                                        <a href="/edit-user?${queryParams.toString()}&targetUserId=${uid}" class="btn btn-primary"><i class="fas fa-edit icon"></i></a>
                                        <form action="/remove-user" method="POST" onsubmit="return confirm('هل أنت متأكد من إزالة هذا المستخدم؟');">
                                            <input type="hidden" name="userId" value="${userId}">
                                            <input type="hidden" name="serverId" value="${serverId}">
                                            <input type="hidden" name="targetUserId" value="${uid}">
                                            <button type="submit" class="btn btn-danger"><i class="fas fa-trash icon"></i></button>
                                        </form>
                                    </div>
                                ` : ''}
                            </div>
                        `;
                    })).then(results => results.join(''))}
                </div>
            `}
        </div>
    `, 'المستخدمين', user, true, serverId, server.name, targetUserId, server, req, impersonatedUsername)); // Pass impersonatedUsername
});

app.post('/add-user', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { userId, serverId, username, viewConsole, viewFiles, editFiles, viewSettings, editSettings, viewUsers, editUsers, viewStartup, editStartup } = req.body;
    const targetUserId = userId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.editUsers) {
        return res.redirect('/?error=غير مصرح لك بتعديل المستخدمين');
    }

    const newUser = await User.findOne({ username });
    if (!newUser) {
        return res.redirect(`/users?serverId=${serverId}&userId=${targetUserId}&error=المستخدم غير موجود`);
    }
    if (newUser.userId === server.ownerId) {
        return res.redirect(`/users?serverId=${serverId}&userId=${targetUserId}&error=لا يمكن إضافة مالك السيرفر كمستخدم فرعي`); // Corrected error message
    }
    if (server.users.has(newUser.userId)) {
        return res.redirect(`/users?serverId=${serverId}&userId=${targetUserId}&error=المستخدم موجود بالفعل`);
    }

    try {
        server.users.set(newUser.userId, {
        viewConsole: !!viewConsole,
        viewFiles: !!viewFiles,
        editFiles: !!editFiles,
        viewSettings: !!viewSettings,
        editSettings: !!editSettings,
        viewUsers: !!viewUsers,
            editUsers: !!editUsers,
            viewStartup: !!viewStartup, // Added
            editStartup: !!editStartup  // Added
        });
        await server.save();
        logServerEvent('إضافة مستخدم إلى سيرفر', { userId: req.userId, serverId, addedUserId: newUser.userId, username });
    res.redirect(`/users?serverId=${serverId}&userId=${targetUserId}&success=تم إضافة المستخدم بنجاح`);
    } catch (err) {
        console.error('Error adding user:', err);
        res.redirect(`/users?serverId=${serverId}&userId=${targetUserId}&error=خطأ أثناء إضافة المستخدم`);
    }
});

app.get('/edit-user', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, targetUserId: editUserId, userId: ownerUserId } = req.query;
    const userId = ownerUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;
    const editUser = await User.findOne({ userId: editUserId });

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.editUsers) {
        return res.redirect('/?error=غير مصرح لك بتعديل المستخدمين');
    }
    if (!editUser || !server.users.has(editUserId)) {
        return res.redirect(`/users?serverId=${serverId}&userId=${userId}&error=المستخدم غير موجود`);
    }

    const queryParams = new URLSearchParams({ serverId, targetUserId: editUserId });
    if (ownerUserId) queryParams.append('userId', ownerUserId);

    res.send(baseTemplate(`
        <h1 class="text-3xl font-bold mb-6"><i class="fas fa-user-edit mr-2 icon"></i>تعديل أذونات ${editUser.username}</h1>
        <div class="card max-w-md mx-auto">
            <form action="/edit-user" method="POST">
                <input type="hidden" name="userId" value="${userId}">
                <input type="hidden" name="serverId" value="${serverId}">
                <input type="hidden" name="targetUserId" value="${editUserId}">
                <label class="block text-sm mb-2">الأذونات</label>
                <div class="grid grid-cols-2 gap-4">
                    <label class="flex items-center"><input type="checkbox" name="viewConsole" class="mr-2 accent-blue-500" ${server.users.get(editUserId).viewConsole ? 'checked' : ''}>عرض الكونسول</label>
                    <label class="flex items-center"><input type="checkbox" name="viewFiles" class="mr-2 accent-blue-500" ${server.users.get(editUserId).viewFiles ? 'checked' : ''}>عرض الملفات</label>
                    <label class="flex items-center"><input type="checkbox" name="editFiles" class="mr-2 accent-blue-500" ${server.users.get(editUserId).editFiles ? 'checked' : ''}>تعديل الملفات</label>
                    <label class="flex items-center"><input type="checkbox" name="viewSettings" class="mr-2 accent-blue-500" ${server.users.get(editUserId).viewSettings ? 'checked' : ''}>عرض الإعدادات</label>
                    <label class="flex items-center"><input type="checkbox" name="editSettings" class="mr-2 accent-blue-500" ${server.users.get(editUserId).editSettings ? 'checked' : ''}>تعديل الإعدادات</label>
                    <label class="flex items-center"><input type="checkbox" name="viewUsers" class="mr-2 accent-blue-500" ${server.users.get(editUserId).viewUsers ? 'checked' : ''}>عرض المستخدمين</label>
                    <label class="flex items-center"><input type="checkbox" name="editUsers" class="mr-2 accent-blue-500" ${server.users.get(editUserId).editUsers ? 'checked' : ''}>تعديل المستخدمين</label>
                    <label class="flex items-center"><input type="checkbox" name="viewStartup" class="mr-2 accent-blue-500" ${server.users.get(editUserId).viewStartup ? 'checked' : ''}>عرض بدء التشغيل</label>
                    <label class="flex items-center"><input type="checkbox" name="editStartup" class="mr-2 accent-blue-500" ${server.users.get(editUserId).editStartup ? 'checked' : ''}>تعديل بدء التشغيل</label>
                </div>
                <button type="submit" class="mt-4 btn btn-success w-full"><i class="fas fa-save mr-2 icon"></i>حفظ</button>
            </form>
            <a href="/users?${queryParams.toString()}" class="block mt-4 btn btn-danger w-full"><i class="fas fa-arrow-right mr-2 icon"></i>إلغاء</a>
        </div>
    `, 'تعديل مستخدم', user, true, serverId, server.name, ownerUserId, server, req));
});

app.post('/edit-user', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { userId, serverId, targetUserId, viewConsole, viewFiles, editFiles, viewSettings, editSettings, viewUsers, editUsers } = req.body;
    const targetOwnerId = userId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.editUsers) {
        return res.redirect('/?error=غير مصرح لك بتعديل المستخدمين');
    }
    if (!server.users.has(targetUserId)) {
        return res.redirect(`/users?serverId=${serverId}&userId=${targetOwnerId}&error=المستخدم غير موجود`);
    }

    try {
        server.users.set(targetUserId, {
        viewConsole: !!viewConsole,
        viewFiles: !!viewFiles,
        editFiles: !!editFiles,
        viewSettings: !!viewSettings,
        editSettings: !!editSettings,
        viewUsers: !!viewUsers,
        editUsers: !!editUsers
        });
        await server.save();
    logServerEvent('تعديل أذونات مستخدم', { userId: req.userId, serverId, targetUserId });
        res.redirect(`/users?serverId=${serverId}&userId=${targetOwnerId}&success=تم تعديل الأذونات بنجاح`);
    } catch (err) {
        console.error('Error editing user permissions:', err);
        res.redirect(`/users?serverId=${serverId}&userId=${targetOwnerId}&error=خطأ أثناء تعديل الأذونات`);
    }
});

app.post('/remove-user', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { userId, serverId, targetUserId } = req.body;
    const targetOwnerId = userId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.editUsers) {
        return res.redirect('/?error=غير مصرح لك بتعديل المستخدمين');
    }
    if (!server.users.has(targetUserId)) {
        return res.redirect(`/users?serverId=${serverId}&userId=${targetOwnerId}&error=المستخدم غير موجود`);
    }
    if (targetUserId === server.ownerId) {
        return res.redirect(`/users?serverId=${serverId}&userId=${targetOwnerId}&error=لا يمكن إزالة مالك السيرفر`);
    }

    try {
        server.users.delete(targetUserId);
        await server.save();
    logServerEvent('إزالة مستخدم من سيرفر', { userId: req.userId, serverId, removedUserId: targetUserId });
    res.redirect(`/users?serverId=${serverId}&userId=${targetOwnerId}&success=تم إزالة المستخدم بنجاح`);
    } catch (err) {
        console.error('Error removing user:', err);
        res.redirect(`/users?serverId=${serverId}&userId=${targetOwnerId}&error=خطأ أثناء إزالة المستخدم`);
    }
});

app.get('/admin', ensureLoggedIn, ensureAdmin, async (req, res) => {
    const user = await User.findOne({ userId: req.userId });
    const activePage = req.query.page || 'servers';
    const searchQuery = req.query.search || '';
    const logType = req.query.type || 'all';
    const page = Math.max(parseInt(req.query.pageNum || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '20', 10), 1), 100);
    
    // Get all servers with owner information
    const servers = await Server.find().lean();
    const serversWithOwners = await Promise.all(servers.map(async server => {
        const owner = await User.findOne({ userId: server.ownerId });
        return {
            ...server,
            ownerUsername: owner?.username || 'غير معروف',
            isSuspended: server.isSuspended || false
        };
    }));

    // Get all users
    const users = await User.find().lean();

    // DB-backed logs with filtering and pagination
    const logFilter = {};
    if (logType !== 'all') {
        logFilter.event = { $regex: logType, $options: 'i' };
    }
    if (searchQuery) {
        logFilter.$or = [
            { event: { $regex: searchQuery, $options: 'i' } },
            { detailsText: { $regex: searchQuery, $options: 'i' } }
        ];
    }
    const totalLogs = await EventLog.countDocuments(logFilter);
    const logsFromDb = await EventLog.find(logFilter)
        .sort({ timestamp: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean();

    const adminContent = `
        <div class="flex">
            <!-- Sidebar -->
            <div class="w-64 bg-slate-800 p-4 rounded-lg mr-4">
                <h2 class="text-xl font-semibold mb-4">لوحة الإدارة</h2>
                <nav class="space-y-2">
                    <a href="/admin?page=servers" class="block p-2 rounded ${activePage === 'servers' ? 'bg-blue-600' : 'hover:bg-slate-700'}">
                        <i class="fas fa-server mr-2"></i>السيرفرات
                    </a>
                    <a href="/admin?page=users" class="block p-2 rounded ${activePage === 'users' ? 'bg-blue-600' : 'hover:bg-slate-700'}">
                        <i class="fas fa-users mr-2"></i>المستخدمين
                    </a>
                    <a href="/admin?page=logs" class="block p-2 rounded ${activePage === 'logs' ? 'bg-blue-600' : 'hover:bg-slate-700'}">
                        <i class="fas fa-history mr-2"></i>سجل الأحداث
                    </a>
                </nav>
            </div>

            <!-- Main Content -->
            <div class="flex-1">
                ${activePage === 'servers' ? `
                    <div class="card">
                        <h2 class="text-xl font-semibold mb-4">إدارة السيرفرات</h2>
            <div class="space-y-4">
                            ${serversWithOwners.map(server => `
                                <div class="bg-slate-700 p-4 rounded-lg ${server.isSuspended ? 'border-2 border-red-500' : ''}">
                                    <div class="flex justify-between items-center">
                        <div>
                                            <h3 class="text-lg font-semibold">${server.name}</h3>
                                            <p class="text-sm text-slate-400">المالك: ${server.ownerUsername}</p>
                                            ${server.isSuspended ? '<p class="text-red-500 mt-2">هذا السيرفر معلق</p>' : ''}
                        </div>
                        <div class="flex space-x-2">
                                            <a href="/server?serverId=${server.id}&userId=${server.ownerId}" class="btn btn-primary">
                                                <i class="fas fa-external-link-alt"></i>
                                            </a>
                                            <form action="/admin/toggle-server-suspension" method="POST" class="inline">
                                                <input type="hidden" name="serverId" value="${server.id}">
                                                <button type="submit" class="btn ${server.isSuspended ? 'btn-success' : 'btn-warning'}">
                                                    <i class="fas ${server.isSuspended ? 'fa-unlock' : 'fa-lock'}"></i>
                                </button>
                            </form>
                                            <form action="/admin/delete-server" method="POST" class="inline" onsubmit="return confirm('هل أنت متأكد من حذف هذا السيرفر؟');">
                                                <input type="hidden" name="serverId" value="${server.id}">
                                                <button type="submit" class="btn btn-danger">
                                                    <i class="fas fa-trash"></i>
                                                </button>
                            </form>
                        </div>
                    </div>
            </div>
                            `).join('')}
        </div>
                    </div>
                ` : activePage === 'users' ? `
        <div class="card">
                        <h2 class="text-xl font-semibold mb-4">إدارة المستخدمين</h2>
                        <div class="space-y-4">
                            ${users.map(user => `
                                <div class="bg-slate-700 p-4 rounded-lg">
                                    <div class="flex justify-between items-center">
                                        <div>
                                            <h3 class="text-lg font-semibold">${user.username}</h3>
                                            <p class="text-sm text-slate-400">الحالة: ${user.isAdmin ? 'مدير' : 'مستخدم'}</p>
                                        </div>
                                        <div class="flex space-x-2">
                                            <button onclick="showEditUserModal('${user.userId}', '${user.username}', ${user.isAdmin})" class="btn btn-primary">
                                                <i class="fas fa-edit"></i>
                                            </button>
                                            <form action="/admin/impersonate" method="POST" class="inline">
                                                <input type="hidden" name="userId" value="${user.userId}">
                                                <button type="submit" class="btn btn-info">
                                                    <i class="fas fa-user-secret"></i>
                                                </button>
                                            </form>
                                            <form action="/admin/delete-user" method="POST" class="inline" onsubmit="return confirm('هل أنت متأكد من حذف هذا المستخدم؟');">
                                                <input type="hidden" name="userId" value="${user.userId}">
                                                <button type="submit" class="btn btn-danger">
                                                    <i class="fas fa-trash"></i>
                                                </button>
                                            </form>
                                        </div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <!-- Edit User Modal -->
                    <div id="editUserModal" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center">
                        <div class="bg-slate-800 p-6 rounded-lg w-96">
                            <h3 class="text-xl font-semibold mb-4">تعديل المستخدم</h3>
                            <form id="editUserForm" action="/admin/edit-user" method="POST">
                                <input type="hidden" name="userId" id="editUserId">
                                <div class="mb-4">
                                    <label class="block text-sm mb-2">اسم المستخدم</label>
                                    <input type="text" name="username" id="editUsername" class="form-input" required>
                                </div>
                                <div class="mb-4">
                                    <label class="block text-sm mb-2">كلمة المرور الجديدة (اتركها فارغة إذا لم ترد تغييرها)</label>
                                    <input type="password" name="newPassword" class="form-input">
                                </div>
                                <div class="mb-4">
                                    <label class="flex items-center">
                                        <input type="checkbox" name="isAdmin" id="editIsAdmin" class="mr-2 accent-blue-500">
                                        <span>مدير؟</span>
                                    </label>
                                </div>
                                <div class="flex justify-end space-x-2">
                                    <button type="button" onclick="hideEditUserModal()" class="btn btn-danger">إلغاء</button>
                                    <button type="submit" class="btn btn-success">حفظ</button>
                                </div>
                            </form>
                        </div>
                    </div>
                ` : `
                    <div class="card">
                        <h2 class="text-xl font-semibold mb-4">سجل الأحداث</h2>
                        <div class="mb-4 grid grid-cols-1 md:grid-cols-4 gap-4">
                            <input type="text" id="logSearch" placeholder="بحث..." class="form-input" value="${searchQuery}">
                            <select id="logType" class="form-input">
                                <option value="all" ${logType === 'all' ? 'selected' : ''}>جميع الأحداث</option>
                                <option value="login" ${logType === 'login' ? 'selected' : ''}>تسجيل الدخول</option>
                                <option value="server" ${logType === 'server' ? 'selected' : ''}>السيرفرات</option>
                                <option value="file" ${logType === 'file' ? 'selected' : ''}>الملفات</option>
                                <option value="user" ${logType === 'user' ? 'selected' : ''}>المستخدمين</option>
                            </select>
                            <select id="logPageSize" class="form-input">
                                ${[20,50,100].map(size => `<option value="${size}" ${pageSize === size ? 'selected' : ''}>${size} / صفحة</option>`).join('')}
                            </select>
                            <button class="btn btn-primary" type="button" id="applyLogFilters">تصفية</button>
                        </div>
                        <div class="space-y-2 max-h-96 overflow-y-auto">
                            ${logsFromDb.map(log => `
                                <div class="bg-slate-700 p-3 rounded-lg">
                                    <p class="text-sm">
                                        <span class="text-blue-400">[${new Date(log.timestamp).toLocaleString('ar')}]</span>
                                        <span class="font-semibold">${log.event}:</span>
                                        <span class="text-slate-300">${JSON.stringify(log.details)}</span>
                                    </p>
                                </div>
                    `).join('')}
                        </div>
                        <div class="flex justify-between items-center mt-4">
                            <div>الصفحة ${page} من ${Math.max(1, Math.ceil(totalLogs / pageSize))} (الإجمالي: ${totalLogs})</div>
                            <div class="space-x-2">
                                ${page > 1 ? `<a class=\"btn btn-secondary\" href=\"/admin?page=logs&search=${encodeURIComponent(searchQuery)}&type=${encodeURIComponent(logType)}&pageSize=${pageSize}&pageNum=${page - 1}\">السابق</a>` : ''}
                                ${(page * pageSize) < totalLogs ? `<a class=\"btn btn-secondary\" href=\"/admin?page=logs&search=${encodeURIComponent(searchQuery)}&type=${encodeURIComponent(logType)}&pageSize=${pageSize}&pageNum=${page + 1}\">التالي</a>` : ''}
                            </div>
                        </div>
                </div>
            `}
        </div>
        </div>

        <script>
            function showEditUserModal(userId, username, isAdmin) {
                document.getElementById('editUserId').value = userId;
                document.getElementById('editUsername').value = username;
                document.getElementById('editIsAdmin').checked = !!isAdmin;
                document.getElementById('editUserModal').classList.remove('hidden');
                document.getElementById('editUserModal').classList.add('flex');
            }

            function hideEditUserModal() {
                document.getElementById('editUserModal').classList.add('hidden');
                document.getElementById('editUserModal').classList.remove('flex');
            }

            // Log search and filter functionality
            document.getElementById('applyLogFilters')?.addEventListener('click', updateLogFilters);
            document.getElementById('logSearch')?.addEventListener('keydown', function(e) { if (e.key === 'Enter') updateLogFilters(); });
            function updateLogFilters() {
                const search = document.getElementById('logSearch').value;
                const type = document.getElementById('logType').value;
                const pageSize = document.getElementById('logPageSize').value;
                window.location.href = '/admin?page=logs&search=' + encodeURIComponent(search) + '&type=' + encodeURIComponent(type) + '&pageSize=' + encodeURIComponent(pageSize) + '&pageNum=1';
            }
        </script>
    `;

    // --- Fetch impersonated username --- Start
    let impersonatedUsername = null;
    if (req.session.impersonating) {
        try {
            const impersonatedUser = await User.findOne({ userId: req.session.impersonating });
            impersonatedUsername = impersonatedUser ? impersonatedUser.username : 'مستخدم غير معروف';
        } catch (err) {
            console.error("Error fetching impersonated user:", err);
            impersonatedUsername = 'خطأ في جلب الاسم'; 
        }
    }
    // --- Fetch impersonated username --- End

    res.send(baseTemplate(adminContent, 'لوحة الإدارة', user, true, null, null, null, null, req, impersonatedUsername)); // Pass impersonatedUsername
});

// Add new admin routes for server management
app.post('/admin/toggle-server-suspension', ensureLoggedIn, ensureAdmin, async (req, res) => {
    const { serverId } = req.body;
    try {
        const server = await Server.findOne({ id: serverId });
        if (!server) {
            return res.redirect('/admin?page=servers&error=السيرفر غير موجود');
        }
        server.isSuspended = !server.isSuspended;
        await server.save();
        logServerEvent('تغيير حالة تعليق السيرفر', { 
            userId: req.userId, 
            serverId, 
            isSuspended: server.isSuspended 
        });
        res.redirect('/admin?page=servers&success=تم تغيير حالة التعليق بنجاح');
    } catch (err) {
        console.error('Error toggling server suspension:', err);
        res.redirect('/admin?page=servers&error=خطأ أثناء تغيير حالة التعليق');
    }
});

app.post('/admin/delete-server', ensureLoggedIn, ensureAdmin, async (req, res) => {
    const { serverId } = req.body;
    try {
        const server = await Server.findOne({ id: serverId });
        if (!server) {
            return res.redirect('/admin?page=servers&error=السيرفر غير موجود');
        }
        await Server.deleteOne({ id: serverId });
        logServerEvent('حذف سيرفر بواسطة المدير', { userId: req.userId, serverId });
        res.redirect('/admin?page=servers&success=تم حذف السيرفر بنجاح');
    } catch (err) {
        console.error('Error deleting server:', err);
        res.redirect('/admin?page=servers&error=خطأ أثناء حذف السيرفر');
    }
});

app.post('/admin/edit-user', ensureLoggedIn, ensureAdmin, async (req, res) => {
    const { userId, username, newPassword, isAdmin } = req.body;
    try {
        const user = await User.findOne({ userId });
        if (!user) {
            return res.redirect('/admin?page=users&error=المستخدم غير موجود');
        }
        if (username) user.username = username;
        if (newPassword) user.password = newPassword;
        user.isAdmin = !!isAdmin;
        await user.save();
        logServerEvent('تعديل مستخدم بواسطة المدير', { 
            adminId: req.userId, 
            targetUserId: userId,
            changes: { username, passwordChanged: !!newPassword, isAdmin: !!isAdmin }
        });
        res.redirect('/admin?page=users&success=تم تعديل المستخدم بنجاح');
    } catch (err) {
        console.error('Error editing user:', err);
        res.redirect('/admin?page=users&error=خطأ أثناء تعديل المستخدم');
    }
});

app.post('/admin/delete-user', ensureLoggedIn, ensureAdmin, async (req, res) => {
    const { userId } = req.body;
    try {
        const user = await User.findOne({ userId });
        if (!user) {
            return res.redirect('/admin?page=users&error=المستخدم غير موجود');
        }
        if (user.isAdmin) {
            return res.redirect('/admin?page=users&error=لا يمكن حذف مدير');
        }
        await User.deleteOne({ userId });
        logServerEvent('حذف مستخدم بواسطة المدير', { adminId: req.userId, deletedUserId: userId });
        res.redirect('/admin?page=users&success=تم حذف المستخدم بنجاح');
    } catch (err) {
        console.error('Error deleting user:', err);
        res.redirect('/admin?page=users&error=خطأ أثناء حذف المستخدم');
    }
});

app.get('/profile', ensureLoggedIn, async (req, res) => {
    const user = await User.findOne({ userId: req.userId });

    // --- Fetch impersonated username --- Start
    let impersonatedUsername = null;
    if (req.session.impersonating) {
        try {
            const impersonatedUser = await User.findOne({ userId: req.session.impersonating });
            impersonatedUsername = impersonatedUser ? impersonatedUser.username : 'مستخدم غير معروف';
        } catch (err) {
            console.error("Error fetching impersonated user:", err);
            impersonatedUsername = 'خطأ في جلب الاسم'; 
        }
    }
    // --- Fetch impersonated username --- End

    res.send(baseTemplate(`
        <h1 class="text-3xl font-bold mb-6"><i class="fas fa-user-circle mr-2 icon"></i>الملف الشخصي</h1>
        <div class="card max-w-md mx-auto">
            <h2 class="text-xl font-semibold mb-4">معلومات الحساب</h2>
            <p class="mb-2"><i class="fas fa-user mr-2 icon"></i>اسم المستخدم: ${user.username}</p>
            <p class="mb-4"><i class="fas fa-shield-alt mr-2 icon"></i>الحالة: ${user.isAdmin ? 'مدير' : 'مستخدم'}</p>
            <form action="/change-password" method="POST">
                <label class="block text-sm mb-2">كلمة المرور الجديدة</label>
                <input type="password" name="newPassword" class="form-input" required>
                <button type="submit" class="mt-4 btn btn-success w-full"><i class="fas fa-key mr-2 icon"></i>تغيير كلمة المرور</button>
            </form>
            ${req.session.impersonating ? `
                <form action="/stop-impersonating" method="POST" class="mt-4">
                    <button type="submit" class="btn btn-danger w-full"><i class="fas fa-sign-out-alt mr-2 icon"></i>إنهاء التسجيل كمستخدم آخر</button>
                </form>
            ` : ''}
        </div>
    `, 'الملف الشخصي', user, true, null, null, req.userId, null, req, impersonatedUsername)); // Pass impersonatedUsername, ensure userId is passed correctly
});

app.post('/change-password', ensureLoggedIn, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
        return res.redirect('/profile?error=كلمة المرور يجب أن تكون 6 أحرف على الأقل');
    }

    try {
        const user = await User.findOne({ userId: req.userId });
        user.password = newPassword;
        await user.save();
        logServerEvent('تغيير كلمة لمرور', { userId: req.userId });
    res.redirect('/profile?success=تم تغيير كلمة المرور بنجاح');
    } catch (err) {
        console.error('Error changing password:', err);
        res.redirect('/profile?error=خطأ أثناء تغيير كلمة المرور');
    }
});

app.post('/stop-impersonating', ensureLoggedIn, (req, res) => { // Removed ensureAdmin, as only admin can start impersonating
    const adminUserId = req.session.originalUserId || req.userId; // Get original admin ID
    const impersonatedUserId = req.session.impersonating;
    
    delete req.session.impersonating;
    // Keep req.session.originalUserId if needed elsewhere, or delete if not
    // delete req.session.originalUserId; 
    
    if (impersonatedUserId) { // Log only if impersonation was actually active
        logServerEvent('إنهاء التسجيل كمستخدم آخر', { adminId: adminUserId, stoppedImpersonating: impersonatedUserId });
    }
    
    // Redirect back to the admin users page
    res.redirect('/admin?page=users');
});

app.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.send(authTemplate(`
        <div class="card">
            <!-- Header -->
            <div class="text-center mb-8">
                <div class="w-20 h-20 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center mx-auto mb-4">
                    <i class="fas fa-rocket text-white text-3xl"></i>
                </div>
                <h1 class="text-4xl font-bold mb-2 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                    مرحباً بك
                </h1>
                <p class="text-gray-400">سجل دخولك للوصول إلى لوحة التحكم</p>
            </div>

            ${req.query.error ? `
                <div class="error-popup">
                    <div class="flex items-center gap-3">
                        <i class="fas fa-exclamation-triangle text-xl"></i>
                        <span>${req.query.error}</span>
                    </div>
                </div>
            ` : ''}

            <!-- Login Form -->
            <form action="/login" method="POST" class="space-y-6">
                <div>
                    <label class="block text-sm font-medium mb-3 text-gray-300">
                        <i class="fas fa-user mr-2 text-blue-400"></i>
                        اسم المستخدم
                    </label>
                    <input type="text" 
                           name="username" 
                           class="form-input" 
                           placeholder="أدخل اسم المستخدم..."
                           required
                           autocomplete="username">
                </div>

                <div>
                    <label class="block text-sm font-medium mb-3 text-gray-300">
                        <i class="fas fa-lock mr-2 text-blue-400"></i>
                        كلمة المرور
                    </label>
                    <input type="password" 
                           name="password" 
                           class="form-input" 
                           placeholder="أدخل كلمة المرور..."
                           required
                           autocomplete="current-password">
                </div>

                <button type="submit" class="btn btn-primary w-full text-lg">
                    <i class="fas fa-sign-in-alt"></i>
                    تسجيل الدخول
                </button>
                </form>

            <!-- Footer -->
            <div class="mt-8 text-center">
                <p class="text-gray-400">
                    ليس لديك حساب؟ 
                    <a href="/register" class="text-blue-400 hover:text-blue-300 font-medium transition-colors">
                        إنشاء حساب جديد
                    </a>
                </p>
            </div>
        </div>
    `, 'تسجيل الدخول'));
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (!user) {
        return res.redirect('/login?error=اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    req.session.userId = user.userId;
    logServerEvent('تسجيل دخول', { userId: user.userId });
    res.redirect('/');
});

app.get('/register', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.send(authTemplate(`
        <div class="card">
            <!-- Header -->
            <div class="text-center mb-8">
                <div class="w-20 h-20 bg-gradient-to-r from-green-500 to-blue-500 rounded-full flex items-center justify-center mx-auto mb-4">
                    <i class="fas fa-user-plus text-white text-3xl"></i>
                </div>
                <h1 class="text-4xl font-bold mb-2 bg-gradient-to-r from-green-400 to-blue-500 bg-clip-text text-transparent">
                    إنشاء حساب
                </h1>
                <p class="text-gray-400">انضم إلينا وابدأ رحلتك مع Dexster Pro</p>
            </div>

            ${req.query.error ? `
                <div class="error-popup">
                    <div class="flex items-center gap-3">
                        <i class="fas fa-exclamation-triangle text-xl"></i>
                        <span>${req.query.error}</span>
                    </div>
                </div>
            ` : ''}

            <!-- Register Form -->
            <form action="/register" method="POST" class="space-y-6">
                <div>
                    <label class="block text-sm font-medium mb-3 text-gray-300">
                        <i class="fas fa-user mr-2 text-green-400"></i>
                        اسم المستخدم
                    </label>
                    <input type="text" 
                           name="username" 
                           class="form-input" 
                           placeholder="اختر اسم مستخدم مميز..."
                           required
                           autocomplete="username">
                </div>

                <div>
                    <label class="block text-sm font-medium mb-3 text-gray-300">
                        <i class="fas fa-lock mr-2 text-green-400"></i>
                        كلمة المرور
                    </label>
                    <input type="password" 
                           name="password" 
                           class="form-input" 
                           placeholder="أدخل كلمة مرور قوية..."
                           required
                           autocomplete="new-password">
                    <p class="text-xs text-gray-500 mt-1">يجب أن تكون كلمة المرور 6 أحرف على الأقل</p>
                </div>

                <button type="submit" class="btn btn-success w-full text-lg">
                    <i class="fas fa-user-plus"></i>
                    إنشاء حساب
                </button>
                </form>

            <!-- Footer -->
            <div class="mt-8 text-center">
                <p class="text-gray-400">
                    لديك حساب بالفعل؟ 
                    <a href="/login" class="text-green-400 hover:text-green-300 font-medium transition-colors">
                        تسجيل الدخول
                    </a>
                </p>
            </div>
        </div>
    `, 'إنشاء حساب'));
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || password.length < 6) {
        return res.redirect('/register?error=اسم المستخدم أو كلمة المرور غير صالحة');
    }
    const existingUser = await User.findOne({ username });
    if (existingUser) {
        return res.redirect('/register?error=اسم المستخدم موجود بالفعل');
    }

    const userId = uuidv4();
    const userCount = await User.countDocuments();
    const newUser = new User({
        userId: userId,
        username,
        password,
        isAdmin: userCount === 0
    });

    try {
        await newUser.save();
    logServerEvent('إنشاء حساب', { userId, username });
    req.session.userId = userId;
    res.redirect('/?success=تم إنشاء الحساب بنجاح');
    } catch (err) {
        console.error('Error registering user:', err);
        res.redirect('/register?error=خطأ أثناء إنشاء الحساب');
    }
});

app.get('/logout', (req, res) => {
    logServerEvent('تسجيل خروج', { userId: req.session.userId });
    req.session.destroy();
    res.redirect('/login');
});

const startServerInBackground = async (serverId, targetUserId, server, tempDir, consoleLogs, runningProcesses, serverStartTime, wss, formatConsoleOutput, trimLogs, decodeFilePathKey, logServerEvent) => {
    const serverDir = path.join(tempDir, targetUserId, serverId);
    try {
        // تنظيف المجلد المؤقت إذا كان موجودًا - بشكل غير متزامن ومعالجة الأخطاء
        if (fs.existsSync(serverDir)) {
            try {
                await fs.remove(serverDir);
            } catch (rmErr) {
                // Log EBUSY or other errors during initial cleanup but don't stop
                console.error(`Warning: Failed to initially remove temp dir ${serverDir}:`, rmErr);
                const removeWarnMsg = formatConsoleOutput(`⚠️ تحذير: فشل تنظيف المجلد المؤقت القديم (${rmErr.code}). سيتم محاولة الكتابة فوقه.`);
                // Ensure logs are initialized before pushing
                initializeServerLogs(targetUserId, serverId);
                consoleLogs[`${targetUserId}-${serverId}`].push(removeWarnMsg);
                trimLogs(consoleLogs[`${targetUserId}-${serverId}`]);
                wss.clients.forEach(client => {
                    if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                        client.send(removeWarnMsg);
                    }
                });
            }
        }
        await fs.ensureDir(serverDir);

        // تهيئة سجل الكونسول مع مسح السجل السابق عند بدء التشغيل
        initializeServerLogs(targetUserId, serverId);
        // Clear in-memory logs and persistent logs for this server/user
        try {
            const logKey = `${targetUserId}-${serverId}`;
            consoleLogs[logKey] = [];
            clearConsoleLogs(targetUserId, serverId);
        } catch (e) { /* ignore */ }
        // Notify connected clients to clear their UI console
        try {
            wss.clients.forEach(client => {
                if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                    client.send('__CLEAR_CONSOLE__');
                }
            });
        } catch (e) { /* ignore */ }
        const startMsg = formatConsoleOutput('🚀 جاري تجهيز السيرفر... برجاء الانتظار');
        consoleLogs[`${targetUserId}-${serverId}`].push(startMsg);
        saveConsoleLog(targetUserId, serverId, startMsg);
        wss.clients.forEach(client => {
            if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                client.send(startMsg);
            }
        });

        // كتابة ملفات السيرفر
        for (const [encodedFilePath, fileContent] of server.files.entries()) {
            const filePath = decodeFilePathKey(encodedFilePath);
            const content = Buffer.from(fileContent, 'base64');
            const fullPath = path.join(serverDir, filePath);
            await fs.ensureDir(path.dirname(fullPath));
            await fs.writeFile(fullPath, content);
        }

        // قراءة إعدادات بدء التشغيل
        const mainFile = server.startupSettings.get('mainFile') || 'index.js';
        const userPackages = server.startupSettings.get('packages');
        const port = server.startupSettings.get('port') || '3000';

        // تثبيت الحزم المحددة من قبل المستخدم أولاً
        if (userPackages && userPackages.trim() !== '') {
            const packagesToInstall = userPackages.trim().split(/\s+/).filter(pkg => pkg);
            if (packagesToInstall.length > 0) {
                const installingUserPkgsMsg = formatConsoleOutput(`📦 جاري تثبيت الحزم المحددة من إعدادات بدء التشغيل: ${packagesToInstall.join(', ')}...`);
                consoleLogs[`${targetUserId}-${serverId}`].push(installingUserPkgsMsg);
                wss.clients.forEach(client => {
                    if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                        client.send(installingUserPkgsMsg);
                    }
                });
                try {
                    const { stdout, stderr } = await execPromise(`npm install ${packagesToInstall.join(' ')} --save`, {
                        cwd: serverDir,
                        timeout: 300000 // 5 دقائق
                    });
                    if (stdout) {
                        const formattedOutput = formatConsoleOutput(stdout);
                        consoleLogs[`${targetUserId}-${serverId}`].push(formattedOutput);
                        saveConsoleLog(targetUserId, serverId, formattedOutput);
                        wss.clients.forEach(client => client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN && client.send(formattedOutput));
                    }
                    if (stderr) {
                        const formattedError = formatConsoleOutput(stderr);
                        consoleLogs[`${targetUserId}-${serverId}`].push(formattedError);
                        saveConsoleLog(targetUserId, serverId, formattedError);
                        wss.clients.forEach(client => client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN && client.send(formattedError));
                    }
                    const doneUserPkgsMsg = formatConsoleOutput('✅ تم تثبيت الحزم المحددة من إعدادات بدء التشغيل بنجاح.');
                    consoleLogs[`${targetUserId}-${serverId}`].push(doneUserPkgsMsg);
                    saveConsoleLog(targetUserId, serverId, doneUserPkgsMsg);
                    wss.clients.forEach(client => client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN && client.send(doneUserPkgsMsg));
                } catch (error) {
                    const formattedError = formatConsoleOutput(`❌ خطأ في تثبيت الحزم المحددة من إعدادات بدء التشغيل: ${error.message}`);
                    consoleLogs[`${targetUserId}-${serverId}`].push(formattedError);
                    wss.clients.forEach(client => client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN && client.send(formattedError));
                }
            }
        }

        // التحقق من وجود الملف الرئيسي
        const mainFilePath = path.join(serverDir, mainFile);
        if (!fs.existsSync(mainFilePath)) {
            const errorMsg = formatConsoleOutput(`❌ ملف التشغيل الرئيسي (${mainFile}) غير موجود`);
            consoleLogs[`${targetUserId}-${serverId}`].push(errorMsg);
            saveConsoleLog(targetUserId, serverId, errorMsg);
            wss.clients.forEach(client => {
                if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                    client.send(errorMsg);
                }
            });
            return;
        }

        // التحقق من وجود package.json وتثبيت الحزم
        const packageJsonPath = path.join(serverDir, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            const installingMsg = formatConsoleOutput('📦 جاري تثبيت الحزم المطلوبة...');
            consoleLogs[`${targetUserId}-${serverId}`].push(installingMsg);
            saveConsoleLog(targetUserId, serverId, installingMsg);
            wss.clients.forEach(client => {
                if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                    client.send(installingMsg);
                }
            });

            try {
                const { stdout, stderr } = await execPromise('npm install', {
                    cwd: serverDir,
                    timeout: 300000 // 5 دقائق
                });
                if (stdout) {
                    const formattedOutput = formatConsoleOutput(stdout);
                    consoleLogs[`${targetUserId}-${serverId}`].push(formattedOutput);
                    saveConsoleLog(targetUserId, serverId, formattedOutput);
                    wss.clients.forEach(client => {
                        if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                            client.send(formattedOutput);
                        }
                    });
                }
                if (stderr) {
                    const formattedError = formatConsoleOutput(stderr);
                    consoleLogs[`${targetUserId}-${serverId}`].push(formattedError);
                    saveConsoleLog(targetUserId, serverId, formattedError);
                    wss.clients.forEach(client => {
                        if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                            client.send(formattedError);
                        }
                    });
                }
                const doneMsg = formatConsoleOutput('✅ تم تثبيت الحزم بنجاح. جاري تشغيل السيرفر...');
                consoleLogs[`${targetUserId}-${serverId}`].push(doneMsg);
                saveConsoleLog(targetUserId, serverId, doneMsg);
                wss.clients.forEach(client => {
                    if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                        client.send(doneMsg);
                    }
                });
            } catch (error) {
                const formattedError = formatConsoleOutput(`❌ خطأ في تثبيت الحزم: ${error.message}`);
                consoleLogs[`${targetUserId}-${serverId}`].push(formattedError);
                saveConsoleLog(targetUserId, serverId, formattedError);
                wss.clients.forEach(client => {
                    if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                        client.send(formattedError);
                    }
                });
                throw error;
            }
        }

        // تشغيل السيرفر
        const serverProcess = spawn('node', [mainFilePath], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT: port,
                NODE_ENV: 'production'
            },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        if (!runningProcesses[targetUserId]) {
            runningProcesses[targetUserId] = {};
        }
        runningProcesses[targetUserId][serverId] = serverProcess;
        serverStartTime[`${targetUserId}-${serverId}`] = Date.now();
        setProcessState(targetUserId, serverId, true, serverStartTime[`${targetUserId}-${serverId}`]);

        const startSuccessMsg = formatConsoleOutput(`✅ تم تشغيل السيرفر بنجاح على المنفذ ${port}`);
        consoleLogs[`${targetUserId}-${serverId}`].push(startSuccessMsg);
        saveConsoleLog(targetUserId, serverId, startSuccessMsg);
        wss.clients.forEach(client => {
            if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                client.send(startSuccessMsg);
            }
        });

        serverProcess.stdout.on('data', (data) => {
            const log = data.toString();
            const formattedLog = formatConsoleOutput(log);
            consoleLogs[`${targetUserId}-${serverId}`].push(formattedLog);
            trimLogs(consoleLogs[`${targetUserId}-${serverId}`]);
            wss.clients.forEach(client => {
                if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                    client.send(formattedLog);
                }
            });
            saveConsoleLog(targetUserId, serverId, formattedLog);
        });

        serverProcess.stderr.on('data', (data) => {
            const log = data.toString();
            const formattedLog = formatConsoleOutput(log);
            consoleLogs[`${targetUserId}-${serverId}`].push(formattedLog);
            trimLogs(consoleLogs[`${targetUserId}-${serverId}`]);
            wss.clients.forEach(client => {
                if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                    client.send(formattedLog);
                }
            });
            saveConsoleLog(targetUserId, serverId, formattedLog);
        });

        serverProcess.on('close', async (code) => {
            const closeMessage = formatConsoleOutput(`❌ توقف السيرفر (رمز الخروج: ${code})`);
            consoleLogs[`${targetUserId}-${serverId}`].push(closeMessage);
            trimLogs(consoleLogs[`${targetUserId}-${serverId}`]);
            delete runningProcesses[targetUserId][serverId];
            setProcessState(targetUserId, serverId, false, null);
            await fs.remove(serverDir).catch(() => {});

            wss.clients.forEach(client => {
                if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                    client.send(closeMessage);
                }
            });
        });

        serverProcess.on('error', async (error) => {
            const errorMsg = formatConsoleOutput(`❌ خطأ في بدء تشغيل السيرفر: ${error.message}`);
            consoleLogs[`${targetUserId}-${serverId}`].push(errorMsg);
            trimLogs(consoleLogs[`${targetUserId}-${serverId}`]);
            delete runningProcesses[targetUserId][serverId];
            setProcessState(targetUserId, serverId, false, null);
            fs.removeSync(serverDir);
            wss.clients.forEach(client => {
                if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                    client.send(errorMsg);
                }
            });
        });

        logServerEvent('تشغيل سيرفر', { userId: targetUserId, serverId, port });
    } catch (error) {
        const errorMsg = formatConsoleOutput(`❌ حدث خطأ أثناء تشغيل السيرفر: ${error.message}`);
        consoleLogs[`${targetUserId}-${serverId}`].push(errorMsg);
        wss.clients.forEach(client => {
            if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                client.send(errorMsg);
            }
        });
        console.error('Error starting server:', error);
        await fs.remove(serverDir).catch(() => {});
    }
};

app.post('/start-server', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, userId } = req.body;
    const targetUserId = userId || req.userId;
    const server = await Server.findOne({ id: serverId });

    if (!server) {
        return res.redirect(`/server?serverId=${serverId}&userId=${targetUserId}&error=${encodeURIComponent('السيرفر غير موجود')}`);
    }

    if (server.isSuspended) {
        return res.redirect(`/server?serverId=${serverId}&userId=${targetUserId}&error=${encodeURIComponent('هذا السيرفر معلق. يرجى التواصل مع الإدارة')}`);
    }

    // تشغيل العملية في الخلفية
    startServerInBackground(serverId, targetUserId, server, tempDir, consoleLogs, runningProcesses, serverStartTime, wss, formatConsoleOutput, trimLogs, decodeFilePathKey, logServerEvent);

    // إرجاع استجابة فورية
    res.redirect(`/server?serverId=${serverId}&userId=${targetUserId}&success=${encodeURIComponent('جاري تشغيل السيرفر... تحقق من الكونسول لمتابعة العملية')}`);
});

app.post('/stop-server', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { userId, serverId } = req.body;
    const targetUserId = userId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.editSettings) {
        return res.redirect('/?error=غير مصرح لك بإيقاف السيرفر');
    }

    if (!runningProcesses[targetUserId]?.[serverId]) {
        return res.redirect(`/server?serverId=${serverId}&userId=${targetUserId}&error=السيرفر متوقف بالفعل`);
    }

    runningProcesses[targetUserId][serverId].kill();
    delete runningProcesses[targetUserId][serverId];
    setProcessState(targetUserId, serverId, false, null);
    const stopMsg = formatConsoleOutput('[معلومات] تم إيقاف السيرفر');
    consoleLogs[`${targetUserId}-${serverId}`].push(stopMsg);
    saveConsoleLog(targetUserId, serverId, stopMsg);
    trimLogs(consoleLogs[`${targetUserId}-${serverId}`]);
    fs.removeSync(path.join(__dirname, 'temp', targetUserId, serverId));

    wss.clients.forEach(client => {
        if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
            client.send('[معلومات] تم إيقاف السيرفر');
        }
    });

    logServerEvent('إيقاف سيرفر', { userId: req.userId, serverId });
    res.redirect(`/server?serverId=${serverId}&userId=${targetUserId}&success=تم إيقاف السيرفر بنجاح`);
});

app.post('/restart-server', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { userId, serverId } = req.body;
    const targetUserId = userId || req.userId;
    const server = req.server; // From ensureServerAccess

    const requestingUser = await User.findOne({ userId: req.originalUserId }); // User performing the action
    const permissions = server.users.get(req.originalUserId) || {};

    // Check if the user has permission to edit startup settings, or is owner/admin
    if (!req.isServerOwner && !requestingUser.isAdmin && !permissions.editStartup) {
        return res.redirect(`/server?serverId=${serverId}&userId=${targetUserId}&error=${encodeURIComponent('غير مصرح لك بإعادة تشغيل السيرفر (يتطلب إذن تعديل بدء التشغيل)')}`);
    }

    // Initialize logs for this server if they don't exist yet
    initializeServerLogs(targetUserId, serverId);

    const serverSpecificTempDir = path.join(__dirname, 'temp', targetUserId, serverId);

    if (runningProcesses[targetUserId]?.[serverId]) {
        const stopMsg = formatConsoleOutput('[معلومات] إيقاف السيرفر لإعادة التشغيل...');
        consoleLogs[`${targetUserId}-${serverId}`].push(stopMsg);
        trimLogs(consoleLogs[`${targetUserId}-${serverId}`]);
        wss.clients.forEach(client => {
            if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                client.send(stopMsg);
            }
        });

        runningProcesses[targetUserId][serverId].kill();
        delete runningProcesses[targetUserId][serverId];
        
        // Short delay to allow process to terminate before removing directory
        await new Promise(resolve => setTimeout(resolve, 1000)); 
        if (fs.existsSync(serverSpecificTempDir)) {
            await fs.remove(serverSpecificTempDir).catch(err => {
                console.error(`Error removing temp dir during restart: ${serverSpecificTempDir}`, err);
            });
        }
    } else {
        // If server wasn't running, still good to ensure temp dir is clean for a fresh start
        if (fs.existsSync(serverSpecificTempDir)) {
            await fs.remove(serverSpecificTempDir).catch(err => {
                console.error(`Error removing temp dir (server not running): ${serverSpecificTempDir}`, err);
            });
        }
    }

    // Clear logs on restart as well
    try {
        const logKey = `${targetUserId}-${serverId}`;
        consoleLogs[logKey] = [];
        clearConsoleLogs(targetUserId, serverId);
        wss.clients.forEach(client => {
            if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                client.send('__CLEAR_CONSOLE__');
            }
        });
    } catch (e) { /* ignore */ }

    const restartingMsg = formatConsoleOutput('[معلومات] جاري إعادة تشغيل السيرفر مع الإعدادات المحدثة...');
    consoleLogs[`${targetUserId}-${serverId}`].push(restartingMsg);
    trimLogs(consoleLogs[`${targetUserId}-${serverId}`]);
    wss.clients.forEach(client => {
        if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
            client.send(restartingMsg);
        }
    });

    const globalTempDir = path.join(__dirname, 'temp'); // Base temp directory for all servers

    // Call startServerInBackground to handle the actual start with current settings
    startServerInBackground(
        serverId,
        targetUserId,
        server, // The Mongoose server object, which includes startupSettings
        globalTempDir,
        consoleLogs,
        runningProcesses,
        serverStartTime,
        wss,
        formatConsoleOutput,
        trimLogs,
        decodeFilePathKey,
        logServerEvent
    ).catch(err => {
        console.error(`Error during startServerInBackground from restart for server ${serverId}, user ${targetUserId}:`, err);
        const errorMsg = formatConsoleOutput(`❌ خطأ فادح أثناء عملية إعادة التشغيل: ${err.message}`);
        consoleLogs[`${targetUserId}-${serverId}`].push(errorMsg);
        trimLogs(consoleLogs[`${targetUserId}-${serverId}`]);
        wss.clients.forEach(client => {
            if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                client.send(errorMsg);
            }
        });
    });

    logServerEvent('إعادة تشغيل سيرفر', { userId: req.originalUserId, serverId });
    res.redirect(`/server?serverId=${serverId}&userId=${targetUserId}&success=${encodeURIComponent('جاري إعادة تشغيل السيرفر... تحقق من الكونسول لمتابعة العملية')}`);
});

// إضافة دالة للحصول على عنوان IP
const getServerIP = () => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // تجاهل عناوين IPv6 والعناوين الداخلية
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '69.30.219.180'; // عنوان افتراضي إذا لم يتم العثور على عنوان
};

app.get('/startup', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.viewStartup) {
        return res.redirect(`/?error=${encodeURIComponent('غير مصرح لك بمشاهدة إعدادات بدء التشغيل')}`);
    }

    const currentMainFile = server.startupSettings.get('mainFile') || 'index.js';
    const currentPackages = server.startupSettings.get('packages') || '';
    const currentPort = server.startupSettings.get('port') || '3000';
    const serverIP = getServerIP(); // استخدام الدالة الجديدة للحصول على IP

    const queryParams = new URLSearchParams({ serverId });
    if (targetUserId) queryParams.append('userId', targetUserId);

    // --- Fetch impersonated username --- Start
    let impersonatedUsername = null;
    if (req.session.impersonating) {
        try {
            const impersonatedUser = await User.findOne({ userId: req.session.impersonating });
            impersonatedUsername = impersonatedUser ? impersonatedUser.username : 'مستخدم غير معروف';
        } catch (err) {
            console.error("Error fetching impersonated user:", err);
            impersonatedUsername = 'خطأ في جلب الاسم'; 
        }
    }
    // --- Fetch impersonated username --- End

    res.send(baseTemplate(`
        <h1 class="text-3xl font-bold mb-6"><i class="fas fa-play-circle mr-2 icon"></i>إعدادات بدء تشغيل ${server.name}</h1>
        
        <div class="card max-w-lg mx-auto mb-6">
            <div class="p-4 bg-slate-800 rounded-lg">
                <h2 class="text-xl font-semibold mb-2 text-white"><i class="fas fa-globe mr-2"></i>عنوان السيرفر</h2>
                <div class="flex items-center space-x-2">
                    <code class="text-green-400 text-lg">${serverIP}:${currentPort}</code>
                    <button onclick="copyToClipboard('${serverIP}:${currentPort}')" class="btn btn-sm btn-ghost">
                        <i class="fas fa-copy"></i>
                    </button>
                </div>
                <p class="text-slate-400 text-sm mt-2">استخدم هذا العنوان للوصول إلى موقعك</p>
            </div>
        </div>

        <div class="card max-w-lg mx-auto">
            ${(req.isServerOwner || user.isAdmin || permissions.editStartup) ? `
                <form action="/update-startup" method="POST">
                    <input type="hidden" name="userId" value="${userId}">
                    <input type="hidden" name="serverId" value="${serverId}">
                    
                    <label class="block text-sm mb-2">ملف التشغيل الرئيسي</label>
                    <input type="text" name="mainFile" class="form-input" value="${currentMainFile}" placeholder="مثال: index.js, bot.js" required>
                    <p class="text-xs text-slate-400 mb-4">اسم ملف JavaScript الرئيسي الذي سيتم تشغيله (مثل index.js أو server.js).</p>

                    <label class="block text-sm mb-2">المنفذ (Port)</label>
                    <input type="number" name="port" class="form-input" value="${currentPort}" placeholder="مثال: 3000" required>
                    <p class="text-xs text-slate-400 mb-4">المنفذ الذي سيعمل عليه التطبيق (مثل 3000 أو 8080).</p>

                    <label class="block text-sm mb-2">الحزم الإضافية للتثبيت</label>
                    <input type="text" name="packages" class="form-input" value="${currentPackages}" placeholder="مثال: express discord.js moment">
                    <p class="text-xs text-slate-400 mb-4">أسماء الحزم مفصولة بمسافات (مثل express axios). سيتم تثبيتها باستخدام npm install.</p>

                    <button type="submit" class="mt-4 btn btn-success w-full"><i class="fas fa-save mr-2 icon"></i>حفظ إعدادات بدء التشغيل</button>
                </form>
            ` : `
                <div class="p-4">
                    <p class="text-red-500"><i class="fas fa-lock mr-2"></i>غير مصرح لك بتعديل إعدادات بدء التشغيل</p>
                </div>
            `}
        </div>

        <script>
            function copyToClipboard(text) {
                navigator.clipboard.writeText(text).then(() => {
                    // يمكنك إضافة إشعار نجاح النسخ هنا
                    alert('تم نسخ العنوان بنجاح!');
                }).catch(err => {
                    console.error('فشل نسخ العنوان:', err);
                });
            }
        </script>
    `, 'startup', user, true, serverId, server.name, userId, server, req, impersonatedUsername));
});

app.post('/update-startup', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { userId, serverId, mainFile, packages, port } = req.body;
    const targetUserId = userId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.editStartup) {
        return res.redirect(`/?error=${encodeURIComponent('غير مصرح لك بتعديل إعدادات بدء التشغيل')}`);
    }

    if (!mainFile || typeof mainFile !== 'string' || mainFile.trim() === '') {
        return res.redirect(`/startup?serverId=${serverId}&userId=${targetUserId}&error=${encodeURIComponent('اسم ملف التشغيل الرئيسي غير صالح')}`);
    }

    if (!port || isNaN(port) || port < 1 || port > 65535) {
        return res.redirect(`/startup?serverId=${serverId}&userId=${targetUserId}&error=${encodeURIComponent('المنفذ غير صالح. يجب أن يكون رقم بين 1 و 65535')}`);
    }

    try {
        server.startupSettings.set('mainFile', mainFile.trim());
        server.startupSettings.set('packages', packages ? packages.trim() : '');
        server.startupSettings.set('port', port.trim());
        await server.save();
        logServerEvent('تعديل إعدادات بدء التشغيل', { userId: req.userId, serverId, mainFile: mainFile.trim(), packages: packages ? packages.trim() : '', port: port.trim() });
        res.redirect(`/startup?serverId=${serverId}&userId=${targetUserId}&success=${encodeURIComponent('تم تحديث إعدادات بدء التشغيل بنجاح')}`);
    } catch (err) {
        console.error('Error updating startup settings:', err);
        res.redirect(`/startup?serverId=${serverId}&userId=${targetUserId}&error=${encodeURIComponent('خطأ أثناء تحديث إعدادات بدء التشغيل')}`);
    }
});

// Add the /kill-server route here
app.post('/kill-server', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { userId, serverId } = req.body;
    const targetUserId = userId || req.userId;
    const server = req.server; // From ensureServerAccess

    const requestingUser = await User.findOne({ userId: req.originalUserId }); // User performing the action
    const permissions = server.users.get(req.originalUserId) || {};

    // Check if the user has permission to edit settings (like stop), or is owner/admin
    if (!req.isServerOwner && !requestingUser.isAdmin && !permissions.editSettings) {
        return res.redirect(`/server?serverId=${serverId}&userId=${targetUserId}&error=${encodeURIComponent('غير مصرح لك بإيقاف السيرفر قسراً')}`);
    }

    const logKey = `${targetUserId}-${serverId}`;
    initializeServerLogs(targetUserId, serverId); // Ensure logs array exists

    const serverProcess = runningProcesses[targetUserId]?.[serverId];

    if (serverProcess) {
        const killMsg = formatConsoleOutput('🛑 [هام] تم طلب إيقاف قسري للسيرفر (Kill)...');
        consoleLogs[logKey].push(killMsg);
        trimLogs(consoleLogs[logKey]);
        wss.clients.forEach(client => {
            if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                client.send(killMsg);
            }
        });

        try {
            // Use SIGKILL for immediate termination
            serverProcess.kill('SIGKILL'); 
        } catch (killError) {
            console.error(`Error sending SIGKILL to process for server ${serverId}:`, killError);
            // Log error to user console even if kill signal failed (process might have already exited)
            const killErrorMsg = formatConsoleOutput(`⚠️ تحذير: حدث خطأ أثناء محاولة إرسال إشارة الإيقاف القسري: ${killError.message}`);
            consoleLogs[logKey].push(killErrorMsg);
            trimLogs(consoleLogs[logKey]);
        wss.clients.forEach(client => {
            if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                    client.send(killErrorMsg);
                }
            });
        }

        // Remove from running processes immediately after sending kill signal
        delete runningProcesses[targetUserId]?.[serverId]; // Use optional chaining
        
        // Attempt to clean up temp directory asynchronously
        const serverDir = path.join(__dirname, 'temp', targetUserId, serverId);
        fs.remove(serverDir).catch(err => {
            console.error(`Error removing temp dir after kill for server ${serverId}: ${serverDir}`, err);
            // Log warning about cleanup failure (optional)
            const cleanupWarnMsg = formatConsoleOutput(`⚠️ تحذير: فشل حذف المجلد المؤقت (${path.basename(serverDir)}) تلقائياً بعد الإيقاف القسري.`); // Show only last part of dir
            consoleLogs[logKey].push(cleanupWarnMsg);
            trimLogs(consoleLogs[logKey]);
        wss.clients.forEach(client => {
            if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                    client.send(cleanupWarnMsg);
            }
        });
    });

        logServerEvent('إيقاف قسري للسيرفر (Kill)', { userId: req.originalUserId, serverId });
        res.redirect(`/server?serverId=${serverId}&userId=${targetUserId}&success=${encodeURIComponent('تم إرسال إشارة الإيقاف القسري بنجاح.')}`);

    } else {
        // Process not found, maybe already stopped or never started
        const notRunningMsg = formatConsoleOutput('ℹ️ السيرفر لم يكن يعمل لمحاولة الإيقاف القسري.');
        consoleLogs[logKey].push(notRunningMsg);
        trimLogs(consoleLogs[logKey]);
        wss.clients.forEach(client => {
            if (client.userId === targetUserId && client.serverId === serverId && client.readyState === client.OPEN) {
                client.send(notRunningMsg);
            }
        });
        
        // Still attempt cleanup in case temp dir was left behind
        const serverDir = path.join(__dirname, 'temp', targetUserId, serverId);
         fs.remove(serverDir).catch(err => {
            // Log silently if cleanup fails when process wasn't found
            console.error(`Error removing temp dir (server not running) for server ${serverId}: ${serverDir}`, err);
        });

        res.redirect(`/server?serverId=${serverId}&userId=${targetUserId}&error=${encodeURIComponent('السيرفر لم يكن يعمل أو لا يمكن إيجاد العملية.')}`);
    }
});

app.get('/startup', ensureLoggedIn, ensureServerAccess, async (req, res) => {
    const { serverId, userId: targetUserId } = req.query;
    const userId = targetUserId || req.userId;
    const user = await User.findOne({ userId: req.userId });
    const server = req.server;

    const permissions = server.users.get(req.userId) || {};
    if (!req.isServerOwner && !user.isAdmin && !permissions.viewStartup) {
        return res.redirect(`/?error=${encodeURIComponent('غير مصرح لك بمشاهدة إعدادات بدء التشغيل')}`);
    }

    const currentMainFile = server.startupSettings.get('mainFile') || 'index.js';
    const currentPackages = server.startupSettings.get('packages') || '';
    const currentPort = server.startupSettings.get('port') || '3000';
    const serverIP = '69.30.219.180'; // عنوان IP الخاص بالسيرفر

    const queryParams = new URLSearchParams({ serverId });
    if (targetUserId) queryParams.append('userId', targetUserId);

    res.send(baseTemplate(`
        <h1 class="text-3xl font-bold mb-6"><i class="fas fa-play-circle mr-2 icon"></i>إعدادات بدء تشغيل ${server.name}</h1>
        
        <div class="card max-w-lg mx-auto mb-6">
            <div class="p-4 bg-slate-800 rounded-lg">
                <h2 class="text-xl font-semibold mb-2 text-white"><i class="fas fa-globe mr-2"></i>عنوان السيرفر</h2>
                <div class="flex items-center space-x-2">
                    <code class="text-green-400 text-lg">${serverIP}:${currentPort}</code>
                    <button onclick="copyToClipboard('${serverIP}:${currentPort}')" class="btn btn-sm btn-ghost">
                        <i class="fas fa-copy"></i>
                    </button>
                </div>
                <p class="text-slate-400 text-sm mt-2">استخدم هذا العنوان للوصول إلى موقعك</p>
            </div>
        </div>

        <div class="card max-w-lg mx-auto">
            ${(req.isServerOwner || user.isAdmin || permissions.editStartup) ? `
                <form action="/update-startup" method="POST">
                    <input type="hidden" name="userId" value="${userId}">
                    <input type="hidden" name="serverId" value="${serverId}">
                    
                    <label class="block text-sm mb-2">ملف التشغيل الرئيسي</label>
                    <input type="text" name="mainFile" class="form-input" value="${currentMainFile}" placeholder="مثال: index.js, bot.js" required>
                    <p class="text-xs text-slate-400 mb-4">اسم ملف JavaScript الرئيسي الذي سيتم تشغيله (مثل index.js أو server.js).</p>

                    <label class="block text-sm mb-2">المنفذ (Port)</label>
                    <input type="number" name="port" class="form-input" value="${currentPort}" placeholder="مثال: 3000" required>
                    <p class="text-xs text-slate-400 mb-4">المنفذ الذي سيعمل عليه التطبيق (مثل 3000 أو 8080).</p>

                    <label class="block text-sm mb-2">الحزم الإضافية للتثبيت</label>
                    <input type="text" name="packages" class="form-input" value="${currentPackages}" placeholder="مثال: express discord.js moment">
                    <p class="text-xs text-slate-400 mb-4">أسماء الحزم مفصولة بمسافات (مثل express axios). سيتم تثبيتها باستخدام npm install.</p>

                    <button type="submit" class="mt-4 btn btn-success w-full"><i class="fas fa-save mr-2 icon"></i>حفظ إعدادات بدء التشغيل</button>
                </form>
            ` : `
                <div class="p-4">
                    <p class="text-red-500"><i class="fas fa-lock mr-2"></i>غير مصرح لك بتعديل إعدادات بدء التشغيل</p>
                </div>
            `}
        </div>

        <script>
            function copyToClipboard(text) {
                navigator.clipboard.writeText(text).then(() => {
                    // يمكنك إضافة إشعار نجاح النسخ هنا
                    alert('تم نسخ العنوان بنجاح!');
                }).catch(err => {
                    console.error('فشل نسخ العنوان:', err);
                });
            }
        </script>
    `, 'startup', user, true, serverId, server.name, userId, server, req, impersonatedUsername));
});

app.post('/admin/impersonate', ensureLoggedIn, ensureAdmin, async (req, res) => {
    const { userId: targetUserId } = req.body; // The user ID to impersonate
    const adminUserId = req.userId; // The actual admin user ID

    if (adminUserId === targetUserId) {
        return res.redirect('/admin?page=users&error=' + encodeURIComponent('لا يمكنك تسجيل الدخول كـ نفسك'));
    }

    try {
        const targetUser = await User.findOne({ userId: targetUserId });
        if (!targetUser) {
            return res.redirect('/admin?page=users&error=' + encodeURIComponent('المستخدم المستهدف غير موجود'));
        }

        // Optional: Prevent admin from impersonating another admin
        if (targetUser.isAdmin) {
            return res.redirect('/admin?page=users&error=' + encodeURIComponent('لا يمكنك تسجيل الدخول كـ مدير آخر'));
        }

        // Store original user if not already set (should be set at login)
        if (!req.session.originalUserId) {
            req.session.originalUserId = adminUserId;
        }
        // Set the impersonated user ID
        req.session.impersonating = targetUserId;
        
        logServerEvent('بدء التسجيل كمستخدم آخر', { adminId: adminUserId, targetUserId: targetUserId });
        
        // Redirect to the main page, now acting as the target user
        res.redirect('/'); 

    } catch (err) {
        console.error('Error during impersonation:', err);
        res.redirect('/admin?page=users&error=' + encodeURIComponent('حدث خطأ أثناء محاولة تسجيل الدخول كـ مستخدم آخر'));
    }
});

// Add cleanup handler for process exit
process.on('SIGINT', async () => {
    console.log('\nCleaning up temporary directories before exit...');
    try {
        const tempDir = path.join(__dirname, 'temp');
        if (fs.existsSync(tempDir)) {
            await fs.remove(tempDir);
            console.log('Successfully cleaned up temporary directories');
        }
    } catch (err) {
        console.error('Error cleaning up temporary directories:', err);
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nCleaning up temporary directories before exit...');
    try {
        const tempDir = path.join(__dirname, 'temp');
        if (fs.existsSync(tempDir)) {
            await fs.remove(tempDir);
            console.log('Successfully cleaned up temporary directories');
        }
    } catch (err) {
        console.error('Error cleaning up temporary directories:', err);
    }
    process.exit(0);
});