#!/usr/bin/env node
'use strict';
// The one deploy entry for this stack: build api, worker and web into staging directories,
// pause the watchdog for the whole window, swap the live builds, start the stack through
// start-native.sh, and verify it end to end. Any failure restores the previous builds and the
// previous values of the env keys this run changed, starts the stack again, and verifies the
// old build. A receipt (deployment.json) and a log land in releases/deploy-<stamp>/.
//
// Usage:
//   node deploy-stack.cjs --plan                 # print what would happen, change nothing
//   node deploy-stack.cjs                        # build and deploy api + worker + web
//   node deploy-stack.cjs --migrate [--expect-migration <name>]
//   node deploy-stack.cjs --set KEY=VALUE ...    # repeatable, applied to env.native
//   node deploy-stack.cjs --restart-memory       # memory-service.sh restart after the checks
//   node deploy-stack.cjs --restart-watchdog     # reload the watchdog after the checks
//
// What it guarantees:
//   - builds never write the live dist; they land in apps/<app>/dist-stack-<stamp> (a sibling
//     of dist, which the server bundle's relative node_modules paths depend on);
//   - run/watchdog.disabled exists from before the first service stops until the checks pass,
//     and only this deployment's start-native.sh calls can start while it is held;
//   - the previous dist directories and env.native are kept in <release>/rollback/.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

const ROOT = __dirname;
const SRC = process.env.RAKAZO_SRC ?? path.resolve(ROOT, '..');
const RUN = path.join(ROOT, 'run');
const START_LOCK = path.join(RUN, 'start.lock');
const PAUSE_FILE = path.join(RUN, 'watchdog.disabled');
const MEMORY_SERVICE = path.join(ROOT, 'memory-service.sh');
const ENV_FILE = path.join(ROOT, 'env.native');
const STAMP = `${timestamp(new Date())}-${process.pid}`;
const PAUSE_OWNER = `deploy-stack ${STAMP}`;
const RELEASE = path.join(ROOT, 'releases', `deploy-${STAMP}`);
const ROLLBACK = path.join(RELEASE, 'rollback');
const LOG_FILE = path.join(RELEASE, 'deployment.log');
const KEEP_PAUSED = { RAKAZO_KEEP_WATCHDOG_PAUSED: '1' };
const NO_PROXY_ENV = { NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
const APPS = ['api', 'worker', 'web'];

const receipt = {
	startedAt: new Date().toISOString(),
	stamp: STAMP,
	status: 'planning',
	release: RELEASE,
};
let envPrevious = new Map();
let ownsLock = false;

function releasePause() {
	if (fs.readFileSync(PAUSE_FILE, 'utf8') !== `${PAUSE_OWNER}\n`) {
		throw new Error('deployment no longer owns run/watchdog.disabled');
	}
	fs.unlinkSync(PAUSE_FILE);
	receipt.paused = false;
}

function timestamp(date) {
	const pad = (value) => String(value).padStart(2, '0');
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

function log(message) {
	const line = `${new Date().toISOString()} ${message}\n`;
	if (fs.existsSync(RELEASE)) fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });
	process.stdout.write(line);
}

// ---------------------------------------------------------------- env.native and the database

function readNativeEnv() {
	const env = {};
	for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
		const line = raw.replace(/^export /, '');
		if (!line || line.startsWith('#')) continue;
		const split = line.indexOf('=');
		if (split < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, split))) {
			throw new Error(`Invalid line in ${ENV_FILE}`);
		}
		let value = line.slice(split + 1);
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		env[line.slice(0, split)] = value;
	}
	for (const key of ['DATABASE_URL', 'DATABASE_MIGRATION_URL']) {
		const url = new URL(env[key]);
		if (url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/rakazo') {
			throw new Error(`Unexpected production target in ${key}`);
		}
	}
	return env;
}

