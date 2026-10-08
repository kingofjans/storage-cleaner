/**
 * Storage Audit & Cleaner Utility
 * Runtime: Node.js (Built-in modules only: http, fs, path, crypto, child_process, url)
 * No npm dependencies required.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const url = require('url');

const PORT = process.env.PORT || 3456;
const GIANT_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2 MB (2,048 KB = 2,097,152 bytes)
const DEFAULT_TARGET_FOLDER = './Bahan Latihan P12';

// Utility: Format bytes into readable string
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Utility: Calculate SHA-256 hash
function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', err => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

// Rekursif mengumpulkan semua file di direktori
async function collectFilesRecursively(dirPath, baseDir) {
  let results = [];
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    // Abaikan sistem direktori sensitif
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', '.vscode', '.idea'].includes(entry.name)) {
        continue;
      }
      const subResults = await collectFilesRecursively(fullPath, baseDir);
      results = results.concat(subResults);
    } else if (entry.isFile()) {
      try {
        const stats = await fs.promises.stat(fullPath);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const hash = await calculateFileHash(fullPath);
        const ext = path.extname(entry.name).toLowerCase();

        results.push({
          name: entry.name,
          relativePath: relPath,
          absolutePath: path.resolve(fullPath),
          size: stats.size,
          sizeFormatted: formatBytes(stats.size),
          extension: ext,
          mtime: stats.mtime,
          birthtime: stats.birthtime,
          hash: hash,
          isGiant: stats.size >= GIANT_FILE_THRESHOLD_BYTES,
          isTemp: ext === '.tmp' || entry.name.toLowerCase().endsWith('.tmp')
        });
      } catch (e) {
        console.error(`Gagal membaca file: ${fullPath}`, e.message);
      }
    }
  }
  return results;
}

// Lakukan audit komprehensif pada target folder
async function runStorageAudit(targetFolderInput) {
  const resolvedTarget = path.resolve(process.cwd(), targetFolderInput || DEFAULT_TARGET_FOLDER);

  if (!fs.existsSync(resolvedTarget)) {
    throw new Error(`Folder target tidak ditemukan: "${resolvedTarget}"`);
  }

  const stat = await fs.promises.stat(resolvedTarget);
  if (!stat.isDirectory()) {
    throw new Error(`Path bukan sebuah direktori: "${resolvedTarget}"`);
  }

  const files = await collectFilesRecursively(resolvedTarget, resolvedTarget);

  // Analisis grup duplikat berdasarkan hash SHA-256
  const hashMap = {};
  for (const file of files) {
    if (!hashMap[file.hash]) {
      hashMap[file.hash] = [];
    }
    hashMap[file.hash].push(file);
  }

  const duplicateGroups = [];
  let totalDuplicateWasteBytes = 0;
  let totalDuplicateFilesCount = 0;

  for (const [hashVal, fileList] of Object.entries(hashMap)) {
    if (fileList.length > 1) {
      // Urutkan file untuk menentukan file asli (original) vs salinan
      // Kriteria file asli:
      // 1. Bukan yang mengandung kata 'backup', 'copy', 'salinan'
      // 2. Jika sama, pilih mtime tertua atau path terpendek
      const sorted = [...fileList].sort((a, b) => {
        const aBackup = /(backup|copy|salinan)/i.test(a.name);
        const bBackup = /(backup|copy|salinan)/i.test(b.name);
        if (aBackup !== bBackup) return aBackup ? 1 : -1;
        return (new Date(a.birthtime || a.mtime).getTime()) - (new Date(b.birthtime || b.mtime).getTime());
      });

      const originalFile = sorted[0];
      const duplicateCopies = sorted.slice(1).map(f => ({ ...f, isOriginal: false }));

      const wastePerGroup = (fileList.length - 1) * fileList[0].size;
      totalDuplicateWasteBytes += wastePerGroup;
      totalDuplicateFilesCount += duplicateCopies.length;

      duplicateGroups.push({
        hash: hashVal,
        fileCount: fileList.length,
        sizePerFile: fileList[0].size,
        sizePerFileFormatted: formatBytes(fileList[0].size),
        totalWastedBytes: wastePerGroup,
        totalWastedFormatted: formatBytes(wastePerGroup),
        originalFile: { ...originalFile, isOriginal: true },
        duplicates: duplicateCopies
      });
    }
  }

  // Identifikasi file raksasa (>= 2 MB)
  const giantFiles = files
    .filter(f => f.isGiant)
    .sort((a, b) => b.size - a.size);

  // Identifikasi file .tmp
  const tempFiles = files.filter(f => f.isTemp);
  const tempBytes = tempFiles.reduce((acc, f) => acc + f.size, 0);

  // Hitung total potensi hemat (duplicate copies + temp files yang bukan duplikat)
  const duplicateCopyPaths = new Set();
  duplicateGroups.forEach(g => {
    g.duplicates.forEach(d => duplicateCopyPaths.add(d.absolutePath));
  });

  let nonDuplicateTempBytes = 0;
  tempFiles.forEach(tf => {
    if (!duplicateCopyPaths.has(tf.absolutePath)) {
      nonDuplicateTempBytes += tf.size;
    }
  });

  const totalPotentialSavingsBytes = totalDuplicateWasteBytes + nonDuplicateTempBytes;
  const totalSizeBytes = files.reduce((acc, f) => acc + f.size, 0);

  return {
    targetFolder: targetFolderInput,
    resolvedTargetFolder: resolvedTarget,
    auditTimestamp: new Date().toISOString(),
    metrics: {
      totalFiles: files.length,
      totalCapacityBytes: totalSizeBytes,
      totalCapacityFormatted: formatBytes(totalSizeBytes),
      giantFilesCount: giantFiles.length,
      giantFilesTotalBytes: giantFiles.reduce((acc, f) => acc + f.size, 0),
      giantFilesTotalFormatted: formatBytes(giantFiles.reduce((acc, f) => acc + f.size, 0)),
      duplicateGroupsCount: duplicateGroups.length,
      duplicateCopiesCount: totalDuplicateFilesCount,
      tempFilesCount: tempFiles.length,
      potentialSavingsBytes: totalPotentialSavingsBytes,
      potentialSavingsFormatted: formatBytes(totalPotentialSavingsBytes)
    },
    giantFiles,
    duplicateGroups,
    tempFiles,
    allFiles: files
  };
}

// Eksekusi pembersihan in-place
async function executeCleanStorage(targetFolderInput, selectedFilesToDelete = null) {
  const auditResult = await runStorageAudit(targetFolderInput);
  const resolvedTarget = auditResult.resolvedTargetFolder;

  // Kumpulkan file yang diizinkan untuk dihapus:
  // 1. Semua duplicate copies (BUKAN originalFile)
  // 2. Semua file .tmp
  const filesToDeleteMap = new Map();

  auditResult.duplicateGroups.forEach(g => {
    g.duplicates.forEach(dup => {
      filesToDeleteMap.set(dup.absolutePath, {
        name: dup.name,
        path: dup.absolutePath,
        size: dup.size,
        reason: 'Salinan Duplikat (Hash SHA-256 Identik)'
      });
    });
  });

  auditResult.tempFiles.forEach(tmp => {
    if (!filesToDeleteMap.has(tmp.absolutePath)) {
      filesToDeleteMap.set(tmp.absolutePath, {
        name: tmp.name,
        path: tmp.absolutePath,
        size: tmp.size,
        reason: 'File Sampah Temporary (.tmp)'
      });
    }
  });

  // Jika client mengirim daftar khusus yang dipilih, filter dengannya
  const targets = [];
  for (const [absPath, info] of filesToDeleteMap.entries()) {
    // Validasi keamanan ketat: file HARUS berada di dalam resolvedTarget
    const rel = path.relative(resolvedTarget, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      console.warn(`[KEAMANAN] File di luar target folder ditolak: ${absPath}`);
      continue;
    }

    if (Array.isArray(selectedFilesToDelete) && selectedFilesToDelete.length > 0) {
      if (selectedFilesToDelete.includes(absPath)) {
        targets.push(info);
      }
    } else {
      targets.push(info);
    }
  }

  const deleted = [];
  const errors = [];
  let freedBytes = 0;

  for (const item of targets) {
    try {
      if (fs.existsSync(item.path)) {
        await fs.promises.unlink(item.path);
        freedBytes += item.size;
        deleted.push({
          name: item.name,
          path: item.path,
          size: item.size,
          sizeFormatted: formatBytes(item.size),
          reason: item.reason
        });
      }
    } catch (err) {
      errors.push({
        path: item.path,
        error: err.message
      });
    }
  }

  // Lakukan audit ulang setelah pembersihan selesai
  const postAudit = await runStorageAudit(targetFolderInput);

  return {
    success: true,
    deletedCount: deleted.length,
    freedBytes: freedBytes,
    freedFormatted: formatBytes(freedBytes),
    deletedFiles: deleted,
    errors: errors,
    postAuditMetrics: postAudit.metrics
  };
}

// Generate UI HTML Dashboard
function renderDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storage Audit & Cleaner Engine</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0b0f19;
      --bg-card: #131b2e;
      --bg-card-hover: #18223a;
      --bg-input: #0e1526;
      --border-color: #23304c;
      --border-focus: #3b82f6;
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
      --text-sub: #64748b;
      
      --accent-blue: #3b82f6;
      --accent-cyan: #06b6d4;
      --accent-emerald: #10b981;
      --accent-amber: #f59e0b;
      --accent-rose: #f43f5e;
      --accent-purple: #8b5cf6;

      --glow-blue: rgba(59, 130, 246, 0.25);
      --glow-rose: rgba(244, 63, 94, 0.25);
      --glow-emerald: rgba(16, 185, 129, 0.25);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: var(--bg-primary);
      color: var(--text-main);
      min-height: 100vh;
      line-height: 1.5;
      padding: 2rem 1.5rem 4rem;
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(59, 130, 246, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(139, 92, 246, 0.06) 0%, transparent 40%);
    }

    .container {
      max-width: 1240px;
      margin: 0 auto;
    }

    /* Header */
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 1.5rem;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border-color);
    }

    .brand-group {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .brand-icon {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 24px var(--glow-blue);
    }

    .brand-icon svg {
      width: 26px;
      height: 26px;
      color: #fff;
    }

    .brand-title h1 {
      font-size: 1.5rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      background: linear-gradient(to right, #ffffff, #94a3b8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-title p {
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    .system-status {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      background: rgba(19, 27, 46, 0.8);
      border: 1px solid var(--border-color);
      padding: 0.5rem 1rem;
      border-radius: 9999px;
      font-size: 0.8rem;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--accent-emerald);
      box-shadow: 0 0 10px var(--accent-emerald);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(0.9); }
    }

    /* Target Folder Bar */
    .target-bar-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 1.25rem 1.5rem;
      margin-bottom: 2rem;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
    }

    .target-form {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      align-items: center;
    }

    .input-wrapper {
      flex: 1;
      min-width: 280px;
      position: relative;
    }

    .input-icon {
      position: absolute;
      left: 1rem;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-sub);
    }

    .input-wrapper input {
      width: 100%;
      background: var(--bg-input);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 0.75rem 1rem 0.75rem 2.8rem;
      color: #fff;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.9rem;
      transition: all 0.2s;
    }

    .input-wrapper input:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px var(--glow-blue);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1.4rem;
      border-radius: 10px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--accent-blue), #2563eb);
      color: #fff;
      box-shadow: 0 4px 14px var(--glow-blue);
    }

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(59, 130, 246, 0.4);
    }

    .btn-danger {
      background: linear-gradient(135deg, var(--accent-rose), #e11d48);
      color: #fff;
      box-shadow: 0 4px 14px var(--glow-rose);
    }

    .btn-danger:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(244, 63, 94, 0.4);
    }

    .btn-secondary {
      background: #1e293b;
      color: var(--text-main);
      border: 1px solid var(--border-color);
    }

    .btn-secondary:hover:not(:disabled) {
      background: #27354f;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
    }

    .quick-chips {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.75rem;
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 0.2rem 0.6rem;
      font-family: 'JetBrains Mono', monospace;
      cursor: pointer;
      transition: background 0.15s;
    }

    .chip:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }

    /* Metric Cards Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1.25rem;
      margin-bottom: 2rem;
    }

    .metric-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 1.4rem;
      position: relative;
      overflow: hidden;
      transition: transform 0.2s, border-color 0.2s;
    }

    .metric-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .metric-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
    }

    .metric-title {
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .metric-icon-box {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .icon-files { background: rgba(59, 130, 246, 0.12); color: var(--accent-blue); }
    .icon-capacity { background: rgba(139, 92, 246, 0.12); color: var(--accent-purple); }
    .icon-giant { background: rgba(245, 158, 11, 0.12); color: var(--accent-amber); }
    .icon-savings { background: rgba(16, 185, 129, 0.12); color: var(--accent-emerald); }

    .metric-value {
      font-size: 1.85rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      margin-bottom: 0.35rem;
      color: #fff;
    }

    .metric-sub {
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .metric-highlight {
      color: var(--accent-emerald);
      font-weight: 700;
    }

    /* Actions Bar */
    .actions-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.7), rgba(15, 23, 42, 0.7));
      border: 1px solid var(--border-color);
      border-radius: 14px;
      padding: 1rem 1.5rem;
      margin-bottom: 2rem;
    }

    .actions-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .actions-info svg {
      color: var(--accent-amber);
    }

    /* Tab Section */
    .tabs-header {
      display: flex;
      gap: 0.5rem;
      border-bottom: 1px solid var(--border-color);
      margin-bottom: 1.5rem;
    }

    .tab-btn {
      padding: 0.75rem 1.25rem;
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 0.875rem;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }

    .tab-btn:hover {
      color: #fff;
    }

    .tab-btn.active {
      color: var(--accent-blue);
      border-bottom-color: var(--accent-blue);
    }

    .tab-badge {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      font-size: 0.7rem;
      padding: 0.1rem 0.5rem;
      border-radius: 999px;
    }

    /* Panels */
    .tab-panel {
      display: none;
    }

    .tab-panel.active {
      display: block;
    }

    /* Tables */
    .card-panel {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
      margin-bottom: 2rem;
    }

    .table-responsive {
      width: 100%;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.85rem;
    }

    th {
      background: #0f172a;
      padding: 0.9rem 1.25rem;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.72rem;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--border-color);
    }

    td {
      padding: 1rem 1.25rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      color: var(--text-main);
      vertical-align: middle;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover td {
      background-color: rgba(255, 255, 255, 0.02);
    }

    .file-name-cell {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-weight: 600;
    }

    .file-ext-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: #1e293b;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.65rem;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 700;
      color: var(--accent-cyan);
      text-transform: uppercase;
      border: 1px solid var(--border-color);
      flex-shrink: 0;
    }

    .mono-path {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: var(--text-sub);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 360px;
    }

    .hash-badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.72rem;
      background: rgba(0, 0, 0, 0.3);
      padding: 0.25rem 0.5rem;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--accent-cyan);
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }

    .copy-hash-btn {
      cursor: pointer;
      background: none;
      border: none;
      color: var(--text-sub);
      display: flex;
      align-items: center;
      padding: 2px;
    }
    .copy-hash-btn:hover {
      color: #fff;
    }

    .tag-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.25rem 0.65rem;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .tag-giant {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .tag-original {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .tag-duplicate {
      background: rgba(244, 63, 94, 0.15);
      color: #fb7185;
      border: 1px solid rgba(244, 63, 94, 0.3);
    }

    .tag-temp {
      background: rgba(139, 92, 246, 0.15);
      color: #c084fc;
      border: 1px solid rgba(139, 92, 246, 0.3);
    }

    /* Duplicate Accordion */
    .accordion-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .accordion-item {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 14px;
      overflow: hidden;
      transition: border-color 0.2s;
    }

    .accordion-item:hover {
      border-color: rgba(255, 255, 255, 0.15);
    }

    .accordion-header {
      padding: 1.25rem;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      user-select: none;
      background: rgba(255, 255, 255, 0.01);
    }

    .accordion-header:hover {
      background: rgba(255, 255, 255, 0.03);
    }

    .accordion-summary {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .accordion-title {
      font-weight: 700;
      font-size: 0.95rem;
    }

    .accordion-chevron {
      transition: transform 0.2s;
      color: var(--text-muted);
    }

    .accordion-item.open .accordion-chevron {
      transform: rotate(180deg);
    }

    .accordion-body {
      display: none;
      border-top: 1px solid var(--border-color);
      padding: 1.25rem;
      background: rgba(11, 15, 25, 0.5);
    }

    .accordion-item.open .accordion-body {
      display: block;
    }

    .empty-state {
      padding: 3rem 1.5rem;
      text-align: center;
      color: var(--text-muted);
    }

    .empty-state svg {
      width: 48px;
      height: 48px;
      color: var(--accent-emerald);
      margin-bottom: 1rem;
      opacity: 0.8;
    }

    /* Modal */
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(6px);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }

    .modal-backdrop.show {
      display: flex;
    }

    .modal-content {
      background: #111827;
      border: 1px solid #374151;
      border-radius: 18px;
      max-width: 650px;
      width: 100%;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      animation: modalFade 0.2s ease-out;
    }

    @keyframes modalFade {
      from { opacity: 0; transform: scale(0.96); }
      to { opacity: 1; transform: scale(1); }
    }

    .modal-header {
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid #374151;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-header h3 {
      font-size: 1.2rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 0.6rem;
      color: #fff;
    }

    .modal-body {
      padding: 1.5rem;
      overflow-y: auto;
      font-size: 0.875rem;
      color: var(--text-main);
    }

    .modal-footer {
      padding: 1.25rem 1.5rem;
      border-top: 1px solid #374151;
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      background: #0f172a;
      border-bottom-left-radius: 18px;
      border-bottom-right-radius: 18px;
    }

    .alert-box {
      background: rgba(244, 63, 94, 0.1);
      border: 1px solid rgba(244, 63, 94, 0.3);
      padding: 1rem;
      border-radius: 10px;
      margin-bottom: 1.25rem;
      display: flex;
      gap: 0.75rem;
      align-items: flex-start;
      color: #fda4af;
      font-size: 0.82rem;
    }

    .clean-preview-list {
      max-height: 220px;
      overflow-y: auto;
      background: #0b0f19;
      border: 1px solid #1f2937;
      border-radius: 8px;
      padding: 0.5rem;
      margin-top: 0.75rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
    }

    .clean-preview-item {
      padding: 0.4rem 0.6rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
    }

    .clean-preview-item:last-child {
      border-bottom: none;
    }

    /* Toast notification */
    #toastContainer {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      z-index: 2000;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .toast {
      background: #1e293b;
      border: 1px solid var(--border-color);
      color: #fff;
      padding: 0.9rem 1.2rem;
      border-radius: 10px;
      font-size: 0.85rem;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      gap: 0.75rem;
      min-width: 280px;
      animation: slideIn 0.25s ease-out;
    }

    .toast-success {
      border-left: 4px solid var(--accent-emerald);
    }

    .toast-error {
      border-left: 4px solid var(--accent-rose);
    }

    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    /* Loader */
    .spinner {
      animation: rotate 1s linear infinite;
    }

    @keyframes rotate {
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>

  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand-group">
        <div class="brand-icon">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7C5 4 4 5 4 7zM9 12h6M9 16h6M9 8h2" />
          </svg>
        </div>
        <div class="brand-title">
          <h1>Storage Audit & Cleaner Engine</h1>
          <p>Pemindaian Rekursif, Deteksi File Raksasa, Hash SHA-256 & Pembersihan In-Place</p>
        </div>
      </div>
      <div class="system-status">
        <span class="status-dot"></span>
        <span>Node.js Native Runtime (Zero Dependencies)</span>
      </div>
    </header>

    <!-- Target Folder Input Bar -->
    <div class="target-bar-card">
      <form id="scanForm" class="target-form" onsubmit="handleScanSubmit(event)">
        <div class="input-wrapper">
          <svg class="input-icon" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <input type="text" id="targetFolderInput" value="./Bahan Latihan P12" placeholder="Masukkan path folder (e.g. ./Bahan Latihan P12 atau C:\\Data)" required />
        </div>
        <button type="submit" id="scanBtn" class="btn btn-primary">
          <svg id="scanBtnIcon" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <span id="scanBtnText">Pindai Folder</span>
        </button>
      </form>
      <div class="quick-chips">
        <span>Target Cepat:</span>
        <button type="button" class="chip" onclick="setTargetFolder('./Bahan Latihan P12')">./Bahan Latihan P12</button>
        <button type="button" class="chip" onclick="setTargetFolder('.')">Folder Saat Ini (.)</button>
      </div>
    </div>

    <!-- 4 Metrik Cards -->
    <div class="metrics-grid">
      <!-- Total File -->
      <div class="metric-card">
        <div class="metric-top">
          <span class="metric-title">Total File</span>
          <div class="metric-icon-box icon-files">
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
        </div>
        <div class="metric-value" id="valTotalFiles">-</div>
        <div class="metric-sub" id="subTotalFiles">Berkas ditemukan di semua subfolder</div>
      </div>

      <!-- Total Kapasitas -->
      <div class="metric-card">
        <div class="metric-top">
          <span class="metric-title">Total Kapasitas</span>
          <div class="metric-icon-box icon-capacity">
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7M4 7c0-2 1-3 3-3h10c2 0 3 1 3 3M4 7h16m-5 4h.01M15 15h.01" />
            </svg>
          </div>
        </div>
        <div class="metric-value" id="valTotalCapacity">-</div>
        <div class="metric-sub" id="subTotalCapacity">Ukuran total ruang terpakai</div>
      </div>

      <!-- File Raksasa (> 2 MB) -->
      <div class="metric-card">
        <div class="metric-top">
          <span class="metric-title">File Raksasa (&gt; 2 MB)</span>
          <div class="metric-icon-box icon-giant">
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
        </div>
        <div class="metric-value" id="valGiantFiles">-</div>
        <div class="metric-sub" id="subGiantFiles">Melebihi threshold 2.048 KB</div>
      </div>

      <!-- Potensi Hemat -->
      <div class="metric-card">
        <div class="metric-top">
          <span class="metric-title">Potensi Hemat</span>
          <div class="metric-icon-box icon-savings">
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </div>
        </div>
        <div class="metric-value metric-highlight" id="valPotentialSavings">-</div>
        <div class="metric-sub" id="subPotentialSavings">Dari salinan duplikat & file .tmp</div>
      </div>
    </div>

    <!-- Actions Bar -->
    <div class="actions-bar">
      <div class="actions-info">
        <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span id="actionsDescription">Pembersihan in-place: menghapus salinan kembar & file sementara .tmp, mempertahankan 1 file asli per grup.</span>
      </div>
      <button id="cleanActionBtn" class="btn btn-danger" onclick="openCleanConfirmationModal()" disabled>
        <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
        <span>Bersihkan Duplikat & Sampah</span>
      </button>
    </div>

    <!-- Navigation Tabs -->
    <div class="tabs-header">
      <button class="tab-btn active" onclick="switchTab('tab-duplicates', this)">
        <span>Duplikat Identik</span>
        <span class="tab-badge" id="badgeDuplicates">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('tab-giants', this)">
        <span>File Raksasa (&gt; 2 MB)</span>
        <span class="tab-badge" id="badgeGiants">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('tab-temps', this)">
        <span>File Sampah (.tmp)</span>
        <span class="tab-badge" id="badgeTemps">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('tab-all', this)">
        <span>Semua Berkas</span>
        <span class="tab-badge" id="badgeAll">0</span>
      </button>
    </div>

    <!-- Panel 1: Grup Duplikat -->
    <div id="tab-duplicates" class="tab-panel active">
      <div id="duplicateAccordionContainer" class="accordion-list">
        <!-- Rendered via JS -->
      </div>
    </div>

    <!-- Panel 2: File Raksasa -->
    <div id="tab-giants" class="tab-panel">
      <div class="card-panel">
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Nama Berkas</th>
                <th>Path Relatif / Folder</th>
                <th>Ukuran</th>
                <th>Hash SHA-256</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="giantFilesTableBody">
              <!-- Rendered via JS -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Panel 3: File Sampah .tmp -->
    <div id="tab-temps" class="tab-panel">
      <div class="card-panel">
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Nama Berkas</th>
                <th>Lokasi Path</th>
                <th>Ukuran</th>
                <th>Tipe</th>
                <th>Tindakan Pembersihan</th>
              </tr>
            </thead>
            <tbody id="tempFilesTableBody">
              <!-- Rendered via JS -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Panel 4: Semua File -->
    <div id="tab-all" class="tab-panel">
      <div class="card-panel">
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Nama Berkas</th>
                <th>Lokasi Path</th>
                <th>Ukuran</th>
                <th>Hash SHA-256</th>
                <th>Kategori</th>
              </tr>
            </thead>
            <tbody id="allFilesTableBody">
              <!-- Rendered via JS -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </div>

  <!-- Modal Konfirmasi Pembersihan -->
  <div id="cleanModal" class="modal-backdrop">
    <div class="modal-content">
      <div class="modal-header">
        <h3>
          <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="color: var(--accent-rose)">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          Konfirmasi Pembersihan In-Place
        </h3>
        <button onclick="closeCleanModal()" style="background:none; border:none; color:var(--text-muted); cursor:pointer;">
          <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="alert-box">
          <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="flex-shrink:0;">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <strong>Peringatan Eksekusi:</strong> Tindakan ini akan menghapus file secara langsung (in-place) pada folder target. File yang dihapus tidak dapat dipulihkan.
          </div>
        </div>

        <p style="margin-bottom: 0.75rem;">
          Ringkasan item yang akan dibersihkan dari direktori:
        </p>

        <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); padding: 1rem; border-radius: 10px; margin-bottom: 1rem;">
          <div style="display:flex; justify-content:space-between; margin-bottom: 0.5rem;">
            <span style="color:var(--text-muted);">Salinan Duplikat:</span>
            <strong id="modalDupCount">0 file</strong>
          </div>
          <div style="display:flex; justify-content:space-between; margin-bottom: 0.5rem;">
            <span style="color:var(--text-muted);">File Sampah Sementara (.tmp):</span>
            <strong id="modalTempCount">0 file</strong>
          </div>
          <div style="display:flex; justify-content:space-between; border-top: 1px solid var(--border-color); padding-top: 0.5rem;">
            <span style="color:var(--text-main); font-weight:600;">Potensi Ruang Yang Dibebaskan:</span>
            <strong id="modalTotalFreed" style="color:var(--accent-emerald);">0 B</strong>
          </div>
        </div>

        <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom: 0.4rem;">
          Daftar berkas yang akan dihapus:
        </p>
        <div id="modalPreviewList" class="clean-preview-list">
          <!-- Item list via JS -->
        </div>

        <div style="margin-top: 1rem; font-size: 0.8rem; color: var(--accent-emerald); display: flex; align-items: center; gap: 0.5rem;">
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <span>1 file asli per grup duplikat dipastikan AMAN dan TETAP DIPERTAHANKAN.</span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeCleanModal()">Batal</button>
        <button id="confirmExecuteCleanBtn" class="btn btn-danger" onclick="executeCleanNow()">
          <span id="cleanBtnText">Ya, Bersihkan Sekarang</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Toast Notification Container -->
  <div id="toastContainer"></div>

  <script>
    let currentAuditData = null;

    // Toast utility
    function showToast(message, type = 'success') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.innerHTML = \`
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          \${type === 'success' 
            ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />' 
            : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />'}
        </svg>
        <span>\${message}</span>
      \`;
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.transition = 'opacity 0.3s, transform 0.3s';
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('Hash berhasil disalin ke clipboard: ' + text.substring(0, 10) + '...', 'success');
      }).catch(() => {
        showToast('Gagal menyalin hash', 'error');
      });
    }

    function setTargetFolder(path) {
      document.getElementById('targetFolderInput').value = path;
      performScan(path);
    }

    function switchTab(tabId, btnElement) {
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      
      const panel = document.getElementById(tabId);
      if (panel) panel.classList.add('active');
      if (btnElement) btnElement.classList.add('active');
    }

    function toggleAccordion(index) {
      const item = document.getElementById('accItem-' + index);
      if (item) {
        item.classList.toggle('open');
      }
    }

    async function performScan(targetFolder) {
      const scanBtn = document.getElementById('scanBtn');
      const scanBtnText = document.getElementById('scanBtnText');
      const scanBtnIcon = document.getElementById('scanBtnIcon');
      
      scanBtn.disabled = true;
      scanBtnText.innerText = 'Memindai...';
      scanBtnIcon.classList.add('spinner');

      try {
        const response = await fetch('/api/scan?folder=' + encodeURIComponent(targetFolder));
        const data = await response.json();

        if (!response.ok || data.error) {
          throw new Error(data.error || 'Gagal memindai direktori');
        }

        currentAuditData = data;
        updateUI(data);
        showToast('Pemindaian selesai: ' + data.metrics.totalFiles + ' berkas dianalisis.', 'success');
      } catch (err) {
        console.error(err);
        showToast('Kesalahan: ' + err.message, 'error');
      } finally {
        scanBtn.disabled = false;
        scanBtnText.innerText = 'Pindai Folder';
        scanBtnIcon.classList.remove('spinner');
      }
    }

    function handleScanSubmit(event) {
      event.preventDefault();
      const folder = document.getElementById('targetFolderInput').value.trim();
      if (folder) {
        performScan(folder);
      }
    }

    function updateUI(data) {
      const m = data.metrics;

      // Update 4 Metrik Cards
      document.getElementById('valTotalFiles').innerText = m.totalFiles;
      document.getElementById('subTotalFiles').innerText = \`Total dari folder target "\${data.targetFolder}"\`;

      document.getElementById('valTotalCapacity').innerText = m.totalCapacityFormatted;
      document.getElementById('subTotalCapacity').innerText = \`\${m.totalCapacityBytes.toLocaleString()} bytes\`;

      document.getElementById('valGiantFiles').innerText = m.giantFilesCount;
      document.getElementById('subGiantFiles').innerText = \`Total ukuran: \${m.giantFilesTotalFormatted}\`;

      document.getElementById('valPotentialSavings').innerText = m.potentialSavingsFormatted;
      document.getElementById('subPotentialSavings').innerText = \`\${m.duplicateCopiesCount} duplikat + \${m.tempFilesCount} file .tmp\`;

      // Update Badges
      document.getElementById('badgeDuplicates').innerText = m.duplicateGroupsCount;
      document.getElementById('badgeGiants').innerText = m.giantFilesCount;
      document.getElementById('badgeTemps').innerText = m.tempFilesCount;
      document.getElementById('badgeAll').innerText = m.totalFiles;

      // Action button state
      const cleanBtn = document.getElementById('cleanActionBtn');
      if (m.duplicateCopiesCount > 0 || m.tempFilesCount > 0) {
        cleanBtn.disabled = false;
      } else {
        cleanBtn.disabled = true;
      }

      // Render Panels
      renderDuplicateAccordion(data.duplicateGroups);
      renderGiantFiles(data.giantFiles);
      renderTempFiles(data.tempFiles);
      renderAllFiles(data.allFiles);
    }

    function renderDuplicateAccordion(groups) {
      const container = document.getElementById('duplicateAccordionContainer');
      if (!groups || groups.length === 0) {
        container.innerHTML = \`
          <div class="card-panel empty-state">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3>Tidak Ada Duplikat Ditemukan</h3>
            <p>Semua berkas pada target folder memiliki hash SHA-256 yang unik.</p>
          </div>
        \`;
        return;
      }

      let html = '';
      groups.forEach((g, idx) => {
        html += \`
          <div class="accordion-item \${idx === 0 ? 'open' : ''}" id="accItem-\${idx}">
            <div class="accordion-header" onclick="toggleAccordion(\${idx})">
              <div class="accordion-summary">
                <span class="file-ext-icon">\${g.originalFile.extension.replace('.', '') || 'FILE'}</span>
                <div>
                  <div class="accordion-title">\${g.originalFile.name}</div>
                  <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">
                    \${g.fileCount} file kembar &bull; Ukuran per file: \${g.sizePerFileFormatted} &bull; Potensi Hemat: <strong style="color:var(--accent-emerald);">\${g.totalWastedFormatted}</strong>
                  </div>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:0.75rem;">
                <span class="hash-badge" title="SHA-256">
                  \${g.hash.substring(0, 10)}...
                  <button type="button" class="copy-hash-btn" onclick="event.stopPropagation(); copyToClipboard('\${g.hash}')" title="Salin hash">
                    <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </button>
                </span>
                <svg class="accordion-chevron" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
            <div class="accordion-body">
              <div class="table-responsive">
                <table>
                  <thead>
                    <tr>
                      <th>Status Berkas</th>
                      <th>Nama File</th>
                      <th>Lokasi Relatif</th>
                      <th>Ukuran</th>
                      <th>Waktu Modifikasi</th>
                    </tr>
                  </thead>
                  <tbody>
                    <!-- Original -->
                    <tr>
                      <td><span class="tag-badge tag-original">ASLI (DIPERTAHANKAN)</span></td>
                      <td style="font-weight:600;">\${g.originalFile.name}</td>
                      <td class="mono-path">\${g.originalFile.relativePath}</td>
                      <td>\${g.originalFile.sizeFormatted}</td>
                      <td style="color:var(--text-sub); font-size:0.75rem;">\${new Date(g.originalFile.mtime).toLocaleString()}</td>
                    </tr>
                    <!-- Duplicates -->
                    \${g.duplicates.map(d => \`
                      <tr>
                        <td><span class="tag-badge tag-duplicate">SALINAN DUPLIKAT</span></td>
                        <td>\${d.name}</td>
                        <td class="mono-path">\${d.relativePath}</td>
                        <td>\${d.sizeFormatted}</td>
                        <td style="color:var(--text-sub); font-size:0.75rem;">\${new Date(d.mtime).toLocaleString()}</td>
                      </tr>
                    \`).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        \`;
      });

      container.innerHTML = html;
    }

    function renderGiantFiles(giants) {
      const tbody = document.getElementById('giantFilesTableBody');
      if (!giants || giants.length === 0) {
        tbody.innerHTML = \`
          <tr>
            <td colspan="5" class="empty-state">
              <p>Tidak ada berkas yang melebihi ambang batas 2 MB (2.048 KB).</p>
            </td>
          </tr>
        \`;
        return;
      }

      tbody.innerHTML = giants.map(f => \`
        <tr>
          <td>
            <div class="file-name-cell">
              <span class="file-ext-icon">\${f.extension.replace('.', '') || 'FILE'}</span>
              <span>\${f.name}</span>
            </div>
          </td>
          <td class="mono-path" title="\${f.absolutePath}">\${f.relativePath}</td>
          <td style="font-weight:700; color:var(--accent-amber);">\${f.sizeFormatted}</td>
          <td>
            <span class="hash-badge">
              \${f.hash.substring(0, 12)}...
              <button type="button" class="copy-hash-btn" onclick="copyToClipboard('\${f.hash}')">
                <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </span>
          </td>
          <td><span class="tag-badge tag-giant">FILE RAKSASA (&gt; 2 MB)</span></td>
        </tr>
      \`).join('');
    }

    function renderTempFiles(temps) {
      const tbody = document.getElementById('tempFilesTableBody');
      if (!temps || temps.length === 0) {
        tbody.innerHTML = \`
          <tr>
            <td colspan="5" class="empty-state">
              <p>Tidak ada file sampah sementara (.tmp) ditemukan.</p>
            </td>
          </tr>
        \`;
        return;
      }

      tbody.innerHTML = temps.map(f => \`
        <tr>
          <td>
            <div class="file-name-cell">
              <span class="file-ext-icon">TMP</span>
              <span>\${f.name}</span>
            </div>
          </td>
          <td class="mono-path" title="\${f.absolutePath}">\${f.relativePath}</td>
          <td>\${f.sizeFormatted}</td>
          <td><span class="tag-badge tag-temp">CACHE / TEMPORARY</span></td>
          <td style="color:var(--accent-rose); font-weight:600; font-size:0.75rem;">Siap dibersihkan in-place</td>
        </tr>
      \`).join('');
    }

    function renderAllFiles(all) {
      const tbody = document.getElementById('allFilesTableBody');
      if (!all || all.length === 0) {
        tbody.innerHTML = \`<tr><td colspan="5" class="empty-state">Belum ada file yang dipindai.</td></tr>\`;
        return;
      }

      tbody.innerHTML = all.map(f => {
        let tag = '<span class="tag-badge" style="background:rgba(255,255,255,0.06);">STANDAR</span>';
        if (f.isGiant) tag = '<span class="tag-badge tag-giant">RAKSASA</span>';
        else if (f.isTemp) tag = '<span class="tag-badge tag-temp">TEMP</span>';

        return \`
          <tr>
            <td>
              <div class="file-name-cell">
                <span class="file-ext-icon">\${f.extension.replace('.', '') || 'FILE'}</span>
                <span>\${f.name}</span>
              </div>
            </td>
            <td class="mono-path" title="\${f.absolutePath}">\${f.relativePath}</td>
            <td>\${f.sizeFormatted}</td>
            <td>
              <span class="hash-badge">
                \${f.hash.substring(0, 10)}...
                <button type="button" class="copy-hash-btn" onclick="copyToClipboard('\${f.hash}')">
                  <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </span>
            </td>
            <td>\${tag}</td>
          </tr>
        \`;
      }).join('');
    }

    // Modal Handlers
    function openCleanConfirmationModal() {
      if (!currentAuditData) return;

      const m = currentAuditData.metrics;
      document.getElementById('modalDupCount').innerText = m.duplicateCopiesCount + ' file';
      document.getElementById('modalTempCount').innerText = m.tempFilesCount + ' file';
      document.getElementById('modalTotalFreed').innerText = m.potentialSavingsFormatted;

      const previewList = document.getElementById('modalPreviewList');
      let items = [];

      // Masukkan duplicate copies
      currentAuditData.duplicateGroups.forEach(g => {
        g.duplicates.forEach(d => {
          items.push({
            name: d.name,
            path: d.relativePath,
            size: d.sizeFormatted,
            tag: 'DUPLIKAT'
          });
        });
      });

      // Masukkan temp files
      currentAuditData.tempFiles.forEach(t => {
        // cegah dobel tampil jika ada file tmp yang juga duplikat
        if (!items.some(i => i.path === t.relativePath)) {
          items.push({
            name: t.name,
            path: t.relativePath,
            size: t.sizeFormatted,
            tag: 'TEMP'
          });
        }
      });

      previewList.innerHTML = items.map(item => \`
        <div class="clean-preview-item">
          <div>
            <strong style="color:#fff;">\${item.name}</strong>
            <div style="color:var(--text-sub); font-size:0.7rem;">\${item.path}</div>
          </div>
          <div style="text-align:right;">
            <span style="color:var(--accent-rose); font-weight:600;">\${item.size}</span>
            <span class="tag-badge \${item.tag === 'TEMP' ? 'tag-temp' : 'tag-duplicate'}" style="font-size:0.6rem; padding:1px 5px; margin-left:4px;">\${item.tag}</span>
          </div>
        </div>
      \`).join('');

      document.getElementById('cleanModal').classList.add('show');
    }

    function closeCleanModal() {
      document.getElementById('cleanModal').classList.remove('show');
    }

    async function executeCleanNow() {
      if (!currentAuditData) return;

      const confirmBtn = document.getElementById('confirmExecuteCleanBtn');
      const cleanBtnText = document.getElementById('cleanBtnText');
      confirmBtn.disabled = true;
      cleanBtnText.innerText = 'Membersihkan...';

      try {
        const response = await fetch('/api/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder: currentAuditData.targetFolder
          })
        });

        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error || 'Gagal mengeksekusi pembersihan');
        }

        closeCleanModal();
        showToast(\`Pembersihan selesai! \${result.deletedCount} berkas dihapus, membebaskan \${result.freedFormatted}.\`, 'success');

        // Refresh UI dengan scan ulang
        performScan(currentAuditData.targetFolder);

      } catch (err) {
        console.error(err);
        showToast('Kesalahan pembersihan: ' + err.message, 'error');
      } finally {
        confirmBtn.disabled = false;
        cleanBtnText.innerText = 'Ya, Bersihkan Sekarang';
      }
    }

    // Inisialisasi otomatis pemindaian saat pertama kali dibuka
    window.addEventListener('DOMContentLoaded', () => {
      const defaultFolder = document.getElementById('targetFolderInput').value;
      performScan(defaultFolder);
    });
  </script>
</body>
</html>
`;
}

