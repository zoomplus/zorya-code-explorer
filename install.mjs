#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const RELEASE = 'v0.1.1';
const PACKAGE_ROOT_NAME = 'zorya-code-explorer-0.1.1';
const ASSET = 'zorya-code-explorer-v0.1.1.tgz';
const EXPECTED_SHA256 = '40d8b112cf91c7fd0ec44510c09ff5de7da62f0dd1bf9cdef40c5d4fdbcadc6b';
const ASSET_URL = `https://github.com/zoomplus/zorya-code-explorer/releases/download/${RELEASE}/${ASSET}`;
const CHECKSUMS_URL = `https://raw.githubusercontent.com/zoomplus/zorya-code-explorer/${RELEASE}/SHA256SUMS`;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 64 * 1024;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const NPM_TIMEOUT_MS = 10 * 60_000;
const LOCK_WAIT_MS = 10 * 60_000;
const LOCK_RETRY_MS = 400;
const LOCK_MARKER = 'zorya-code-explorer-public-bootstrap-v2';
const ALLOWED_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const REQUIRED_RELATIVE_FILES = [
  'dist/cli.js',
  'package.json',
  'package-lock.json',
  'scripts/install.mjs',
  'PROPRIETARY-NOTICE.txt',
];

function usage() {
  return [
    'Usage: node install.mjs [--project <project-directory>] [--config <external-operator-config.json>]',
    'Without --project, the current directory is used.',
  ].join('\n');
}

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag !== '--project' && flag !== '--config') throw new Error(`Unknown option: ${flag}\n${usage()}`);
    if (values.has(flag)) throw new Error(`Option may be supplied only once: ${flag}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    values.set(flag, value);
    i += 1;
  }
  return { project: values.get('--project') ?? process.cwd(), config: values.get('--config') };
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathKey(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function assertSupportedNode() {
  const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10));
  if (major < 20 || (major === 20 && minor < 19)) {
    throw new Error(`Node.js 20.19 or newer is required; found ${process.versions.node}.`);
  }
}

async function ensureDirectory(candidate, label, { ownerBoundary, mode = 0o700 } = {}) {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!metadata) {
      try { await mkdir(current, { mode }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} path contains a non-directory or symbolic link: ${current}`);
    const canonical = await realpath(current);
    if (!samePath(canonical, current)) throw new Error(`${label} path resolves through an alias: ${current}`);
    const mustOwn = ownerBoundary && within(ownerBoundary, canonical);
    if (mustOwn && typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error(`${label} path is not owned by the current user: ${current}`);
    }
    if (process.platform !== 'win32' && mustOwn && (metadata.mode & 0o022) !== 0) {
      throw new Error(`${label} path is writable by other users: ${current}`);
    }
  }
  return await realpath(absolute);
}

async function resolveProject(projectInput) {
  const requested = path.resolve(projectInput);
  const metadata = await lstat(requested).catch((error) => {
    throw new Error(`Project directory does not exist or cannot be inspected: ${requested}`, { cause: error });
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`Project path must be an existing directory and may not be a symlink: ${requested}`);
  const project = await realpath(requested);
  const fsRoot = path.parse(project).root;
  const home = await realpath(homedir());
  if (samePath(project, fsRoot)) throw new Error('Refusing to install into a filesystem root.');
  if (samePath(project, home)) throw new Error('Refusing to install into the user home directory. Choose a project subdirectory.');
  return { project, home };
}

async function resolveConfig(configInput, project) {
  if (!configInput) return undefined;
  const requested = path.resolve(configInput);
  const metadata = await lstat(requested).catch((error) => {
    throw new Error(`Operator config does not exist or cannot be inspected: ${requested}`, { cause: error });
  });
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`Operator config must be a regular non-symlink file: ${requested}`);
  const config = await realpath(requested);
  if (within(project, config)) throw new Error('Operator config must be outside the indexed project.');
  try {
    const parsed = JSON.parse(await readFile(config, 'utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Expected a JSON object.');
  } catch (error) {
    throw new Error(`Operator config must be valid JSON: ${config}`, { cause: error });
  }
  return config;
}

function dataHomeCandidate() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local && path.isAbsolute(local)) return { path: local, ownerBoundary: local };
    const home = homedir();
    return { path: path.join(home, 'AppData', 'Local'), ownerBoundary: home };
  }
  if (process.platform === 'darwin') {
    const home = homedir();
    return { path: path.join(home, 'Library', 'Application Support'), ownerBoundary: home };
  }
  const configured = process.env.XDG_DATA_HOME;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('XDG_DATA_HOME must be absolute when set.');
    return { path: configured, ownerBoundary: configured };
  }
  const home = homedir();
  return { path: path.join(home, '.local', 'share'), ownerBoundary: home };
}