function ownerClient() {
	const { Client } = createRequire(path.join(SRC, 'packages/db/package.json'))('pg');
	return new Client({
		connectionString: readNativeEnv().DATABASE_MIGRATION_URL,
		application_name: 'deploy-stack',
	});
}

async function queryOwner(sql, params = []) {
	const client = ownerClient();
	await client.connect();
	try {
		return (await client.query(sql, params)).rows;
	} finally {
		await client.end();
	}
}

async function assertIdle() {
	const rows = await queryOwner(
		`SELECT id, status FROM runs WHERE status IN ('queued','leased','running','waiting_input','waiting_takeover') OR "leaseExpiresAt" > now() ORDER BY "createdAt"`,
	);
	if (rows.length) throw new Error(`In-flight runs: ${JSON.stringify(rows)}`);
	return { checkedAt: new Date().toISOString(), activeRuns: 0 };
}

function readEnvLines() {
	const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
	while (lines.length && lines.at(-1) === '') lines.pop();
	return lines;
}

function writeEnvLines(lines) {
	const stage = `${ENV_FILE}.${process.pid}.tmp`;
	const fd = fs.openSync(stage, 'wx', 0o600);
	try {
		try {
			fs.writeFileSync(fd, `${lines.join('\n')}\n`);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(stage, ENV_FILE);
	} finally {
		fs.rmSync(stage, { force: true });
	}
}

// Applies KEY=VALUE changes to env.native and returns the previous value of each key (null when
// the key did not exist), so a rollback can undo exactly those keys instead of restoring the
// whole file and dropping whatever was added after the backup.
function applyEnvChanges(changes) {
	const lines = readEnvLines();
	const previous = new Map();
	for (const { key, value } of changes) {
		const pattern = new RegExp(`^(?:export )?${key}=`);
		const at = lines.findLastIndex((line) => pattern.test(line));
		if (!previous.has(key)) previous.set(key, at === -1 ? null : lines[at]);
		if (at === -1) {
			lines.push(`${key}=${value}`);
		} else {
			lines[at] = `${key}=${value}`;
		}
	}
	writeEnvLines(lines);
	return previous;
}

function restoreEnv(previous) {
	const lines = readEnvLines();
	for (const [key, line] of previous) {
		const pattern = new RegExp(`^(?:export )?${key}=`);
		const at = lines.findLastIndex((line) => pattern.test(line));
		if (line === null) {
			if (at !== -1) lines.splice(at, 1);
		} else if (at === -1) {
			lines.push(line);
		} else {
			lines[at] = line;
		}
	}
	writeEnvLines(lines);
}

// ------------------------------------------------------------------------------- process state

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === 'ESRCH') return false;
		throw error;
	}
}

function readPid(app) {
	const file = path.join(RUN, `${app}.pid`);
	if (!fs.existsSync(file)) return null;
	const pid = Number(fs.readFileSync(file, 'utf8').trim());
	return Number.isInteger(pid) && pid > 1 ? pid : null;
}

function currentBuildId() {
	const file = path.join(SRC, 'apps/web/dist/build-id');
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
}

async function stop(app) {
	const file = path.join(RUN, `${app}.pid`);
	const pid = readPid(app);
	if (pid === null) return;
	if (!alive(pid)) {
		fs.unlinkSync(file);
		return;
	}
	const inspected = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
		encoding: 'utf8',
	});
	const cwd = inspected.stdout
		.split('\n')
		.find((line) => line.startsWith('n'))
		?.slice(1);
	if (cwd !== fs.realpathSync(path.join(SRC, 'apps', app))) {
		throw new Error(`Refusing to stop pid ${pid}: it is not this stack's ${app}`);
	}
	log(`stopping ${app} (pid ${pid})`);
	process.kill(pid, 'SIGTERM');
	for (let waited = 0; waited < 120 && alive(pid); waited++) await delay(500);
	if (alive(pid)) throw new Error(`${app} did not stop within 60 seconds; nothing is forced`);
	fs.unlinkSync(file);
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// start-native.sh is idempotent and starts whatever is missing; the pause must survive it.
function startStack() {
	const fd = fs.openSync(LOG_FILE, 'a', 0o600);
	const result = spawnSync('/bin/bash', [path.join(ROOT, 'start-native.sh')], {
		cwd: ROOT,
		env: {
			...process.env,
			...KEEP_PAUSED,
			...NO_PROXY_ENV,
			RAKAZO_START_LOCK_PID: String(process.pid),
			RAKAZO_DEPLOY_PAUSE_OWNER: PAUSE_OWNER,
		},
		detached: true,
		stdio: ['ignore', fd, fd],
		timeout: 180000,
	});
	fs.closeSync(fd);
	if (result.status !== 0) throw new Error('start-native.sh failed; see deployment.log');
}

