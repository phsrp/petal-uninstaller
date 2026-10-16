// Petal Uninstaller - main process. Scans installed programs, runs uninstallers, finds and removes leftovers.
const { app, BrowserWindow, ipcMain, shell, nativeImage, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

const SCRIPTS = app.isPackaged ? path.join(process.resourcesPath, 'scripts') : path.join(__dirname, 'scripts');
const SELFTEST = process.env.PETAL_SELFTEST === '1';
if (process.env.PETAL_USERDATA) app.setPath('userData', process.env.PETAL_USERDATA);
let win;
let isAdmin = false;

function ps(script, args = [], { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, script), ...args],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout, encoding: 'utf8' },
      (err, stdout, stderr) => (err && !stdout ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())));
  });
}
function psCommand(cmd, { timeout = 0 } = {}) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: (stdout || '').trim(), err: (stderr || '').trim() }));
  });
}
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

async function checkAdmin() {
  const r = await psCommand("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)");
  isAdmin = r.out === 'True';
  return isAdmin;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 820, minHeight: 520,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191724' : '#faf4ed',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#908caa', height: 44 },
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (SELFTEST && process.env.PETAL_SHOTS) {
    // Safety net for debugging: grab the window and console errors even if the in-page test never starts.
    win.webContents.on('console-message', (e) => testLog('console.txt', e.message || ''));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => testLog('main.txt', `fail-load ${code} ${desc} ${url}`));
    win.webContents.on('render-process-gone', (_e, d) => testLog('main.txt', 'renderer gone ' + JSON.stringify(d)));
    win.webContents.on('did-finish-load', () => testLog('main.txt', 'page loaded'));
    win.webContents.on('preload-error', (_e, p, err) => testLog('main.txt', 'preload error ' + err.message));
    setTimeout(async () => { try { const img = await win.webContents.capturePage(); fs.mkdirSync(process.env.PETAL_SHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.PETAL_SHOTS, '00-startup.png'), img.toPNG()); } catch {} }, 12000);
  }
}

function testLog(file, m) {
  if (!SELFTEST || !process.env.PETAL_SHOTS) return;
  try { fs.mkdirSync(process.env.PETAL_SHOTS, { recursive: true }); fs.appendFileSync(path.join(process.env.PETAL_SHOTS, file), m + os.EOL); } catch {}
}
const dbg = (m) => testLog('main.txt', m);
dbg('main loaded ' + SCRIPTS);
app.whenReady().then(async () => {
  dbg('ready');
  await checkAdmin();
  dbg('admin=' + isAdmin);
  createWindow();
  dbg('window');
});
app.on('window-all-closed', () => app.quit());

// ---------- program list ----------
const snapshotFile = () => path.join(app.getPath('userData'), 'snapshot.json');
function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return fallback; } }

ipcMain.handle('apps:list', async (_e, kind) => {
  const raw = await ps('scan.ps1', kind === 'store' ? ['-Store'] : []);
  let list = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(list)) list = [list];
  // "New since last run" highlight, like Geek Uninstaller
  const snap = readJson(snapshotFile(), {});
  const prev = snap[kind];
  for (const a of list) {
    a.isNew = !!prev && (!(a.id in prev) || prev[a.id] !== a.version);
    if (!a.installDate && a.installLocation) {
      try { a.installDate = fs.statSync(a.installLocation).birthtime.toISOString().slice(0, 10).replace(/-/g, ''); } catch {}
    }
  }
  if (kind === 'desktop') startIconBatch(list);
  snap[kind] = Object.fromEntries(list.map((a) => [a.id, a.version]));
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(snapshotFile(), JSON.stringify(snap)); } catch {}
  return list;
});

