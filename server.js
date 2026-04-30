const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
  port: 3000,
  bungeecordPath: 'C:\\Users\\Ecole\\Desktop\\bungeecord',
  bungeecordJar: 'BungeeCord.jar',
  javaPath: 'C:\\java21\\jdk-25.0.3+9\\bin\\java.exe',
  javaArgs: ['-Xms256M', '-Xmx512M'],
  sessionSecret: 'eaglercraft_' + crypto.randomBytes(16).toString('hex'),
  maxLogLines: 500,
};

// ============================================================
// SETTINGS
// ============================================================
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return {
    displayAddress: 'ws://mon-serveur.example.com:8081',
    lobbyAddress: 'ridgehead.aternos.host:22527',
    serverName: 'Mon Serveur EaglerCraft',
    registrationOpen: true,
    ngrokUrl: '',
  };
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); }

function updateBungeeConfigLobby(lobbyAddress) {
  const configPath = path.join(CONFIG.bungeecordPath, 'config.yml');
  try {
    let content = fs.readFileSync(configPath, 'utf8');
    content = content.replace(/(lobby:\n\s+motd:[^\n]*\n\s+address:\s*)([^\n]+)/m, '$1' + lobbyAddress);
    fs.writeFileSync(configPath, content);
    return true;
  } catch (e) { console.error('Erreur config.yml:', e.message); return false; }
}

// ============================================================
// UTILISATEURS
// ============================================================
const USERS_FILE = path.join(__dirname, 'users.json');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}));

function hashPassword(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

const ADMIN_USER = {
  admin: {
    email: '2204071@educrm.ca',
    password: hashPassword('CrmAdm!n'),
    role: 'admin',
    username: 'Maxime',
  },
};

function loadUsers() {
  try { return { ...ADMIN_USER, ...JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) }; }
  catch { return { ...ADMIN_USER }; }
}
function saveUsers(users) {
  const s = { ...users }; delete s.admin;
  fs.writeFileSync(USERS_FILE, JSON.stringify(s, null, 2));
}

// ============================================================
// BUNGEECORD
// ============================================================
let bungeecordProcess = null;
let consoleLog = [];
let serverStatus = 'stopped';
let serverStartTime = null;
let clients = new Set();

function addLog(line, type) {
  if (!type) type = 'info';
  const entry = { time: new Date().toLocaleTimeString('fr-FR'), text: line, type };
  consoleLog.push(entry);
  if (consoleLog.length > CONFIG.maxLogLines) consoleLog.shift();
  broadcast({ type: 'log', data: entry });
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(function(ws) { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function updateStatus(status) {
  serverStatus = status;
  if (status === 'running') serverStartTime = Date.now();
  if (status === 'stopped') serverStartTime = null;
  broadcast({ type: 'status', data: { status: status, startTime: serverStartTime } });
}

function startBungeeCord() {
  if (bungeecordProcess) { addLog('Serveur deja en cours.', 'warn'); return; }
  addLog('Demarrage de BungeeCord...', 'info');
  updateStatus('starting');
  try {
    var args = CONFIG.javaArgs.concat(['-jar', CONFIG.bungeecordJar]);
    bungeecordProcess = spawn(CONFIG.javaPath, args, { cwd: CONFIG.bungeecordPath, stdio: ['pipe', 'pipe', 'pipe'] });
    bungeecordProcess.stdout.on('data', function(data) {
      data.toString().split('\n').filter(function(l) { return l.trim(); }).forEach(function(line) {
        addLog(line, 'info');
        if (line.includes('Listening on')) updateStatus('running');
      });
    });
    bungeecordProcess.stderr.on('data', function(data) {
      data.toString().split('\n').filter(function(l) { return l.trim(); }).forEach(function(line) { addLog(line, 'error'); });
    });
    bungeecordProcess.on('close', function(code) {
      addLog('BungeeCord arrete (code: ' + code + ')', 'warn');
      bungeecordProcess = null; updateStatus('stopped');
    });
    bungeecordProcess.on('error', function(err) {
      addLog('Erreur: ' + err.message, 'error');
      bungeecordProcess = null; updateStatus('stopped');
    });
  } catch (err) { addLog('Impossible de demarrer: ' + err.message, 'error'); updateStatus('stopped'); }
}

function stopBungeeCord() {
  if (!bungeecordProcess) { addLog('Serveur non demarre.', 'warn'); return; }
  addLog('Arret...', 'warn'); updateStatus('stopping');
  bungeecordProcess.stdin.write('end\n');
  setTimeout(function() {
    if (bungeecordProcess) { bungeecordProcess.kill(); bungeecordProcess = null; updateStatus('stopped'); }
  }, 10000);
}

function sendCommand(command) {
  if (!bungeecordProcess) { addLog('Serveur non demarre.', 'warn'); return; }
  addLog('> ' + command, 'command');
  bungeecordProcess.stdin.write(command + '\n');
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json());
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', 'https://maxguill8883.github.io');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(session({
  secret: CONFIG.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, sameSite: 'none', secure: false },
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Non authentifie' });
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: 'Acces refuse' });
}

// ============================================================
// ROUTES AUTH
// ============================================================
app.post('/api/login', function(req, res) {
  var users = loadUsers();
  var user = Object.values(users).find(function(u) { return u.email === req.body.email; });
  if (!user || user.password !== hashPassword(req.body.password))
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  req.session.user = { email: user.email, role: user.role, username: user.username };
  res.json({ success: true, user: req.session.user });
});