// HTTP Server Handler
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const method = req.method.toUpperCase();

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // 1. Root / UI Dashboard
    if (pathname === '/' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHTML());
      return;
    }

    // 2. API Scan: GET /api/scan?folder=...
    if (pathname === '/api/scan' && method === 'GET') {
      const folderParam = reqUrl.searchParams.get('folder') || DEFAULT_TARGET_FOLDER;
      const auditResult = await runStorageAudit(folderParam);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(auditResult));
      return;
    }

    // 3. API Clean: POST /api/clean
    if (pathname === '/api/clean' && method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = body ? JSON.parse(body) : {};
          const folderParam = payload.folder || DEFAULT_TARGET_FOLDER;
          const cleanResult = await executeCleanStorage(folderParam, payload.selectedFiles || null);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(cleanResult));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 4. 404 Not Found
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Endpoint tidak ditemukan' }));

  } catch (err) {
    console.error(`[Server Error] ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// Auto-open browser
function openBrowser(url) {
  const startCmd = process.platform === 'win32' ? 'start' :
                   process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${startCmd} ${url}`, (err) => {
    if (err) {
      console.log(`Buka URL manual di browser: ${url}`);
    }
  });
}

// Jalankan Server
server.listen(PORT, () => {
  const serverUrl = `http://localhost:${PORT}`;
  console.log('====================================================');
  console.log('  STORAGE AUDIT & CLEANER UTILITY (NODE.JS)');
  console.log('  Runtime  : Node.js Native (Tanpa npm dependencies)');
  console.log(`  Server   : ${serverUrl}`);
  console.log(`  Default  : ${DEFAULT_TARGET_FOLDER}`);
  console.log('====================================================');
  console.log(`Membuka otomatis dashboard di browser: ${serverUrl} ...`);
  openBrowser(serverUrl);
});