const iconCache = new Map();
function iconSource(a) {
  const clean = (p) => (p || '').split(',')[0].trim().replace(/^"|"$/g, '');
  const cands = [clean(a.displayIcon)];
  const m = /^"?([a-z]:\\[^"]*?\.exe)/i.exec(a.uninstallString || '');
  if (a.installLocation) {
    try {
      const exe = fs.readdirSync(a.installLocation).find((f) => /\.exe$/i.test(f) && !/unins|setup|update/i.test(f));
      if (exe) cands.push(path.join(a.installLocation, exe));
    } catch {}
  }
  if (m) cands.push(m[1]);
  return cands.find((p) => p && fs.existsSync(p) && !/msiexec/i.test(p));
}
// Desktop icons are extracted in one PowerShell batch (handles "file,index" and MSI product icons, like Geek does).
const msiCode = (a) => (a.msi ? /\{[0-9A-F-]{36}\}/i.exec(a.uninstallString || '')?.[0] || (/^\{[0-9A-F-]{36}\}$/i.test(a.keyName) ? a.keyName : '') : '');
let iconBatch = null;
function startIconBatch(list) {
  const todo = list.filter((a) => !iconCache.has(a.id));
  if (!todo.length) return;
  iconBatch = (async () => {
    const f = path.join(os.tmpdir(), `petal-icons-${process.pid}.json`);
    fs.writeFileSync(f, JSON.stringify(todo.map((a) => ({ id: a.id, displayIcon: a.displayIcon, installLocation: a.installLocation, uninstallString: a.uninstallString, msiCode: msiCode(a) }))));
    try {
      const out = JSON.parse((await ps('icons.ps1', ['-InFile', f])) || '{}');
      for (const [id, b64] of Object.entries(out)) iconCache.set(id, 'data:image/png;base64,' + b64);
    } catch {}
    try { fs.unlinkSync(f); } catch {}
  })();
}

ipcMain.handle('apps:icon', async (_e, a) => {
  const key = a.id;
  if (a.kind === 'desktop' && iconBatch) await iconBatch;
  if (iconCache.has(key)) return iconCache.get(key);
  let url = null;
  try {
    const src = iconSource(a);
    if (src) {
      let img;
      if (/\.(png|jpg|jpeg|bmp)$/i.test(src)) img = nativeImage.createFromPath(src).resize({ width: 64, height: 64, quality: 'best' });
      else if (/\.ico$/i.test(src)) img = nativeImage.createFromPath(src);
      if (!img || img.isEmpty()) img = await app.getFileIcon(src, { size: 'large' });
      if (img && !img.isEmpty()) url = img.toDataURL();
    }
  } catch {}
  iconCache.set(key, url);
  return url;
});

// ---------- uninstall ----------
function splitCommand(cmd) {
  cmd = (cmd || '').trim();
  if (cmd.startsWith('"')) {
    const end = cmd.indexOf('"', 1);
    return { exe: cmd.slice(1, end), args: cmd.slice(end + 1).trim() };
  }
  const m = /^(.*?\.exe)(\s.*)?$/i.exec(cmd);
  if (m) return { exe: m[1], args: (m[2] || '').trim() };
  const sp = cmd.indexOf(' ');
  return sp < 0 ? { exe: cmd, args: '' } : { exe: cmd.slice(0, sp), args: cmd.slice(sp + 1) };
}

function buildUninstall(a, quiet) {
  if (a.msi) {
    const guid = /\{[0-9A-F-]{36}\}/i.exec(a.uninstallString || '')?.[0] || (/^\{.*\}$/.test(a.keyName) ? a.keyName : null);
    if (guid) return { exe: 'msiexec.exe', args: `/x ${guid}` + (quiet ? ' /passive /norestart' : '') };
  }
  if (quiet && a.quietUninstall) return splitCommand(a.quietUninstall);
  return splitCommand(a.uninstallString);
}

ipcMain.handle('app:uninstall', async (_e, a, opts = {}) => {
  if (a.kind === 'store') {
    const r = await psCommand(`Remove-AppxPackage -Package ${psq(a.id)}`);
    return { ok: r.code === 0, code: r.code, error: r.err };
  }
  if (!a.uninstallString && !a.quietUninstall) return { ok: false, error: 'This program has no uninstaller. Use Force remove.' };
  const { exe, args } = buildUninstall(a, opts.quiet);
  if (exe !== 'msiexec.exe' && !fs.existsSync(exe) && !/^[\w.-]+$/.test(exe)) {
    return { ok: false, missing: true, error: 'The uninstaller file is missing. Use Force remove.' };
  }
  // Start-Process (ShellExecute) shows the UAC prompt when the uninstaller needs admin, and -Wait also waits for child
  // processes, which covers uninstallers that copy themselves to %TEMP% and relaunch.
  const argPart = args ? ` -ArgumentList ${psq(args)}` : '';
  const r = await psCommand(`$p = Start-Process -FilePath ${psq(exe)}${argPart} -Wait -PassThru; exit $p.ExitCode`);
  return { ok: r.code === 0 || r.code === 3010 || r.code === 1641, code: r.code, error: r.err };
});