function parseChecksumFile(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { throw new Error('SHA256SUMS is not valid UTF-8.', { cause: error }); }
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '');
  const matching = lines.filter((line) => line.trimEnd().endsWith(ASSET));
  if (matching.length !== 1) throw new Error(`The v0.1.1 SHA256SUMS must contain exactly one entry for ${ASSET}.`);
  const match = matching[0].match(/^([0-9a-fA-F]{64})\s+\*?zorya-code-explorer-v0\.1\.1\.tgz$/u);
  if (!match) throw new Error(`The SHA256SUMS entry for ${ASSET} is malformed.`);
  const digest = match[1].toLowerCase();
  if (digest !== EXPECTED_SHA256) throw new Error('The v0.1.1 SHA256SUMS digest does not match the pinned release digest in this installer.');
  return digest;
}

function requestBuffer(input, maxBytes, redirectsLeft = 5) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !ALLOWED_HOSTS.has(url.hostname)) {
    return Promise.reject(new Error(`Refusing an untrusted release URL: ${url.origin}`));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      fn(value);
    };
    const totalTimer = setTimeout(() => request.destroy(new Error('GitHub download timed out.')), DOWNLOAD_TIMEOUT_MS);
    const request = https.get(url, {
      headers: { 'User-Agent': 'zorya-code-explorer-installer/2', Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location || redirectsLeft <= 0) return finish(reject, new Error('GitHub download exceeded its redirect limit.'));
        let redirected;
        try { redirected = new URL(location, url).href; }
        catch (error) { return finish(reject, new Error('GitHub returned an invalid redirect.', { cause: error })); }
        finish(resolve, requestBuffer(redirected, maxBytes, redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        return finish(reject, new Error(`GitHub returned HTTP ${status} for ${url.pathname}.`));
      }
      const contentLength = Number(response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.destroy();
        return finish(reject, new Error(`GitHub response exceeds the ${maxBytes} byte download limit.`));
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new Error(`GitHub response exceeds the ${maxBytes} byte download limit.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, Buffer.concat(chunks, size)));
      response.on('error', (error) => finish(reject, error));
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error('GitHub download timed out.')));
    request.on('error', (error) => finish(reject, error));
  });
}

async function downloadVerifiedRelease() {
  const [checksums, archive] = await Promise.all([
    requestBuffer(CHECKSUMS_URL, MAX_CHECKSUM_BYTES),
    requestBuffer(ASSET_URL, MAX_ARCHIVE_BYTES),
  ]);
  const expected = parseChecksumFile(checksums);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw new Error('Release archive SHA-256 mismatch; nothing was extracted or installed.');
  return { archive, digest: actual };
}

function command(program, args, { cwd, timeout = NPM_TIMEOUT_MS, maxBuffer = 8 * 1024 * 1024 } = {}) {
  const windows = process.platform === 'win32';
  const env = { ...process.env, CI: '1' };
  delete env.TAR_OPTIONS;
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    shell: windows && (program.toLowerCase().endsWith('.cmd') || program.toLowerCase().endsWith('.bat')),
    timeout,
    maxBuffer,
    windowsHide: true,
    env,
  });
  if (result.error) throw new Error(`${program} could not be started: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`${program} failed with exit code ${result.status}${detail ? `:\n${detail}` : '.'}`);
  }
  return result.stdout ?? '';
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function tarCommand() {
  return process.platform === 'win32' ? 'tar.exe' : 'tar';
}

async function verifyCandidate(candidate, files) {
  const metadata = await lstat(candidate).catch(() => undefined);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) return { valid: false, reason: 'not a regular directory' };
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) return { valid: false, reason: 'not owned by the current user' };
  const expectedTop = new Set(['dist', 'package.json', 'package-lock.json', 'scripts', 'PROPRIETARY-NOTICE.txt']);
  const actualTop = new Set(await readdir(candidate));
  const hasModules = actualTop.has('node_modules');
  if (hasModules) actualTop.delete('node_modules');
  if (actualTop.size !== expectedTop.size || [...expectedTop].some((name) => !actualTop.has(name))) return { valid: false, reason: 'unexpected files' };
  const expectedDirectories = [path.join(candidate, 'dist'), path.join(candidate, 'scripts')];
  for (const directory of expectedDirectories) {
    const dirInfo = await lstat(directory).catch(() => undefined);
    if (!dirInfo?.isDirectory() || dirInfo.isSymbolicLink()) return { valid: false, reason: 'unexpected directory type' };
  }
  if (hasModules) {
    const modules = path.join(candidate, 'node_modules');
    const moduleInfo = await lstat(modules).catch(() => undefined);
    if (!moduleInfo?.isDirectory() || moduleInfo.isSymbolicLink()) return { valid: false, reason: 'node_modules is not a regular directory' };
  }
  const expectedDirs = new Map([
    ['dist', new Set(['cli.js'])],
    ['scripts', new Set(['install.mjs'])],
  ]);
  for (const [directory, expectedFiles] of expectedDirs) {
    const actualFiles = new Set(await readdir(path.join(candidate, directory)));
    if (actualFiles.size !== expectedFiles.size || [...expectedFiles].some((name) => !actualFiles.has(name))) return { valid: false, reason: `unexpected contents under ${directory}` };
  }
  for (const relative of REQUIRED_RELATIVE_FILES) {
    const filePath = path.join(candidate, relative);
    const fileInfo = await lstat(filePath).catch(() => undefined);
    if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) return { valid: false, reason: `missing or unsafe ${relative}` };
    if (typeof process.getuid === 'function' && fileInfo.uid !== process.getuid()) return { valid: false, reason: `${relative} is not owned by the current user` };
    const expected = files.get(`${PACKAGE_ROOT_NAME}/${relative}`);
    if (!expected || !(await readFile(filePath)).equals(expected)) return { valid: false, reason: `${relative} differs from the verified release` };
  }
  return { valid: true, hasModules };
}

