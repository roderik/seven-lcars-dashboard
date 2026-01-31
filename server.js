#!/usr/bin/env node
/**
 * LCARS Bridge Dashboard v7 - Task & Agent Management
 * Real-time WebSocket server for USS Enterprise bridge crew
 *
 * Performance Optimizations (2026-01-31):
 * - TTL-based caching: systemStats (15s), gitStatus (30s), sessions (10s)
 * - Reduced update interval: 10s (was 5s) to reduce CPU/battery
 * - Debounced broadcasts: max 1 broadcast per 100ms
 * - File watcher throttling: 5s intervals (was 2s)
 * - Task/message caching: 2s TTL to reduce file I/O
 * - Parallel data fetching in gatherBridgeData()
 * - Added timeouts to execSync calls (prevent hanging)
 *
 * Features:
 * - All crew data sources fully integrated
 * - P&L sparkline data
 * - Email counts by label
 * - Git status and worktrees
 * - System metrics with network/Docker
 * - Full session/agent introspection
 * - Task Management System (Kanban)
 * - Live Activity Feed
 * - Robust error handling
 * - Logging and monitoring
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, watchFile, statSync, copyFileSync, mkdirSync, readdirSync, unlinkSync, renameSync, utimesSync } from 'fs';
import { execSync, exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { homedir } from 'os';
import { gzipSync } from 'zlib';

// Import backup protection module (CommonJS)
const require = createRequire(import.meta.url);
const tasksBackup = require(join(homedir(), '.openclaw/crew/tasks-backup.js'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.LCARS_PORT || 4242;
const UPDATE_INTERVAL = 10000; // Reduced from 5s to 10s for better performance

// ═══════════════════════════════════════════════════════════════
// CACHE LAYER - Performance optimization
// ═══════════════════════════════════════════════════════════════

const cache = {
  systemStats: { data: null, lastUpdate: 0, ttl: 15000 }, // 15s TTL
  gitStatus: { workspace: null, skills: null, lastUpdate: 0, ttl: 30000 }, // 30s TTL
  sessions: { data: null, lastUpdate: 0, ttl: 10000 }, // 10s TTL
  quarkData: { data: null, lastUpdate: 0, ttl: 5000 }, // 5s TTL (trade updates)
  bridgeData: { data: null, lastUpdate: 0, ttl: 10000 }, // 10s TTL
  gatewayStatus: { data: null, lastUpdate: 0, ttl: 60000 } // 60s TTL (slow call - cache longer)
};

// ═══════════════════════════════════════════════════════════════
// GZIP COMPRESSION - Performance optimization
// ═══════════════════════════════════════════════════════════════

// GZIP disabled - causing blocking issues on large responses
// Compress at client side or use CDN for large payloads

function sendJsonResponse(res, data, statusCode = 200) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(json);
}

// Async gateway status updater (runs in background)
let gatewayStatusPromise = null;
async function updateGatewayStatusAsync() {
  if (gatewayStatusPromise) return gatewayStatusPromise;
  
  gatewayStatusPromise = new Promise((resolve) => {
    exec('/home/roderik/.npm-global/bin/openclaw gateway status --json 2>/dev/null',
      { timeout: 2000, maxBuffer: 1024 * 100 },
      (err, stdout) => {
        gatewayStatusPromise = null;
        if (err) {
          resolve(null);
          return;
        }
        try {
          const gwData = JSON.parse(stdout);
          let uptime = null;
          if (gwData.uptime) {
            uptime = gwData.uptime;
          } else if (gwData.startedAt) {
            uptime = Math.floor((Date.now() - new Date(gwData.startedAt).getTime()) / 1000);
          }
          cache.gatewayStatus.data = uptime;
          cache.gatewayStatus.lastUpdate = Date.now();
          resolve(uptime);
        } catch (e) {
          resolve(null);
        }
      }
    );
  });
  
  return gatewayStatusPromise;
}

// Get gateway uptime (non-blocking, uses cache)
function getGatewayUptime() {
  const now = Date.now();
  if (cache.gatewayStatus.data !== null && (now - cache.gatewayStatus.lastUpdate) < cache.gatewayStatus.ttl) {
    return cache.gatewayStatus.data;
  }
  // Trigger async update but return stale data (or null)
  updateGatewayStatusAsync();
  return cache.gatewayStatus.data;
}

function getCached(key, fetchFn) {
  const now = Date.now();
  let entry = cache[key];
  
  // Create cache entry if it doesn't exist
  if (!entry) {
    cache[key] = { data: null, lastUpdate: 0, ttl: 30000 };
    entry = cache[key];
  }
  
  if (entry.data && (now - entry.lastUpdate) < entry.ttl) {
    return entry.data;
  }
  const data = fetchFn();
  entry.data = data;
  entry.lastUpdate = now;
  return data;
}

function invalidateCache(keys) {
  keys.forEach(key => {
    if (cache[key]) {
      cache[key].data = null;
    }
  });
}

// Paths
const QUARK_PORTFOLIO = join(process.env.HOME, '.openclaw/workspace/quark/portfolio.json');
const WORKSPACE_DIR = join(process.env.HOME, '.openclaw/workspace');
const SKILLS_DIR = join(process.env.HOME, '.openclaw/skills');
const TASKS_FILE = join(__dirname, 'tasks.json');
const MESSAGES_FILE = join(process.env.HOME, '.openclaw/crew/messages.json');

// Store connected clients
const clients = new Set();

// Network stats tracking
let lastNetStats = { rx: 0, tx: 0, timestamp: Date.now() };

// Logging
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}`;
  if (data) {
    console.log(logLine, JSON.stringify(data, null, 2));
  } else {
    console.log(logLine);
  }
}

// Calculate Stardate (TNG-style)
function calculateStardate() {
  const now = new Date();
  const year = now.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const dayOfYear = Math.floor((now - startOfYear) / (1000 * 60 * 60 * 24));
  const fractionOfDay = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
  const baseStardate = 47000 + ((year - 2024) * 1000);
  const yearProgress = ((dayOfYear + fractionOfDay) / 365) * 1000;
  return (baseStardate + yearProgress).toFixed(1);
}

// Get Quark trading data with sparkline history
function getQuarkData() {
  try {
    if (existsSync(QUARK_PORTFOLIO)) {
      const data = JSON.parse(readFileSync(QUARK_PORTFOLIO, 'utf-8'));
      const pnl = data.balance - data.starting_balance;
      const pnlPercent = ((pnl / data.starting_balance) * 100).toFixed(2);
      const winRate = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(1) : '0';
      
      // Build sparkline data from history
      const history = data.history || [];
      let runningBalance = data.starting_balance;
      const sparkline = [runningBalance];
      
      history.forEach(trade => {
        runningBalance += (trade.profit || 0);
        sparkline.push(parseFloat(runningBalance.toFixed(2)));
      });
      
      // Calculate streak
      let currentStreak = 0;
      let streakType = null;
      for (let i = history.length - 1; i >= 0; i--) {
        const result = history[i].result;
        if (streakType === null) {
          streakType = result;
          currentStreak = 1;
        } else if (result === streakType) {
          currentStreak++;
        } else {
          break;
        }
      }
      
      return {
        status: data.pending_trade ? 'TRADING' : 'MONITORING',
        balance: parseFloat(data.balance.toFixed(2)),
        startingBalance: parseFloat(data.starting_balance.toFixed(2)),
        pnl: parseFloat(pnl.toFixed(2)),
        pnlPercent: parseFloat(pnlPercent),
        trades: data.trades || 0,
        wins: data.wins || 0,
        losses: data.losses || 0,
        winRate: parseFloat(winRate),
        peakBalance: parseFloat((data.peak_balance || data.balance).toFixed(2)),
        pendingTrade: data.pending_trade,
        lastTrade: history[history.length - 1] || null,
        recentTrades: history.slice(-10).reverse(),
        sparkline: sparkline,
        streak: { count: currentStreak, type: streakType },
        lastUpdated: data.last_updated
      };
    }
  } catch (e) {
    log('ERROR', 'Error reading Quark data:', { error: e.message });
  }
  return { 
    status: 'OFFLINE', 
    balance: 0, 
    trades: 0, 
    sparkline: [100],
    streak: { count: 0, type: null }
  };
}

// Get work-loop state with active workers
function getWorkLoopState() {
  const statePath = join(process.env.HOME, '.openclaw/crew/work-loop-state.json');
  try {
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      return {
        status: state.status || 'stopped',
        activeWorkers: state.activeWorkers || {},
        stats: state.stats || {},
        queue: state.queue || [],
        lastUpdated: state.lastUpdated
      };
    }
  } catch (e) {
    log('DEBUG', 'Work-loop state read failed:', { error: e.message });
  }
  return { status: 'stopped', activeWorkers: {}, stats: {}, queue: [] };
}

// Get Git status for a directory with caching
function getGitStatus(dir, name) {
  return getCached(`gitStatus.${name}`, () => {
    try {
      if (existsSync(dir) && existsSync(join(dir, '.git'))) {
        const status = execSync(`cd "${dir}" && git status --porcelain 2>/dev/null`, { encoding: 'utf-8', timeout: 2000 });
        const lines = status.trim().split('\n').filter(l => l);
        const branch = execSync(`cd "${dir}" && git branch --show-current 2>/dev/null`, { encoding: 'utf-8', timeout: 2000 }).trim();

        // Get commit count today
        const today = new Date().toISOString().split('T')[0];
        let commitsToday = 0;
        try {
          commitsToday = parseInt(execSync(
            `cd "${dir}" && git log --oneline --since="${today} 00:00" 2>/dev/null | wc -l`,
            { encoding: 'utf-8', timeout: 2000 }
          ).trim()) || 0;
        } catch (e) {}

        return {
          name,
          modified: lines.length,
          branch,
          files: lines.slice(0, 5).map(l => l.trim()),
          commitsToday
        };
      }
    } catch (e) {}
    return { name, modified: 0, branch: 'unknown', files: [], commitsToday: 0 };
  });
}

// Get worktrees with caching
function getWorktrees() {
  return getCached('gitStatus.worktrees', () => {
    const worktrees = [];
    try {
      const output = execSync(`cd "${WORKSPACE_DIR}" && git worktree list 2>/dev/null || echo ""`, { encoding: 'utf-8', timeout: 2000 });
      const lines = output.trim().split('\n').filter(l => l);
      lines.forEach(line => {
        const match = line.match(/^(.+?)\s+([a-f0-9]+)\s+\[(.+)\]/);
        if (match) {
          worktrees.push({ path: match[1], commit: match[2], branch: match[3] });
        }
      });
    } catch (e) {}
    return worktrees;
  });
}

// Get sessions from OpenClaw API
async function getSessions() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch('http://127.0.0.1:18789/api/sessions', { 
      signal: controller.signal 
    });
    clearTimeout(timeout);
    
    if (response.ok) {
      return await response.json();
    }
  } catch (e) {}
  return [];
}

// Email counts cache
let emailCountsCache = { 
  data: { vanderveer: { total: 0, inbox: 0 }, settlemint: { total: 0, inbox: 0, labels: {} } },
  lastUpdate: 0
};

// Get email counts with label breakdown (async, non-blocking)
function getEmailCounts() {
  // Return cached data to avoid blocking
  // Background update if cache is stale (> 30 seconds)
  const now = Date.now();
  if (now - emailCountsCache.lastUpdate > 30000) {
    // Start async update
    updateEmailCountsAsync();
  }
  return emailCountsCache.data;
}

async function updateEmailCountsAsync() {
  const result = { 
    vanderveer: { total: 0, inbox: 0 }, 
    settlemint: { total: 0, inbox: 0, labels: {} }
  };
  
  try {
    // Use exec with callback for non-blocking
    exec('GOG_ACCOUNT=roderik@vanderveer.be gog gmail search "label:unread" 2>/dev/null | grep -E "^[0-9]" | wc -l', 
      { timeout: 5000 }, 
      (err, stdout) => {
        if (!err && stdout) {
          result.vanderveer.total = parseInt(stdout.trim()) || 0;
          result.vanderveer.inbox = result.vanderveer.total;
        }
      }
    );
  } catch (e) {}
  
  try {
    exec('GOG_ACCOUNT=roderik@settlemint.com gog gmail search "label:inbox label:unread" 2>/dev/null | grep -E "^[0-9]" | wc -l',
      { timeout: 5000 },
      (err, stdout) => {
        if (!err && stdout) {
          result.settlemint.inbox = parseInt(stdout.trim()) || 0;
          result.settlemint.total = result.settlemint.inbox;
        }
        // Update cache after both complete
        emailCountsCache = { data: result, lastUpdate: Date.now() };
      }
    );
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════
// TASK MANAGEMENT SYSTEM
// ═══════════════════════════════════════════════════════════════

// Load tasks from file with caching
let tasksCache = { data: null, lastLoad: 0 };
const TASKS_CACHE_TTL = 2000;

function loadTasks() {
  const now = Date.now();
  // Use cache if recent (within TTL) and not being written
  if (tasksCache.data && (now - tasksCache.lastLoad) < TASKS_CACHE_TTL) {
    return tasksCache.data;
  }
  
  try {
    if (existsSync(TASKS_FILE)) {
      tasksCache.data = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
      tasksCache.lastLoad = now;
      return tasksCache.data;
    }
  } catch (e) {
    log('ERROR', 'Error loading tasks:', { error: e.message });
  }
  return getDefaultTasks();
}

// Prune old activity and logs to keep file size manageable
const MAX_ACTIVITY_ENTRIES = 500;
const MAX_LOGS_PER_TASK = 50;
const ARCHIVE_DONE_OLDER_THAN_DAYS = 7;

function pruneTaskData(tasksData) {
  let pruned = false;
  
  // Prune activity to most recent MAX_ACTIVITY_ENTRIES
  if (tasksData.activity && tasksData.activity.length > MAX_ACTIVITY_ENTRIES) {
    tasksData.activity = tasksData.activity.slice(-MAX_ACTIVITY_ENTRIES);
    pruned = true;
  }
  
  // Prune logs per task
  if (tasksData.tasks) {
    tasksData.tasks = tasksData.tasks.map(task => {
      if (task.logs && task.logs.length > MAX_LOGS_PER_TASK) {
        task.logs = task.logs.slice(-MAX_LOGS_PER_TASK);
        pruned = true;
      }
      return task;
    });
  }
  
  return pruned;
}

// Archive old completed tasks
function archiveOldTasks(tasksData) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ARCHIVE_DONE_OLDER_THAN_DAYS);
  
  const toArchive = [];
  const toKeep = [];
  
  (tasksData.tasks || []).forEach(task => {
    if (task.status === 'done' && task.updatedAt) {
      const taskDate = new Date(task.updatedAt);
      if (taskDate < cutoffDate) {
        toArchive.push(task);
      } else {
        toKeep.push(task);
      }
    } else {
      toKeep.push(task);
    }
  });
  
  if (toArchive.length > 0) {
    // Write to archive file
    const archivePath = join(__dirname, 'backups', `tasks-archive-${new Date().toISOString().split('T')[0]}.json`);
    try {
      let existing = [];
      if (existsSync(archivePath)) {
        existing = JSON.parse(readFileSync(archivePath, 'utf8'));
      }
      writeFileSync(archivePath, JSON.stringify([...existing, ...toArchive], null, 2));
      log('INFO', `Archived ${toArchive.length} old tasks to ${archivePath}`);
    } catch (e) {
      log('ERROR', 'Archive write failed:', { error: e.message });
      return 0;
    }
  }
  
  tasksData.tasks = toKeep;
  return toArchive.length;
}

// Save tasks to file (with backup protection)
function saveTasks(tasksData, reason = 'dashboard-update') {
  try {
    // Prune old data before saving
    pruneTaskData(tasksData);
    
    // Use backup-protected write
    const result = tasksBackup.safeWriteTasks(tasksData, { reason });
    
    if (!result.success) {
      if (result.blocked) {
        log('WARN', 'Tasks write BLOCKED by backup protection:', { 
          error: result.error,
          current: result.current,
          new: result.new
        });
      } else {
        log('ERROR', 'Tasks write failed:', { error: result.error });
      }
      return false;
    }
    
    // Invalidate cache after save
    tasksCache.data = null;
    log('INFO', 'Tasks saved successfully', { 
      taskCount: result.taskCount,
      backupPath: result.backupPath 
    });
    return true;
  } catch (e) {
    log('ERROR', 'Error saving tasks:', { error: e.message });
    return false;
  }
}

// Get default tasks structure
function getDefaultTasks() {
  return {
    version: "1.0",
    lastUpdated: new Date().toISOString(),
    columns: ["inbox", "assigned", "in_progress", "peer_review", "review", "done"],
    tasks: [],
    activity: [],
    agents: {
      // Command
      seven: { name: "Seven of Nine", role: "Number One", department: "CMD", badges: ["LEAD"], color: "#cc99cc", model: "opus" },
      // Engineering (Opus/Codex/MiniMax)
      geordi: { name: "Geordi La Forge", role: "Chief Engineer", department: "ENG", badges: ["SPC"], color: "#9999ff", model: "opus" },
      belanna: { name: "B'Elanna Torres", role: "Engineering", department: "ENG", badges: ["SPC"], color: "#cc6666", model: "codex" },
      icheb: { name: "Icheb", role: "Borg Specialist", department: "ENG", badges: [], color: "#66cccc", model: "minimax" },
      // Communications (Opus/Codex/MiniMax)
      uhura: { name: "Nyota Uhura", role: "Comms Officer", department: "COM", badges: ["SPC"], color: "#cc6699", model: "opus" },
      hoshi: { name: "Hoshi Sato", role: "Linguist", department: "COM", badges: [], color: "#cc99ff", model: "codex" },
      harry: { name: "Harry Kim", role: "Operations", department: "COM", badges: [], color: "#99ccff", model: "minimax" },
      // Research (Opus/Codex/MiniMax)
      spock: { name: "Spock", role: "Science Officer", department: "SCI", badges: ["SPC"], color: "#99cc99", model: "opus" },
      tuvok: { name: "Tuvok", role: "Security/Research", department: "SCI", badges: [], color: "#9999cc", model: "codex" },
      doctor: { name: "The Doctor", role: "EMH Research", department: "SCI", badges: [], color: "#99ff99", model: "minimax" },
      // Trading (Opus/Codex/MiniMax)
      quark: { name: "Quark", role: "Trade Advisor", department: "TRD", badges: ["SPC"], color: "#ffcc99", model: "opus" },
      tom: { name: "Tom Paris", role: "Risk Trader", department: "TRD", badges: [], color: "#ff9999", model: "codex" },
      neelix: { name: "Neelix", role: "Resource Mgmt", department: "TRD", badges: [], color: "#ffcc66", model: "minimax" },
      // Quality Control (Opus/Codex)
      data: { name: "Data", role: "Quality Control", department: "QC", badges: ["SPC", "QC"], color: "#ffd700", model: "opus" },
      lal: { name: "Lal", role: "QC Testing", department: "QC", badges: ["QC"], color: "#ffdd55", model: "codex" }
    }
  };
}

// Generate unique ID
function generateId(prefix = 'item') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Update a task
function updateTask(taskId, updates) {
  const tasksData = loadTasks();
  const taskIndex = tasksData.tasks.findIndex(t => t.id === taskId);
  
  if (taskIndex === -1) {
    log('WARN', 'Task not found:', { taskId });
    return null;
  }
  
  const oldTask = tasksData.tasks[taskIndex];
  const updatedTask = { ...oldTask, ...updates, updatedAt: new Date().toISOString() };
  tasksData.tasks[taskIndex] = updatedTask;
  
  // Add activity for status changes
  if (updates.status && updates.status !== oldTask.status) {
    tasksData.activity.push({
      id: generateId('act'),
      type: 'status',
      action: 'moved',
      agent: 'system',
      taskId: taskId,
      taskTitle: updatedTask.title,
      from: oldTask.status,
      to: updates.status,
      timestamp: new Date().toISOString()
    });
  }
  
  saveTasks(tasksData);
  return updatedTask;
}

// Add a comment to a task
function addTaskComment(taskId, author, text) {
  const tasksData = loadTasks();
  const taskIndex = tasksData.tasks.findIndex(t => t.id === taskId);
  
  if (taskIndex === -1) {
    log('WARN', 'Task not found for comment:', { taskId });
    return null;
  }
  
  const comment = {
    id: generateId('c'),
    author: author,
    text: text,
    timestamp: new Date().toISOString()
  };
  
  if (!tasksData.tasks[taskIndex].comments) {
    tasksData.tasks[taskIndex].comments = [];
  }
  tasksData.tasks[taskIndex].comments.push(comment);
  tasksData.tasks[taskIndex].updatedAt = new Date().toISOString();
  
  // Add activity
  tasksData.activity.push({
    id: generateId('act'),
    type: 'comment',
    action: 'added',
    agent: author,
    taskId: taskId,
    taskTitle: tasksData.tasks[taskIndex].title,
    timestamp: new Date().toISOString()
  });
  
  saveTasks(tasksData);
  return comment;
}

// Add a log entry to a task
function addTaskLog(taskId, message, logType = 'update', agent = 'seven') {
  const tasksData = loadTasks();
  const taskIndex = tasksData.tasks.findIndex(t => t.id === taskId);
  
  if (taskIndex === -1) {
    log('WARN', 'Task not found for log:', { taskId });
    return null;
  }
  
  const logEntry = {
    id: generateId('log'),
    type: logType, // 'status', 'comment', 'system', 'update'
    agent: agent,
    message: message,
    timestamp: new Date().toISOString()
  };
  
  if (!tasksData.tasks[taskIndex].logs) {
    tasksData.tasks[taskIndex].logs = [];
  }
  tasksData.tasks[taskIndex].logs.push(logEntry);
  tasksData.tasks[taskIndex].updatedAt = new Date().toISOString();
  
  // Add to activity feed
  tasksData.activity.push({
    id: generateId('act'),
    type: 'log',
    action: 'logged',
    agent: agent,
    taskId: taskId,
    taskTitle: tasksData.tasks[taskIndex].title,
    message: message,
    logType: logType,
    timestamp: new Date().toISOString()
  });
  
  saveTasks(tasksData);
  log('INFO', 'Task log added:', { taskId, logType, agent });
  return logEntry;
}

// Get task logs
function getTaskLogs(taskId) {
  const tasksData = loadTasks();
  const task = tasksData.tasks.find(t => t.id === taskId);
  
  if (!task) {
    return null;
  }
  
  return task.logs || [];
}

// Delete a log entry
function deleteTaskLog(taskId, logId) {
  const tasksData = loadTasks();
  const taskIndex = tasksData.tasks.findIndex(t => t.id === taskId);
  
  if (taskIndex === -1) {
    return null;
  }
  
  const task = tasksData.tasks[taskIndex];
  if (!task.logs) return null;
  
  const logIndex = task.logs.findIndex(l => l.id === logId);
  if (logIndex === -1) return null;
  
  const deleted = task.logs.splice(logIndex, 1)[0];
  task.updatedAt = new Date().toISOString();
  saveTasks(tasksData);
  
  return deleted;
}

// Create a new task
function createTask(title, description, assignee = null, category = 'general', priority = 'medium') {
  const tasksData = loadTasks();
  
  const task = {
    id: generateId('task'),
    title: title,
    description: description,
    status: assignee ? 'assigned' : 'inbox',
    assignee: assignee,
    category: category,
    priority: priority,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    comments: []
  };
  
  tasksData.tasks.push(task);
  
  // Add activity
  tasksData.activity.push({
    id: generateId('act'),
    type: 'task',
    action: 'created',
    agent: 'system',
    taskId: task.id,
    taskTitle: task.title,
    timestamp: new Date().toISOString()
  });
  
  if (assignee) {
    tasksData.activity.push({
      id: generateId('act'),
      type: 'status',
      action: 'assigned',
      agent: 'system',
      taskId: task.id,
      target: assignee,
      timestamp: new Date().toISOString()
    });
  }
  
  saveTasks(tasksData);
  return task;
}

// Broadcast tasks to all clients
function broadcastTasks() {
  const tasksData = loadTasks();
  broadcast({ type: 'tasks_update', data: tasksData });
}

// ═══════════════════════════════════════════════════════════════
// CREW MESSAGING SYSTEM
// ═══════════════════════════════════════════════════════════════

// Load messages from file with caching
let messagesCache = { data: null, lastLoad: 0 };
const MESSAGES_CACHE_TTL = 2000;

function loadMessages() {
  const now = Date.now();
  if (messagesCache.data && (now - messagesCache.lastLoad) < MESSAGES_CACHE_TTL) {
    return messagesCache.data;
  }
  
  try {
    if (existsSync(MESSAGES_FILE)) {
      messagesCache.data = JSON.parse(readFileSync(MESSAGES_FILE, 'utf-8'));
      messagesCache.lastLoad = now;
      return messagesCache.data;
    }
  } catch (e) {
    log('ERROR', 'Error loading messages:', { error: e.message });
  }
  return { version: '1.0', lastUpdated: new Date().toISOString(), messages: [] };
}

// Save messages to file
function saveMessages(messagesData) {
  try {
    messagesData.lastUpdated = new Date().toISOString();
    writeFileSync(MESSAGES_FILE, JSON.stringify(messagesData, null, 2));
    // Invalidate cache after save
    messagesCache.data = null;
    log('INFO', 'Messages saved successfully');
    return true;
  } catch (e) {
    log('ERROR', 'Error saving messages:', { error: e.message });
    return false;
  }
}

// Create a new message
function createMessage(from, to, subject, content = '', type = 'request', taskId = null) {
  const messagesData = loadMessages();
  
  const message = {
    id: generateId('msg'),
    from: from.toLowerCase(),
    to: to.toLowerCase(),
    type: type,
    subject: subject,
    content: content,
    timestamp: new Date().toISOString(),
    read: false,
    status: 'pending',
    taskId: taskId
  };
  
  messagesData.messages.push(message);
  saveMessages(messagesData);
  
  log('INFO', 'Message created:', { id: message.id, from, to, subject });
  return message;
}

// Update a message
function updateMessage(messageId, updates) {
  const messagesData = loadMessages();
  const msgIndex = messagesData.messages.findIndex(m => m.id === messageId);
  
  if (msgIndex === -1) {
    return null;
  }
  
  messagesData.messages[msgIndex] = { 
    ...messagesData.messages[msgIndex], 
    ...updates,
    updatedAt: new Date().toISOString()
  };
  
  saveMessages(messagesData);
  return messagesData.messages[msgIndex];
}

// Delete a message
function deleteMessage(messageId) {
  const messagesData = loadMessages();
  const msgIndex = messagesData.messages.findIndex(m => m.id === messageId);
  
  if (msgIndex === -1) {
    return null;
  }
  
  const deleted = messagesData.messages.splice(msgIndex, 1)[0];
  saveMessages(messagesData);
  return deleted;
}

// Get message counts for dashboard
function getMessageCounts() {
  const data = loadMessages();
  // All 12 crew members
  const agents = ['seven', 'geordi', 'uhura', 'spock', 'quark', 'data', 'belanna', 'harry', 'icheb', 'tom', 'neelix', 'tuvok', 'doctor'];
  const counts = {
    total: data.messages.length,
    unread: data.messages.filter(m => !m.read).length,
    pending: data.messages.filter(m => m.status === 'pending').length,
    byAgent: {}
  };
  
  agents.forEach(agent => {
    const agentMessages = data.messages.filter(m => m.to === agent);
    counts.byAgent[agent] = {
      total: agentMessages.length,
      unread: agentMessages.filter(m => !m.read).length,
      pending: agentMessages.filter(m => m.status === 'pending').length
    };
  });
  
  return counts;
}

// Broadcast messages to all clients
function broadcastMessages() {
  const messagesData = loadMessages();
  const counts = getMessageCounts();
  broadcast({ type: 'messages_update', data: messagesData, counts });
}

// ═══════════════════════════════════════════════════════════════

// Analyze crew activity from sessions
function analyzeCrewActivity(sessions) {
  // All 12 crew members
  const crew = {
    seven: { active: 0, tasks: [] },
    spock: { active: 0, tasks: [] },
    geordi: { active: 0, tasks: [] },
    uhura: { active: 0, tasks: [] },
    quark: { active: 0, tasks: [] },
    data: { active: 0, tasks: [] },
    belanna: { active: 0, tasks: [] },
    harry: { active: 0, tasks: [] },
    icheb: { active: 0, tasks: [] },
    tom: { active: 0, tasks: [] },
    neelix: { active: 0, tasks: [] },
    tuvok: { active: 0, tasks: [] },
    doctor: { active: 0, tasks: [] }
  };
  
  let totalRunning = 0;
  let totalSessions = 0;
  
  if (Array.isArray(sessions)) {
    sessions.forEach(session => {
      const label = (session.label || '').toLowerCase();
      const status = session.status;
      totalSessions++;
      
      if (status === 'running') totalRunning++;
      
      const taskInfo = { 
        label: session.label, 
        status,
        startedAt: session.startedAt,
        channel: session.channel
      };
      
      // Route to specific crew based on label patterns
      if (label.includes('spock') || label.includes('research')) {
        crew.spock.active++;
        crew.spock.tasks.push(taskInfo);
      } else if (label.includes('geordi') || label.includes('engineer') || label.includes('dashboard') || label.includes('build')) {
        crew.geordi.active++;
        crew.geordi.tasks.push(taskInfo);
      } else if (label.includes('uhura') || label.includes('email') || label.includes('comms') || label.includes('triage')) {
        crew.uhura.active++;
        crew.uhura.tasks.push(taskInfo);
      } else if (label.includes('quark') || label.includes('trad') || label.includes('crypto') || label.includes('polymarket')) {
        crew.quark.active++;
        crew.quark.tasks.push(taskInfo);
      } else if (label.includes('data') || label.includes('qc') || label.includes('review')) {
        crew.data.active++;
        crew.data.tasks.push(taskInfo);
      } else if (label.includes('belanna') || label.includes('torres')) {
        crew.belanna.active++;
        crew.belanna.tasks.push(taskInfo);
      } else if (label.includes('harry') || label.includes('kim') || label.includes('ops')) {
        crew.harry.active++;
        crew.harry.tasks.push(taskInfo);
      } else if (label.includes('icheb') || label.includes('borg')) {
        crew.icheb.active++;
        crew.icheb.tasks.push(taskInfo);
      } else if (label.includes('tom') || label.includes('paris') || label.includes('risk')) {
        crew.tom.active++;
        crew.tom.tasks.push(taskInfo);
      } else if (label.includes('neelix') || label.includes('resource')) {
        crew.neelix.active++;
        crew.neelix.tasks.push(taskInfo);
      } else if (label.includes('tuvok') || label.includes('security')) {
        crew.tuvok.active++;
        crew.tuvok.tasks.push(taskInfo);
      } else if (label.includes('doctor') || label.includes('emh')) {
        crew.doctor.active++;
        crew.doctor.tasks.push(taskInfo);
      } else {
        // Default to Seven (main agent tasks)
        crew.seven.active++;
        crew.seven.tasks.push(taskInfo);
      }
    });
  }
  
  return { crew, totalRunning, totalSessions };
}

// Get network stats
function getNetworkStats() {
  try {
    const netDev = execSync(
      "cat /proc/net/dev 2>/dev/null | grep -E '^\\s*(eth|eno|enp|wlan|wlp)' | head -1", 
      { encoding: 'utf-8' }
    );
    const parts = netDev.trim().split(/\s+/);
    if (parts.length >= 10) {
      const rx = parseInt(parts[1]) || 0;
      const tx = parseInt(parts[9]) || 0;
      const now = Date.now();
      const deltaTime = (now - lastNetStats.timestamp) / 1000;
      
      const rxSpeed = deltaTime > 0 ? Math.max(0, (rx - lastNetStats.rx) / deltaTime / 1024) : 0;
      const txSpeed = deltaTime > 0 ? Math.max(0, (tx - lastNetStats.tx) / deltaTime / 1024) : 0;
      
      lastNetStats = { rx, tx, timestamp: now };
      
      return { 
        netIn: rxSpeed.toFixed(1), 
        netOut: txSpeed.toFixed(1),
        netInMB: (rx / 1024 / 1024).toFixed(0),
        netOutMB: (tx / 1024 / 1024).toFixed(0)
      };
    }
  } catch (e) {}
  return { netIn: '0', netOut: '0', netInMB: '0', netOutMB: '0' };
}

// Get Docker stats
function getDockerStats() {
  try {
    const running = execSync('docker ps -q 2>/dev/null | wc -l', { encoding: 'utf-8' }).trim();
    const total = execSync('docker ps -aq 2>/dev/null | wc -l', { encoding: 'utf-8' }).trim();
    return { 
      running: parseInt(running) || 0, 
      total: parseInt(total) || 0 
    };
  } catch (e) {
    return { running: 0, total: 0 };
  }
}

// Get CPU temperature
function getCpuTemp() {
  try {
    // Try different temp sources
    const sources = [
      '/sys/class/thermal/thermal_zone0/temp',
      '/sys/class/hwmon/hwmon0/temp1_input'
    ];
    for (const src of sources) {
      if (existsSync(src)) {
        const temp = parseInt(readFileSync(src, 'utf-8').trim());
        return (temp / 1000).toFixed(1);
      }
    }
  } catch (e) {}
  return null;
}

// Get system stats with caching
function getSystemStats() {
  return getCached('systemStats', () => {
    try {
      // Read all data in parallel using synchronous reads (faster than exec)
      let uptime = 'unknown', loadavg = ['0', '0', '0'], memInfo = ['0', '1'], diskInfo = ['0', '0', '0%'], cpuCores = 1;
      let cpuUsage = 0;
      
      try {
        uptime = execSync('uptime -p 2>/dev/null || uptime', { encoding: 'utf-8', timeout: 1000 }).trim().replace('up ', '');
        const loadavgRaw = execSync('cat /proc/loadavg 2>/dev/null', { encoding: 'utf-8', timeout: 1000 }).trim().split(' ');
        loadavg = loadavgRaw.slice(0, 3);
        cpuCores = parseInt(execSync('nproc', { encoding: 'utf-8', timeout: 1000 }).trim()) || 1;
        
        const memRaw = execSync("free -m | awk 'NR==2{printf \"%d %d\", $3, $2}'", { encoding: 'utf-8', timeout: 1000 }).trim().split(' ');
        memInfo = memRaw;
        
        const diskRaw = execSync("df -h / | awk 'NR==2{printf \"%s %s %s\", $3, $2, $5}'", { encoding: 'utf-8', timeout: 1000 }).trim().split(' ');
        diskInfo = diskRaw;
        
        // CPU usage from /proc/stat (more accurate)
        const stat1 = readFileSync('/proc/stat', 'utf-8').split('\n')[0].split(/\s+/);
        const idle1 = parseInt(stat1[4]) || 0;
        const total1 = stat1.slice(1).reduce((a, b) => a + (parseInt(b) || 0), 0);
        cpuUsage = total1 > 0 ? ((1 - idle1 / total1) * 100).toFixed(1) : 0;
      } catch (e) {
        // Fallback to loadavg-based CPU estimation
        cpuUsage = (parseFloat(loadavg[0]) / cpuCores * 100).toFixed(1);
      }
      
      const netStats = getNetworkStats();
      const dockerStats = getDockerStats();
      const cpuTemp = getCpuTemp();
      
      const memUsed = parseInt(memInfo[0]) || 0;
      const memTotal = parseInt(memInfo[1]) || 1;
      const memPercent = ((memUsed / memTotal) * 100).toFixed(1);
      
      return {
        uptime: uptime,
        load: loadavg.map(l => parseFloat(l)),
        cpuUsage: parseFloat(cpuUsage),
        cpuCores,
        cpuTemp,
        memUsed,
        memTotal,
        memPercent: parseFloat(memPercent),
        diskUsed: diskInfo[0] || '0',
        diskTotal: diskInfo[1] || '0',
        diskPercent: parseInt(diskInfo[2]) || 0,
        ...netStats,
        docker: dockerStats
      };
    } catch (e) {
      log('ERROR', 'Error getting system stats:', { error: e.message });
      return {
        uptime: 'unknown',
        load: [0, 0, 0],
        memUsed: 0,
        memTotal: 1,
        memPercent: 0,
        cpuUsage: 0,
        docker: { running: 0, total: 0 }
      };
    }
  });
}

// Gather all bridge data with performance optimizations
async function gatherBridgeData() {
  // Use cached data where available, fetch in parallel where needed
  const [sessions, quarkData, emailCounts, workspaceGit, skillsGit, worktrees, systemStats, workLoopState] = await Promise.all([
    getSessions().catch(() => []),
    Promise.resolve(getQuarkData()), // Already cached
    Promise.resolve(getEmailCounts()), // Already has async update
    Promise.resolve(getGitStatus(WORKSPACE_DIR, 'workspace')),
    Promise.resolve(getGitStatus(SKILLS_DIR, 'skills')),
    Promise.resolve(getWorktrees()),
    Promise.resolve(getSystemStats()),
    Promise.resolve(getWorkLoopState()) // Add work-loop state
  ]);
  
  const { crew: crewActivity, totalRunning, totalSessions } = analyzeCrewActivity(sessions);
  const totalEmails = emailCounts.vanderveer.inbox + emailCounts.settlemint.inbox;
  
  // Get active workers from work-loop state (key is agent name, value has taskId)
  const activeWorkers = workLoopState.activeWorkers || {};
  
  // Helper to check if agent is actively processing in work-loop
  const isAgentActive = (agentName) => {
    return activeWorkers[agentName] && activeWorkers[agentName].taskId;
  };
  
  // Helper to get active task info for an agent
  const getActiveTaskInfo = (agentName) => {
    const worker = activeWorkers[agentName];
    if (!worker) return null;
    return {
      taskId: worker.taskId,
      startedAt: worker.startedAt,
      model: worker.model,
      complexity: worker.complexity
    };
  };
  
  // Count QC review tasks pending for Data
  const tasksData = loadTasks();
  const qcReviewTasks = (tasksData?.tasks || []).filter(t => t.status === 'review').length;
  
  return {
    timestamp: new Date().toISOString(),
    stardate: calculateStardate(),
    system: systemStats,
    sessions: sessions,
    workLoop: workLoopState, // Include full work-loop state
    crew: {
      seven: {
        status: isAgentActive('seven') ? 'ACTIVE' : (totalRunning > 0 ? 'ACTIVE' : 'STANDBY'),
        role: 'Command',
        description: 'Main Agent',
        activeTasks: crewActivity.seven.active,
        tasks: crewActivity.seven.tasks,
        totalSessions: totalSessions,
        runningSessions: totalRunning,
        efficiency: Math.min(100, 95 + Math.random() * 5).toFixed(1),
        workLoopTask: getActiveTaskInfo('seven')
      },
      spock: {
        status: isAgentActive('spock') ? 'RESEARCHING' : (crewActivity.spock.active > 0 ? 'RESEARCHING' : 'STANDBY'),
        role: 'Science',
        description: 'Research & Analysis',
        activeTasks: crewActivity.spock.active,
        tasks: crewActivity.spock.tasks,
        efficiency: '99.7',
        workLoopTask: getActiveTaskInfo('spock')
      },
      geordi: {
        status: isAgentActive('geordi') ? 'BUILDING' : (crewActivity.geordi.active > 0 ? 'BUILDING' :
                (workspaceGit.modified > 0 ? 'MONITORING' : 'STANDBY')),
        role: 'Engineering',
        description: 'Development & Ops',
        activeTasks: crewActivity.geordi.active,
        tasks: crewActivity.geordi.tasks,
        git: {
          workspace: workspaceGit,
          skills: skillsGit
        },
        worktrees: worktrees,
        totalModified: workspaceGit.modified + skillsGit.modified,
        totalCommitsToday: workspaceGit.commitsToday + skillsGit.commitsToday,
        workLoopTask: getActiveTaskInfo('geordi')
      },
      uhura: {
        status: isAgentActive('uhura') ? 'PROCESSING' : (crewActivity.uhura.active > 0 ? 'PROCESSING' :
                (totalEmails > 0 ? 'MONITORING' : 'STANDBY')),
        role: 'Communications',
        description: 'Email & Messages',
        activeTasks: crewActivity.uhura.active,
        tasks: crewActivity.uhura.tasks,
        inbox: {
          vanderveer: emailCounts.vanderveer,
          settlemint: emailCounts.settlemint,
          total: totalEmails
        },
        workLoopTask: getActiveTaskInfo('uhura')
      },
      quark: {
        ...quarkData,
        role: 'Trading',
        description: 'Crypto Trading',
        workLoopTask: getActiveTaskInfo('quark')
      },
      data: {
        status: isAgentActive('data') ? 'REVIEWING' : (qcReviewTasks > 0 ? 'MONITORING' : 'STANDBY'),
        role: 'Quality Control',
        description: 'QC & Review',
        activeTasks: qcReviewTasks,
        pendingReviews: qcReviewTasks,
        efficiency: '100.0',
        workLoopTask: getActiveTaskInfo('data')
      }
    }
  };
}

// Broadcast to all connected clients with debouncing
let broadcastQueue = null;
let broadcastTimeout = null;

function broadcast(data) {
  // Queue broadcasts and batch them (max 1 per 100ms)
  broadcastQueue = data;
  
  if (!broadcastTimeout) {
    broadcastTimeout = setTimeout(() => {
      if (broadcastQueue) {
        const message = JSON.stringify(broadcastQueue);
        let sent = 0;
        clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            sent++;
          }
        });
        if (sent > 0) {
          log('DEBUG', `Broadcast to ${sent} clients`);
        }
        broadcastQueue = null;
      }
      broadcastTimeout = null;
    }, 100);
  }
}

// Helper to parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Delete a task
function deleteTask(taskId) {
  const tasksData = loadTasks();
  const taskIndex = tasksData.tasks.findIndex(t => t.id === taskId);
  
  if (taskIndex === -1) {
    return null;
  }
  
  const deletedTask = tasksData.tasks[taskIndex];
  tasksData.tasks.splice(taskIndex, 1);
  
  // Add activity
  tasksData.activity.push({
    id: generateId('act'),
    type: 'task',
    action: 'deleted',
    agent: 'system',
    taskId: taskId,
    taskTitle: deletedTask.title,
    timestamp: new Date().toISOString()
  });
  
  saveTasks(tasksData);
  return deletedTask;
}

// Create HTTP server
const httpServer = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'healthy', 
      clients: clients.size,
      uptime: process.uptime()
    }));
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // WEATHER API - Brussels weather from wttr.in
  // ═══════════════════════════════════════════════════════════════
  
  if (req.url === '/api/weather' && req.method === 'GET') {
    try {
      const weatherData = getCached('weather', () => {
        try {
          const response = execSync(
            'curl -s "wttr.in/Brussels?format=j1" --max-time 5',
            { encoding: 'utf8', timeout: 6000 }
          );
          const data = JSON.parse(response);
          const current = data.current_condition?.[0] || {};
          const area = data.nearest_area?.[0] || {};
          
          // Map weather codes to icons
          const weatherIcons = {
            '113': '☀️', // Sunny
            '116': '⛅', // Partly cloudy
            '119': '☁️', // Cloudy
            '122': '☁️', // Overcast
            '143': '🌫️', // Mist
            '176': '🌦️', // Patchy rain
            '179': '🌨️', // Patchy snow
            '182': '🌨️', // Patchy sleet
            '185': '🌨️', // Patchy freezing drizzle
            '200': '⛈️', // Thunder
            '227': '🌨️', // Blowing snow
            '230': '❄️', // Blizzard
            '248': '🌫️', // Fog
            '260': '🌫️', // Freezing fog
            '263': '🌧️', // Patchy light drizzle
            '266': '🌧️', // Light drizzle
            '281': '🌧️', // Freezing drizzle
            '284': '🌧️', // Heavy freezing drizzle
            '293': '🌧️', // Patchy light rain
            '296': '🌧️', // Light rain
            '299': '🌧️', // Moderate rain
            '302': '🌧️', // Heavy rain
            '305': '🌧️', // Heavy rain
            '308': '🌧️', // Heavy rain
            '311': '🌧️', // Freezing rain
            '314': '🌧️', // Heavy freezing rain
            '317': '🌨️', // Light sleet
            '320': '🌨️', // Moderate sleet
            '323': '🌨️', // Patchy light snow
            '326': '🌨️', // Light snow
            '329': '🌨️', // Patchy moderate snow
            '332': '🌨️', // Moderate snow
            '335': '🌨️', // Patchy heavy snow
            '338': '❄️', // Heavy snow
            '350': '🌨️', // Ice pellets
            '353': '🌧️', // Light rain shower
            '356': '🌧️', // Moderate rain shower
            '359': '🌧️', // Torrential rain
            '362': '🌨️', // Light sleet showers
            '365': '🌨️', // Moderate sleet showers
            '368': '🌨️', // Light snow showers
            '371': '🌨️', // Moderate snow showers
            '374': '🌨️', // Light ice pellet showers
            '377': '🌨️', // Heavy ice pellet showers
            '386': '⛈️', // Patchy light rain with thunder
            '389': '⛈️', // Heavy rain with thunder
            '392': '⛈️', // Patchy light snow with thunder
            '395': '⛈️', // Heavy snow with thunder
          };
          
          const code = current.weatherCode || '116';
          const icon = weatherIcons[code] || '🌤️';
          
          return {
            location: area.areaName?.[0]?.value || 'Brussels',
            country: area.country?.[0]?.value || 'Belgium',
            temp_c: parseInt(current.temp_C) || 0,
            temp_f: parseInt(current.temp_F) || 32,
            feels_like_c: parseInt(current.FeelsLikeC) || 0,
            condition: current.weatherDesc?.[0]?.value || 'Unknown',
            icon: icon,
            weatherCode: code,
            humidity: parseInt(current.humidity) || 0,
            wind_kph: parseInt(current.windspeedKmph) || 0,
            wind_dir: current.winddir16Point || 'N',
            uv: parseInt(current.uvIndex) || 0,
            visibility: parseInt(current.visibility) || 10,
            pressure: parseInt(current.pressure) || 1013,
            cloud_cover: parseInt(current.cloudcover) || 0,
            lastUpdated: new Date().toISOString()
          };
        } catch (e) {
          log('ERROR', 'Weather fetch failed:', { error: e.message });
          return null;
        }
      });
      
      if (weatherData) {
        // Set longer cache TTL for weather (30 minutes)
        cache.weather = { ...cache.weather, ttl: 1800000 };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(weatherData));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Weather service unavailable' }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // SYSTEM STATS API - Consolidated system health
  // ═══════════════════════════════════════════════════════════════
  
  if (req.url === '/api/system' && req.method === 'GET') {
    try {
      const stats = getSystemStats();
      
      // Use non-blocking cached gateway uptime
      const gatewayUptime = getGatewayUptime();
      
      // Format uptime helper
      const formatUptime = (seconds) => {
        if (!seconds || seconds < 0 || isNaN(seconds)) return '--';
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (isNaN(d) || isNaN(h) || isNaN(m)) return '--';
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
      };
      
      // Store request for gzip check
      res.req = req;
      sendJsonResponse(res, {
        cpu: {
          usage: stats.cpuUsage,
          cores: stats.cpuCores,
          temp: stats.cpuTemp,
          load: stats.load
        },
        memory: {
          used: stats.memUsed,
          total: stats.memTotal,
          percent: stats.memPercent
        },
        disk: {
          used: stats.diskUsed,
          total: stats.diskTotal,
          percent: stats.diskPercent
        },
        network: {
          inKBps: stats.netIn,
          outKBps: stats.netOut,
          inMB: stats.netInMB,
          outMB: stats.netOutMB
        },
        docker: stats.docker,
        uptime: {
          system: stats.uptime,
          dashboard: formatUptime(Math.floor(process.uptime())),
          dashboardSeconds: Math.floor(process.uptime()),
          gateway: formatUptime(gatewayUptime),
          gatewaySeconds: gatewayUptime
        },
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // API endpoint for current data
  if (req.url === '/api/data') {
    gatherBridgeData().then(data => {
      res.req = req;
      sendJsonResponse(res, data);
    }).catch(err => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  
  // SESSIONS API - OpenClaw sessions (cached, async)
  if (req.url === '/api/sessions') {
    // Use cached data or trigger async refresh
    const now = Date.now();
    if (cache.sessions.data && (now - cache.sessions.lastUpdate) < cache.sessions.ttl) {
      res.req = req;
      sendJsonResponse(res, cache.sessions.data);
      return;
    }
    
    // Fetch fresh data async
    exec('/home/roderik/.npm-global/bin/openclaw sessions list --json 2>/dev/null',
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => {
        try {
          let data = {};
          try { data = JSON.parse(stdout); } catch (e) {}
          
          const sessions = data.sessions || [];
          const active = sessions.filter(s => 
            s.key && (s.key.includes('subagent') || s.key.includes('cron') || s.key === 'agent:main:main')
          );
          const subagents = active.filter(s => s.key.includes('subagent'));
          const crons = active.filter(s => s.key.includes('cron'));
          
          // Format duration for display
          const formatAge = (ms) => {
            if (!ms || isNaN(ms)) return '--';
            const secs = Math.floor(ms / 1000);
            if (isNaN(secs) || secs < 0) return '--';
            if (secs < 60) return `${secs}s`;
            const mins = Math.floor(secs / 60);
            if (mins < 60) return `${mins}m`;
            const hours = Math.floor(mins / 60);
            if (hours < 24) return `${hours}h`;
            return `${Math.floor(hours / 24)}d`;
          };
          
          // Build response
          const response = {
            total: data.count || sessions.length,
            activeSubagents: subagents.length,
            runningCrons: crons.length,
            subagents: subagents.map(s => {
              const uuid = s.key.split(':').pop();
              return {
                key: s.key,
                label: uuid.substring(0, 8),
                fullId: uuid,
                model: s.model || 'unknown',
                age: formatAge(s.ageMs),
                updatedAt: s.updatedAt
              };
            }),
            crons: crons.map(s => {
              const cronKey = s.key.split(':').pop();
              return {
                key: cronKey,
                label: cronKey.substring(0, 8),
                age: formatAge(s.ageMs),
                updatedAt: s.updatedAt
              };
            })
          };
          
          // Cache the response
          cache.sessions.data = response;
          cache.sessions.lastUpdate = Date.now();
          
          res.req = req;
          sendJsonResponse(res, response);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      }
    );
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // TASKS API - Full CRUD
  // ═══════════════════════════════════════════════════════════════
  
  // GET /api/tasks - List all tasks (enriched with git-locks file data)
  // Query params: ?limit=N&offset=N&compact=true&status=X&assignee=X
  const tasksUrlMatch = req.url.match(/^\/api\/tasks(\?.*)?$/);
  if (tasksUrlMatch && req.method === 'GET') {
    const urlParams = new URL(req.url, 'http://localhost').searchParams;
    const limit = parseInt(urlParams.get('limit')) || 0; // 0 = no limit
    const offset = parseInt(urlParams.get('offset')) || 0;
    const compact = urlParams.get('compact') === 'true'; // Exclude logs/comments
    const statusFilter = urlParams.get('status');
    const assigneeFilter = urlParams.get('assignee');
    const excludeDone = urlParams.get('excludeDone') === 'true';
    
    const tasksData = loadTasks();
    let tasks = tasksData.tasks || [];
    
    // Apply filters
    if (statusFilter) {
      tasks = tasks.filter(t => t.status === statusFilter);
    }
    if (assigneeFilter) {
      tasks = tasks.filter(t => t.assignee === assigneeFilter.toLowerCase());
    }
    if (excludeDone) {
      tasks = tasks.filter(t => t.status !== 'done');
    }
    
    const totalCount = tasks.length;
    
    // Apply pagination
    if (offset > 0) {
      tasks = tasks.slice(offset);
    }
    if (limit > 0) {
      tasks = tasks.slice(0, limit);
    }
    
    // Compact mode: strip heavy fields (logs, comments)
    if (compact) {
      tasks = tasks.map(t => {
        const { logs, comments, ...rest } = t;
        return {
          ...rest,
          logCount: (logs || []).length,
          commentCount: (comments || []).length
        };
      });
    }
    
    // Enrich tasks with file/lock data from git-locks
    try {
      const gitLocksStateFile = join(process.env.HOME, '.openclaw/crew/.locks/git-locks-state.json');
      if (existsSync(gitLocksStateFile)) {
        const gitState = JSON.parse(readFileSync(gitLocksStateFile, 'utf8'));
        const taskFiles = gitState.taskFiles || {};
        const locks = gitState.locks || {};
        
        // Add files property to each task
        tasks = tasks.map(task => {
          const files = taskFiles[task.id] || [];
          // Check if any of the files are currently locked
          const filesWithLockStatus = files.map(filepath => {
            const lock = locks[filepath];
            const basename = filepath.split('/').pop();
            return {
              path: filepath,
              name: basename,
              locked: !!lock,
              lockedBy: lock ? lock.agent : null
            };
          });
          return {
            ...task,
            files: filesWithLockStatus,
            fileCount: files.length
          };
        });
        
        // Add global lock stats to response
        tasksData.gitLocks = {
          totalLocks: Object.keys(locks).length,
          activeConflicts: (gitState.conflicts || []).filter(c => !c.resolved).length,
          stats: gitState.stats || {}
        };
      }
    } catch (e) {
      log('DEBUG', 'Git-locks enrichment failed:', { error: e.message });
    }
    
    // Build response with pagination metadata
    const response = {
      ...tasksData,
      tasks,
      pagination: {
        total: totalCount,
        offset,
        limit: limit || totalCount,
        hasMore: offset + tasks.length < totalCount
      }
    };
    
    // Use gzip compression for large responses
    res.req = req;
    sendJsonResponse(res, response);
    return;
  }
  
  // POST /api/tasks - Create new task
  if (req.url === '/api/tasks' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body.title) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Title is required' }));
        return;
      }
      
      const task = createTask(
        body.title,
        body.description || '',
        body.assignee || null,
        body.category || 'general',
        body.priority || 'medium'
      );
      
      broadcastTasks();
      log('INFO', 'Task created via API:', { taskId: task.id, title: task.title });
      
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // PATCH /api/tasks/:id - Update task
  const patchMatch = req.url.match(/^\/api\/tasks\/([^/]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    try {
      const taskId = patchMatch[1];
      const body = await parseBody(req);
      
      const updatedTask = updateTask(taskId, body);
      if (!updatedTask) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      
      broadcastTasks();
      log('INFO', 'Task updated via API:', { taskId, updates: body });
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updatedTask));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // DELETE /api/tasks/:id - Delete task
  const deleteMatch = req.url.match(/^\/api\/tasks\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const taskId = deleteMatch[1];
    const deletedTask = deleteTask(taskId);
    
    if (!deletedTask) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Task not found' }));
      return;
    }
    
    broadcastTasks();
    log('INFO', 'Task deleted via API:', { taskId });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, deleted: deletedTask }));
    return;
  }
  
  // POST /api/tasks/:id/comments - Add comment
  const commentMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/comments$/);
  if (commentMatch && req.method === 'POST') {
    try {
      const taskId = commentMatch[1];
      const body = await parseBody(req);
      
      if (!body.text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Comment text is required' }));
        return;
      }
      
      const comment = addTaskComment(taskId, body.author || 'system', body.text);
      if (!comment) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      
      broadcastTasks();
      log('INFO', 'Comment added via API:', { taskId });
      
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(comment));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // MAINTENANCE API - Archive and cleanup
  // ═══════════════════════════════════════════════════════════════
  
  // POST /api/tasks/archive - Archive old completed tasks
  if (req.url === '/api/tasks/archive' && req.method === 'POST') {
    try {
      const tasksData = loadTasks();
      const beforeSize = JSON.stringify(tasksData).length;
      const archived = archiveOldTasks(tasksData);
      const pruned = pruneTaskData(tasksData);
      
      if (archived > 0 || pruned) {
        saveTasks(tasksData, 'archive-cleanup');
      }
      
      const afterSize = JSON.stringify(loadTasks()).length;
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        archived,
        pruned,
        beforeSize,
        afterSize,
        savedBytes: beforeSize - afterSize
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // GET /api/tasks/stats - Get task file statistics
  if (req.url === '/api/tasks/stats' && req.method === 'GET') {
    try {
      const tasksData = loadTasks();
      const stats = statSync(TASKS_FILE);
      
      const tasksByStatus = {};
      (tasksData.tasks || []).forEach(t => {
        tasksByStatus[t.status] = (tasksByStatus[t.status] || 0) + 1;
      });
      
      const totalLogs = (tasksData.tasks || []).reduce((sum, t) => sum + (t.logs?.length || 0), 0);
      const totalComments = (tasksData.tasks || []).reduce((sum, t) => sum + (t.comments?.length || 0), 0);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        fileSize: stats.size,
        fileSizeFormatted: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
        taskCount: tasksData.tasks?.length || 0,
        tasksByStatus,
        activityCount: tasksData.activity?.length || 0,
        totalLogs,
        totalComments
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // CHECKPOINTS API - State Recovery System
  // ═══════════════════════════════════════════════════════════════
  
  // GET /api/checkpoints - List active checkpoints for dashboard
  if (req.url === '/api/checkpoints' && req.method === 'GET') {
    try {
      const result = execSync('node ~/.openclaw/crew/crew-checkpoint.js dashboard', {
        encoding: 'utf8',
        timeout: 5000
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(result);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ checkpoints: [], stats: { created: 0, restored: 0, cleaned: 0 }, error: e.message }));
    }
    return;
  }
  
  // GET /api/checkpoints/status - Checkpoint system status
  if (req.url === '/api/checkpoints/status' && req.method === 'GET') {
    try {
      const result = execSync('node ~/.openclaw/crew/crew-checkpoint.js status', {
        encoding: 'utf8',
        timeout: 5000
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(result);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // MESSAGES API - Crew Communication
  // ═══════════════════════════════════════════════════════════════
  
  // GET /api/messages - List messages (with optional filters)
  const messagesUrlMatch = req.url.match(/^\/api\/messages(\?.*)?$/);
  if (messagesUrlMatch && req.method === 'GET') {
    const urlParams = new URL(req.url, 'http://localhost').searchParams;
    const agent = urlParams.get('agent');
    const from = urlParams.get('from');
    const status = urlParams.get('status');
    const unread = urlParams.get('unread') === 'true';
    
    const messagesData = loadMessages();
    let messages = messagesData.messages;
    
    if (agent) messages = messages.filter(m => m.to === agent.toLowerCase());
    if (from) messages = messages.filter(m => m.from === from.toLowerCase());
    if (status) messages = messages.filter(m => m.status === status);
    if (unread) messages = messages.filter(m => !m.read);
    
    // Sort by timestamp descending
    messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    const counts = getMessageCounts();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages, counts, lastUpdated: messagesData.lastUpdated }));
    return;
  }
  
  // POST /api/messages - Send a new message
  if (req.url === '/api/messages' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      
      if (!body.to || !body.subject) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'to and subject are required' }));
        return;
      }
      
      const message = createMessage(
        body.from || 'seven',
        body.to,
        body.subject,
        body.content || '',
        body.type || 'request',
        body.taskId || null
      );
      
      broadcastMessages();
      
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(message));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // PATCH /api/messages/:id - Update message (mark read, acknowledge, etc.)
  const msgPatchMatch = req.url.match(/^\/api\/messages\/([^/]+)$/);
  if (msgPatchMatch && req.method === 'PATCH') {
    try {
      const messageId = msgPatchMatch[1];
      const body = await parseBody(req);
      
      const updated = updateMessage(messageId, body);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message not found' }));
        return;
      }
      
      broadcastMessages();
      log('INFO', 'Message updated via API:', { messageId, updates: body });
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // DELETE /api/messages/:id - Delete message
  const msgDeleteMatch = req.url.match(/^\/api\/messages\/([^/]+)$/);
  if (msgDeleteMatch && req.method === 'DELETE') {
    const messageId = msgDeleteMatch[1];
    const deleted = deleteMessage(messageId);
    
    if (!deleted) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Message not found' }));
      return;
    }
    
    broadcastMessages();
    log('INFO', 'Message deleted via API:', { messageId });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, deleted }));
    return;
  }
  
  // GET /api/messages/counts - Get message counts for dashboard
  if (req.url === '/api/messages/counts' && req.method === 'GET') {
    const counts = getMessageCounts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(counts));
    return;
  }
  
  // GET /api/inbox/counts - Get crew-msg inbox counts for all agents
  if (req.url === '/api/inbox/counts' && req.method === 'GET') {
    try {
      const result = execSync(
        'node ~/.openclaw/scripts/crew_inbox_check.js counts 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(result);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents: {}, totalUnread: 0 }));
    }
    return;
  }
  
  // POST /api/messages/:id/reply - Add reply to a message
  const msgReplyMatch = req.url.match(/^\/api\/messages\/([^/]+)\/reply$/);
  if (msgReplyMatch && req.method === 'POST') {
    try {
      const messageId = msgReplyMatch[1];
      const body = await parseBody(req);
      
      if (!body.text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Reply text is required' }));
        return;
      }
      
      const messagesData = loadMessages();
      const msgIndex = messagesData.messages.findIndex(m => m.id === messageId);
      
      if (msgIndex === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message not found' }));
        return;
      }
      
      if (!messagesData.messages[msgIndex].replies) {
        messagesData.messages[msgIndex].replies = [];
      }
      
      const reply = {
        from: body.from || 'system',
        text: body.text,
        timestamp: new Date().toISOString()
      };
      
      messagesData.messages[msgIndex].replies.push(reply);
      messagesData.messages[msgIndex].status = body.complete ? 'completed' : 'acknowledged';
      messagesData.messages[msgIndex].updatedAt = new Date().toISOString();
      
      saveMessages(messagesData);
      broadcastMessages();
      
      log('INFO', 'Reply added to message:', { messageId });
      
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // POST /api/messages/:id/create-task - Create task from message
  const msgTaskMatch = req.url.match(/^\/api\/messages\/([^/]+)\/create-task$/);
  if (msgTaskMatch && req.method === 'POST') {
    try {
      const messageId = msgTaskMatch[1];
      
      const messagesData = loadMessages();
      const msg = messagesData.messages.find(m => m.id === messageId);
      
      if (!msg) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message not found' }));
        return;
      }
      
      // Create task from message
      const task = createTask(
        msg.subject,
        msg.content || `Created from message ${msg.id}`,
        msg.to,
        'general',
        msg.type === 'request' ? 'medium' : 'low'
      );
      
      // Link message to task
      updateMessage(messageId, { taskId: task.id });
      
      broadcastTasks();
      broadcastMessages();
      
      log('INFO', 'Task created from message:', { messageId, taskId: task.id });
      
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: msg, task }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // CRON JOBS API - System Tasks Status
  // ═══════════════════════════════════════════════════════════════
  
  // GET /api/cron - Get all cron jobs with status
  if (req.url === '/api/cron' && req.method === 'GET') {
    try {
      const result = execSync(
        '/home/roderik/.npm-global/bin/openclaw cron list --json 2>/dev/null || echo "[]"',
        { encoding: 'utf8', timeout: 5000 }
      );
      // Strip any non-JSON prefix lines (plugin registration, etc.)
      const jsonStart = result.indexOf('{');
      const jsonStr = jsonStart >= 0 ? result.substring(jsonStart) : '{}';
      let jobs = [];
      try { jobs = JSON.parse(jsonStr); } catch (e) {}
      
      // Format for dashboard display
      const formatMs = (ms) => {
        if (!ms || ms < 0) return '--';
        const secs = Math.floor(ms / 1000);
        if (secs < 60) return `${secs}s`;
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins}m`;
        const hours = Math.floor(mins / 60);
        return `${hours}h ${mins % 60}m`;
      };
      
      const now = Date.now();
      const formattedJobs = (jobs.jobs || jobs || []).map(job => {
        const nextRun = job.state?.nextRunAtMs ? job.state.nextRunAtMs - now : null;
        const lastRun = job.state?.lastRunAtMs ? now - job.state.lastRunAtMs : null;
        return {
          id: job.id,
          name: job.name || 'unnamed',
          enabled: job.enabled !== false,
          schedule: job.schedule,
          sessionTarget: job.sessionTarget,
          lastStatus: job.state?.lastStatus || 'unknown',
          lastDurationMs: job.state?.lastDurationMs,
          nextRunIn: formatMs(nextRun),
          lastRunAgo: formatMs(lastRun),
          runCount: job.state?.runCount || 0
        };
      });
      
      const enabled = formattedJobs.filter(j => j.enabled);
      const disabled = formattedJobs.filter(j => !j.enabled);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total: formattedJobs.length,
        enabled: enabled.length,
        disabled: disabled.length,
        jobs: formattedJobs,
        timestamp: new Date().toISOString()
      }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: 0, enabled: 0, disabled: 0, jobs: [], error: e.message }));
    }
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // STALL DETECTION API - Agent Health Monitoring
  // ═══════════════════════════════════════════════════════════════
  
  // GET /api/stall - Get stall detection status
  if (req.url === '/api/stall' && req.method === 'GET') {
    try {
      const result = execSync(
        'python3 ~/.openclaw/scripts/stall_detector.py api 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(result);
    } catch (e) {
      // Return empty state if script fails
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        timestamp: new Date().toISOString(),
        recoveries_today: 0,
        agents: {},
        error: 'Stall detector unavailable'
      }));
    }
    return;
  }
  
  // POST /api/stall/check - Trigger stall check
  if (req.url === '/api/stall/check' && req.method === 'POST') {
    try {
      const result = execSync(
        'python3 ~/.openclaw/scripts/stall_detector.py check 2>&1',
        { encoding: 'utf8', timeout: 10000 }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, output: result }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // POST /api/stall/reset - Reset stall counters
  if (req.url === '/api/stall/reset' && req.method === 'POST') {
    try {
      execSync('python3 ~/.openclaw/scripts/stall_detector.py reset 2>/dev/null', { timeout: 5000 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // WORK LOOP API - Autonomous Task Queue
  // ═══════════════════════════════════════════════════════════════
  
  // GET /api/work-loop - Get work loop status
  if (req.url === '/api/work-loop' && req.method === 'GET') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/work-loop.js json 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(result);
    } catch (e) {
      // Return default state if script fails
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'stopped',
        startedAt: null,
        uptime: 0,
        config: { maxWorkers: 3, pollIntervalMs: 30000 },
        stats: { tasksProcessed: 0, tasksCompleted: 0, tasksFailed: 0, cycleCount: 0 },
        activeWorkers: [],
        queue: { length: 0, tasks: [] },
        dependencies: 0,
        chains: 0
      }));
    }
    return;
  }
  
  // POST /api/work-loop/start - Start work loop
  if (req.url === '/api/work-loop/start' && req.method === 'POST') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/work-loop.js start 2>&1',
        { encoding: 'utf8', timeout: 10000 }
      );
      log('INFO', 'Work Loop started via API');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: result.trim() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // POST /api/work-loop/stop - Stop work loop
  if (req.url === '/api/work-loop/stop' && req.method === 'POST') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/work-loop.js stop 2>&1',
        { encoding: 'utf8', timeout: 10000 }
      );
      log('INFO', 'Work Loop stopped via API');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: result.trim() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // POST /api/work-loop/next - Process one cycle
  if (req.url === '/api/work-loop/next' && req.method === 'POST') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/work-loop.js next 2>&1',
        { encoding: 'utf8', timeout: 30000 }
      );
      log('INFO', 'Work Loop processed one cycle via API');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: result.trim() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // GET /api/work-loop/queue - Get queue summary
  if (req.url === '/api/work-loop/queue' && req.method === 'GET') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/crew-task.js queue 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(result);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // SPAWN-TASK API (Session ↔ Task Mapping)
  // ═══════════════════════════════════════════════════════════════
  
  // GET /api/spawn-task/state - Get session-to-task mappings
  if (req.url === '/api/spawn-task/state' && req.method === 'GET') {
    try {
      const stateFile = join(process.env.HOME, '.openclaw/crew/spawn-task-state.json');
      if (existsSync(stateFile)) {
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessionToTask: {}, taskToSession: {}, spawns: [] }));
      }
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionToTask: {}, taskToSession: {}, spawns: [], error: e.message }));
    }
    return;
  }
  
  // GET /api/spawn-task/lookup/:sessionId - Lookup task by session ID
  const spawnLookupMatch = req.url.match(/^\/api\/spawn-task\/lookup\/([^/]+)$/);
  if (spawnLookupMatch && req.method === 'GET') {
    try {
      const sessionId = spawnLookupMatch[1];
      const stateFile = join(process.env.HOME, '.openclaw/crew/spawn-task-state.json');
      if (existsSync(stateFile)) {
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        const taskId = state.sessionToTask[sessionId];
        if (taskId) {
          // Get full task details
          const tasksData = loadTasks();
          const task = tasksData.tasks.find(t => t.id === taskId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ found: true, taskId, task }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ found: false, sessionId }));
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: false, sessionId }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // POST /api/spawn-task - Create task and spawn agent
  if (req.url === '/api/spawn-task' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body.title) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Title is required' }));
        return;
      }
      
      // Build CLI command
      const args = ['node', '~/.openclaw/crew/spawn-task.js'];
      args.push('--title', `"${body.title.replace(/"/g, '\\"')}"`);
      if (body.agent) args.push('--agent', body.agent);
      else args.push('--auto-route');
      if (body.desc) args.push('--desc', `"${body.desc.replace(/"/g, '\\"')}"`);
      if (body.priority) args.push('--priority', body.priority);
      if (body.category) args.push('--category', body.category);
      args.push('--json');
      
      const result = execSync(args.join(' '), { encoding: 'utf8', timeout: 30000 });
      log('INFO', 'Spawn-task via API:', { title: body.title, agent: body.agent });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(result);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // POST /api/work-loop/priority/:id - Boost task priority
  const priorityMatch = req.url.match(/^\/api\/work-loop\/priority\/([^/]+)$/);
  if (priorityMatch && req.method === 'POST') {
    try {
      const taskId = priorityMatch[1];
      const result = execSync(
        `node ~/.openclaw/crew/work-loop.js priority "${taskId}" 2>&1`,
        { encoding: 'utf8', timeout: 5000 }
      );
      log('INFO', 'Task priority boosted via API:', { taskId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: result.trim() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // GIT LOCKS API (Conflict Detection)
  // ═══════════════════════════════════════════════════════════════
  
  // GET /api/git-locks - Get all lock status
  if (req.url === '/api/git-locks' && req.method === 'GET') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/git-locks.js status 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(result);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        totalLocks: 0,
        locks: {},
        activeConflicts: 0,
        stats: { locksCreated: 0, conflictsDetected: 0, conflictsResolved: 0, commitsCompleted: 0 }
      }));
    }
    return;
  }
  
  // GET /api/git-locks/conflicts - Get active conflicts
  if (req.url === '/api/git-locks/conflicts' && req.method === 'GET') {
    try {
      const stateFile = join(process.env.HOME, '.openclaw/crew/.locks/git-locks-state.json');
      if (existsSync(stateFile)) {
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        const active = (state.conflicts || []).filter(c => !c.resolved);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conflicts: active, count: active.length }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conflicts: [], count: 0 }));
      }
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conflicts: [], count: 0, error: e.message }));
    }
    return;
  }
  
  // GET /api/git-locks/files/:taskId - Get files for a task
  const taskFilesMatch = req.url.match(/^\/api\/git-locks\/files\/([^/]+)$/);
  if (taskFilesMatch && req.method === 'GET') {
    try {
      const taskId = taskFilesMatch[1];
      const result = execSync(
        `node ~/.openclaw/crew/git-locks.js files "${taskId}" 2>/dev/null`,
        { encoding: 'utf8', timeout: 5000 }
      );
      // Parse output into JSON
      const files = result.split('\n')
        .filter(line => line.trim().startsWith('-'))
        .map(line => line.replace(/^\s*-\s*/, '').trim());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId, files, count: files.length }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: taskFilesMatch[1], files: [], count: 0 }));
    }
    return;
  }
  
  // POST /api/git-locks/refresh - Refresh git state
  if (req.url === '/api/git-locks/refresh' && req.method === 'POST') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/git-locks.js refresh 2>&1',
        { encoding: 'utf8', timeout: 30000 }
      );
      log('INFO', 'Git locks refreshed via API');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: result.trim() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // @MENTION ROUTING API - Direct Agent Messaging
  // ═══════════════════════════════════════════════════════════════
  
  // Crew roster for @mention routing
  const MENTION_ROSTER = {
    seven: { sessionLabel: 'seven-direct', role: 'Orchestrator', model: 'opus' },
    geordi: { sessionLabel: 'geordi-direct', role: 'Chief Engineer', model: 'sonnet' },
    belanna: { sessionLabel: 'belanna-direct', role: 'Engineer', model: 'sonnet' },
    icheb: { sessionLabel: 'icheb-direct', role: 'Tech Specialist', model: 'Minimax' },
    spock: { sessionLabel: 'spock-direct', role: 'Science Officer', model: 'sonnet' },
    tuvok: { sessionLabel: 'tuvok-direct', role: 'Security Officer', model: 'sonnet' },
    doctor: { sessionLabel: 'doctor-direct', role: 'Medical Officer', model: 'sonnet' },
    uhura: { sessionLabel: 'uhura-direct', role: 'Comms Officer', model: 'Minimax' },
    harry: { sessionLabel: 'harry-direct', role: 'Ops Officer', model: 'Minimax' },
    quark: { sessionLabel: 'quark-direct', role: 'Trade Advisor', model: 'sonnet' },
    tom: { sessionLabel: 'tom-direct', role: 'Risk Trader', model: 'sonnet' },
    neelix: { sessionLabel: 'neelix-direct', role: 'Resources', model: 'Minimax' },
    data: { sessionLabel: 'data-direct', role: 'QC Officer', model: 'sonnet' }
  };
  
  // Parse @mentions from text
  function parseMentionsFromText(text) {
    const pattern = /@(\w+)/gi;
    const mentions = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1].toLowerCase();
      if (MENTION_ROSTER[name]) {
        mentions.push({
          agent: name,
          config: MENTION_ROSTER[name],
          position: match.index,
          raw: match[0]
        });
      }
    }
    return mentions;
  }
  
  // GET /api/mention/roster - Get all crew with session keys
  if (req.url === '/api/mention/roster' && req.method === 'GET') {
    const roster = Object.entries(MENTION_ROSTER).map(([name, config]) => ({
      name,
      sessionKey: `agent:main:subagent:${config.sessionLabel}`,
      ...config
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ roster, count: roster.length }));
    return;
  }
  
  // POST /api/mention/parse - Parse @mentions from text (preview)
  if (req.url === '/api/mention/parse' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const text = body.message || body.text || '';
      const mentions = parseMentionsFromText(text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        text, 
        mentions,
        validAgents: Object.keys(MENTION_ROSTER)
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // POST /api/mention/route - Route message to mentioned agent
  if (req.url === '/api/mention/route' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const message = body.message || body.text || '';
      const explicitAgent = body.agent?.toLowerCase();
      
      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message required' }));
        return;
      }
      
      let targetAgent = explicitAgent;
      let cleanMessage = message;
      
      // If no explicit agent, parse from message
      if (!targetAgent) {
        const mentions = parseMentionsFromText(message);
        if (mentions.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            error: 'No valid @mentions found',
            validAgents: Object.keys(MENTION_ROSTER)
          }));
          return;
        }
        targetAgent = mentions[0].agent;
        cleanMessage = message.replace(mentions[0].raw, '').trim().replace(/^[,:\-]+\s*/, '');
      }
      
      const config = MENTION_ROSTER[targetAgent];
      if (!config) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown agent: ${targetAgent}` }));
        return;
      }
      
      // Build task for the agent
      const agentTask = `