ipcMain.handle('app:exists', async (_e, a) => {
  if (a.kind === 'store') {
    const r = await psCommand(`[bool](Get-AppxPackage | Where-Object PackageFullName -eq ${psq(a.id)})`);
    return r.out === 'True';
  }
  const p = a.id.replace(/^(HKLM|HKCU)\\/, '$1:\\');
  const r = await psCommand(`Test-Path -LiteralPath ${psq(p)}`);
  return r.out === 'True';
});

// ---------- leftovers ----------
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const GENERIC = new Set(['microsoft', 'windows', 'commonfiles', 'programs', 'program', 'packages', 'temp', 'tmp', 'google', 'intel', 'amd',
  'nvidia', 'nvidiacorporation', 'realtek', 'system', 'system32', 'users', 'public', 'default', 'app', 'apps', 'application', 'data',
  'software', 'classes', 'policies', 'wow6432node', 'clients', 'microsoftcorporation', 'mozilla', 'adobe', 'update', 'updater', 'setup',
  'installer', 'uninstall', 'launcher', 'game', 'games', 'tools', 'tool', 'driver', 'drivers', 'service', 'services', 'helper', 'client',
  'runtime', 'redist', 'redistributable', 'cache', 'crashpad', 'logs', 'local', 'roaming', 'locallow', 'documents', 'desktop', 'downloads',
  'python', 'java', 'node', 'nodejs', 'git', 'steam', 'electron', 'chrome', 'edge', 'appdata', 'programdata', 'startmenu', 'plugins']);

function cleanName(n) {
  return String(n || '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(x64|x86|64-bit|32-bit|amd64|arm64|win64|win32|version|edition|setup|en-us)\b/gi, ' ')
    .replace(/\bv?\d+(\.\d+)+\w*/g, ' ')
    .replace(/\s[-–]\s.*$/, ' ')
    .replace(/\s+/g, ' ').trim();
}
function cleanPublisher(p) {
  return String(p || '').replace(/[,.]?\s*\b(inc|ltd|llc|gmbh|co|corp|corporation|limited|s\.?a|ag|bv|pty|plc|software|technologies|technology)\b\.?/gi, ' ').trim();
}
// Words that are never safe to match on (shared Windows/vendor folders).
const NEVER = new Set(['microsoft', 'windows', 'commonfiles', 'programs', 'program', 'packages', 'temp', 'tmp', 'system', 'system32', 'users',
  'public', 'default', 'appdata', 'programdata', 'local', 'roaming', 'locallow', 'documents', 'desktop', 'downloads', 'startmenu',
  'software', 'classes', 'policies', 'wow6432node', 'clients', 'microsoftcorporation', 'application', 'data']);
function nameCandidates(a) {
  const out = new Set();
  const ok = (n) => n.length >= 4 && !NEVER.has(n) && !/^\d+$/.test(n);
  // The program's own name may be a common word (e.g. "Steam"); other guesses must not be.
  const own = (s) => { const n = norm(s); if (ok(n)) out.add(n); };
  const add = (s) => { const n = norm(s); if (ok(n) && !GENERIC.has(n)) out.add(n); };
  const cn = cleanName(a.name);
  own(cn); own(a.name);
  const pub = cleanPublisher(a.publisher);
  if (pub && cn.toLowerCase().startsWith(pub.toLowerCase() + ' ')) add(cn.slice(pub.length + 1));
  if (a.keyName && !/^\{.*\}$/.test(a.keyName) && !/^[0-9a-f-]{30,}$/i.test(a.keyName)) add(cleanName(a.keyName.replace(/_is1$/i, '')));
  if (a.installLocation) add(path.basename(a.installLocation.replace(/[\\/]+$/, '')));
  if (a.packageFamily) add(a.packageFamily);
  return out;
}
function publisherCandidates(a) {
  const out = new Set();
  for (const s of [a.publisher, cleanPublisher(a.publisher)]) { const n = norm(s); if (n.length >= 3 && !GENERIC.has(n)) out.add(n); }
  return out;
}

const env = process.env;
const ROOTS = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.APPDATA, env.LOCALAPPDATA,
  env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.USERPROFILE && path.join(env.USERPROFILE, 'AppData', 'LocalLow'),
  env.ProgramFiles && path.join(env.ProgramFiles, 'Common Files'), env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Common Files'),
  env.USERPROFILE && path.join(env.USERPROFILE, 'Documents')].filter(Boolean);