async function readPackageFiles(packageRoot) {
  const expectedTop = new Set(['dist', 'package.json', 'package-lock.json', 'scripts', 'PROPRIETARY-NOTICE.txt']);
  const actualTop = new Set(await readdir(packageRoot));
  if (actualTop.size !== expectedTop.size || [...expectedTop].some((name) => !actualTop.has(name))) {
    throw new Error('The extracted release has unexpected top-level files.');
  }
  for (const [directory, expected] of [['dist', ['cli.js']], ['scripts', ['install.mjs']]]) {
    const dirPath = path.join(packageRoot, directory);
    const dir = await lstat(dirPath);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error(`The extracted ${directory} path is unsafe.`);
    const contents = await readdir(dirPath);
    if (contents.length !== expected.length || expected.some((name) => !contents.includes(name))) {
      throw new Error(`The extracted ${directory} directory has unexpected files.`);
    }
  }
  const files = new Map();
  for (const relative of REQUIRED_RELATIVE_FILES) {
    const fullPath = path.join(packageRoot, relative);
    const info = await lstat(fullPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`The extracted release contains an unsafe ${relative}.`);
    files.set(`${PACKAGE_ROOT_NAME}/${relative}`, await readFile(fullPath));
  }
  return files;
}

async function dependenciesReady(candidate) {
  try {
    command(npmCommand(), ['ls', '--omit=dev', '--depth=0'], { cwd: candidate, timeout: 60_000 });
    return true;
  } catch { return false; }
}

