#!/usr/bin/env node
/**
 * LCARS Bridge Dashboard v7 - Task & Agent Management
 * Real-time WebSocket server for USS Enterprise bridge crew
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
import { readFileSync, writeFileSync, existsSync, watchFile, statSync } from 'fs';
import { execSync, exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.LCARS_PORT || 4242;
const UPDATE_INTERVAL = 5000;

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

// Get Git status for a directory
function getGitStatus(dir, name) {
  try {
    if (existsSync(dir) && existsSync(join(dir, '.git'))) {
      const status = execSync(`cd "${dir}" && git status --porcelain 2>/dev/null`, { encoding: 'utf-8' });
      const lines = status.trim().split('\n').filter(l => l);
      const branch = execSync(`cd "${dir}" && git branch --show-current 2>/dev/null`, { encoding: 'utf-8' }).trim();
      
      // Get commit count today
      const today = new Date().toISOString().split('T')[0];
      let commitsToday = 0;
      try {
        commitsToday = parseInt(execSync(
          `cd "${dir}" && git log --oneline --since="${today} 00:00" 2>/dev/null | wc -l`, 
          { encoding: 'utf-8' }
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
}

// Get worktrees
function getWorktrees() {
  const worktrees = [];
  try {
    const output = execSync(`cd "${WORKSPACE_DIR}" && git worktree list 2>/dev/null || echo ""`, { encoding: 'utf-8' });
    const lines = output.trim().split('\n').filter(l => l);
    lines.forEach(line => {
      const match = line.match(/^(.+?)\s+([a-f0-9]+)\s+\[(.+)\]/);
      if (match) {
        worktrees.push({ path: match[1], commit: match[2], branch: match[3] });
      }
    });
  } catch (e) {}
  return worktrees;
}

// Get sessions from OpenClaw API
async function getSessions() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch('http://127.0.0.1:4000/api/sessions', { 
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

// Load tasks from file
function loadTasks() {
  try {
    if (existsSync(TASKS_FILE)) {
      return JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
    }
  } catch (e) {
    log('ERROR', 'Error loading tasks:', { error: e.message });
  }
  return getDefaultTasks();
}

// Save tasks to file
function saveTasks(tasksData) {
  try {
    tasksData.lastUpdated = new Date().toISOString();
    writeFileSync(TASKS_FILE, JSON.stringify(tasksData, null, 2));
    log('INFO', 'Tasks saved successfully');
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
    columns: ["inbox", "assigned", "in_progress", "review", "done"],
    tasks: [],
    activity: [],
    agents: {
      seven: { name: "Seven of Nine", role: "Number One", department: "CMD", badges: ["LEAD"], color: "#cc99cc" },
      geordi: { name: "Geordi La Forge", role: "Chief Engineer", department: "ENG", badges: ["SPC"], color: "#9999ff" },
      uhura: { name: "Nyota Uhura", role: "Comms Officer", department: "COM", badges: [], color: "#cc6699" },
      spock: { name: "Spock", role: "Science Officer", department: "SCI", badges: ["SPC"], color: "#99cc99" },
      quark: { name: "Quark", role: "Trade Advisor", department: "TRD", badges: [], color: "#ffcc99" }
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

// Load messages from file
function loadMessages() {
  try {
    if (existsSync(MESSAGES_FILE)) {
      return JSON.parse(readFileSync(MESSAGES_FILE, 'utf-8'));
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
  const agents = ['seven', 'geordi', 'uhura', 'spock', 'quark'];
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
  const crew = {
    seven: { active: 0, tasks: [] },
    spock: { active: 0, tasks: [] },
    geordi: { active: 0, tasks: [] },
    uhura: { active: 0, tasks: [] },
    quark: { active: 0, tasks: [] }
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
      
      if (label.includes('spock') || label.includes('research')) {
        crew.spock.active++;
        crew.spock.tasks.push(taskInfo);
      } else if (label.includes('geordi') || label.includes('engineer') || label.includes('dashboard') || label.includes('build')) {
        crew.geordi.active++;
        crew.geordi.tasks.push(taskInfo);
      } else if (label.includes('uhura') || label.includes('email') || label.includes('comms') || label.includes('triage')) {
        crew.uhura.active++;
        crew.uhura.tasks.push(taskInfo);
      } else if (label.includes('quark') || label.includes('trad') || label.includes('crypto')) {
        crew.quark.active++;
        crew.quark.tasks.push(taskInfo);
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

// Get system stats
function getSystemStats() {
  try {
    const uptime = execSync('uptime -p 2>/dev/null || uptime', { encoding: 'utf-8' }).trim();
    const loadavg = execSync('cat /proc/loadavg 2>/dev/null', { encoding: 'utf-8' }).trim().split(' ');
    const memInfo = execSync("free -m | awk 'NR==2{printf \"%d %d\", $3, $2}'", { encoding: 'utf-8' }).trim().split(' ');
    const diskInfo = execSync("df -h / | awk 'NR==2{printf \"%s %s %s\", $3, $2, $5}'", { encoding: 'utf-8' }).trim().split(' ');
    const cpuCores = parseInt(execSync('nproc', { encoding: 'utf-8' }).trim()) || 1;
    
    // CPU usage
    let cpuUsage = 0;
    try {
      const stat1 = readFileSync('/proc/stat', 'utf-8').split('\n')[0].split(/\s+/);
      const idle1 = parseInt(stat1[4]);
      const total1 = stat1.slice(1).reduce((a, b) => a + parseInt(b), 0);
      cpuUsage = ((1 - idle1 / total1) * 100).toFixed(1);
    } catch (e) {
      cpuUsage = (parseFloat(loadavg[0]) / cpuCores * 100).toFixed(1);
    }
    
    const netStats = getNetworkStats();
    const dockerStats = getDockerStats();
    const cpuTemp = getCpuTemp();
    
    const memUsed = parseInt(memInfo[0]);
    const memTotal = parseInt(memInfo[1]);
    const memPercent = ((memUsed / memTotal) * 100).toFixed(1);
    
    return {
      uptime: uptime.replace('up ', ''),
      load: loadavg.slice(0, 3).map(l => parseFloat(l)),
      cpuUsage: parseFloat(cpuUsage),
      cpuCores,
      cpuTemp,
      memUsed,
      memTotal,
      memPercent: parseFloat(memPercent),
      diskUsed: diskInfo[0],
      diskTotal: diskInfo[1],
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
}

// Gather all bridge data
async function gatherBridgeData() {
  const sessions = await getSessions();
  const { crew: crewActivity, totalRunning, totalSessions } = analyzeCrewActivity(sessions);
  const quarkData = getQuarkData();
  const emailCounts = getEmailCounts();
  const workspaceGit = getGitStatus(WORKSPACE_DIR, 'workspace');
  const skillsGit = getGitStatus(SKILLS_DIR, 'skills');
  const worktrees = getWorktrees();
  const systemStats = getSystemStats();
  
  // Determine statuses
  const totalEmails = emailCounts.vanderveer.inbox + emailCounts.settlemint.inbox;
  
  return {
    timestamp: new Date().toISOString(),
    stardate: calculateStardate(),
    system: systemStats,
    sessions: sessions, // Raw sessions for introspection panel
    crew: {
      seven: {
        status: totalRunning > 0 ? 'ACTIVE' : 'STANDBY',
        role: 'Command',
        description: 'Main Agent',
        activeTasks: crewActivity.seven.active,
        tasks: crewActivity.seven.tasks,
        totalSessions: totalSessions,
        runningSessions: totalRunning,
        efficiency: Math.min(100, 95 + Math.random() * 5).toFixed(1)
      },
      spock: {
        status: crewActivity.spock.active > 0 ? 'RESEARCHING' : 'STANDBY',
        role: 'Science',
        description: 'Research & Analysis',
        activeTasks: crewActivity.spock.active,
        tasks: crewActivity.spock.tasks,
        efficiency: '99.7'
      },
      geordi: {
        status: crewActivity.geordi.active > 0 ? 'BUILDING' : 
                (workspaceGit.modified > 0 ? 'MONITORING' : 'STANDBY'),
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
        totalCommitsToday: workspaceGit.commitsToday + skillsGit.commitsToday
      },
      uhura: {
        status: crewActivity.uhura.active > 0 ? 'PROCESSING' : 
                (totalEmails > 0 ? 'MONITORING' : 'STANDBY'),
        role: 'Communications',
        description: 'Email & Messages',
        activeTasks: crewActivity.uhura.active,
        tasks: crewActivity.uhura.tasks,
        inbox: {
          vanderveer: emailCounts.vanderveer,
          settlemint: emailCounts.settlemint,
          total: totalEmails
        }
      },
      quark: {
        ...quarkData,
        role: 'Trading',
        description: 'Crypto Trading'
      }
    }
  };
}

// Broadcast to all connected clients
function broadcast(data) {
  const message = JSON.stringify(data);
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
  
  // API endpoint for current data
  if (req.url === '/api/data') {
    gatherBridgeData().then(data => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }).catch(err => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  
  // SESSIONS API - OpenClaw sessions
  if (req.url === '/api/sessions') {
    try {
      const output = execSync('/home/roderik/.npm-global/bin/openclaw sessions list --json 2>/dev/null || echo "{}"', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      let data = {};
      try { data = JSON.parse(output); } catch (e) {}
      
      const sessions = data.sessions || [];
      const active = sessions.filter(s => 
        s.key && (s.key.includes('subagent') || s.key.includes('cron') || s.key === 'agent:main:main')
      );
      const subagents = active.filter(s => s.key.includes('subagent'));
      const crons = active.filter(s => s.key.includes('cron'));
      
      // Format duration for display
      const formatAge = (ms) => {
        if (!ms) return '--';
        const secs = Math.floor(ms / 1000);
        if (secs < 60) return `${secs}s`;
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins}m`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h`;
        return `${Math.floor(hours / 24)}d`;
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total: data.count || sessions.length,
        activeSubagents: subagents.length,
        runningCrons: crons.length,
        subagents: subagents.map(s => {
          const uuid = s.key.split(':').pop();
          return {
            key: s.key,
            label: uuid.substring(0, 8), // Short UUID as label
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
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // TASKS API - Full CRUD
  // ═══════════════════════════════════════════════════════════════
  
  // GET /api/tasks - List all tasks
  if (req.url === '/api/tasks' && req.method === 'GET') {
    const tasksData = loadTasks();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tasksData));
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
    log('INFO', 'Quark portfolio changed - broadcasting update');
    try {
      const data = await gatherBridgeData();
      broadcast({ type: 'trade_update', data });
    } catch (e) {
      log('ERROR', 'Trade update error:', { error: e.message });
    }
  });
}

// Watch tasks file for external changes
if (existsSync(TASKS_FILE)) {
  watchFile(TASKS_FILE, { interval: 2000 }, () => {
    log('INFO', 'Tasks file changed - broadcasting update');
    broadcastTasks();
  });
}

// Watch messages file for external changes (CLI updates)
if (existsSync(MESSAGES_FILE)) {
  watchFile(MESSAGES_FILE, { interval: 2000 }, () => {
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