// ------------------------------------------------------------------------------------ building

function entriesFromPackage(app) {
	const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'apps', app, 'package.json'), 'utf8'));
	const script = String(pkg?.scripts?.build ?? '').trim();
	const tokens = script.split(/\s+/);
	const at = tokens.findIndex((token) => token.endsWith('scripts/build-server.mjs'));
	if (at === -1) throw new Error(`${app} build script does not call scripts/build-server.mjs`);
	const entries = tokens.slice(at + 1).filter((token) => token.endsWith('.ts'));
	if (!entries.length) throw new Error(`${app} build script lists no entrypoints`);
	return entries;
}

async function buildServerApp(app, stage) {
	const esbuild = createRequire(path.join(SRC, 'package.json'))('esbuild');
	const { serverBuildOptions } = await import(
		pathToFileURL(path.join(SRC, 'scripts/build-server.mjs')).href
	);
	const appDir = path.join(SRC, 'apps', app);
	for (const entry of entriesFromPackage(app)) {
		const source = path.join(appDir, entry);
		const outfile = path.join(
			stage,
			path.relative(path.join(appDir, 'src'), source).replace(/\.ts$/, '.js'),
		);
		fs.mkdirSync(path.dirname(outfile), { recursive: true });
		await esbuild.build(serverBuildOptions(source, outfile));
	}
	log(`built ${app} into ${path.relative(SRC, stage)}`);
}