const PROTECTED = new Set([...ROOTS, env.SystemRoot, env.SystemDrive + '\\', env.USERPROFILE, env.PUBLIC, os.homedir(),
  env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Packages'), env.SystemRoot && path.join(env.SystemRoot, 'System32')]
  .filter(Boolean).map((p) => p.toLowerCase().replace(/[\\/]+$/, '')));
const isProtected = (p) => {
  const l = p.toLowerCase().replace(/[\\/]+$/, '');
  return PROTECTED.has(l) || l.split('\\').length < 3 || l.startsWith((env.SystemRoot || 'c:\\windows').toLowerCase());
};

function listDir(d) { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } }

async function folderSize(dir, budget = { n: 30000 }) {
  let total = 0;
  const stack = [dir];
  while (stack.length && budget.n > 0) {
    const d = stack.pop();
    let ents;
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (--budget.n <= 0) break;
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(p);
      else { try { total += (await fs.promises.stat(p)).size; } catch {} }
    }
  }
  return total;
}

ipcMain.handle('app:leftovers', async (_e, a, { includeEntry = true } = {}) => {
  const names = nameCandidates(a);
  const pubs = publisherCandidates(a);
  const found = new Map();
  const add = (type, p, confidence, why, value) => {
    const k = (type + p + (value || '')).toLowerCase();
    if (!found.has(k)) found.set(k, { type, path: p, value, confidence, why });
  };
  const installDir = a.installLocation && fs.existsSync(a.installLocation) && !isProtected(a.installLocation) ? a.installLocation.replace(/[\\/]+$/, '') : null;
  if (installDir) add('folder', installDir, 'high', 'Install folder');
  const uninst = /^"?([a-z]:\\[^"]*?\.exe)/i.exec(a.uninstallString || '')?.[1];
  if (uninst) {
    const ud = path.dirname(uninst);
    if (fs.existsSync(ud) && !isProtected(ud) && names.has(norm(path.basename(ud)))) add('folder', ud, 'high', 'Folder with the uninstaller');
  }
  const iconExe = (a.displayIcon || '').split(',')[0].trim().replace(/^"|"$/g, '');
  if (/^[a-z]:\\.+\.exe$/i.test(iconExe)) {
    const idir = path.dirname(iconExe);
    if (fs.existsSync(idir) && !isProtected(idir) && names.has(norm(path.basename(idir)))) add('folder', idir, 'high', 'Program folder');
  }
  if (a.kind === 'store' && a.packageFamily && env.LOCALAPPDATA) {
    const pd = path.join(env.LOCALAPPDATA, 'Packages', a.packageFamily);
    if (fs.existsSync(pd)) add('folder', pd, 'high', 'App data');
  }

  // Folders named after the app (or publisher\app) in the usual places
  for (const root of ROOTS) {
    for (const e of listDir(root)) {
      if (!e.isDirectory()) continue;
      const n = norm(e.name);
      const p = path.join(root, e.name);
      if (names.has(n)) { if (!isProtected(p)) add('folder', p, 'high', 'Folder named after the app'); continue; }
      if (pubs.has(n)) {
        const subs = listDir(p).filter((s) => s.isDirectory());
        const hits = subs.filter((s) => names.has(norm(s.name)));
        hits.forEach((s) => add('folder', path.join(p, s.name), 'high', 'Folder under the publisher'));
        if (hits.length && hits.length === subs.length && listDir(p).length === subs.length) add('folder', p, 'low', 'Publisher folder with nothing else in it');
      }
    }
  }

  // Shortcuts: Start menu and desktop
  const linkRoots = [env.ProgramData && path.join(env.ProgramData, 'Microsoft\\Windows\\Start Menu\\Programs'),
    env.APPDATA && path.join(env.APPDATA, 'Microsoft\\Windows\\Start Menu\\Programs'),
    env.PUBLIC && path.join(env.PUBLIC, 'Desktop'), path.join(os.homedir(), 'Desktop'),
    env.APPDATA && path.join(env.APPDATA, 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')].filter(Boolean);
  const pointsInto = (lnk) => {
    if (!installDir) return false;
    try { const t = shell.readShortcutLink(lnk).target || ''; return t.toLowerCase().startsWith(installDir.toLowerCase() + '\\'); } catch { return false; }
  };
  for (const root of linkRoots) {
    for (const e of listDir(root)) {
      const p = path.join(root, e.name);
      if (e.isDirectory()) {
        if (names.has(norm(e.name)) || pubs.has(norm(e.name)) && listDir(p).every((f) => /\.lnk$/i.test(f.name) && (names.has(norm(f.name.replace(/\.lnk$/i, ''))) || pointsInto(path.join(p, f.name))))) {
          add('folder', p, 'high', 'Start menu folder');
        } else {
          for (const f of listDir(p)) if (/\.lnk$/i.test(f.name) && (names.has(norm(f.name.replace(/\.lnk$/i, ''))) || pointsInto(path.join(p, f.name)))) add('file', path.join(p, f.name), 'high', 'Shortcut');
        }
      } else if (/\.lnk$/i.test(e.name) && (names.has(norm(e.name.replace(/\.lnk$/i, ''))) || pointsInto(p))) add('file', p, 'high', 'Shortcut');
    }
  }

  // Registry
  const exes = [];
  if (installDir) for (const e of listDir(installDir)) if (/\.exe$/i.test(e.name)) exes.push(e.name);
  try {
    const q = Buffer.from(JSON.stringify({ names: [...names], publishers: [...pubs], dirs: installDir ? [installDir] : [], exes })).toString('base64');
    const raw = await ps('regscan.ps1', [q]);
    let regs = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(regs)) regs = [regs];
    regs.forEach((r) => add(r.type, r.path, r.confidence, r.why, r.value));
  } catch {}
  if (includeEntry && a.kind === 'desktop') {
    const r = await psCommand(`Test-Path -LiteralPath ${psq(a.id.replace(/^(HKLM|HKCU)\\/, '$1:\\'))}`);
    if (r.out === 'True') add('key', a.id, 'high', 'Uninstall entry');
  }

  // Never offer a folder that contains another offered folder twice: keep the parent only
  let items = [...found.values()];
  const folders = items.filter((i) => i.type === 'folder').map((i) => i.path.toLowerCase());
  items = items.filter((i) => !(i.type !== 'key' && i.type !== 'value' && folders.some((f) => i.path.toLowerCase() !== f && i.path.toLowerCase().startsWith(f + '\\'))));
  const budget = { n: 60000 };
  for (const i of items) {
    if (i.type === 'folder') i.bytes = await folderSize(i.path, budget);
    else if (i.type === 'file') { try { i.bytes = fs.statSync(i.path).size; } catch { i.bytes = 0; } }
  }
  return items;
});