You are ${targetAgent.charAt(0).toUpperCase() + targetAgent.slice(1)}, ${config.role} on the starship.

**Direct Message from Captain:**
${cleanMessage}

**Instructions:**
1. Complete the requested task
2. When done, your response will be delivered to the Captain
3. Be concise but thorough
4. Sign your response with your role

🖖 Engage.
      `.trim();
      
      // @mention routing returns the routing info
      // Actual routing is handled by Seven's main session
      // This API provides the metadata needed for the routing logic
      
      const label = config.sessionLabel;
      const model = config.model;
      const sessionKey = `agent:main:subagent:${label}`;
      
      log('INFO', '@mention routing info prepared:', { agent: targetAgent, sessionKey });
      
      // Return routing information for Seven's main session to process
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        agent: targetAgent,
        sessionKey,
        sessionLabel: label,
        model,
        message: cleanMessage,
        routingType: 'direct_mention',
        instructions: `Route this message to agent session: ${sessionKey}`,
        // The actual session spawning is done by Seven's main session
        // when it detects the @mention pattern in incoming messages
        readyForRouting: true
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // GET /api/mention/sessions - Get all agent direct sessions
  if (req.url === '/api/mention/sessions' && req.method === 'GET') {
    try {
      const sessionsData = await getSessions();
      const directSessions = (sessionsData || []).filter(s => 
        s.key && s.key.includes('-direct')
      ).map(s => {
        const labelMatch = s.key.match(/subagent:(\w+)-direct/);
        const agent = labelMatch ? labelMatch[1] : 'unknown';
        return {
          agent,
          sessionKey: s.key,
          model: s.model,
          tokens: s.totalTokens,
          updatedAt: s.updatedAt,
          status: s.status || 'idle'
        };
      });
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        sessions: directSessions, 
        count: directSessions.length,
        roster: Object.keys(MENTION_ROSTER)
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // GET /api/meta-learning - Get meta-learning analysis summary
  if (req.url === '/api/meta-learning' && req.method === 'GET') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/meta-learning.js summary 2>/dev/null',
        { encoding: 'utf8', timeout: 10000 }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(result);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, lessons: [], statistics: {} }));
    }
    return;
  }
  
  // POST /api/meta-learning/analyze - Trigger fresh analysis
  if (req.url === '/api/meta-learning/analyze' && req.method === 'POST') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/meta-learning.js analyze 2>&1',
        { encoding: 'utf8', timeout: 30000 }
      );
      log('INFO', 'Meta-learning analysis triggered via API');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Analysis complete', output: result }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // GET /api/meta-learning/lessons - Get lessons only
  if (req.url === '/api/meta-learning/lessons' && req.method === 'GET') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/meta-learning.js lessons 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(result);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('No lessons available');
    }
    return;
  }
  
  // GET /api/meta-learning/improvements - Get improvement suggestions
  if (req.url === '/api/meta-learning/improvements' && req.method === 'GET') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/meta-learning.js improvements 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(result);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('No improvements available');
    }
    return;
  }
  
  // POST /api/meta-learning/mark-implemented/:id - Mark improvement as implemented
  const markImplMatch = req.url.match(/^\/api\/meta-learning\/mark-implemented\/([^/]+)$/);
  if (markImplMatch && req.method === 'POST') {
    try {
      const impId = markImplMatch[1];
      const result = execSync(
        `node ~/.openclaw/crew/meta-learning.js mark-implemented "${impId}" 2>&1`,
        { encoding: 'utf8', timeout: 5000 }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: result.trim() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }
  
  // GET /api/collaboration - Get collaboration metrics
  if (req.url === '/api/collaboration' && req.method === 'GET') {
    try {
      const result = execSync(
        'node ~/.openclaw/crew/collaboration-metrics.js json 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(result);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ totals: {}, topPairs: [], activeAgents: [], today: { messages: 0, requests: 0 } }));
    }
    return;
  }
  
  // GET /api/collaboration/inboxes - Get inbox summary for all agents
  if (req.url === '/api/collaboration/inboxes' && req.method === 'GET') {
    try {
      const inboxDir = join(process.env.HOME, '.openclaw/crew/inboxes');
      const inboxSummary = {};
      
      if (existsSync(inboxDir)) {
        const files = readdirSync(inboxDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const agent = file.replace('.json', '');
          try {
            const data = JSON.parse(readFileSync(join(inboxDir, file), 'utf8'));
            const messages = data.messages || [];
            inboxSummary[agent] = {
              total: messages.length,
              unread: messages.filter(m => m.status === 'unread').length,
              requests: messages.filter(m => m.type === 'request' && m.status === 'unread').length,
              lastMessage: messages.length > 0 ? messages[0].timestamp : null
            };
          } catch (e) {}
        }
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ inboxes: inboxSummary }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // GET /api/collaboration/suggest - Suggest specialists for a task
  if (req.url.startsWith('/api/collaboration/suggest') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const task = urlObj.searchParams.get('task') || '';
      
      const result = execSync(
        `CREW_AGENT=dashboard node ~/.openclaw/scripts/crew_msg.js suggest "${task.replace(/"/g, '\\"')}" 2>&1`,
        { encoding: 'utf8', timeout: 5000 }
      );
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ task, suggestions: result }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // Mission control route
  if (req.url === '/mission' || req.url === '/mission/') {
    try {
      const missionFile = join(__dirname, 'mission.html');
      if (existsSync(missionFile)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(missionFile));
        return;
      }
    } catch (e) {
      log('ERROR', 'Mission page error:', { error: e.message });
    }
  }
  
  let filePath = join(__dirname, req.url === '/' ? 'index.html' : req.url);
  
  try {
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = filePath.split('.').pop();
      const contentTypes = {
        'html': 'text/html; charset=utf-8',
        'css': 'text/css',
        'js': 'application/javascript',
        'json': 'application/json',
        'png': 'image/png',
        'svg': 'image/svg+xml',
        'ico': 'image/x-icon',
        'woff2': 'font/woff2',
        'ttf': 'font/ttf',
        'wav': 'audio/wav',
        'mp3': 'audio/mpeg'
      };
      res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
      res.end(readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  } catch (e) {
    log('ERROR', 'HTTP error:', { error: e.message });
    res.writeHead(500);
    res.end('Server Error');
  }
});