function run(command, args, options) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		timeout: 900000,
		...options,
	});
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.slice(0, 4).join(' ')} failed: ${(result.stderr || result.stdout || '').slice(-2000)}`,
		);
	}
	return result;
}

function buildWeb(stage) {
	// Locale catalogs are committed under packages/i18n; `lingui extract-template` edits the
	// source tree, so a deploy does not run it. Vite compiles the existing catalogs.
	run(path.join(SRC, 'apps/web/node_modules/.bin/vite'), ['build', '--outDir', stage, '--emptyOutDir'], {
		cwd: path.join(SRC, 'apps/web'),
		// This flag only relaxes build-time secret validation; runtime services use env.native.
		env: { ...process.env, NODE_ENV: 'production', RAKAZO_ALLOW_DEV_SECRETS: '1', ...NO_PROXY_ENV },
	});
	log(`built web into ${path.relative(SRC, stage)}`);
}

async function buildWebServer(stage) {
	const esbuild = createRequire(path.join(SRC, 'package.json'))('esbuild');
	const { serverBuildOptions } = await import(
		pathToFileURL(path.join(SRC, 'scripts/build-server.mjs')).href
	);
	const source = path.join(SRC, 'apps/web/src/standalone-server.ts');
	const outfile = path.join(stage, 'index.js');
	fs.mkdirSync(stage, { recursive: true });
	await esbuild.build(serverBuildOptions(source, outfile));
	log(`built the web host into ${path.relative(SRC, stage)}`);
}

function requireFiles(stage, files, label) {
	for (const file of files) {
		if (!fs.existsSync(path.join(stage, file))) {
			throw new Error(`${label} build is missing ${file}`);
		}
	}
}

// ---------------------------------------------------------------------------------- health

async function fetchWithTimeout(url, options = {}, timeout = 10000) {
	return fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
}

async function checkApiReady() {
	const response = await fetchWithTimeout('http://127.0.0.1:3100/ready');
	if (response.status !== 200) throw new Error(`/ready answered ${response.status}`);
	const body = await response.json();
	if (body.ok !== true) throw new Error(`/ready body is ${JSON.stringify(body)}`);
}

async function checkBuildId(expected) {
	const response = await fetchWithTimeout('http://127.0.0.1:5173/build-id');
	if (response.status !== 200) throw new Error(`/build-id answered ${response.status}`);
	const build = (await response.text()).trim();
	if (build !== expected) throw new Error(`/build-id is ${build}, expected ${expected}`);
}

async function checkRpcHealth(expected) {
	const response = await fetchWithTimeout('http://127.0.0.1:5173/rpc/health', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ json: {} }),
	});
	if (response.status !== 200) throw new Error(`/rpc/health answered ${response.status}`);
	const build = response.headers.get('x-rakazo-build');
	if (build !== expected) throw new Error(`/rpc/health build header is ${build}, expected ${expected}`);
}

function checkWorker() {
	const pid = readPid('worker');
	if (pid === null || !alive(pid)) throw new Error('worker pid is missing or not running');
	const result = spawnSync(process.execPath, [path.join(SRC, 'apps/worker/dist/health-check.js')], {
		encoding: 'utf8',
		timeout: 10000,
		env: {
			...process.env,
			WORKER_HEALTH_FILE: path.join(RUN, 'worker-health.json'),
			WORKER_HEALTH_PID: String(pid),
		},
	});
	if (result.status !== 0) throw new Error('worker heartbeat is stale or belongs to another PID');
}

function checkMemory() {
	const result = spawnSync('/bin/bash', [MEMORY_SERVICE, 'status'], {
		encoding: 'utf8',
		timeout: 30000,
	});
	if (result.status !== 0) throw new Error('local memory index is stopped or unhealthy');
}

async function verify(expectedBuild) {
	await checkApiReady();
	await checkBuildId(expectedBuild);
	await checkRpcHealth(expectedBuild);
	checkWorker();
	checkMemory();
	log(
		`verified: /ready ok, build-id ${expectedBuild}, /rpc/health ok, worker heartbeat fresh, memory index healthy`,
	);
}

// ------------------------------------------------------------------------------------- swap

function swapIn(label, live, stage) {
	const backup = path.join(ROLLBACK, `${label}-dist`);
	fs.renameSync(live, backup);
	// Recorded before the second rename: if that fails, live is gone and must be restored.
	receipt.swapped.push({ label, live, backup });
	fs.renameSync(stage, live);
}

function restoreSwapped() {
	for (const entry of [...receipt.swapped].reverse()) {
		if (fs.existsSync(entry.live)) {
			fs.renameSync(entry.live, path.join(RELEASE, `failed-${entry.label}-dist`));
		}
		if (fs.existsSync(entry.backup)) fs.renameSync(entry.backup, entry.live);
	}
	receipt.swapped = [];
}

function restartWatchdog() {
	const result = spawnSync(
		'/bin/launchctl',
		['kickstart', '-k', `gui/${process.getuid()}/ai.rakazo.watchdog`],
		{ encoding: 'utf8', timeout: 30000 },
	);
	if (result.status !== 0) throw new Error(`watchdog kickstart failed: ${result.stderr}`);
	log('watchdog restarted');
}

// ------------------------------------------------------------------------------------- plan

function parseArgs(argv) {
	const options = {
		plan: false,
		migrate: false,
		expectMigration: null,
		sets: [],
		restartMemory: false,
		restartWatchdog: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			return value;
		};
		if (arg === '--plan' || arg === '--dry-run') options.plan = true;
		else if (arg === '--migrate') options.migrate = true;
		else if (arg === '--expect-migration') options.expectMigration = next();
		else if (arg === '--set') {
			const pair = next();
			const split = pair.indexOf('=');
			if (split < 1) throw new Error('--set expects KEY=VALUE');
			const key = pair.slice(0, split);
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`--set has an invalid key: ${key}`);
			options.sets.push({ key, value: pair.slice(split + 1) });
		} else if (arg === '--restart-memory') options.restartMemory = true;
		else if (arg === '--restart-watchdog') options.restartWatchdog = true;
		else throw new Error(`Unknown argument ${arg}`);
	}
	return options;
}

async function printPlan(options) {
	const env = readNativeEnv();
	const before = Object.fromEntries(APPS.map((app) => [app, readPid(app)]));
	let inFlight = 'not checked';
	try {
		const rows = await queryOwner(
			`SELECT count(*)::int AS n FROM runs WHERE status IN ('queued','leased','running','waiting_input','waiting_takeover') OR "leaseExpiresAt" > now()`,
		);
		inFlight = String(rows[0].n);
	} catch (error) {
		inFlight = `check failed (${error.message})`;
	}
	const stages = stagePaths();
	console.log(
		[
			`plan: deploy-stack`,
			`  source:            ${SRC}`,
			`  release dir:       ${RELEASE}`,
			`  current build-id:  ${currentBuildId()}`,
			`  pids now:          api=${before.api} worker=${before.worker} web=${before.web}`,
			`  in-flight runs:    ${inFlight}`,
			`  start.lock:        ${fs.existsSync(path.join(RUN, 'start.lock')) ? 'present' : 'absent'}`,
			`  watchdog marker:   ${fs.existsSync(path.join(RUN, 'watchdog.disabled')) ? 'present' : 'absent'}`,
			`  build steps:`,
			`    api    -> ${path.relative(ROOT, stages.api)}`,
			`    worker -> ${path.relative(ROOT, stages.worker)}`,
			`    web    -> ${path.relative(ROOT, stages.web)}`,
			`    host   -> ${path.relative(ROOT, stages.webServer)}`,
			`  migrate:           ${options.migrate ? `yes${options.expectMigration ? ` (expect ${options.expectMigration})` : ''}` : 'no'}`,
			`  env changes:       ${options.sets.length ? options.sets.map(({ key }) => `${key} (currently ${Object.hasOwn(env, key) ? 'set' : 'unset'})`).join(', ') : 'none'}`,
			`  restart memory:    ${options.restartMemory ? 'yes' : 'no'}`,
			`  restart watchdog:  ${options.restartWatchdog ? 'yes' : 'no'}`,
			`  deploy steps:`,
			`    1. pause the watchdog (run/watchdog.disabled)`,
			`    2. build the four artefacts above`,
			`    3. apply env changes, run migrations`,
			`    4. stop web, worker, api and swap the builds (previous ones into ${path.relative(ROOT, ROLLBACK)})`,
			`    5. start through start-native.sh with RAKAZO_KEEP_WATCHDOG_PAUSED=1`,
			`    6. verify /ready, build-id, /rpc/health, worker heartbeat, memory index`,
			`    7. restart memory/watchdog if asked, then remove the pause`,
			`  on failure: stop services, restore the previous builds and changed env keys, start, verify the old build`,
			`  nothing is changed by this plan run.`,
		].join('\n'),
	);
}

// ------------------------------------------------------------------------------------- main

function stagePaths() {
	return {
		api: path.join(SRC, 'apps/api', `dist-stack-${STAMP}`),
		worker: path.join(SRC, 'apps/worker', `dist-stack-${STAMP}`),
		web: path.join(SRC, 'apps/web', `dist-stack-${STAMP}`),
		webServer: path.join(SRC, 'apps/web', `dist-server-stack-${STAMP}`),
	};
}

async function runMigration(stage) {
	const env = readNativeEnv();
	const fd = fs.openSync(LOG_FILE, 'a', 0o600);
	const result = spawnSync(process.execPath, [path.join(stage, 'cli/migrate-database.js')], {
		cwd: path.join(SRC, 'apps/api'),
		env: {
			...process.env,
			...env,
			RAKAZO_ENV_FILE: 'none',
			RAKAZO_DB_PACKAGE_DIR: path.join(SRC, 'packages/db'),
			...NO_PROXY_ENV,
		},
		stdio: ['ignore', fd, fd],
		timeout: 600000,
	});
	fs.closeSync(fd);
	if (result.status !== 0) throw new Error('database migration failed; see deployment.log');
	log('database migration finished');
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.plan) {
		await printPlan(options);
		return;
	}
	if (options.expectMigration && !options.migrate) {
		throw new Error('--expect-migration only applies together with --migrate');
	}
	if (fs.existsSync(PAUSE_FILE)) {
		throw new Error('run/watchdog.disabled already exists; another stop or deploy is in progress');
	}
	if (fs.existsSync(START_LOCK)) throw new Error('Another native operation is in progress');
	for (const app of APPS) {
		if (!fs.statSync(path.join(SRC, 'apps', app, 'dist')).isDirectory()) {
			throw new Error(`apps/${app}/dist is missing`);
		}
	}
	if (!fs.statSync(path.join(SRC, 'apps/web/dist-server')).isDirectory()) {
		throw new Error('apps/web/dist-server is missing');
	}
	const stages = stagePaths();
	for (const stage of Object.values(stages)) {
		if (fs.existsSync(stage)) throw new Error(`Staging directory already exists: ${stage}`);
	}

	fs.mkdirSync(ROLLBACK, { recursive: true, mode: 0o700 });
	receipt.status = 'preparing';
	receipt.initialGuard = await assertIdle();
	fs.mkdirSync(START_LOCK, { mode: 0o700 });
	ownsLock = true;
	fs.writeFileSync(path.join(START_LOCK, 'pid'), `${process.pid}\n`, { mode: 0o600 });
	receipt.before = Object.fromEntries(APPS.map((app) => [app, readPid(app)]));
	receipt.previousBuild = currentBuildId();
	receipt.swapped = [];
	log(`deploy-stack ${STAMP}: api=${receipt.before.api} worker=${receipt.before.worker} web=${receipt.before.web} build=${receipt.previousBuild}`);

	fs.copyFileSync(ENV_FILE, path.join(ROLLBACK, 'env.native'));
	fs.chmodSync(path.join(ROLLBACK, 'env.native'), 0o600);

	fs.writeFileSync(PAUSE_FILE, `${PAUSE_OWNER}\n`, {
		flag: 'wx',
		mode: 0o600,
	});
	receipt.paused = true;
	log('watchdog paused for the deploy window');

	// 1. Build every artefact next to (never over) the live dist.
	receipt.status = 'building';
	await buildServerApp('api', stages.api);
	await buildServerApp('worker', stages.worker);
	buildWeb(stages.web);
	await buildWebServer(stages.webServer);
	requireFiles(stages.api, ['index.js', 'cli/migrate-database.js'], 'api');
	requireFiles(stages.worker, ['index.js', 'health-check.js'], 'worker');
	requireFiles(stages.web, ['index.html', 'build-id'], 'web');
	requireFiles(stages.webServer, ['index.js'], 'web host');
	const build = fs.readFileSync(path.join(stages.web, 'build-id'), 'utf8').trim();
	if (!/^\d{14}$/.test(build)) throw new Error(`Unexpected build-id "${build}"`);
	receipt.build = build;
	receipt.builtAt = new Date().toISOString();
	log(`built build-id ${build}`);

	// 2. Env changes and migrations; both are upstream of the swap and undone on failure.
	receipt.envChanges = options.sets.map(({ key }) => key);
	if (options.sets.length) envPrevious = applyEnvChanges(options.sets);
	if (options.sets.length) log(`updated env.native keys: ${receipt.envChanges.join(', ')}`);
	if (options.migrate) {
		receipt.status = 'migrating';
		await runMigration(stages.api);
		if (options.expectMigration) {
			const applied = await queryOwner(
				`SELECT 1 FROM _prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
				[options.expectMigration],
			);
			if (applied.length !== 1) throw new Error(`Migration ${options.expectMigration} is not applied`);
			log(`migration ${options.expectMigration} is applied`);
		}
	}

	// 3. Stop the three services, then swap each artefact in.
	receipt.status = 'swapping';
	await assertIdle();
	receipt.stopStarted = true;
	await stop('web');
	await stop('worker');
	await stop('api');
	swapIn('api', path.join(SRC, 'apps/api/dist'), stages.api);
	swapIn('worker', path.join(SRC, 'apps/worker/dist'), stages.worker);
	swapIn('web', path.join(SRC, 'apps/web/dist'), stages.web);
	swapIn('web-server', path.join(SRC, 'apps/web/dist-server'), stages.webServer);
	receipt.swappedAt = new Date().toISOString();

	// 4. Start and verify.
	receipt.status = 'starting';
	startStack();
	receipt.status = 'verifying';
	await verify(build);

	// 5. Optional restarts, then lift the pause.
	if (options.restartMemory) {
		receipt.status = 'restarting memory';
		const result = spawnSync('/bin/bash', [MEMORY_SERVICE, 'restart'], {
			encoding: 'utf8',
			timeout: 180000,
		});
		if (result.status !== 0) {
			throw new Error(`memory index restart failed: ${(result.stderr || '').trim()}`);
		}
		checkMemory();
		log('memory index restarted and healthy');
	}
	if (options.restartWatchdog) {
		receipt.status = 'restarting watchdog';
		restartWatchdog();
	}
	releasePause();
	receipt.status = 'deployed';
	receipt.after = Object.fromEntries(APPS.map((app) => [app, readPid(app)]));
	receipt.completedAt = new Date().toISOString();
	log(`deployed build-id ${build}; watchdog resume`);
}