app.post('/api/register', function(req, res) {
  var settings = loadSettings();
  if (!settings.registrationOpen) return res.status(403).json({ error: 'Les inscriptions sont fermees.' });
  var email = req.body.email, password = req.body.password, username = req.body.username;
  if (!email || !password || !username) return res.status(400).json({ error: 'Tous les champs sont requis.' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caracteres min).' });
  var users = loadUsers();
  if (Object.values(users).find(function(u) { return u.email === email; }))
    return res.status(409).json({ error: 'Cet email est deja utilise.' });
  var id = 'user_' + Date.now();
  users[id] = { email: email, password: hashPassword(password), username: username, role: 'user' };
  saveUsers(users);
  req.session.user = { email: email, role: 'user', username: username };
  res.json({ success: true, user: req.session.user });
});

app.post('/api/logout', function(req, res) { req.session.destroy(); res.json({ success: true }); });

app.get('/api/me', function(req, res) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Non authentifie' });
  res.json({ user: req.session.user });
});

// ============================================================
// ROUTES SERVEUR
// ============================================================
app.post('/api/server/start', requireAuth, requireAdmin, function(req, res) { startBungeeCord(); res.json({ success: true }); });
app.post('/api/server/stop', requireAuth, requireAdmin, function(req, res) { stopBungeeCord(); res.json({ success: true }); });
app.post('/api/server/command', requireAuth, requireAdmin, function(req, res) {
  if (!req.body.command) return res.status(400).json({ error: 'Commande manquante' });
  sendCommand(req.body.command); res.json({ success: true });
});
app.get('/api/server/status', requireAuth, function(req, res) {
  res.json({ status: serverStatus, uptime: serverStartTime ? Math.floor((Date.now() - serverStartTime) / 1000) : 0, startTime: serverStartTime, logs: consoleLog.slice(-100) });
});
app.get('/api/server/info', requireAuth, function(req, res) {
  var s = loadSettings();
  res.json({ displayAddress: s.displayAddress, serverName: s.serverName });
});

// ============================================================
// ROUTES SETTINGS
// ============================================================
app.get('/api/settings', requireAuth, requireAdmin, function(req, res) { res.json(loadSettings()); });
app.put('/api/settings', requireAuth, requireAdmin, function(req, res) {
  var s = loadSettings();
  if (req.body.displayAddress !== undefined) s.displayAddress = req.body.displayAddress;
  if (req.body.serverName !== undefined) s.serverName = req.body.serverName;
  if (req.body.registrationOpen !== undefined) s.registrationOpen = req.body.registrationOpen;
  if (req.body.ngrokUrl !== undefined) s.ngrokUrl = req.body.ngrokUrl;
  if (req.body.lobbyAddress !== undefined) {
    s.lobbyAddress = req.body.lobbyAddress;
    if (!updateBungeeConfigLobby(req.body.lobbyAddress))
      return res.status(500).json({ error: 'Impossible de modifier config.yml' });
  }
  saveSettings(s);
  res.json({ success: true });
});

// ============================================================
// ROUTES USERS
// ============================================================
app.get('/api/users', requireAuth, requireAdmin, function(req, res) {
  var users = loadUsers();
  res.json({ users: Object.entries(users).map(function(e) { return { id: e[0], email: e[1].email, username: e[1].username, role: e[1].role }; }) });
});
app.post('/api/users', requireAuth, requireAdmin, function(req, res) {
  var email = req.body.email, password = req.body.password, username = req.body.username, role = req.body.role;
  if (!email || !password || !username) return res.status(400).json({ error: 'Champs manquants' });
  var users = loadUsers();
  if (Object.values(users).find(function(u) { return u.email === email; })) return res.status(409).json({ error: 'Email deja utilise' });
  var id = 'user_' + Date.now();
  users[id] = { email: email, password: hashPassword(password), username: username, role: role || 'user' };
  saveUsers(users); res.json({ success: true, id: id });
});
app.delete('/api/users/:id', requireAuth, requireAdmin, function(req, res) {
  var users = loadUsers();
  if (!users[req.params.id]) return res.status(404).json({ error: 'Introuvable' });
  delete users[req.params.id]; saveUsers(users); res.json({ success: true });
});
app.put('/api/users/:id/password', requireAuth, requireAdmin, function(req, res) {
  var users = loadUsers();
  if (!users[req.params.id]) return res.status(404).json({ error: 'Introuvable' });
  users[req.params.id].password = hashPassword(req.body.password);
  saveUsers(users); res.json({ success: true });
});

// ============================================================
// WEBSOCKET
// ============================================================
wss.on('connection', function(ws) {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', data: { status: serverStatus, startTime: serverStartTime, logs: consoleLog.slice(-100) } }));
  ws.on('close', function() { clients.delete(ws); });
});

// ============================================================
// DEMARRAGE
// ============================================================
server.listen(CONFIG.port, function() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   EaglerCraft Panel - Port ' + CONFIG.port + '        ║');
  console.log('║   http://localhost:' + CONFIG.port + '             ║');
  console.log('║   Admin : 2204071@educrm.ca          ║');
  console.log('║   MDP   : CrmAdm!n                   ║');
  console.log('╚══════════════════════════════════════╝\n');
});