// Create WebSocket server
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', async (ws, req) => {
  clients.add(ws);
  const clientIP = req.socket.remoteAddress;
  log('INFO', `Client connected from ${clientIP}. Total: ${clients.size}`);
  
  // Send initial data (bridge + tasks + messages)
  try {
    const data = await gatherBridgeData();
    ws.send(JSON.stringify({ type: 'init', data }));
    
    // Also send task data
    const tasksData = loadTasks();
    ws.send(JSON.stringify({ type: 'tasks', data: tasksData }));
    
    // Also send messages data
    const messagesData = loadMessages();
    const msgCounts = getMessageCounts();
    ws.send(JSON.stringify({ type: 'messages', data: messagesData, counts: msgCounts }));
  } catch (e) {
    log('ERROR', 'Error sending init data:', { error: e.message });
  }
  
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      
      switch (msg.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
          
        case 'refresh':
          gatherBridgeData().then(data => {
            ws.send(JSON.stringify({ type: 'update', data }));
          });
          break;
          
        case 'get_tasks':
          const tasksData = loadTasks();
          ws.send(JSON.stringify({ type: 'tasks', data: tasksData }));
          break;
          
        case 'update_task':
          if (msg.taskId && msg.updates) {
            const updated = updateTask(msg.taskId, msg.updates);
            if (updated) {
              broadcastTasks();
              log('INFO', 'Task updated:', { taskId: msg.taskId, updates: msg.updates });
            }
          }
          break;
          
        case 'add_comment':
          if (msg.taskId && msg.text) {
            const comment = addTaskComment(msg.taskId, msg.author || 'system', msg.text);
            if (comment) {
              broadcastTasks();
              log('INFO', 'Comment added:', { taskId: msg.taskId });
            }
          }
          break;
          
        case 'create_task':
          if (msg.title) {
            const task = createTask(msg.title, msg.description, msg.assignee, msg.category, msg.priority);
            broadcastTasks();
            log('INFO', 'Task created:', { taskId: task.id, title: task.title });
          }
          break;
          
        case 'add_task_log':
          if (msg.taskId && msg.message) {
            const logEntry = addTaskLog(msg.taskId, msg.message, msg.logType || 'update', msg.agent || 'seven');
            if (logEntry) {
              broadcastTasks();
              // Also broadcast a specific log update event for real-time updates
              broadcast({
                type: 'task_log_update',
                taskId: msg.taskId,
                log: logEntry
              });
            }
          }
          break;
          
        // Crew messaging
        case 'get_messages':
          const messagesData = loadMessages();
          const msgCounts = getMessageCounts();
          ws.send(JSON.stringify({ type: 'messages', data: messagesData, counts: msgCounts }));
          break;
          
        case 'send_message':
          if (msg.to && msg.subject) {
            const newMsg = createMessage(msg.from || 'seven', msg.to, msg.subject, msg.content, msg.msgType, msg.taskId);
            broadcastMessages();
            log('INFO', 'Message sent via WS:', { id: newMsg.id, to: msg.to });
          }
          break;
          
        case 'update_message':
          if (msg.messageId && msg.updates) {
            const updated = updateMessage(msg.messageId, msg.updates);
            if (updated) {
              broadcastMessages();
              log('INFO', 'Message updated via WS:', { id: msg.messageId });
            }
          }
          break;
          
        default:
          log('DEBUG', 'Unknown message type:', { type: msg.type });
      }
    } catch (e) {
      log('ERROR', 'Message handling error:', { error: e.message });
    }
  });
  
  ws.on('close', () => {
    clients.delete(ws);
    log('INFO', `Client disconnected. Total: ${clients.size}`);
  });
  
  ws.on('error', (err) => {
    log('ERROR', 'WebSocket error:', { error: err.message });
    clients.delete(ws);
  });
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Keepalive ping
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