async function rollback(error) {
	const ownsStages = receipt.paused;
	receipt.status = 'failed';
	receipt.error = error.message;
	log(`FAILED: ${error.message}`);
	try {
		if (receipt.paused) {
			if (receipt.stopStarted) {
				for (const app of ['web', 'worker', 'api']) {
					if (fs.existsSync(path.join(RUN, `${app}.pid`))) await stop(app);
				}
				restoreSwapped();
			}
			if (envPrevious.size) {
				restoreEnv(envPrevious);
				log(`restored env.native keys: ${receipt.envChanges.join(', ')}`);
			}
			if (receipt.stopStarted) {
				startStack();
				await verify(receipt.previousBuild);
			}
			releasePause();
			receipt.rollback = receipt.stopStarted ? 'restored' : 'nothing was stopped; the running stack was not touched';
			log(
				receipt.stopStarted
					? `rolled back to build-id ${receipt.previousBuild}`
					: 'nothing was stopped; the running stack was not touched',
			);
		}
	} catch (rollbackError) {
		receipt.rollback = `needs attention: ${rollbackError.message}`;
		log(`ROLLBACK NEEDS ATTENTION: ${rollbackError.message}`);
	}
	// Anything not swapped in is still a staging tree in the source checkout.
	if (ownsStages) {
		for (const stage of Object.values(stagePaths())) {
			if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
		}
	}
}

main()
	.catch(async (error) => {
		await rollback(error);
		process.exitCode = 1;
	})
	.finally(() => {
		if (ownsLock) fs.rmSync(START_LOCK, { recursive: true, force: true });
		receipt.finishedAt = new Date().toISOString();
		if (fs.existsSync(RELEASE)) {
			fs.writeFileSync(path.join(RELEASE, 'deployment.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
				mode: 0o600,
			});
		}
		console.log(JSON.stringify(receipt));
	});