// ---------- cleanup (elevated when needed) ----------
async function runClean(job) {
  const dir = path.join(app.getPath('userData'), 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  job.backupDir = path.join(app.getPath('userData'), 'registry-backups', stamp);
  fs.mkdirSync(job.backupDir, { recursive: true });
  job.resultFile = path.join(dir, `result-${stamp}.json`);
  const jobFile = path.join(dir, `job-${stamp}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8');
  const script = path.join(SCRIPTS, 'clean.ps1');
  const needsAdmin = !isAdmin && job.items.some((i) => /^HKLM|^HKCR/i.test(i.path) || !isUserPath(i.path)) || (!isAdmin && job.killDirs.some((d) => !isUserPath(d)));
  if (needsAdmin) {
    const argList = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" -JobFile "${jobFile}"`;
    const r = await psCommand(`try { Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList ${psq(argList)} } catch { exit 5 }`);
    if (r.code === 5) return { cancelled: true, results: [] };
  } else {
    await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-JobFile', jobFile], { windowsHide: true }, res));
  }
  const out = readJson(job.resultFile, null);
  try { fs.unlinkSync(jobFile); fs.unlinkSync(job.resultFile); } catch {}
  if (!out) return { cancelled: true, results: [] };
  out.results = Array.isArray(out.results) ? out.results : out.results ? [out.results] : [];
  out.backupDir = job.backupDir;
  return out;
}
function isUserPath(p) {
  const l = String(p).toLowerCase();
  return l.startsWith('hkcu') || l.startsWith(os.homedir().toLowerCase() + '\\');
}

ipcMain.handle('app:clean', async (_e, items, opts = {}) => {
  items = items.filter((i) => i.type === 'key' || i.type === 'value' || !isProtected(i.path));
  const killDirs = [...new Set(items.filter((i) => i.type === 'folder').map((i) => i.path))];
  if (SELFTEST && !process.env.PETAL_ALLOW_DELETE) return { selftest: true, results: items.map((i) => ({ ...i, ok: true })) };
  return runClean({ items, killDirs, recycle: opts.recycle !== false });
});

// ---------- misc actions ----------
ipcMain.handle('admin:status', () => isAdmin);
ipcMain.handle('admin:relaunch', async () => {
  const args = app.isPackaged ? '' : `"${app.getAppPath()}"`;
  const cmd = `Start-Process -FilePath ${psq(process.execPath)}${args ? ` -ArgumentList ${psq(args)}` : ''} -Verb RunAs`;
  const r = await psCommand(cmd);
  if (r.code === 0) app.quit();
  return r.code === 0;
});
ipcMain.handle('shell:open', (_e, p) => (fs.existsSync(p) ? shell.openPath(p) : 'missing'));
ipcMain.handle('shell:show', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:url', (_e, u) => { if (/^https?:\/\//i.test(u)) shell.openExternal(u); });
ipcMain.handle('shell:regedit', async (_e, key) => {
  const full = key.replace(/^HKLM\\/i, 'Computer\\HKEY_LOCAL_MACHINE\\').replace(/^HKCU\\/i, 'Computer\\HKEY_CURRENT_USER\\');
  await psCommand(`Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit' -Name LastKey -Value ${psq(full)}; Start-Process regedit.exe -ArgumentList '/m'`);
});
ipcMain.handle('shell:backups', () => {
  const d = path.join(app.getPath('userData'), 'registry-backups');
  fs.mkdirSync(d, { recursive: true });
  return shell.openPath(d);
});

ipcMain.handle('export:html', async (_e, rows, title) => {
  const { filePath, canceled } = await dialog.showSaveDialog(win, { defaultPath: `Installed programs ${new Date().toISOString().slice(0, 10)}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] });
  if (canceled || !filePath) return false;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Montserrat,Segoe UI,sans-serif;background:#191724;color:#e0def4;margin:32px}h1{color:#ebbcba;font-weight:600}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #26233a}th{color:#908caa;font-weight:600}
tr:hover td{background:#1f1d2e}td.n{text-align:right;font-variant-numeric:tabular-nums}</style>
<h1>${esc(title)}</h1><p>${rows.length} programs · ${esc(os.hostname())} · ${new Date().toLocaleString()}</p>
<table><tr><th>Name</th><th>Publisher</th><th>Version</th><th>Size</th><th>Installed</th></tr>
${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.publisher)}</td><td>${esc(r.version)}</td><td class="n">${esc(r.size)}</td><td>${esc(r.date)}</td></tr>`).join('\n')}
</table>`;
  fs.writeFileSync(filePath, html, 'utf8');
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('theme:titlebar', (_e, { color, symbol }) => {
  try { win.setTitleBarOverlay({ color, symbolColor: symbol, height: 44 }); } catch {}
});

// Self-test hook: lets the test script capture screenshots without showing the window.
ipcMain.handle('selftest:info', () => ({ on: SELFTEST, target: process.env.PETAL_TARGET || '' }));
ipcMain.handle('selftest:shot', async (_e, name) => {
  const img = await win.webContents.capturePage();
  const dir = process.env.PETAL_SHOTS || path.join(__dirname, 'docs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
});
ipcMain.handle('selftest:quit', () => app.quit());
ipcMain.handle('selftest:log', (_e, m) => {
  console.log('[selftest]', m);
  testLog('log.txt', m);
});