async function listCandidates(versionRoot, stableName) {
  const names = await readdir(versionRoot);
  return names
    .filter((name) => name === stableName || name.startsWith(`${stableName}-recovery-`))
    .sort()
    .map((name) => path.join(versionRoot, name));
}

async function extractStaging(stageRoot, archive) {
  const archivePath = path.join(stageRoot, ASSET);
  const handle = await open(archivePath, 'wx', 0o600);
  try { await handle.writeFile(archive); await handle.sync(); }
  finally { await handle.close(); }
  const listing = command(tarCommand(), ['-tzf', archivePath], { cwd: stageRoot, timeout: 60_000 })
    .split(/\r?\n/u).filter(Boolean).sort();
  const expectedListing = REQUIRED_RELATIVE_FILES.map((file) => `${PACKAGE_ROOT_NAME}/${file}`).sort();
  if (listing.length !== expectedListing.length || listing.some((name, index) => name !== expectedListing[index])) {
    throw new Error('The verified release archive has an unexpected file layout.');
  }
  command(tarCommand(), ['-xzf', archivePath, '-C', stageRoot], { cwd: stageRoot, timeout: 60_000 });
  const extractedRoot = path.join(stageRoot, PACKAGE_ROOT_NAME);
  const rootInfo = await lstat(extractedRoot).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Extracted release layout is invalid.');
  const top = new Set(await readdir(stageRoot));
  if (top.size !== 2 || !top.has(ASSET) || !top.has(PACKAGE_ROOT_NAME)) throw new Error('Extracted release contains unexpected top-level paths.');
  await rm(archivePath);
  return { root: extractedRoot, files: await readPackageFiles(extractedRoot) };
}