// Update loop
async function updateLoop() {
  try {
    const data = await gatherBridgeData();
    broadcast({ type: 'update', data });
  } catch (e) {
    log('ERROR', 'Update loop error:', { error: e.message });
  }
  setTimeout(updateLoop, UPDATE_INTERVAL);
}

// Watch Quark portfolio
if (existsSync(QUARK_PORTFOLIO)) {
  watchFile(QUARK_PORTFOLIO, { interval: 1000 }, async () => {
    log('INFO', 'Quark portfolio changed - invalidating cache and broadcasting update');
    // Invalidate quark cache so next gatherBridgeData gets fresh data
    cache.quarkData.data = null;
    cache.bridgeData.data = null;
    try {
      const data = await gatherBridgeData();
      broadcast({ type: 'trade_update', data });
    } catch (e) {
      log('ERROR', 'Trade update error:', { error: e.message });
    }
  });
}

// Track last known task state to detect completions
let lastTasksState = null;

// Watch tasks file for external changes (less aggressive polling)
if (existsSync(TASKS_FILE)) {
  watchFile(TASKS_FILE, { interval: 5000 }, async () => {
    try {
      const tasksData = loadTasks();

      // Detect task completions (moved to 'done' by 'data')
      if (lastTasksState && tasksData) {
        const lastTasks = lastTasksState.tasks || [];
        const currentTasks = tasksData.tasks || [];

        currentTasks.forEach(task => {
          const lastTask = lastTasks.find(t => t.id === task.id);
          if (lastTask && lastTask.status !== 'done' && task.status === 'done') {
            // Check if this was completed by 'data' (QC Officer)
            const recentActivity = tasksData.activity?.filter(a =>
              a.taskId === task.id &&
              a.action === 'moved' &&
              a.to === 'done' &&
              a.agent === 'data'
            );

            if (recentActivity?.length > 0) {
              // Emit task_completed event
              const payload = {
                taskId: task.id,
                title: task.title,
                assignee: task.assignee,
                category: task.category,
                timestamp: new Date().toISOString()
              };

              broadcast({ type: 'task_completed', data: payload });

              // Add QC approval activity entry
              tasksData.activity.push({
                id: generateId('act'),
                type: 'status',
                action: 'qc_approved',
                agent: 'data',
                taskId: task.id,
                taskTitle: task.title,
                timestamp: new Date().toISOString()
              });

              // Save updated activity
              saveTasks(tasksData);

              log('INFO', 'Task completed by Data:', payload);
            }
          }
        });
      }

      lastTasksState = JSON.parse(JSON.stringify(tasksData));
      log('INFO', 'Tasks file changed - broadcasting update');
      broadcastTasks();
    } catch (e) {
      log('ERROR', 'Tasks file watcher error:', { error: e.message });
    }
  });
}