async function installPackage(versionRoot, digest, archive) {
  const stableName = `sha256-${digest.slice(0, 16)}`;
  const lockPath = path.join(versionRoot, '.install.lock');
  const releaseLockInfo = await acquireInstallLock(lockPath);
  const stageRoot = path.join(versionRoot, `.stage-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(stageRoot, { mode: 0o700 });
    const { root: extractedRoot, files } = await extractStaging(stageRoot, archive);
    for (const candidate of await listCandidates(versionRoot, stableName)) {
      const check = await verifyCandidate(candidate, files);
      if (check.valid && check.hasModules && await dependenciesReady(candidate)) return candidate;
    }
    command(npmCommand(), ['ci', '--omit=dev', '--ignore-scripts'], { cwd: extractedRoot, timeout: NPM_TIMEOUT_MS });
    if (!(await dependenciesReady(extractedRoot))) throw new Error('Production dependency validation failed after npm ci.');
    const sourceCheck = await verifyCandidate(extractedRoot, files);
    if (!sourceCheck.valid || !sourceCheck.hasModules) throw new Error(`Installed package no longer matches the verified archive: ${sourceCheck.reason ?? 'missing node_modules'}.`);
    let destination = path.join(versionRoot, stableName);
    if (await lstat(destination).catch(() => undefined)) destination = path.join(versionRoot, `${stableName}-recovery-${randomUUID()}`);
    if (await lstat(destination).catch(() => undefined)) throw new Error('A destination unexpectedly exists; no existing installation was overwritten.');
    await rename(extractedRoot, destination);
    return destination;
  } finally {
    const stageInfo = await lstat(stageRoot).catch(() => undefined);
    if (stageInfo?.isDirectory() && !stageInfo.isSymbolicLink()) await rm(stageRoot, { recursive: true, force: true });
    await releaseLock(releaseLockInfo);
  }
}

async function releaseLock(lock) {
  const info = await lstat(lock.path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) return;
  const bytes = await readFile(lock.path).catch(() => Buffer.alloc(0));
  if (info.dev === lock.dev && info.ino === lock.ino && bytes.equals(lock.bytes)) await rm(lock.path).catch(() => undefined);
}

async function acquireInstallLock(lockPath) {
  const waitingSince = Date.now();
  const token = randomUUID();
  const lockBytes = Buffer.from(`${JSON.stringify({ marker: LOCK_MARKER, pid: process.pid, token, startedAt: new Date().toISOString() })}\n`);
  while (Date.now() - waitingSince < LOCK_WAIT_MS) {
    try {
      await writeFile(lockPath, lockBytes, { flag: 'wx', mode: 0o600 });
      const info = await lstat(lockPath);
      return { path: lockPath, dev: info.dev, ino: info.ino, bytes: lockBytes };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(lockPath).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink()) throw new Error('The install lock path is not a regular file; refusing to continue.');
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('The install lock is owned by another user; refusing to wait on it.');
      if ((info.mode & 0o022) !== 0) throw new Error('The install lock is writable by other users; refusing to wait on it.');
      const content = await readFile(lockPath, 'utf8').catch(() => '');
      let record;
      try { record = JSON.parse(content); } catch { record = undefined; }
      if (record?.marker === LOCK_MARKER && Number.isInteger(record.pid) && record.pid > 0) {
        let running = true;
        try { process.kill(record.pid, 0); }
        catch (probeError) { running = probeError.code === 'EPERM'; }
        if (!running) {
          const check = await lstat(lockPath).catch(() => undefined);
          const latest = await readFile(lockPath, 'utf8').catch(() => '');
          if (check?.isFile() && !check.isSymbolicLink() && check.dev === info.dev && check.ino === info.ino && latest === content) {
            await rm(lockPath).catch(() => undefined);
            continue;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new Error('Another installer is still preparing this release. Wait for it to finish and retry.');
}

async function runPackagedInstaller(installPath, project, config) {
  const installerPath = path.join(installPath, 'scripts', 'install.mjs');
  const args = [installerPath, '--project', project];
  if (config) args.push('--config', config);
  const result = spawnSync(process.execPath, args, {
    cwd: project,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env },
  });
  if (result.error) throw new Error(`The packaged project installer failed to start: ${result.error.message}`, { cause: result.error });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`The packaged project installer exited with code ${result.status}.`);
}

async function main(argv) {
  assertSupportedNode();
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(`${usage()}\n`); return; }
  const { project, home } = await resolveProject(args.project);
  const config = await resolveConfig(args.config, project);
  const base = dataHomeCandidate();
  const dataHome = path.resolve(base.path);
  const canonicalDataHome = await ensureDirectory(dataHome, 'Per-user application data directory', { ownerBoundary: path.resolve(base.ownerBoundary) });
  const applicationRoot = await ensureDirectory(path.join(canonicalDataHome, 'zorya-code-explorer'), 'Zorya Code Explorer installation directory', { ownerBoundary: canonicalDataHome });
  const versionRoot = await ensureDirectory(path.join(applicationRoot, RELEASE), 'Zorya Code Explorer version directory', { ownerBoundary: canonicalDataHome });
  if (within(project, versionRoot) || within(versionRoot, project)) {
    throw new Error('The project and durable installation directory must be separate. Set XDG_DATA_HOME outside the project if needed.');
  }
  if (samePath(project, home)) throw new Error('Refusing to install into the user home directory.');

  process.stdout.write(`Verifying ${ASSET} from public release ${RELEASE}...\n`);
  const release = await downloadVerifiedRelease();
  process.stdout.write(`Verified SHA-256 ${release.digest}.\n`);
  const installPath = await installPackage(versionRoot, release.digest, release.archive);
  await runPackagedInstaller(installPath, project, config);
  process.stdout.write(`Installed project MCP entry for ${project}.\n`);
  process.stdout.write(`Verified package: ${installPath}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`Installation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