// Watch messages file for external changes (CLI updates)
if (existsSync(MESSAGES_FILE)) {
  watchFile(MESSAGES_FILE, { interval: 5000 }, () => {
    log('INFO', 'Messages file changed - broadcasting update');
    broadcastMessages();
  });
}

// Start server
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║       LCARS BRIDGE DASHBOARD v7 - TASK & AGENT MANAGEMENT         ║
╠═══════════════════════════════════════════════════════════════════╣
║  Status:     ▓▓▓▓▓▓▓▓▓▓ ONLINE                                    ║
║  Port:       ${PORT}                                                  ║
║  HTTP:       http://localhost:${PORT}                                 ║
║  WebSocket:  ws://localhost:${PORT}                                   ║
║  Health:     http://localhost:${PORT}/health                          ║
║  Bridge:     http://localhost:${PORT}/                                ║
║  Mission:    http://localhost:${PORT}/mission                         ║
╠═══════════════════════════════════════════════════════════════════╣
║  API Endpoints:                                                   ║
║  • /api/data     - Bridge dashboard data                          ║
║  • /api/tasks    - Task management data                           ║
║  • /api/messages - Crew messaging system                          ║
╠═══════════════════════════════════════════════════════════════════╣
║  Data Sources:                                                    ║
║  • Quark: Portfolio & trade history                               ║
║  • Uhura: Email counts (vanderveer + settlemint)                  ║
║  • Spock: Research sessions                                       ║
║  • Geordi: Git status & worktrees                                 ║
║  • Seven: OpenClaw sessions & activity                            ║
║  • Tasks: Mission queue & activity feed                           ║
║  • System: CPU, Memory, Disk, Network, Docker                     ║
╚═══════════════════════════════════════════════════════════════════╝
  `);
  updateLoop();
});

// Graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  log('INFO', 'Shutting down LCARS Dashboard...');
  clearInterval(pingInterval);
  wss.close();
  httpServer.close(() => {
    log('INFO', 'Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}
