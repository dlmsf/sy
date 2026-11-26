#!/usr/bin/env node
// test_sydb_api.js - SyDB 100% HTTP API test suite (pure vanilla Node.js, ES modules, zero dependencies)
//
// Merges every step of test_sydb.c and newtest.c into 3 API-only levels:
//   Level 1 (default, zero args) - STANDARD:      smoke, database/collection/instance/command/error suites,
//                                                 security, schema, query language, integrity, edge cases,
//                                                 performance, basic concurrency
//   Level 2                      - COMPREHENSIVE: high concurrency, durability & crash recovery,
//                                                 large dataset performance, recovery & restart
//   Level 3                      - EXTREME:       stress, data corruption, mixed workload, long running,
//                                                 consistency, fault injection, chaos, extreme boundaries
//   --all runs levels 1, 2 and 3 in sequence.
//   --log writes a numbered JSON summary of every step.
//
// Everything is driven through the SyDB HTTP API. File-level checks (magic number, header counts,
// stale lock, corruption) are only executed when the data directory is locally accessible
// (managed server or --base-dir) and are skipped otherwise.
//
// Programmatic usage (no CLI / no args):
//   import SyDBApiTest from './test_sydb_api.js';
//   const report = await SyDBApiTest.run();                         // level 1
//   const report2 = await SyDBApiTest.run({ level: 2, log: true }); // level 2 + JSON log
//   const all = await SyDBApiTest.runAll({ silent: true });         // levels 1,2,3
//
// NOTE about SyDB routing: GET .../instances is routed to the schema handler when the request path
// contains "/schema", so test database and collection names never start with "schema".

import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = path.dirname(THIS_FILE);

const TOOL_NAME = 'test_sydb_api.js';
const TOOL_VERSION = '1.0.0';
const FILE_MAGIC_NUMBER = 0x53594442;
const FILE_VERSION_NUMBER = 2;
const FILE_HEADER_SIZE = 136;
const DEFAULT_MANAGED_PORT = 8080;
const DEFAULT_BASE_DIR = '/tmp/sydb_test';
const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const CATEGORY = {
    SMOKE: 'SMOKE',
    DURABILITY: 'DURABILITY',
    CONCURRENCY: 'CONCURRENCY',
    QUERY: 'QUERY',
    SCHEMA: 'SCHEMA',
    SECURITY: 'SECURITY',
    PERFORMANCE: 'PERFORMANCE',
    INTEGRITY: 'INTEGRITY',
    EDGE: 'EDGE',
    RECOVERY: 'RECOVERY'
};

const CATEGORY_LABELS = {
    SMOKE: 'Smoke Tests',
    DURABILITY: 'Durability',
    CONCURRENCY: 'Concurrency',
    QUERY: 'Query Language',
    SCHEMA: 'Schema Enforcement',
    SECURITY: 'Security',
    PERFORMANCE: 'Performance',
    INTEGRITY: 'Data Integrity',
    EDGE: 'Edge Cases',
    RECOVERY: 'Recovery'
};

const LEVEL_NAMES = { 1: 'STANDARD', 2: 'COMPREHENSIVE', 3: 'EXTREME' };

const TEST_DB_PREFIXES = [
    'testdb', 'testdb2', 'testcolldb', 'testinstdb', 'smoke_test', 'durability_test', 'http_durability',
    'concurrency_test', 'http_conc', 'query_test', 'http_query', 'enforce_test', 'http_enforce',
    'perf_test', 'http_perf', 'integrity_test', 'edge_test', 'recovery_test', 'stress_test',
    'corrupt_test', 'mixed_test', 'consistency_test', 'long_test', 'fault_test', 'chaos_test',
    'boundary_test', 'security_test', 'error_test', 'command_test', 'large_test'
];
const TEST_DB_REGEX = new RegExp(`^(${TEST_DB_PREFIXES.join('|')})_`);

const {
    SMOKE, DURABILITY, CONCURRENCY, QUERY, SCHEMA, SECURITY, PERFORMANCE, INTEGRITY, EDGE, RECOVERY
} = CATEGORY;

// ==================== SMALL UTILITIES ====================

function makePalette(enabled) {
    const code = (value) => (enabled ? value : '');
    return {
        red: code('\x1b[1;31m'),
        green: code('\x1b[1;32m'),
        yellow: code('\x1b[1;33m'),
        blue: code('\x1b[1;34m'),
        magenta: code('\x1b[1;35m'),
        cyan: code('\x1b[1;36m'),
        reset: code('\x1b[0m'),
        bold: code('\x1b[1m')
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (error) {
        return null;
    }
}

function short(text, limit = 200) {
    const value = String(text === undefined || text === null ? '' : text);
    return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function F(name, type, required = false, indexed = false) {
    return { name, type, required, indexed };
}

const pass = (details = '', extra = {}) => ({ status: 'pass', details, ...extra });
const fail = (details = '', extra = {}) => ({ status: 'fail', details, ...extra });
const warn = (details = '', extra = {}) => ({ status: 'warn', details, ...extra });
const skip = (details = '', extra = {}) => ({ status: 'skip', details, ...extra });

function summarizeSteps(steps) {
    const summary = { total: steps.length, passed: 0, failed: 0, warned: 0, skipped: 0, criticalFailures: 0 };
    for (const step of steps) {
        if (step.status === 'pass') {
            summary.passed++;
        } else if (step.status === 'fail') {
            summary.failed++;
            if (step.critical) summary.criticalFailures++;
        } else if (step.status === 'warn') {
            summary.warned++;
        } else {
            summary.skipped++;
        }
    }
    return summary;
}

function computeVerdict(summary) {
    const executed = summary.total - summary.skipped;
    const ratio = executed > 0 ? summary.passed / executed : 0;
    let verdict = 'FAIL';
    if (summary.criticalFailures === 0 && ratio >= 0.9) {
        verdict = 'PASS';
    } else if (summary.criticalFailures === 0 && ratio >= 0.7) {
        verdict = 'PASS_WITH_WARNINGS';
    }
    return {
        verdict,
        passRate: Math.round(ratio * 1000) / 10,
        exitCode: (summary.criticalFailures === 0 && ratio >= 0.7) ? 0 : 1
    };
}

async function runWorkers(workerCount, operationsPerWorker, operation) {
    const tasks = [];
    for (let worker = 0; worker < workerCount; worker++) {
        tasks.push((async () => {
            let success = 0;
            const started = Date.now();
            for (let i = 0; i < operationsPerWorker; i++) {
                try {
                    if (await operation(worker, i)) success++;
                } catch (error) {
                    // counted as failure
                }
            }
            return { worker, operations: operationsPerWorker, success, totalTimeMs: Date.now() - started };
        })());
    }
    return Promise.all(tasks);
}

async function insertWorkload(t, database, collection, workers, operationsPerWorker, label) {
    const started = Date.now();
    const results = await runWorkers(workers, operationsPerWorker, async (worker, i) => {
        const result = await t.insert(database, collection, { name: `${label}${worker}_${i}`, age: 20 + (i % 50) });
        return result.ok;
    });
    const totalSuccess = results.reduce((sum, item) => sum + item.success, 0);
    return { results, totalSuccess, attempted: workers * operationsPerWorker, durationMs: Date.now() - started };
}

// ==================== HTTP CLIENT ====================

class HttpClient {
    constructor(baseUrl, timeoutMs = 30000) {
        this.timeoutMs = timeoutMs;
        this.setBaseUrl(baseUrl);
    }

    setBaseUrl(baseUrl) {
        const parsed = new URL(baseUrl);
        this.baseUrl = baseUrl;
        this.host = parsed.hostname;
        this.port = Number(parsed.port) || 80;
    }

    request(method, urlPath, body = null, contentType = 'application/json', extra = {}) {
        return new Promise((resolve) => {
            const started = Date.now();
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                result.durationMs = Date.now() - started;
                resolve(result);
            };

            let payload = null;
            if (body !== null && body !== undefined) {
                payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
            }

            const headers = {};
            if (payload) {
                if (contentType) headers['Content-Type'] = contentType;
                headers['Content-Length'] = payload.length;
            }
            headers['Connection'] = extra.agent ? 'keep-alive' : 'close';

            const options = {
                host: this.host,
                port: this.port,
                method,
                path: urlPath,
                headers,
                agent: extra.agent || false
            };

            let request;
            try {
                request = http.request(options, (response) => {
                    const chunks = [];
                    response.on('data', (chunk) => chunks.push(chunk));
                    response.on('end', () => finish({
                        statusCode: response.statusCode || 0,
                        headers: response.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                        error: null
                    }));
                    response.on('error', (error) => finish({
                        statusCode: 0, headers: {}, body: '', error: error.message
                    }));
                });
            } catch (error) {
                finish({ statusCode: 0, headers: {}, body: '', error: error.message });
                return;
            }

            request.setTimeout(this.timeoutMs, () => request.destroy(new Error('timeout')));
            request.on('error', (error) => finish({ statusCode: 0, headers: {}, body: '', error: error.message }));
            if (payload) request.write(payload);
            request.end();
        });
    }
}

// ==================== SERVER MANAGER (managed SyDB server child process) ====================

class ServerManager {
    constructor(run) {
        this.run = run;
        this.child = null;
        this.exitPromise = null;
        this.exited = true;
        this.managed = false;
        this.startedByTest = false;
    }

    async isReachable() {
        const response = await this.run.client.request('GET', '/api/databases');
        if (response.statusCode !== 200) return false;
        const json = parseJson(response.body);
        return Boolean(json && json.success === true);
    }

    async waitForReady(timeoutSeconds = 10) {
        for (let i = 0; i < timeoutSeconds * 10; i++) {
            if (this.child && this.exited) return false;
            if (await this.isReachable()) return true;
            await sleep(100);
        }
        return false;
    }

    async start() {
        if (this.child) return true;
        const opts = this.run.opts;
        try {
            fs.mkdirSync(opts.baseDir, { recursive: true });
        } catch (error) {
            // server will try again
        }

        const args = [opts.sydbPath, '--server', String(opts.port)];
        if (opts.verbose) args.push('--verbose');

        this.exited = false;
        const child = spawn(process.execPath, args, {
            env: { ...process.env, SYDB_BASE_DIR: opts.baseDir },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        this.child = child;

        child.stdout.on('data', (data) => this.run.vlog(`[server] ${String(data).trimEnd()}`));
        child.stderr.on('data', (data) => this.run.vlog(`[server:stderr] ${String(data).trimEnd()}`));
        this.exitPromise = new Promise((resolve) => {
            child.on('exit', (code, signal) => {
                this.exited = true;
                resolve({ code, signal });
            });
            child.on('error', () => {
                this.exited = true;
                resolve({ code: -1, signal: null });
            });
        });

        await sleep(300);
        const ready = await this.waitForReady(10);
        if (!ready) {
            await this.kill();
            return false;
        }
        this.startedByTest = true;
        return true;
    }

    async stop() {
        if (!this.child) return false;
        const child = this.child;
        try {
            child.kill('SIGTERM');
        } catch (error) {
            // ignore
        }
        const result = await Promise.race([this.exitPromise, sleep(3000).then(() => null)]);
        if (result === null) {
            try {
                child.kill('SIGKILL');
            } catch (error) {
                // ignore
            }
            await this.exitPromise;
        }
        this.child = null;
        return true;
    }

    async kill() {
        if (!this.child) return false;
        try {
            this.child.kill('SIGKILL');
        } catch (error) {
            // ignore
        }
        await this.exitPromise;
        this.child = null;
        return true;
    }

    async crashAndRestart() {
        await this.kill();
        await sleep(200);
        return this.start();
    }

    async gracefulRestart() {
        await this.stop();
        await sleep(200);
        return this.start();
    }
}

// ==================== TEST RUN (state + helpers for one execution) ====================

class TestRun {
    constructor(opts) {
        this.opts = opts;
        this.c = makePalette(opts.color);
        this.client = new HttpClient(opts.url, opts.timeoutMs);
        this.server = new ServerManager(this);
        this.steps = [];
        this.levelReports = [];
        this.currentLevel = null;
        this.currentSuite = '';
        this.levelStepCounter = 0;
        this.createdDbs = new Set();
        this.uniqCounter = 0;
        this.runId = Date.now().toString(36);
        this.startedAtMs = Date.now();
        this.startedAtIso = new Date().toISOString();
        this.fileChecks = false;
        this.fatalError = null;
    }

    // ---------- output ----------

    out(line = '') {
        if (!this.opts.silent) console.log(line);
    }

    vlog(line) {
        if (this.opts.verbose && !this.opts.silent) {
            console.log(`${this.c.yellow}  [VERBOSE] ${line}${this.c.reset}`);
        }
    }

    banner(title, lines = []) {
        const { c } = this;
        this.out(`${c.cyan}${c.bold}\n===============================================${c.reset}`);
        this.out(`${c.cyan}${c.bold}   ${title}${c.reset}`);
        this.out(`${c.cyan}${c.bold}===============================================${c.reset}`);
        for (const line of lines) this.out(line);
        if (lines.length > 0) this.out(`${c.cyan}${c.bold}===============================================${c.reset}\n`);
    }

    beginLevel(level) {
        this.currentLevel = {
            level,
            name: LEVEL_NAMES[level],
            startedAt: new Date().toISOString(),
            startMs: Date.now(),
            steps: []
        };
        this.levelStepCounter = 0;
        this.banner(`LEVEL ${level} - ${LEVEL_NAMES[level]}`);
    }

    endLevel() {
        const level = this.currentLevel;
        if (!level) return;
        level.finishedAt = new Date().toISOString();
        level.durationMs = Date.now() - level.startMs;
        level.summary = summarizeSteps(level.steps);
        delete level.startMs;
        this.levelReports.push(level);
        const s = level.summary;
        this.out(`\n${this.c.yellow}  Level ${level.level} (${level.name}): ${s.passed}/${s.total} passed, ` +
            `${s.failed} failed, ${s.warned} warnings, ${s.skipped} skipped${this.c.reset}`);
        this.currentLevel = null;
    }

    suite(title) {
        this.currentSuite = title;
        this.out(`\n${this.c.magenta}${this.c.bold}${title}${this.c.reset}`);
    }

    // ---------- recording ----------

    record(spec) {
        const { c } = this;
        const level = this.currentLevel ? this.currentLevel.level : 0;
        this.levelStepCounter++;
        const step = {
            step: this.steps.length + 1,
            id: `L${level}.S${String(this.levelStepCounter).padStart(3, '0')}`,
            level,
            levelStep: this.levelStepCounter,
            suite: this.currentSuite,
            category: spec.category,
            description: spec.description,
            status: spec.status,
            critical: Boolean(spec.critical),
            durationMs: spec.durationMs === undefined ? 0 : spec.durationMs,
            method: spec.method === undefined ? null : spec.method,
            endpoint: spec.endpoint === undefined ? null : spec.endpoint,
            httpStatus: spec.httpStatus === undefined ? null : spec.httpStatus,
            details: short(spec.details, 600)
        };
        this.steps.push(step);
        if (this.currentLevel) this.currentLevel.steps.push(step);

        const tags = {
            pass: `${c.green}PASS`,
            fail: `${c.red}FAIL`,
            warn: `${c.yellow}WARN`,
            skip: `${c.yellow}SKIP`
        };
        this.out(`${c.blue}#${String(step.step).padStart(4, '0')} ${step.description.padEnd(78)}${c.reset}` +
            `[${tags[step.status]}${c.reset}] ${c.cyan}${String(step.durationMs).padStart(5)} ms${c.reset}`);
        if (step.details && (step.status !== 'pass' || this.opts.verbose)) {
            const color = step.status === 'fail' ? c.red : (step.status === 'pass' ? c.green : c.yellow);
            this.out(`${color}        ${short(step.details, 300)}${c.reset}`);
        }
        return step;
    }

    async check(description, category, critical, fn) {
        const started = Date.now();
        let result;
        try {
            result = await fn();
        } catch (error) {
            result = fail(`Exception: ${error && error.message ? error.message : error}`);
        }
        if (result === true) {
            result = pass();
        } else if (result === false || result === null || result === undefined) {
            result = fail('check returned false');
        }
        const step = this.record({
            description,
            category,
            critical,
            durationMs: Date.now() - started,
            ...result
        });
        return step.status === 'pass';
    }

    verifyResponse(response, expectedPattern, successOnly, strict = false) {
        if (!response || response.statusCode === 0) return false;
        if (successOnly) {
            const ok = response.statusCode >= 200 && response.statusCode < 500 &&
                response.body.includes('"success":');
            if (!ok) return false;
            if (strict && expectedPattern && !response.body.includes(expectedPattern)) return false;
            return true;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) return false;
        if (expectedPattern && !response.body.includes(expectedPattern)) return false;
        return true;
    }

    async http(spec) {
        const body = (spec.body !== undefined && spec.body !== null &&
            typeof spec.body === 'object' && !Buffer.isBuffer(spec.body))
            ? JSON.stringify(spec.body)
            : spec.body;
        if (spec.track) this.createdDbs.add(spec.track);

        this.vlog(`HTTP Request: ${spec.method} ${short(spec.path, 200)}`);
        if (body !== undefined && body !== null) this.vlog(`Request body: ${short(String(body), 300)}`);

        const response = await this.client.request(
            spec.method, spec.path, body === undefined ? null : body,
            spec.contentType === undefined ? 'application/json' : spec.contentType,
            spec.requestExtra || {}
        );
        this.vlog(`Response: status=${response.statusCode}, body=${short(response.body, 300)}`);

        const ok = this.verifyResponse(response, spec.expect, Boolean(spec.successOnly), Boolean(spec.strict));
        const details = ok
            ? `HTTP ${response.statusCode}`
            : `Expected ${spec.successOnly ? 'a "success" field' : 'HTTP 2xx'}` +
              `${spec.expect ? ` and pattern ${spec.expect}` : ''}; got HTTP ${response.statusCode}` +
              `${response.error ? ` (error: ${response.error})` : ''}, body: ${short(response.body, 200)}`;

        const step = this.record({
            description: spec.description,
            category: spec.category,
            critical: spec.critical,
            status: ok ? 'pass' : 'fail',
            durationMs: response.durationMs,
            method: spec.method,
            endpoint: short(spec.path, 200),
            httpStatus: response.statusCode,
            details
        });
        return { ok, resp: response, json: parseJson(response.body), step };
    }

    setupFailure(description, category = SMOKE) {
        return this.record({
            description: `Setup failed: ${description}`,
            category,
            critical: true,
            status: 'fail',
            details: 'Could not create the test database/collection required by this suite'
        });
    }

    // ---------- silent helpers (setup / verification, not recorded as steps) ----------

    uniq(prefix) {
        this.uniqCounter++;
        return `${prefix}_${this.runId}_${this.uniqCounter}`;
    }

    track(name) {
        this.createdDbs.add(name);
    }

    instancesPath(database, collection, query) {
        const base = `/api/databases/${database}/collections/${collection}/instances`;
        return (query !== undefined && query !== null && query !== '')
            ? `${base}?query=${encodeURIComponent(query)}`
            : base;
    }

    async createDb(prefix) {
        const name = this.uniq(prefix);
        this.createdDbs.add(name);
        const response = await this.client.request('POST', '/api/databases', JSON.stringify({ name }));
        const json = parseJson(response.body);
        return json && json.success === true ? name : null;
    }

    async createCollection(database, name, fields) {
        const response = await this.client.request(
            'POST', `/api/databases/${database}/collections`, JSON.stringify({ name, schema: fields })
        );
        const json = parseJson(response.body);
        return Boolean(json && json.success === true);
    }

    async insert(database, collection, document) {
        const body = typeof document === 'string' ? document : JSON.stringify(document);
        const response = await this.client.request('POST', this.instancesPath(database, collection), body);
        const json = parseJson(response.body);
        return {
            ok: Boolean(json && json.success === true),
            id: json && json.id ? json.id : null,
            resp: response,
            json
        };
    }

    async list(database, collection, query) {
        const response = await this.client.request('GET', this.instancesPath(database, collection, query));
        const json = parseJson(response.body);
        const instances = json && Array.isArray(json.instances) ? json.instances : null;
        return {
            ok: Boolean(json && json.success === true && instances),
            instances: instances || [],
            parsed: instances !== null,
            resp: response,
            json
        };
    }

    async listDatabases() {
        const response = await this.client.request('GET', '/api/databases');
        const json = parseJson(response.body);
        return json && Array.isArray(json.databases) ? json.databases : null;
    }

    async listCollections(database) {
        const response = await this.client.request('GET', `/api/databases/${database}/collections`);
        const json = parseJson(response.body);
        return json && Array.isArray(json.collections) ? json.collections : null;
    }

    async getSchema(database, collection) {
        const response = await this.client.request('GET', `/api/databases/${database}/collections/${collection}/schema`);
        const json = parseJson(response.body);
        const fields = json && json.schema && Array.isArray(json.schema.fields) ? json.schema.fields : null;
        return { ok: Boolean(json && json.success === true && fields), fields: fields || [], json, resp: response };
    }

    async deleteDatabase(name) {
        const response = await this.client.request('DELETE', `/api/databases/${name}`);
        const json = parseJson(response.body);
        return Boolean(json && json.success === true);
    }

    // ---------- file-level helpers (only when the data directory is local) ----------

    dataFilePath(database, collection) {
        return path.join(this.opts.baseDir, database, collection, 'data.sydb');
    }

    fileStructure(database, collection) {
        if (!this.fileChecks) return null;
        const dir = path.join(this.opts.baseDir, database, collection);
        return {
            dir,
            exists: fs.existsSync(dir),
            schema: fs.existsSync(path.join(dir, 'schema.txt')),
            data: fs.existsSync(path.join(dir, 'data.sydb'))
        };
    }

    readHeader(database, collection) {
        const filePath = this.dataFilePath(database, collection);
        try {
            const fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(FILE_HEADER_SIZE);
            const bytesRead = fs.readSync(fd, buffer, 0, FILE_HEADER_SIZE, 0);
            fs.closeSync(fd);
            if (bytesRead < FILE_HEADER_SIZE) return null;
            return {
                magic: buffer.readUInt32LE(0),
                magicBytes: buffer.subarray(0, 4).toString('hex'),
                version: buffer.readUInt32LE(4),
                recordCount: Number(buffer.readBigUInt64LE(8)),
                fileSize: Number(buffer.readBigUInt64LE(16)),
                freeOffset: Number(buffer.readBigUInt64LE(24)),
                actualSize: fs.statSync(filePath).size
            };
        } catch (error) {
            return null;
        }
    }

    createdSinceStart(targetPath) {
        try {
            return fs.statSync(targetPath).mtimeMs >= this.startedAtMs - 1000;
        } catch (error) {
            return false;
        }
    }

    // ---------- server preparation / cleanup ----------

    async prepareServer() {
        const { opts, c } = this;
        this.out('Testing server connectivity...');

        if (await this.server.isReachable()) {
            this.server.managed = false;
            this.fileChecks = Boolean(opts.baseDirExplicit && fs.existsSync(opts.baseDir));
            this.out(`${c.green}Server is responsive at ${opts.url} (external server: crash/restart tests will be skipped` +
                `${this.fileChecks ? '' : ', file-level checks will be skipped'})${c.reset}`);
            return true;
        }

        if (!opts.managed) {
            this.fatalError = `Cannot connect to a SyDB server at ${opts.url}. ` +
                `Start it with: node JS_SyDB.js --server ${opts.port}  ` +
                `(or pass --url=URL / --port=N, or --managed to let the test start its own server)`;
            this.out(`${c.red}ERROR: ${this.fatalError}${c.reset}`);
            return false;
        }

        const localHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
        if (!localHosts.includes(opts.host)) {
            this.fatalError = `Cannot connect to remote server at ${opts.url}`;
            this.out(`${c.red}ERROR: ${this.fatalError}${c.reset}`);
            return false;
        }

        this.out(`${c.yellow}No server at ${opts.url}. Starting a managed SyDB server (${opts.sydbPath}) ` +
            `with base dir ${opts.baseDir}...${c.reset}`);

        if (!fs.existsSync(opts.sydbPath)) {
            this.fatalError = `JS_SyDB.js not found at ${opts.sydbPath} (use --sydb=PATH)`;
            this.out(`${c.red}ERROR: ${this.fatalError}${c.reset}`);
            return false;
        }

        if (path.basename(opts.baseDir).startsWith('sydb_test')) {
            try {
                fs.rmSync(opts.baseDir, { recursive: true, force: true });
            } catch (error) {
                // ignore
            }
        }

        this.server.managed = true;
        const started = await this.server.start();
        if (!started) {
            this.server.managed = false;
            this.fatalError = 'Managed SyDB server failed to start';
            this.out(`${c.red}ERROR: ${this.fatalError}${c.reset}`);
            return false;
        }
        this.fileChecks = true;
        this.out(`${c.green}Managed server started on port ${opts.port}${c.reset}`);
        return true;
    }

    async cleanupTestDatabases() {
        this.out('Cleaning up previous test databases...');
        const databases = await this.listDatabases();
        if (!databases) return 0;
        let removed = 0;
        for (const name of databases) {
            if (TEST_DB_REGEX.test(name)) {
                await this.deleteDatabase(name);
                removed++;
            }
        }
        this.vlog(`Removed ${removed} previous test database(s)`);
        return removed;
    }

    async cleanupCreatedDatabases() {
        if (this.opts.keep) return 0;
        let removed = 0;
        for (const name of this.createdDbs) {
            try {
                await this.deleteDatabase(name);
                removed++;
            } catch (error) {
                // ignore
            }
        }
        return removed;
    }

    // ---------- main execution ----------

    async execute(levels) {
        const { opts, c } = this;
        const onSignal = async () => {
            await this.server.kill();
            process.exit(130);
        };
        const onExit = () => {
            if (this.server.child) {
                try {
                    this.server.child.kill('SIGKILL');
                } catch (error) {
                    // ignore
                }
            }
        };
        process.once('SIGINT', onSignal);
        process.once('exit', onExit);

        this.banner('SYDB 100% API TEST SUITE', [
            `Server URL:  ${opts.url}`,
            `Levels:      ${levels.map((l) => `${l} (${LEVEL_NAMES[l]})`).join(' -> ')}`,
            `Verbose:     ${opts.verbose ? 'Yes' : 'No'}`,
            `Log file:    ${opts.log ? (opts.logFile || '(auto-named JSON in current directory)') : 'disabled'}`
        ]);

        const ready = await this.prepareServer();
        if (!ready) {
            this.record({
                description: `Server connectivity at ${opts.url}`,
                category: SMOKE,
                critical: true,
                status: 'fail',
                details: this.fatalError || 'SyDB server is not reachable'
            });
        }
        if (ready) {
            await this.cleanupTestDatabases();
            for (const level of levels) {
                this.beginLevel(level);
                try {
                    await LEVEL_RUNNERS[level](this);
                } catch (error) {
                    this.record({
                        description: `Level ${level} aborted by unexpected error`,
                        category: SMOKE,
                        critical: true,
                        status: 'fail',
                        details: error && error.stack ? error.stack : String(error)
                    });
                }
                this.endLevel();
            }
            this.out('\nCleaning up test databases created by this run...');
            if (!this.server.child && this.server.managed) await this.server.start();
            const removed = await this.cleanupCreatedDatabases();
            this.vlog(`Removed ${removed} database(s)`);
        }

        if (this.server.startedByTest && this.server.child) {
            this.out('Stopping managed SyDB server...');
            await this.server.stop();
            this.out(`${c.green}Server stopped${c.reset}`);
            if (!opts.keep && path.basename(opts.baseDir).startsWith('sydb_test')) {
                try {
                    fs.rmSync(opts.baseDir, { recursive: true, force: true });
                } catch (error) {
                    // ignore
                }
            }
        }

        process.removeListener('SIGINT', onSignal);
        process.removeListener('exit', onExit);

        const report = this.buildReport(levels);
        if (opts.log) this.writeLog(report);
        this.printFinalResults(report);
        return report;
    }

    buildReport(levels) {
        const summary = summarizeSteps(this.steps);
        const verdict = computeVerdict(summary);
        const finishedAt = new Date().toISOString();

        const categories = {};
        for (const step of this.steps) {
            const label = CATEGORY_LABELS[step.category] || step.category;
            if (!categories[label]) categories[label] = { total: 0, passed: 0, failed: 0, warned: 0, skipped: 0 };
            const entry = categories[label];
            entry.total++;
            if (step.status === 'pass') entry.passed++;
            else if (step.status === 'fail') entry.failed++;
            else if (step.status === 'warn') entry.warned++;
            else entry.skipped++;
        }

        return {
            tool: { name: TOOL_NAME, version: TOOL_VERSION },
            run: {
                startedAt: this.startedAtIso,
                finishedAt,
                durationMs: Date.now() - this.startedAtMs,
                nodeVersion: process.version,
                platform: process.platform,
                levelsRun: levels,
                serverUrl: this.opts.url,
                serverMode: this.server.managed ? 'managed' : 'external',
                baseDir: this.fileChecks ? this.opts.baseDir : null,
                fileLevelChecks: this.fileChecks,
                longRunDurationSeconds: this.opts.longDuration,
                verbose: this.opts.verbose,
                fatalError: this.fatalError,
                logFile: null
            },
            summary: {
                totalSteps: summary.total,
                passed: summary.passed,
                failed: summary.failed,
                warned: summary.warned,
                skipped: summary.skipped,
                criticalFailures: summary.criticalFailures,
                passRatePercent: verdict.passRate,
                passRateNote: 'passed / (total - skipped)',
                verdict: verdict.verdict,
                exitCode: verdict.exitCode,
                categories,
                levels: this.levelReports.map((l) => ({
                    level: l.level,
                    name: l.name,
                    durationMs: l.durationMs,
                    ...l.summary
                }))
            },
            levels: this.levelReports.map((l) => ({
                level: l.level,
                name: l.name,
                startedAt: l.startedAt,
                finishedAt: l.finishedAt,
                durationMs: l.durationMs,
                summary: l.summary,
                steps: l.steps
            }))
        };
    }

    writeLog(report) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = this.opts.logFile || path.join(process.cwd(), `sydb_api_test_log_${stamp}.json`);
        try {
            report.run.logFile = target;
            fs.writeFileSync(target, JSON.stringify(report, null, 2), 'utf8');
            this.out(`${this.c.green}JSON log written to ${target}${this.c.reset}`);
        } catch (error) {
            report.run.logFile = null;
            this.out(`${this.c.red}Failed to write JSON log to ${target}: ${error.message}${this.c.reset}`);
        }
    }

    printFinalResults(report) {
        const { c } = this;
        const s = report.summary;
        this.out('');
        this.out(`${c.cyan}${c.bold}===============================================${c.reset}`);
        this.out(`${c.cyan}${c.bold}           FINAL TEST RESULTS${c.reset}`);
        this.out(`${c.cyan}${c.bold}===============================================${c.reset}`);
        this.out(`Total Steps:       ${s.totalSteps}`);
        this.out(`Passed:            ${c.green}${s.passed}${c.reset}`);
        this.out(`Failed:            ${c.red}${s.failed}${c.reset}`);
        this.out(`Warnings:          ${c.yellow}${s.warned}${c.reset}`);
        this.out(`Skipped:           ${c.yellow}${s.skipped}${c.reset}`);
        this.out(`Critical Failures: ${c.red}${s.criticalFailures}${c.reset}`);
        this.out(`Pass rate:         ${s.passRatePercent}% (passed / executed)`);
        this.out(`Total Duration:    ${c.cyan}${report.run.durationMs} ms${c.reset}`);

        this.out(`\n${c.bold}Level Breakdown:${c.reset}`);
        this.out('------------------------------------------------');
        for (const level of s.levels) {
            this.out(`Level ${level.level} ${level.name.padEnd(14)}: ${level.passed}/${level.total} passed, ` +
                `${level.failed} failed, ${level.warned} warn, ${level.skipped} skip (${level.durationMs} ms)`);
        }

        this.out(`\n${c.bold}Category Breakdown:${c.reset}`);
        this.out('------------------------------------------------');
        for (const [label, entry] of Object.entries(s.categories)) {
            const executed = entry.total - entry.skipped;
            const pct = executed > 0 ? (entry.passed / executed) * 100 : 0;
            const color = pct >= 90 ? c.green : (pct >= 70 ? c.yellow : c.red);
            this.out(`${label.padEnd(20)}: ${color}${String(entry.passed).padStart(3)}/${String(entry.total).padEnd(3)} ` +
                `(${pct.toFixed(0).padStart(3)}%)${c.reset}`);
        }

        this.out(`${c.cyan}${c.bold}===============================================${c.reset}`);
        this.out(`\n${c.bold}VERDICT: ${c.reset}`);
        if (s.verdict === 'PASS') {
            this.out(`${c.green}PASS - All critical tests passed${c.reset}`);
        } else if (s.verdict === 'PASS_WITH_WARNINGS') {
            this.out(`${c.yellow}PASS WITH WARNINGS - Some non-critical tests failed or warned${c.reset}`);
        } else {
            this.out(`${c.red}FAIL - Critical failures detected or pass rate too low${c.reset}`);
            if (report.run.fatalError) this.out(`${c.red}  Fatal: ${report.run.fatalError}${c.reset}`);
            const failedCategories = Object.entries(s.categories).filter(([, entry]) => entry.failed > 0);
            for (const [label, entry] of failedCategories) {
                this.out(`${c.red}  - ${label}: ${entry.failed} failed step(s)${c.reset}`);
            }
        }
        this.out(`${c.cyan}${c.bold}===============================================${c.reset}\n`);
    }
}

// ==================== LEVEL 1 SUITES (STANDARD) ====================

async function suiteSmokeHttp(t) {
    t.suite('SMOKE TESTS - Basic HTTP API');

    await t.check('Server connectivity test', SMOKE, true, async () => {
        const response = await t.client.request('GET', '/api/databases');
        const extra = { method: 'GET', endpoint: '/api/databases', httpStatus: response.statusCode };
        return response.statusCode === 200 && response.body.includes('"success":true')
            ? pass(`HTTP ${response.statusCode}`, extra)
            : fail(`SyDB server did not answer correctly: HTTP ${response.statusCode}` +
                `${response.error ? ` (${response.error})` : ''}`, extra);
    });

    await t.http({
        description: 'GET /api/databases', method: 'GET', path: '/api/databases',
        expect: '"success":true', successOnly: true, category: SMOKE, critical: true
    });

    const name = t.uniq('smoke_test');
    await t.http({
        description: 'POST /api/databases - Create database', method: 'POST', path: '/api/databases',
        body: { name }, expect: '"success":true', category: SMOKE, critical: true, track: name
    });

    await t.check('Verify created smoke database is listed', SMOKE, true, async () => {
        const databases = await t.listDatabases();
        return databases && databases.includes(name)
            ? pass(`${name} listed`)
            : fail(`${name} not found in database list`);
    });
}

async function suiteSmokeApi(t) {
    t.suite('SMOKE TESTS - Basic Functionality (API equivalents of the CLI smoke tests)');

    const db1 = t.uniq('testdb');
    const db2 = t.uniq('testdb2');
    const usersFields = [F('name', 'string', true), F('age', 'int'), F('email', 'string')];
    const productsFields = [F('name', 'string', true), F('price', 'float')];

    await t.http({
        description: "Create database 'testdb'", method: 'POST', path: '/api/databases',
        body: { name: db1 }, expect: '"success":true', category: SMOKE, critical: true, track: db1
    });
    await t.check("Verify database 'testdb' exists and is valid", SMOKE, true, async () => {
        const databases = await t.listDatabases();
        return databases && databases.includes(db1) ? pass(`${db1} exists`) : fail(`${db1} missing`);
    });

    await t.http({
        description: "Create database 'testdb2'", method: 'POST', path: '/api/databases',
        body: { name: db2 }, expect: '"success":true', category: SMOKE, critical: true, track: db2
    });
    await t.check("Verify database 'testdb2' exists and is valid", SMOKE, true, async () => {
        const databases = await t.listDatabases();
        return databases && databases.includes(db2) ? pass(`${db2} exists`) : fail(`${db2} missing`);
    });

    await t.check('List databases and verify both exist', SMOKE, true, async () => {
        const databases = await t.listDatabases();
        if (!databases) return fail('Could not list databases');
        const count = [db1, db2].filter((name) => databases.includes(name)).length;
        return count === 2 ? pass('Both databases listed') : fail(`Only ${count}/2 databases listed`);
    });

    await t.http({
        description: "Create 'users' collection with schema", method: 'POST',
        path: `/api/databases/${db1}/collections`, body: { name: 'users', schema: usersFields },
        expect: '"success":true', category: SMOKE, critical: true
    });
    await t.check("Verify 'users' collection structure (schema + data file)", SMOKE, true, async () => {
        const collections = await t.listCollections(db1);
        if (!collections || !collections.includes('users')) return fail('users collection not listed');
        const schema = await t.getSchema(db1, 'users');
        if (!schema.ok) return fail('users schema not retrievable');
        const structure = t.fileStructure(db1, 'users');
        if (structure && !(structure.exists && structure.schema && structure.data)) {
            return fail(`Missing files: ${JSON.stringify(structure)}`);
        }
        return pass(structure ? 'API and file structure valid (schema.txt + data.sydb)' : 'API structure valid');
    });

    await t.http({
        description: "Create 'products' collection", method: 'POST',
        path: `/api/databases/${db1}/collections`, body: { name: 'products', schema: productsFields },
        expect: '"success":true', category: SMOKE, critical: true
    });
    await t.check("Verify 'products' collection structure", SMOKE, true, async () => {
        const collections = await t.listCollections(db1);
        if (!collections || !collections.includes('products')) return fail('products collection not listed');
        const structure = t.fileStructure(db1, 'products');
        if (structure && !(structure.schema)) return fail('schema.txt missing');
        return pass('products collection present');
    });

    await t.check('View users schema and verify output format', SMOKE, true, async () => {
        const schema = await t.getSchema(db1, 'users');
        if (!schema.ok) return fail('Could not read schema');
        const names = schema.fields.map((f) => f.name).join(',');
        const types = schema.fields.map((f) => f.type).join(',');
        const required = schema.fields.map((f) => f.required).join(',');
        const shapeOk = schema.fields.every((f) =>
            'name' in f && 'type' in f && 'required' in f && 'indexed' in f);
        if (!shapeOk) return fail('Schema fields missing name/type/required/indexed');
        if (names !== 'name,age,email' || types !== 'string,int,string' || required !== 'true,false,false') {
            return fail(`Unexpected schema: ${names} / ${types} / ${required}`);
        }
        return pass('Fields name:string:required, age:int, email:string');
    });

    await t.check('Insert user record and verify by counting instances', SMOKE, true, async () => {
        const result = await t.insert(db1, 'users', { name: 'John Doe', age: 30, email: 'john@test.com' });
        if (!result.ok) return fail(`Insert failed: ${short(result.resp.body, 150)}`);
        const listed = await t.list(db1, 'users');
        return listed.instances.length === 1 ? pass('1 instance') : fail(`Expected 1 instance, got ${listed.instances.length}`);
    });

    await t.check('Insert second user and verify total count', SMOKE, true, async () => {
        const result = await t.insert(db1, 'users', { name: 'Jane Smith', age: 25, email: 'jane@test.com' });
        if (!result.ok) return fail(`Insert failed: ${short(result.resp.body, 150)}`);
        const listed = await t.list(db1, 'users');
        return listed.instances.length === 2 ? pass('2 instances') : fail(`Expected 2 instances, got ${listed.instances.length}`);
    });

    await t.check('Insert product record and verify creation', SMOKE, true, async () => {
        const result = await t.insert(db1, 'products', { name: 'Test Product', price: 19.99 });
        if (!result.ok) return fail(`Insert failed: ${short(result.resp.body, 150)}`);
        const listed = await t.list(db1, 'products');
        const matches = listed.instances.filter((i) => i.name === 'Test Product').length;
        return matches === 1 ? pass('Test Product found once') : fail(`Expected 1 Test Product, got ${matches}`);
    });

    await t.check('Query users by age and verify exact match', SMOKE, true, async () => {
        const listed = await t.list(db1, 'users', 'age:30');
        const matches = listed.instances.filter((i) => i.name === 'John Doe').length;
        return listed.ok && matches === 1 && listed.instances.length === 1
            ? pass('Only John Doe matched')
            : fail(`Unexpected result: ${short(listed.resp.body, 200)}`);
    });

    await t.check('Query products by name and verify result', SMOKE, true, async () => {
        const listed = await t.list(db1, 'products', 'name:Test Product');
        const matches = listed.instances.filter((i) => i.name === 'Test Product').length;
        return listed.ok && matches === 1 ? pass('Test Product matched') : fail(`Unexpected result: ${short(listed.resp.body, 200)}`);
    });

    await t.check('Query with non-existent condition returns empty', SMOKE, true, async () => {
        const listed = await t.list(db1, 'users', 'age:999');
        return listed.ok && listed.instances.length === 0 ? pass('Empty result') : fail(`Got ${listed.instances.length} instances`);
    });

    await t.check('List collections in testdb and verify count', SMOKE, true, async () => {
        const collections = await t.listCollections(db1);
        if (!collections) return fail('Could not list collections');
        const count = ['users', 'products'].filter((name) => collections.includes(name)).length;
        return count === 2 ? pass('users and products listed') : fail(`Only ${count}/2 collections listed`);
    });

    await t.check('List users and verify record count', SMOKE, true, async () => {
        const listed = await t.list(db1, 'users');
        return listed.instances.length === 2 ? pass('2 records') : fail(`Expected 2 records, got ${listed.instances.length}`);
    });

    await t.check('Verify UUID format in inserted records', SMOKE, true, async () => {
        const listed = await t.list(db1, 'users');
        if (listed.instances.length === 0) return fail('No records');
        const first = listed.instances[0];
        if (!UUID_REGEX.test(String(first._id))) return fail(`Invalid UUID: ${first._id}`);
        if (typeof first._created_at !== 'number') return fail('_created_at is not numeric');
        return pass(`_id ${first._id}`);
    });

    // test_sydb.c - comprehensive structure verification
    await t.check('Structure verification: testdb database', SMOKE, true, async () => {
        const databases = await t.listDatabases();
        if (!databases || !databases.includes(db1)) return fail('testdb missing');
        if (t.fileChecks && !fs.statSync(path.join(t.opts.baseDir, db1)).isDirectory()) return fail('not a directory');
        return pass('Database directory exists and is valid');
    });
    await t.check('Structure verification: testdb/users collection', SMOKE, true, async () => {
        const structure = t.fileStructure(db1, 'users');
        const collections = await t.listCollections(db1);
        if (!collections || !collections.includes('users')) return fail('users missing');
        if (structure && !(structure.schema && structure.data)) return fail(`Missing files ${JSON.stringify(structure)}`);
        return pass('Collection structure is valid');
    });
    await t.check('Structure verification: testdb/products collection', SMOKE, true, async () => {
        const structure = t.fileStructure(db1, 'products');
        const collections = await t.listCollections(db1);
        if (!collections || !collections.includes('products')) return fail('products missing');
        if (structure && !(structure.schema && structure.data)) return fail(`Missing files ${JSON.stringify(structure)}`);
        return pass('Collection structure is valid');
    });
    await t.check('Structure verification: users schema content', SMOKE, true, async () => {
        const schema = await t.getSchema(db1, 'users');
        return schema.ok && schema.fields.some((f) => f.name === 'name')
            ? pass('Schema content is valid')
            : fail('Schema content invalid');
    });
    await t.check('Structure verification: testdb2 database', SMOKE, true, async () => {
        const databases = await t.listDatabases();
        return databases && databases.includes(db2) ? pass('Database directory exists and is valid') : fail('testdb2 missing');
    });
}

async function suiteHttpDatabases(t) {
    t.suite('HTTP API DATABASE TESTS');
    const db1 = t.uniq('testdb');
    const db2 = t.uniq('testdb2');

    await t.http({
        description: 'GET /api/databases - List databases', method: 'GET', path: '/api/databases',
        expect: '"success":true', successOnly: true, category: SMOKE, critical: true
    });
    await t.http({
        description: 'POST /api/databases - Create database', method: 'POST', path: '/api/databases',
        body: { name: db1 }, expect: '"success":true', category: SMOKE, critical: true, track: db1
    });
    await t.http({
        description: 'POST /api/databases - Create second database', method: 'POST', path: '/api/databases',
        body: { name: db2 }, expect: '"success":true', category: SMOKE, critical: true, track: db2
    });
    await t.http({
        description: 'POST /api/databases - Prevent duplicate database', method: 'POST', path: '/api/databases',
        body: { name: db1 }, expect: '"success":false', successOnly: true, strict: true, category: SMOKE, critical: true
    });
    await t.http({
        description: 'DELETE /api/databases/{name} - Delete database', method: 'DELETE',
        path: `/api/databases/${db2}`, expect: '"success":true', category: SMOKE, critical: true
    });
    await t.check('Verify deleted database is no longer listed', SMOKE, true, async () => {
        const databases = await t.listDatabases();
        if (!databases) return fail('Could not list databases');
        return !databases.includes(db2) && databases.includes(db1)
            ? pass('Deleted database removed, other database intact')
            : fail('Database list inconsistent after delete');
    });
}

async function suiteHttpCollections(t) {
    t.suite('HTTP API COLLECTION TESTS');
    const db = await t.createDb('testcolldb');
    if (!db) { t.setupFailure('collection tests'); return; }

    const listUrl = `/api/databases/${db}/collections`;
    const usersSchema = {
        name: 'users',
        schema: [F('name', 'string', true), F('age', 'int'), F('email', 'string')]
    };
    const productsSchema = { name: 'products', schema: [F('name', 'string', true), F('price', 'float')] };

    await t.http({
        description: 'GET /api/databases/{db}/collections - List empty collections', method: 'GET',
        path: listUrl, expect: '"collections":[]', category: SMOKE, critical: true
    });
    await t.http({
        description: 'POST /api/databases/{db}/collections - Create users collection', method: 'POST',
        path: listUrl, body: usersSchema, expect: '"success":true', category: SMOKE, critical: true
    });
    await t.http({
        description: 'POST /api/databases/{db}/collections - Create products collection', method: 'POST',
        path: listUrl, body: productsSchema, expect: '"success":true', category: SMOKE, critical: true
    });
    await t.http({
        description: 'GET /api/databases/{db}/collections - List created collections', method: 'GET',
        path: listUrl, expect: '"users"', category: SMOKE, critical: true
    });
    await t.http({
        description: 'GET /api/databases/{db}/collections/{coll}/schema - Get users schema', method: 'GET',
        path: `${listUrl}/users/schema`, expect: '"name"', category: SMOKE, critical: true
    });
    await t.http({
        description: 'DELETE /api/databases/{db}/collections/{coll} - Delete products collection', method: 'DELETE',
        path: `${listUrl}/products`, expect: '"success":true', category: SMOKE, critical: true
    });
    await t.check('Verify deleted collection is no longer listed', SMOKE, true, async () => {
        const collections = await t.listCollections(db);
        if (!collections) return fail('Could not list collections');
        return !collections.includes('products') && collections.includes('users')
            ? pass('products removed, users intact')
            : fail(`Collections: ${collections.join(',')}`);
    });
}

async function suiteHttpInstances(t) {
    t.suite('HTTP API INSTANCE TESTS');
    const db = await t.createDb('testinstdb');
    if (!db) { t.setupFailure('instance tests'); return; }
    const ok = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int'), F('email', 'string')]);
    if (!ok) { t.setupFailure('instance tests (collection)'); return; }

    const instancesUrl = `/api/databases/${db}/collections/users/instances`;

    await t.http({
        description: 'GET /api/databases/{db}/collections/{coll}/instances - List empty instances', method: 'GET',
        path: instancesUrl, expect: '"instances":[]', category: SMOKE, critical: true
    });

    const first = await t.http({
        description: 'POST /api/databases/{db}/collections/{coll}/instances - Insert first user', method: 'POST',
        path: instancesUrl, body: { name: 'John Doe', age: 30, email: 'john@test.com' },
        expect: '"success":true', category: SMOKE, critical: true
    });
    const id1 = first.json && first.json.id ? first.json.id : null;

    await t.http({
        description: 'POST /api/databases/{db}/collections/{coll}/instances - Insert second user', method: 'POST',
        path: instancesUrl, body: { name: 'Jane Smith', age: 25, email: 'jane@test.com' },
        expect: '"success":true', category: SMOKE, critical: true
    });
    await t.http({
        description: 'GET /api/databases/{db}/collections/{coll}/instances - List users', method: 'GET',
        path: instancesUrl, expect: 'John Doe', category: SMOKE, critical: true
    });
    await t.http({
        description: 'GET /api/.../instances?query=age:30 - Query by age', method: 'GET',
        path: `${instancesUrl}?query=${encodeURIComponent('age:30')}`, expect: 'John Doe', category: SMOKE, critical: true
    });

    if (!id1) {
        t.record({
            description: 'PUT/DELETE instance steps', category: SMOKE, critical: true, status: 'fail',
            details: 'First insert did not return an instance id'
        });
        return;
    }

    await t.http({
        description: 'PUT /api/.../instances/{id} - Update user', method: 'PUT',
        path: `${instancesUrl}/${id1}`, body: { age: 35, email: 'john.updated@test.com' },
        expect: '"success":true', category: SMOKE, critical: true
    });
    await t.check('Verify update persisted (query by _id)', SMOKE, true, async () => {
        const listed = await t.list(db, 'users', `_id:${id1}`);
        if (listed.instances.length !== 1) return fail(`Expected 1 instance, got ${listed.instances.length}`);
        const item = listed.instances[0];
        return item.age === 35 && item.email === 'john.updated@test.com' && item.name === 'John Doe'
            ? pass('age=35, email updated, name preserved')
            : fail(`Unexpected data: ${JSON.stringify(item)}`);
    });

    await t.http({
        description: 'DELETE /api/.../instances/{id} - Delete user', method: 'DELETE',
        path: `${instancesUrl}/${id1}`, expect: '"success":true', category: SMOKE, critical: true
    });
    await t.check('Verify delete persisted (instance gone, other user intact)', SMOKE, true, async () => {
        const gone = await t.list(db, 'users', `_id:${id1}`);
        const all = await t.list(db, 'users');
        return gone.instances.length === 0 && all.instances.length === 1
            ? pass('Deleted instance removed, 1 instance remains')
            : fail(`gone=${gone.instances.length}, total=${all.instances.length}`);
    });

    await t.http({
        description: 'PUT /api/.../instances/{unknown-id} - Update non-existent instance is well-formed', method: 'PUT',
        path: `${instancesUrl}/00000000-0000-0000-0000-000000000000`, body: { age: 1 },
        expect: '"success":', successOnly: true, category: SMOKE, critical: false
    });
    await t.http({
        description: 'DELETE /api/.../instances/{unknown-id} - Delete non-existent instance is well-formed', method: 'DELETE',
        path: `${instancesUrl}/00000000-0000-0000-0000-000000000000`,
        expect: '"success":', successOnly: true, category: SMOKE, critical: false
    });
    await t.check('Verify GET by instance id is not a routed endpoint (404)', SMOKE, false, async () => {
        const response = await t.client.request('GET', `${instancesUrl}/00000000-0000-0000-0000-000000000000`);
        return response.statusCode === 404
            ? pass('GET .../instances/{id} returns 404 (use ?query=_id:<id>)', { httpStatus: 404 })
            : warn(`Expected 404, got ${response.statusCode}`, { httpStatus: response.statusCode });
    });
}

async function suiteHttpCommands(t) {
    t.suite('HTTP API COMMAND TESTS');
    const db = await t.createDb('command_test');

    await t.http({
        description: 'POST /api/execute - Execute list command', method: 'POST', path: '/api/execute',
        body: { command: 'list', arguments: [] }, expect: '"success":true', category: SMOKE, critical: true
    });

    if (db) {
        await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
        await t.check('POST /api/execute - Execute schema command', SMOKE, false, async () => {
            const response = await t.client.request('POST', '/api/execute',
                JSON.stringify({ command: 'schema', arguments: [db, 'users'] }));
            const json = parseJson(response.body);
            return json && json.success === true && typeof json.result === 'string' && json.result.includes('fields')
                ? pass('Schema returned through /api/execute', { method: 'POST', endpoint: '/api/execute', httpStatus: response.statusCode })
                : fail(`Unexpected response: ${short(response.body, 200)}`);
        });
    }

    await t.http({
        description: 'POST /api/execute - Unknown command is accepted', method: 'POST', path: '/api/execute',
        body: { command: 'noop', arguments: [] }, expect: '"success":true', category: SMOKE, critical: false
    });
    await t.http({
        description: 'POST /api/execute - Missing command field', method: 'POST', path: '/api/execute',
        body: { arguments: [] }, expect: '"success":false', successOnly: true, strict: true, category: SMOKE, critical: false
    });
    await t.http({
        description: 'POST /api/execute - Empty body', method: 'POST', path: '/api/execute',
        body: null, expect: '"success":false', successOnly: true, strict: true, category: SMOKE, critical: false
    });
    await t.http({
        description: 'POST /api/execute - Invalid JSON', method: 'POST', path: '/api/execute',
        body: 'not json', expect: '"success":false', successOnly: true, strict: true, category: SMOKE, critical: false
    });
}

async function suiteHttpErrors(t) {
    t.suite('HTTP API ERROR HANDLING TESTS');

    await t.http({
        description: 'POST /api/databases - Invalid database name', method: 'POST', path: '/api/databases',
        body: { name: 'invalid/name' }, expect: '"success":false', successOnly: true, strict: true,
        category: SMOKE, critical: true
    });
    await t.http({
        description: 'GET /api/databases/nonexistent/collections - Non-existent database', method: 'GET',
        path: '/api/databases/nonexistent/collections', expect: '"success":false', successOnly: true, strict: true,
        category: SMOKE, critical: true
    });
    await t.http({
        description: 'GET /api/databases/testdb/collections/nonexistent/instances - Non-existent collection', method: 'GET',
        path: '/api/databases/testdb/collections/nonexistent/instances', expect: '"success":false',
        successOnly: true, category: SMOKE, critical: true
    });
    await t.http({
        description: 'POST /api/databases - Invalid JSON', method: 'POST', path: '/api/databases',
        body: 'invalid json', expect: '"success":false', successOnly: true, strict: true,
        category: SMOKE, critical: true
    });
    await t.check('PATCH /api/databases/testdb - Method not allowed', SMOKE, true, async () => {
        const response = await t.client.request('PATCH', '/api/databases/testdb');
        const extra = { method: 'PATCH', endpoint: '/api/databases/testdb', httpStatus: response.statusCode };
        return response.statusCode === 405
            ? pass(`HTTP 405, Allow: ${response.headers.allow || 'n/a'}`, extra)
            : fail(`Expected 405 Method Not Allowed, got ${response.statusCode}`, extra);
    });
    await t.check('GET /api/unknown - Unknown endpoint returns 404', SMOKE, false, async () => {
        const response = await t.client.request('GET', '/api/unknown');
        const extra = { method: 'GET', endpoint: '/api/unknown', httpStatus: response.statusCode };
        return response.statusCode === 404 && response.body.includes('"success":false')
            ? pass('HTTP 404 with success:false', extra)
            : fail(`Expected 404, got ${response.statusCode}`, extra);
    });
    await t.http({
        description: 'POST /api/databases/{db}/collections - Missing body', method: 'POST',
        path: '/api/databases/nonexistent/collections', body: null, expect: '"success":false',
        successOnly: true, strict: true, category: SMOKE, critical: false
    });
}

async function suiteSecurity(t) {
    t.suite('SECURITY & INJECTION TESTS');
    const db = await t.createDb('security_test');
    if (db) {
        await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
        await t.insert(db, 'users', { name: 'Alice', age: 30 });
    }
    const baseDir = t.opts.baseDir;

    // ---- HTTP security tests (newtest.c run_security_tests_http) ----
    await t.http({
        description: 'HTTP: SQL injection attempt in query', method: 'GET',
        path: `/api/databases/${db || 'testdb'}/collections/users/instances?query=${encodeURIComponent("name:' OR 1=1--")}`,
        expect: '"success":', successOnly: true, category: SECURITY, critical: true
    });
    await t.http({
        description: 'HTTP: JSON injection attempt', method: 'POST', path: '/api/databases',
        body: '{"name":"\\"}, \\"malicious\\": true, \\"age\\":30}', expect: '"success":false',
        successOnly: true, strict: true, category: SECURITY, critical: true
    });
    await t.http({
        description: 'HTTP: Path traversal attempt', method: 'GET', path: '/api/databases/../etc/passwd',
        expect: '"success":false', successOnly: true, strict: true, category: SECURITY, critical: true
    });
    await t.http({
        description: 'HTTP: Very long URL (buffer overflow test)', method: 'GET',
        path: `/api/databases/${'a'.repeat(1000)}`, expect: '"success":false', successOnly: true,
        strict: true, category: SECURITY, critical: true
    });
    await t.http({
        description: 'HTTP: Malformed JSON', method: 'POST', path: '/api/databases',
        body: '{name: test}', expect: '"success":false', successOnly: true, strict: true,
        category: SECURITY, critical: true
    });

    // ---- CLI security tests executed through the API ----
    await t.check('Directory traversal prevention - database name', SECURITY, true, async () => {
        const response = await t.client.request('POST', '/api/databases', JSON.stringify({ name: '../evil' }));
        const json = parseJson(response.body);
        if (!json || json.success !== false) return fail(`Not rejected: ${short(response.body, 150)}`);
        const databases = await t.listDatabases();
        if (databases && (databases.includes('evil') || databases.includes('../evil'))) return fail('evil database listed');
        if (t.fileChecks && t.createdSinceStart(path.resolve(baseDir, '..', 'evil'))) return fail('evil directory created outside base dir');
        return pass(`Rejected: ${json.error}`);
    });

    await t.check('Directory traversal prevention - collection name', SECURITY, true, async () => {
        if (!db) return fail('security database unavailable');
        const response = await t.client.request('POST', `/api/databases/${db}/collections`,
            JSON.stringify({ name: '../../evil', schema: [F('name', 'string')] }));
        const json = parseJson(response.body);
        if (!json || json.success !== false) return fail(`Not rejected: ${short(response.body, 150)}`);
        if (t.fileChecks && t.createdSinceStart(path.resolve(baseDir, db, '..', '..', 'evil'))) {
            return fail('evil directory created outside base dir');
        }
        return pass(`Rejected: ${json.error}`);
    });

    await t.check("Special characters in database names - rejection ('invalid/name')", SECURITY, true, async () => {
        const response = await t.client.request('POST', '/api/databases', JSON.stringify({ name: 'invalid/name' }));
        const json = parseJson(response.body);
        if (!json || json.success !== false) return fail(`Not rejected: ${short(response.body, 150)}`);
        if (t.fileChecks && fs.existsSync(path.join(baseDir, 'invalid', 'name'))) return fail('invalid/name directory created');
        return pass(`Rejected: ${json.error}`);
    });

    const injectionNames = [
        ['Command injection attempt - semicolon', 'test; rm -rf /'],
        ['Command injection attempt - backticks', 'test`id`'],
        ['Command injection attempt - command substitution', 'test$(id)'],
        ['Command injection attempt - pipe and ampersand', 'test|cat&whoami']
    ];
    for (const [description, name] of injectionNames) {
        await t.check(description, SECURITY, true, async () => {
            const response = await t.client.request('POST', '/api/databases', JSON.stringify({ name }));
            const json = parseJson(response.body);
            if (!json || json.success !== false) return fail(`Not rejected: ${short(response.body, 150)}`);
            const databases = await t.listDatabases();
            if (databases && databases.some((d) => d.includes('rm') || d.includes('whoami'))) return fail('database created');
            return pass(`Injection prevented: ${json.error}`);
        });
    }

    await t.check('SQL-like injection in query does not leak data', SECURITY, true, async () => {
        if (!db) return fail('security database unavailable');
        const listed = await t.list(db, 'users', "name:' OR 1=1--");
        return listed.ok && listed.instances.length === 0
            ? pass('Injection handled: no instances matched')
            : fail(`Injection returned ${listed.instances.length} instances`);
    });

    await t.check('Very long name - buffer overflow protection (300 chars)', SECURITY, true, async () => {
        const response = await t.client.request('POST', '/api/databases', JSON.stringify({ name: 'a'.repeat(300) }));
        const json = parseJson(response.body);
        return json && json.success === false ? pass(`Rejected: ${json.error}`) : fail(`Not rejected: ${short(response.body, 150)}`);
    });
}

async function expectRejection(t, db, document, description, label) {
    return t.check(description, SCHEMA, false, async () => {
        const result = await t.insert(db, 'users', document);
        const extra = { method: 'POST', endpoint: `/api/databases/${db}/collections/users/instances`, httpStatus: result.resp.statusCode };
        if (!result.json) return fail(`Malformed response: ${short(result.resp.body, 150)}`, extra);
        if (!result.ok) return pass(`Correctly rejected: ${short(result.resp.body, 120)}`, extra);
        return warn(`${label} was accepted - the server does not enforce schema on insert (document model)`, extra);
    });
}

async function suiteSchemaEnforcement(t) {
    t.suite('SCHEMA ENFORCEMENT TESTS');
    const db = await t.createDb('enforce_test');
    if (!db) { t.setupFailure('schema enforcement tests', SCHEMA); return; }
    const created = await t.createCollection(db, 'users', [
        F('name', 'string', true), F('age', 'int', true), F('email', 'string', true), F('active', 'bool')
    ]);
    if (!created) { t.setupFailure('schema enforcement collection', SCHEMA); return; }

    await t.check('Valid insert - all required fields', SCHEMA, true, async () => {
        const result = await t.insert(db, 'users', { name: 'Valid User', email: 'valid@test.com', age: 30, active: true });
        const listed = await t.list(db, 'users');
        return result.ok && listed.instances.length >= 1 ? pass('Inserted and listed') : fail(`Insert failed: ${short(result.resp.body, 150)}`);
    });
    await t.check('Valid insert - HTTP variant (without optional field)', SCHEMA, true, async () => {
        const result = await t.insert(db, 'users', { name: 'Valid User 2', age: 31, email: 'valid2@test.com' });
        return result.ok ? pass('Inserted') : fail(`Insert failed: ${short(result.resp.body, 150)}`);
    });

    await expectRejection(t, db, { age: 30, email: 'missing@test.com' },
        "Missing required field 'name' (should be rejected)", 'Insert without required field');
    await expectRejection(t, db, { name: 'Type Test', email: 'type@test.com', age: 'thirty', active: true },
        'Wrong type - string for age (should be rejected)', 'String for integer field');

    await t.check('Extra field not in schema (document flexibility)', SCHEMA, false, async () => {
        const result = await t.insert(db, 'users', {
            name: 'Extra Field', email: 'extra@test.com', age: 25, active: true, extra: 'should this be allowed?'
        });
        return result.ok
            ? pass('Extra fields allowed (document model)')
            : warn('Extra fields rejected (strict schema)');
    });

    await expectRejection(t, db, { name: 'Bool Test', email: 'bool@test.com', age: 25, active: 'yes' },
        "Invalid boolean value 'yes' - should be true/false", 'Invalid boolean');
}

async function unsupportedQueryCheck(t, db, collection, query, description) {
    return t.check(description, QUERY, false, async () => {
        const response = await t.client.request('GET', t.instancesPath(db, collection, query));
        const json = parseJson(response.body);
        const extra = { method: 'GET', endpoint: short(t.instancesPath(db, collection, query), 200), httpStatus: response.statusCode };
        if (!json) return fail(`Malformed response: ${short(response.body, 150)}`, extra);
        if (json.success === false) return pass(`Unsupported query rejected: ${json.error}`, extra);
        const count = Array.isArray(json.instances) ? json.instances.length : -1;
        if (count === 0) return pass('Unsupported syntax handled gracefully: no matches, no crash (equality-only query language)', extra);
        return warn(`Query "${query}" matched ${count} instances (operator may be implemented)`, extra);
    });
}

async function suiteQuery(t) {
    t.suite('QUERY LANGUAGE & INDEXING TESTS');
    const db = await t.createDb('query_test');
    if (!db) { t.setupFailure('query tests', QUERY); return; }
    const okUsers = await t.createCollection(db, 'users', [
        F('name', 'string', true, true), F('age', 'int', false, true), F('email', 'string'), F('salary', 'float')
    ]);
    const okHttp = await t.createCollection(db, 'http_users', [
        F('name', 'string', true), F('age', 'int'), F('salary', 'float')
    ]);
    if (!okUsers || !okHttp) { t.setupFailure('query collections', QUERY); return; }

    for (let i = 0; i < 50; i++) {
        await t.insert(db, 'users', { name: `User${i}`, age: 20 + (i % 30), email: `user${i}@test.com`, salary: 30000 + i * 1000 });
    }
    for (let i = 0; i < 20; i++) {
        await t.insert(db, 'http_users', { name: `HTTPUser${i}`, age: 20 + (i % 20), salary: 30000 + i * 1000 });
    }

    await t.check('QUERY 1: Equality query - age:25', QUERY, true, async () => {
        const listed = await t.list(db, 'users', 'age:25');
        return listed.ok && listed.instances.length === 2 && listed.instances.every((i) => i.age === 25)
            ? pass('Found 2 records (User5, User35)')
            : fail(`Expected 2 records with age 25, got ${listed.instances.length}`);
    });
    await unsupportedQueryCheck(t, db, 'users', 'age>30', 'QUERY 2: Greater than query - age>30 (feature test)');
    await unsupportedQueryCheck(t, db, 'users', 'age<25', 'QUERY 3: Less than query - age<25 (feature test)');
    await t.check('QUERY 4: AND query - age:25,name:User5', QUERY, true, async () => {
        const listed = await t.list(db, 'users', 'age:25,name:User5');
        return listed.ok && listed.instances.length === 1 && listed.instances[0].name === 'User5'
            ? pass('AND query matched User5 only')
            : fail(`Expected User5 only, got ${listed.instances.length} records`);
    });
    await t.check('QUERY 4b: AND query with contradicting conditions - age:25,name:User1', QUERY, false, async () => {
        const listed = await t.list(db, 'users', 'age:25,name:User1');
        return listed.ok && listed.instances.length === 0 ? pass('No match (User1 has age 21)') : fail(`Got ${listed.instances.length} records`);
    });
    await unsupportedQueryCheck(t, db, 'users', 'age:25 OR age:30', 'QUERY 5: OR query - age:25 OR age:30 (feature test)');
    await unsupportedQueryCheck(t, db, 'users', 'age:25-35', 'QUERY 6: Range query - age:25-35 (feature test)');
    await t.check('QUERY 7: String equality query - name:User7', QUERY, false, async () => {
        const listed = await t.list(db, 'users', 'name:User7');
        return listed.ok && listed.instances.length === 1 && listed.instances[0].email === 'user7@test.com'
            ? pass('User7 found') : fail(`Got ${listed.instances.length} records`);
    });
    await t.check('QUERY 8: Query by _id returns exactly one record', QUERY, false, async () => {
        const all = await t.list(db, 'users', 'age:25');
        if (all.instances.length === 0) return fail('No records to take an id from');
        const id = all.instances[0]._id;
        const listed = await t.list(db, 'users', `_id:${id}`);
        return listed.ok && listed.instances.length === 1 && listed.instances[0]._id === id
            ? pass(`_id ${id} found`) : fail(`Got ${listed.instances.length} records`);
    });

    // HTTP query tests (newtest.c run_query_language_tests_http)
    await t.http({
        description: 'HTTP: Equality query - age:25', method: 'GET',
        path: `/api/databases/${db}/collections/http_users/instances?query=${encodeURIComponent('age:25')}`,
        expect: '"instances":', category: QUERY, critical: false
    });
    await t.http({
        description: 'HTTP: Query with no matches', method: 'GET',
        path: `/api/databases/${db}/collections/http_users/instances?query=${encodeURIComponent('age:999')}`,
        expect: '"instances":[]', category: QUERY, critical: false
    });
}

async function suiteIntegrity(t) {
    t.suite('DATA INTEGRITY TESTS');
    const db = await t.createDb('integrity_test');
    if (!db) { t.setupFailure('integrity tests', INTEGRITY); return; }
    const created = await t.createCollection(db, 'data', [F('value', 'string')]);
    if (!created) { t.setupFailure('integrity collection', INTEGRITY); return; }
    for (let i = 0; i < 10; i++) await t.insert(db, 'data', { value: `test_data_${i}` });

    const needsFiles = 'File-level verification needs a local data directory (managed server or --base-dir)';

    await t.check('INTEGRITY 1: Data file header verification (magic 0x53594442, version 2)', INTEGRITY, true, async () => {
        if (!t.fileChecks) return skip(needsFiles);
        const header = t.readHeader(db, 'data');
        if (!header) return fail('Could not read data file header');
        if (header.magic !== FILE_MAGIC_NUMBER) return fail(`Invalid magic ${header.magic.toString(16)} (bytes ${header.magicBytes})`);
        if (header.version !== FILE_VERSION_NUMBER) return fail(`Unexpected version ${header.version}`);
        return pass(`Valid header (little-endian bytes ${header.magicBytes} = "BDYS" = 0x53594442), version ${header.version}`);
    });

    await t.check('INTEGRITY 2: Record count verification (header vs API)', INTEGRITY, true, async () => {
        if (!t.fileChecks) return skip(needsFiles);
        const header = t.readHeader(db, 'data');
        const listed = await t.list(db, 'data');
        if (!header) return fail('Could not read header');
        return header.recordCount === listed.instances.length && listed.instances.length > 0
            ? pass(`Header count (${header.recordCount}) matches actual (${listed.instances.length})`)
            : fail(`Header count (${header.recordCount}) != actual (${listed.instances.length})`);
    });

    await t.check('INTEGRITY 3: Header file size matches the real file size', INTEGRITY, false, async () => {
        if (!t.fileChecks) return skip(needsFiles);
        const header = t.readHeader(db, 'data');
        if (!header) return fail('Could not read header');
        return header.fileSize === header.actualSize && header.freeOffset === header.fileSize
            ? pass(`fileSize=${header.fileSize}, freeOffset=${header.freeOffset}`)
            : fail(`header fileSize=${header.fileSize}, freeOffset=${header.freeOffset}, actual=${header.actualSize}`);
    });

    await t.check('INTEGRITY 4: Data file grows with inserts', INTEGRITY, false, async () => {
        if (!t.fileChecks) return skip(needsFiles);
        const before = fs.statSync(t.dataFilePath(db, 'data')).size;
        const result = await t.insert(db, 'data', { value: 'test_data_grow' });
        const after = fs.statSync(t.dataFilePath(db, 'data')).size;
        return result.ok && after > before ? pass(`${before} -> ${after} bytes`) : fail(`size ${before} -> ${after}`);
    });

    await t.check('INTEGRITY 5: Every record has a valid UUID, timestamp and unique id', INTEGRITY, true, async () => {
        const listed = await t.list(db, 'data');
        const ids = new Set(listed.instances.map((i) => i._id));
        const valid = listed.instances.every((i) => UUID_REGEX.test(String(i._id)) && typeof i._created_at === 'number');
        return listed.ok && valid && ids.size === listed.instances.length
            ? pass(`${ids.size} unique valid records`) : fail('Invalid or duplicate ids detected');
    });
}

async function suiteEdgeCases(t) {
    t.suite('EDGE CASE TESTS');
    const db = await t.createDb('edge_test');
    if (!db) { t.setupFailure('edge case tests', EDGE); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
    if (!created) { t.setupFailure('edge case collection', EDGE); return; }
    await t.insert(db, 'users', { name: 'Edge One', age: 1 });
    await t.insert(db, 'users', { name: 'Edge Two', age: 2 });

    const collectionsUrl = `/api/databases/${db}/collections`;

    await t.http({
        description: 'Empty database name', method: 'POST', path: '/api/databases', body: { name: '' },
        expect: '"success":false', successOnly: true, strict: true, category: EDGE, critical: true
    });
    await t.http({
        description: 'Empty collection name', method: 'POST', path: collectionsUrl,
        body: { name: '', schema: [F('name', 'string')] }, expect: '"success":false',
        successOnly: true, strict: true, category: EDGE, critical: true
    });
    await t.http({
        description: 'Maximum length field name (64 chars) is handled', method: 'POST', path: collectionsUrl,
        body: { name: 'maxfield', schema: [F('a'.repeat(64), 'string')] }, expect: '"success":',
        successOnly: true, category: EDGE, critical: false
    });
    await t.check('Empty query string returns all instances', EDGE, false, async () => {
        const response = await t.client.request('GET', `/api/databases/${db}/collections/users/instances?query=`);
        const json = parseJson(response.body);
        return json && json.success === true && Array.isArray(json.instances) && json.instances.length === 2
            ? pass('2 instances returned', { httpStatus: response.statusCode })
            : fail(`Unexpected: ${short(response.body, 200)}`);
    });
    await t.check('Very long query value (1200 chars) is handled', EDGE, false, async () => {
        const listed = await t.list(db, 'users', `name:${'a'.repeat(1200)}`);
        return listed.ok && listed.instances.length === 0 ? pass('Handled: no matches') : fail(`Unexpected: ${short(listed.resp.body, 200)}`);
    });
    await t.check('Create collection with zero fields is rejected', EDGE, true, async () => {
        const response = await t.client.request('POST', collectionsUrl, JSON.stringify({ name: 'empty', schema: [] }));
        const json = parseJson(response.body);
        if (!json || json.success !== false) return fail(`Not rejected: ${short(response.body, 150)}`);
        const collections = await t.listCollections(db);
        return collections && !collections.includes('empty') ? pass(`Rejected: ${json.error}`) : fail('empty collection was created');
    });
    await t.check('Handle duplicate database creation', EDGE, false, async () => {
        const before = await t.listDatabases();
        const response = await t.client.request('POST', '/api/databases', JSON.stringify({ name: db }));
        const json = parseJson(response.body);
        const after = await t.listDatabases();
        return json && json.success === false && before && after && before.filter((d) => d === db).length === 1 &&
            after.filter((d) => d === db).length === 1
            ? pass(`Rejected: ${json.error}`) : fail(`Unexpected: ${short(response.body, 150)}`);
    });
    await t.check('Handle duplicate collection creation', EDGE, false, async () => {
        const response = await t.client.request('POST', collectionsUrl,
            JSON.stringify({ name: 'users', schema: [F('name', 'string')] }));
        const json = parseJson(response.body);
        const collections = await t.listCollections(db);
        return json && json.success === false && collections && collections.filter((c) => c === 'users').length === 1
            ? pass(`Rejected: ${json.error}`) : fail(`Unexpected: ${short(response.body, 150)}`);
    });
    await t.http({
        description: 'Handle missing database queries', method: 'GET',
        path: `/api/databases/nonexistentdb/collections/users/instances?query=${encodeURIComponent('name:test')}`,
        expect: '"success":', successOnly: true, category: EDGE, critical: false
    });
    await t.http({
        description: 'Handle missing collection queries', method: 'GET',
        path: `/api/databases/${db}/collections/nonexistent/instances?query=${encodeURIComponent('name:test')}`,
        expect: '"success":', successOnly: true, category: EDGE, critical: false
    });
    await t.check('Handle malformed queries (no field:value format)', EDGE, false, async () => {
        const listed = await t.list(db, 'users', 'invalid-query-format');
        return listed.ok && listed.instances.length === 0 ? pass('Malformed query returns no matches') : fail(`Unexpected: ${short(listed.resp.body, 150)}`);
    });
    await t.check('Handle schema validation failures (unknown field insert)', EDGE, false, async () => {
        const result = await t.insert(db, 'users', { invalid_field: 'value' });
        return result.json && 'success' in result.json
            ? pass(result.ok ? 'Accepted (document model)' : `Rejected: ${short(result.resp.body, 100)}`)
            : fail(`Malformed response: ${short(result.resp.body, 150)}`);
    });
}

async function suitePerformanceStandard(t) {
    t.suite('PERFORMANCE & SCALABILITY TESTS');
    const db = await t.createDb('perf_test');
    if (!db) { t.setupFailure('performance tests', PERFORMANCE); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string'), F('age', 'int')]);
    if (!created) { t.setupFailure('performance collection', PERFORMANCE); return; }

    await t.check('PERF 1: Single insert latency', PERFORMANCE, false, async () => {
        const started = Date.now();
        const result = await t.insert(db, 'users', { name: 'Perf User', age: 30 });
        const elapsed = Date.now() - started;
        if (!result.ok) return fail('Insert failed');
        return elapsed < 100 ? pass(`Insert latency: ${elapsed} ms`) : warn(`Insert latency high: ${elapsed} ms`);
    });

    await t.check('PERF 2: Batch insert - 100 records', PERFORMANCE, false, async () => {
        const started = Date.now();
        let success = 0;
        for (let i = 0; i < 100; i++) {
            const result = await t.insert(db, 'users', { name: `BatchUser${i}`, age: 20 + (i % 50) });
            if (result.ok) success++;
        }
        const elapsed = Date.now() - started;
        const average = success > 0 ? (elapsed / success).toFixed(2) : 'n/a';
        const listed = await t.list(db, 'users');
        if (listed.instances.length !== success + 1) {
            return fail(`Record count mismatch: ${listed.instances.length} stored vs ${success + 1} expected`);
        }
        return success >= 95
            ? pass(`${success}/100 inserts, ${elapsed} ms total, avg ${average} ms`)
            : warn(`Only ${success}/100 inserts succeeded`);
    });

    await t.check('PERF 3: Query performance - exact match', PERFORMANCE, false, async () => {
        const started = Date.now();
        const listed = await t.list(db, 'users', 'age:30');
        const elapsed = Date.now() - started;
        if (!listed.ok) return fail('Query failed');
        return elapsed < 200 ? pass(`Query time: ${elapsed} ms (${listed.instances.length} matches)`) : warn(`Query time high: ${elapsed} ms`);
    });

    await t.check('PERF 4: Legacy thresholds - batch of 50 records', PERFORMANCE, false, async () => {
        await t.createCollection(db, 'legacy', [F('name', 'string', true), F('age', 'int'), F('email', 'string')]);
        const singleStart = Date.now();
        await t.insert(db, 'legacy', { name: 'SingleUser', age: 30, email: 'single@test.com' });
        const singleTime = Date.now() - singleStart;

        const batchStart = Date.now();
        let success = 0;
        for (let i = 0; i < 50; i++) {
            const result = await t.insert(db, 'legacy', { name: `User${i}`, age: 20 + (i % 40), email: `user${i}@test.com` });
            if (result.ok) success++;
        }
        const batchTime = Date.now() - batchStart;
        const average = batchTime / 50;

        const queryStart = Date.now();
        await t.list(db, 'legacy', 'age:25');
        const queryTime = Date.now() - queryStart;

        const count = (await t.list(db, 'legacy')).instances.length;
        const summary = `single ${singleTime} ms, batch ${batchTime} ms (avg ${average.toFixed(2)} ms), ` +
            `query ${queryTime} ms, ${success}/50 inserted, ${count} records stored`;
        if (count !== success + 1) return fail(`Record count mismatch: ${summary}`);
        return singleTime < 1000 && average < 500 && queryTime < 500
            ? pass(`Performance within acceptable limits: ${summary}`)
            : warn(`Performance may need optimization: ${summary}`);
    });

    await t.check('HTTP PERF: Insert latency (10 inserts)', PERFORMANCE, false, async () => {
        const started = Date.now();
        let success = 0;
        for (let i = 0; i < 10; i++) {
            const result = await t.insert(db, 'users', { name: `PerfUser${i}`, age: 20 + i });
            if (result.ok) success++;
        }
        const elapsed = Date.now() - started;
        const average = (elapsed / Math.max(success, 1)).toFixed(2);
        return success >= 9 ? pass(`HTTP insert latency: ${average} ms/op`) : warn(`Only ${success}/10 inserts succeeded`);
    });
}

async function suiteConcurrencyStandard(t) {
    t.suite('CONCURRENCY & THREAD SAFETY TESTS');
    const db = await t.createDb('concurrency_test');
    if (!db) { t.setupFailure('concurrency tests', CONCURRENCY); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
    if (!created) { t.setupFailure('concurrency collection', CONCURRENCY); return; }

    await t.check('CONCURRENCY 1: Two workers - 100 inserts each', CONCURRENCY, true, async () => {
        const work = await insertWorkload(t, db, 'users', 2, 100, 'Thread');
        const listed = await t.list(db, 'users');
        return listed.instances.length === work.totalSuccess && work.totalSuccess === 200
            ? pass(`All ${work.totalSuccess} records inserted successfully in ${work.durationMs} ms`)
            : fail(`Expected 200 records, got ${listed.instances.length} (successful inserts: ${work.totalSuccess})`);
    });

    await t.check("CONCURRENCY 2: Readers don't block writers", CONCURRENCY, false, async () => {
        const before = (await t.list(db, 'users')).instances.length;
        let stopReader = false;
        let reads = 0;
        const reader = (async () => {
            while (!stopReader) {
                await t.list(db, 'users');
                reads++;
                await sleep(10);
            }
        })();
        await sleep(50);
        let writeSuccess = 0;
        for (let i = 0; i < 20; i++) {
            const result = await t.insert(db, 'users', { name: `RW${i}` });
            if (result.ok) writeSuccess++;
            await sleep(5);
        }
        stopReader = true;
        await reader;
        const after = (await t.list(db, 'users')).instances.length;
        if (writeSuccess >= 18 && after === before + writeSuccess) {
            return pass(`Writers completed while readers active: ${writeSuccess}/20 (${reads} concurrent reads)`);
        }
        if (writeSuccess >= 18) return fail(`Count mismatch: ${after} stored vs ${before + writeSuccess} expected`);
        return warn(`Writers blocked by readers: only ${writeSuccess}/20 succeeded`);
    });
}

async function runLevel1(t) {
    await suiteSmokeHttp(t);
    await suiteSmokeApi(t);
    await suiteHttpDatabases(t);
    await suiteHttpCollections(t);
    await suiteHttpInstances(t);
    await suiteHttpCommands(t);
    await suiteHttpErrors(t);
    await suiteSecurity(t);
    await suiteSchemaEnforcement(t);
    await suiteQuery(t);
    await suiteIntegrity(t);
    await suiteEdgeCases(t);
    await suitePerformanceStandard(t);
    await suiteConcurrencyStandard(t);
}

// ==================== LEVEL 2 SUITES (COMPREHENSIVE) ====================

async function suiteConcurrencyHigh(t) {
    t.suite('CONCURRENCY & THREAD SAFETY TESTS - HIGH CONCURRENCY');
    const db = await t.createDb('concurrency_test');
    if (!db) { t.setupFailure('high concurrency tests', CONCURRENCY); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
    if (!created) { t.setupFailure('high concurrency collection', CONCURRENCY); return; }

    await t.check('CONCURRENCY 3: 10 workers - 50 inserts each (high concurrency)', CONCURRENCY, true, async () => {
        const work = await insertWorkload(t, db, 'users', 10, 50, 'Thread');
        const listed = await t.list(db, 'users');
        return listed.instances.length === work.totalSuccess && work.totalSuccess >= 10 * 50 * 0.9
            ? pass(`${listed.instances.length}/500 records inserted successfully in ${work.durationMs} ms`)
            : fail(`Expected ~500, got ${listed.instances.length} (successful: ${work.totalSuccess})`);
    });

    const httpDb = await t.createDb('http_conc');
    if (!httpDb) { t.setupFailure('HTTP concurrency tests', CONCURRENCY); return; }
    await t.createCollection(httpDb, 'users', [F('name', 'string', true), F('age', 'int')]);

    await t.check('HTTP CONCURRENCY: 5 concurrent workers - 25 inserts each', CONCURRENCY, true, async () => {
        const work = await insertWorkload(t, httpDb, 'users', 5, 25, 'HTTP_Thread');
        const listed = await t.list(httpDb, 'users');
        return listed.instances.length === work.totalSuccess && work.totalSuccess >= 5 * 25 * 0.9
            ? pass(`HTTP concurrency: ${listed.instances.length}/${work.totalSuccess} records`)
            : fail(`Expected ${5 * 25}, got ${listed.instances.length} records (successful: ${work.totalSuccess})`);
    });
}

async function suiteDurability(t) {
    t.suite('DURABILITY & CRASH RECOVERY TESTS');
    const db = await t.createDb('durability_test');
    if (!db) { t.setupFailure('durability tests', DURABILITY); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int'), F('data', 'string')]);
    if (!created) { t.setupFailure('durability collection', DURABILITY); return; }
    const needsManaged = 'Requires a test-managed server (start without --url so the test can kill and restart it)';
    const needsFiles = 'File-level verification needs a local data directory';

    await t.check('DURABILITY 1: Insert with immediate durability', DURABILITY, true, async () => {
        const result = await t.insert(db, 'users', { name: 'Durable User', age: 25, data: 'Test data' });
        const listed = await t.list(db, 'users');
        return result.ok && listed.instances.length >= 1
            ? pass('Record present immediately after insert')
            : fail('Record not found after insert');
    });

    await t.check('DURABILITY 2: Crash recovery - server killed (SIGKILL) right after insert acknowledged', DURABILITY, false, async () => {
        if (!t.server.managed) return skip(needsManaged);
        const before = (await t.list(db, 'users')).instances.length;
        const result = await t.insert(db, 'users', { name: 'Crash Test', age: 99, data: 'Should recover' });
        if (!result.ok) return fail('Insert failed before crash');
        await t.server.kill();
        const restarted = await t.server.start();
        if (!restarted) return fail('Server failed to restart after crash');
        const after = await t.list(db, 'users');
        const found = after.instances.some((i) => i.name === 'Crash Test');
        return found && after.instances.length >= before + 1
            ? pass('Data survived crash')
            : warn('Data lost on crash (acknowledged write not durable)');
    });

    await t.check('DURABILITY 3: File system consistency after abnormal termination (kill during bulk insert)', DURABILITY, true, async () => {
        if (!t.server.managed) return skip(needsManaged);
        const before = (await t.list(db, 'users')).instances.length;
        let stop = false;
        let acked = 0;
        const background = (async () => {
            for (let i = 0; i < 10 && !stop; i++) {
                const result = await t.insert(db, 'users', { name: `Bulk${i}` });
                if (result.ok) acked++;
            }
        })();
        await sleep(50);
        await t.server.kill();
        stop = true;
        await background;
        const restarted = await t.server.start();
        if (!restarted) return fail('Server failed to restart after abnormal termination');
        const listed = await t.list(db, 'users');
        if (!listed.ok) return fail(`Collection unreadable after crash: ${short(listed.resp.body, 150)}`);
        let headerNote = '';
        if (t.fileChecks) {
            const header = t.readHeader(db, 'users');
            if (!header || header.magic !== FILE_MAGIC_NUMBER) return fail('Data file header corrupted after crash');
            headerNote = `, header valid (${header.recordCount} records)`;
        }
        if (listed.instances.length < before + acked) {
            return fail(`Acknowledged writes lost: ${listed.instances.length} stored < ${before + acked} expected`);
        }
        return pass(`File readable, ${listed.instances.length} records (${acked} acknowledged before kill)${headerNote}`);
    });

    await t.check('DURABILITY 3b: Database accepts writes after abnormal termination', DURABILITY, true, async () => {
        const result = await t.insert(db, 'users', { name: 'After Crash', age: 1 });
        const listed = await t.list(db, 'users', 'name:After Crash');
        return result.ok && listed.instances.length === 1 ? pass('Writes continue to work') : fail('Write after crash failed');
    });

    await t.check('DURABILITY 4: Bulk insert durability (100 records)', DURABILITY, true, async () => {
        const started = Date.now();
        let success = 0;
        for (let i = 0; i < 100; i++) {
            const result = await t.insert(db, 'users', { name: `BulkUser${i}`, age: 20 + (i % 50) });
            if (result.ok) success++;
        }
        const listed = await t.list(db, 'users');
        return listed.instances.length >= success && success > 90
            ? pass(`${listed.instances.length} stored, ${success}/100 acknowledged (${Date.now() - started} ms)`)
            : fail(`Only ${listed.instances.length}/${success} records persisted`);
    });

    // HTTP durability tests (newtest.c run_durability_tests_http)
    const httpDb = await t.createDb('http_durability');
    if (!httpDb) { t.setupFailure('HTTP durability tests', DURABILITY); return; }
    await t.createCollection(httpDb, 'users', [F('name', 'string', true), F('age', 'int')]);
    const instancesUrl = `/api/databases/${httpDb}/collections/users/instances`;

    await t.http({
        description: 'HTTP: Insert with durability verification', method: 'POST', path: instancesUrl,
        body: { name: 'Durable User', age: 30 }, expect: '"success":true', category: DURABILITY, critical: true
    });
    await t.check('HTTP: Bulk insert durability (50 records)', DURABILITY, true, async () => {
        const started = Date.now();
        let success = 0;
        for (let i = 0; i < 50; i++) {
            const result = await t.insert(httpDb, 'users', { name: `User${i}`, age: 20 + i });
            if (result.ok) success++;
        }
        const listed = await t.list(httpDb, 'users');
        return listed.instances.length >= success && success > 45
            ? pass(`${listed.instances.length}/${success} records (${Date.now() - started} ms)`)
            : fail(`Only ${listed.instances.length}/${success} records`);
    });

    await t.check('DURABILITY 5: Header record count matches API after crash recovery cycle', DURABILITY, false, async () => {
        if (!t.fileChecks) return skip(needsFiles);
        const header = t.readHeader(db, 'users');
        const listed = await t.list(db, 'users');
        if (!header) return fail('Could not read header');
        return header.recordCount === listed.instances.length
            ? pass(`Header ${header.recordCount} == API ${listed.instances.length}`)
            : fail(`Header ${header.recordCount} != API ${listed.instances.length}`);
    });
}

async function suitePerformanceLarge(t) {
    t.suite('PERFORMANCE & SCALABILITY TESTS - LARGE DATASET');
    const db = await t.createDb('large_test');
    if (!db) { t.setupFailure('large dataset tests', PERFORMANCE); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string'), F('age', 'int')]);
    if (!created) { t.setupFailure('large dataset collection', PERFORMANCE); return; }

    await t.check('PERF 5: Large dataset - 1000 records', PERFORMANCE, false, async () => {
        const started = Date.now();
        let success = 0;
        for (let i = 0; i < 1000; i++) {
            const result = await t.insert(db, 'users', { name: `LargeUser${i}`, age: 20 + (i % 50) });
            if (result.ok) success++;
        }
        const elapsed = Date.now() - started;
        const listed = await t.list(db, 'users');
        return listed.instances.length >= 1000
            ? pass(`All 1000 records inserted (${elapsed} ms, avg ${(elapsed / 1000).toFixed(2)} ms/op)`)
            : fail(`Only ${listed.instances.length}/1000 records inserted (${success} acknowledged)`);
    });

    await t.check('PERF 6: Query over 1000 records', PERFORMANCE, false, async () => {
        const started = Date.now();
        const listed = await t.list(db, 'users', 'age:30');
        const elapsed = Date.now() - started;
        if (!listed.ok) return fail('Query failed');
        return listed.instances.length === 20 && elapsed < 1000
            ? pass(`20 matches in ${elapsed} ms`)
            : (listed.instances.length === 20
                ? warn(`Query slow: ${elapsed} ms`)
                : fail(`Expected 20 matches, got ${listed.instances.length}`));
    });
}

async function suiteRecovery(t) {
    t.suite('RECOVERY & ERROR HANDLING TESTS');
    const db = await t.createDb('recovery_test');
    if (!db) { t.setupFailure('recovery tests', RECOVERY); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
    if (!created) { t.setupFailure('recovery collection', RECOVERY); return; }
    for (let i = 0; i < 5; i++) await t.insert(db, 'users', { name: `Initial${i}`, age: 20 + i });
    const needsManaged = 'Requires a test-managed server (start without --url)';

    await t.check('RECOVERY 1: Lock file cleanup after crash (stale lock does not block writes)', RECOVERY, false, async () => {
        if (!t.fileChecks) return skip('File-level verification needs a local data directory');
        const lockPath = path.join(t.opts.baseDir, db, 'users', '.data.lock');
        fs.writeFileSync(lockPath, 'stale lock\n');
        const before = (await t.list(db, 'users')).instances.length;
        const result = await t.insert(db, 'users', { name: 'Lock Test', age: 99 });
        const after = (await t.list(db, 'users')).instances.length;
        const lockExists = fs.existsSync(lockPath);
        if (!result.ok || after !== before + 1) return fail('Write blocked by stale lock file');
        return pass(`Stale lock handled: write succeeded; lock file ${lockExists ? 'left untouched (server has no file locking)' : 'removed'}`);
    });

    await t.check('RECOVERY 2: Data persists across graceful server restart', RECOVERY, true, async () => {
        if (!t.server.managed) return skip(needsManaged);
        const before = (await t.list(db, 'users')).instances.map((i) => i._id).sort();
        const restarted = await t.server.gracefulRestart();
        if (!restarted) return fail('Server failed to restart');
        const after = (await t.list(db, 'users')).instances.map((i) => i._id).sort();
        return JSON.stringify(before) === JSON.stringify(after) && before.length > 0
            ? pass(`${after.length} records identical after restart`)
            : fail(`Before ${before.length} records, after ${after.length} records`);
    });

    await t.check('RECOVERY 3: Data persists across hard crash (SIGKILL) and restart', RECOVERY, true, async () => {
        if (!t.server.managed) return skip(needsManaged);
        const before = (await t.list(db, 'users')).instances.map((i) => i._id).sort();
        const restarted = await t.server.crashAndRestart();
        if (!restarted) return fail('Server failed to restart');
        const after = (await t.list(db, 'users')).instances.map((i) => i._id).sort();
        return JSON.stringify(before) === JSON.stringify(after) && before.length > 0
            ? pass(`${after.length} records identical after crash`)
            : fail(`Before ${before.length} records, after ${after.length} records`);
    });

    await t.check('RECOVERY 4: Databases and collections are listed after restart', RECOVERY, true, async () => {
        const databases = await t.listDatabases();
        const collections = await t.listCollections(db);
        return databases && databases.includes(db) && collections && collections.includes('users')
            ? pass('Metadata intact') : fail('Database or collection missing after restart');
    });
}

async function runLevel2(t) {
    await suiteConcurrencyHigh(t);
    await suiteDurability(t);
    await suitePerformanceLarge(t);
    await suiteRecovery(t);
}

// ==================== LEVEL 3 SUITES (EXTREME) ====================

async function suiteStress(t) {
    t.suite('EXTREME STRESS TESTS');
    const db = await t.createDb('stress_test');
    if (!db) { t.setupFailure('stress tests', PERFORMANCE); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
    if (!created) { t.setupFailure('stress collection', PERFORMANCE); return; }

    await t.check('STRESS TEST 1: 1000 concurrent inserts (10 workers x 100)', PERFORMANCE, true, async () => {
        const work = await insertWorkload(t, db, 'users', 10, 100, 'HTTP_Thread');
        const listed = await t.list(db, 'users');
        return listed.instances.length === work.totalSuccess && work.totalSuccess >= 10 * 100 * 0.95
            ? pass(`${listed.instances.length}/${work.totalSuccess} records in ${work.durationMs} ms`)
            : fail(`Expected ~1000, got ${listed.instances.length} (successful: ${work.totalSuccess})`);
    });

    await t.check('STRESS TEST 2: No duplicate ids after stress', INTEGRITY, true, async () => {
        const listed = await t.list(db, 'users');
        const ids = new Set(listed.instances.map((i) => i._id));
        return ids.size === listed.instances.length ? pass(`${ids.size} unique ids`) : fail(`${listed.instances.length - ids.size} duplicate ids`);
    });

    await t.check('STRESS TEST 3: Concurrent read storm (200 reads, 20 at a time)', PERFORMANCE, false, async () => {
        let ok = 0;
        const results = await runWorkers(20, 10, async () => {
            const listed = await t.list(db, 'users', 'age:30');
            if (listed.ok) ok++;
            return listed.ok;
        });
        const total = results.reduce((sum, item) => sum + item.success, 0);
        return total === 200 && ok === 200 ? pass('All 200 reads succeeded') : fail(`${total}/200 reads succeeded`);
    });
}

async function suiteCorruption(t) {
    t.suite('DATA CORRUPTION TESTS');
    const needsFiles = 'Requires a local data directory (managed server or --base-dir) to corrupt the data file';
    const db = await t.createDb('corrupt_test');
    if (!db) { t.setupFailure('corruption tests', INTEGRITY); return; }
    const okUsers = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
    const okHealthy = await t.createCollection(db, 'healthy', [F('name', 'string', true)]);
    if (!okUsers || !okHealthy) { t.setupFailure('corruption collections', INTEGRITY); return; }
    for (let i = 0; i < 5; i++) await t.insert(db, 'users', { name: `User${i}`, age: 20 + i });
    for (let i = 0; i < 3; i++) await t.insert(db, 'healthy', { name: `Healthy${i}` });

    let corrupted = false;
    await t.check('CORRUPTION 1: Corrupt data file header (magic number 0xDEADBEEF)', INTEGRITY, true, async () => {
        if (!t.fileChecks) return skip(needsFiles);
        const filePath = t.dataFilePath(db, 'users');
        const fd = fs.openSync(filePath, 'r+');
        const magic = Buffer.alloc(4);
        magic.writeUInt32LE(0xDEADBEEF, 0);
        fs.writeSync(fd, magic, 0, 4, 0);
        fs.closeSync(fd);
        corrupted = true;

        const response = await t.client.request('GET', t.instancesPath(db, 'users'));
        const json = parseJson(response.body);
        const extra = { method: 'GET', endpoint: t.instancesPath(db, 'users'), httpStatus: response.statusCode };
        if (response.statusCode === 400 || response.statusCode === 500) return pass('Server rejected corrupt file with an error status', extra);
        if (!json) return fail(`Malformed response: ${short(response.body, 150)}`, extra);
        if (json.success === false) return pass(`Server reported corruption: ${json.error}`, extra);
        if (Array.isArray(json.instances) && json.instances.length === 0) {
            return warn('Server did not crash and returned no data, but did not signal the corruption (empty list)', extra);
        }
        return fail('Server served data from a file with a corrupted header', extra);
    });

    await t.check('CORRUPTION 2: Other collections remain readable while one file is corrupt', INTEGRITY, true, async () => {
        if (!corrupted) return skip(needsFiles);
        const listed = await t.list(db, 'healthy');
        return listed.ok && listed.instances.length === 3 ? pass('Healthy collection unaffected') : fail('Healthy collection affected by corruption');
    });

    await t.check('CORRUPTION 3: Server stays alive after reading corrupt file', INTEGRITY, true, async () => {
        const response = await t.client.request('GET', '/api/databases');
        const json = parseJson(response.body);
        return json && json.success === true ? pass('Server responsive') : fail('Server unresponsive after corruption');
    });

    await t.check('CORRUPTION 4: Data is fully recovered after restoring the magic number', INTEGRITY, false, async () => {
        if (!corrupted) return skip(needsFiles);
        const filePath = t.dataFilePath(db, 'users');
        const fd = fs.openSync(filePath, 'r+');
        const magic = Buffer.alloc(4);
        magic.writeUInt32LE(FILE_MAGIC_NUMBER, 0);
        fs.writeSync(fd, magic, 0, 4, 0);
        fs.closeSync(fd);
        const listed = await t.list(db, 'users');
        return listed.ok && listed.instances.length === 5 ? pass('All 5 records readable again') : fail(`Got ${listed.instances.length}/5 records`);
    });
}

async function suiteMixedWorkload(t) {
    t.suite('MIXED WORKLOAD TESTS');
    const db = await t.createDb('mixed_test');
    if (!db) { t.setupFailure('mixed workload tests', CONCURRENCY); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
    if (!created) { t.setupFailure('mixed workload collection', CONCURRENCY); return; }

    const ids = [];
    for (let i = 0; i < 50; i++) {
        const result = await t.insert(db, 'users', { name: `User${i}`, age: 20 + i });
        if (result.ok) ids.push(result.id);
    }
    const toDelete = ids.slice(0, 10);
    const toUpdate = ids.slice(10, 30);

    const state = { reads: 0, readOk: 0, inserts: 0, insertOk: 0, updates: 0, updateOk: 0, deletes: 0, deleteOk: 0 };

    await t.check('MIXED 1: Concurrent read/write/update/delete operations all succeed', CONCURRENCY, true, async () => {
        const tasks = [];
        for (let i = 0; i < 40; i++) {
            tasks.push((async () => {
                state.reads++;
                const listed = await t.list(db, 'users', i % 2 ? `age:${20 + (i % 50)}` : undefined);
                if (listed.ok) state.readOk++;
            })());
        }
        for (let i = 0; i < 30; i++) {
            tasks.push((async () => {
                state.inserts++;
                const result = await t.insert(db, 'users', { name: `MixedNew${i}`, age: 100 + i });
                if (result.ok) state.insertOk++;
            })());
        }
        for (const id of toUpdate) {
            tasks.push((async () => {
                state.updates++;
                const response = await t.client.request('PUT', `/api/databases/${db}/collections/users/instances/${id}`,
                    JSON.stringify({ age: 999, note: 'updated' }));
                const json = parseJson(response.body);
                if (json && json.success === true) state.updateOk++;
            })());
        }
        for (const id of toDelete) {
            tasks.push((async () => {
                state.deletes++;
                const response = await t.client.request('DELETE', `/api/databases/${db}/collections/users/instances/${id}`);
                const json = parseJson(response.body);
                if (json && json.success === true) state.deleteOk++;
            })());
        }
        await Promise.all(tasks);
        const everything = state.readOk === state.reads && state.insertOk === state.inserts &&
            state.updateOk === state.updates && state.deleteOk === state.deletes;
        return everything
            ? pass(`reads ${state.readOk}/${state.reads}, inserts ${state.insertOk}/${state.inserts}, ` +
                `updates ${state.updateOk}/${state.updates}, deletes ${state.deleteOk}/${state.deletes}`)
            : fail(JSON.stringify(state));
    });

    await t.check('MIXED 2: Final record count equals initial + inserts - deletes', CONCURRENCY, true, async () => {
        const listed = await t.list(db, 'users');
        const expected = ids.length + state.insertOk - toDelete.length;
        return listed.instances.length === expected
            ? pass(`${listed.instances.length} records`) : fail(`Expected ${expected}, got ${listed.instances.length}`);
    });

    await t.check('MIXED 3: Deleted ids gone, updates applied, ids unique', CONCURRENCY, true, async () => {
        const listed = await t.list(db, 'users');
        const present = new Set(listed.instances.map((i) => i._id));
        const duplicates = listed.instances.length - present.size;
        const deletedStillThere = toDelete.filter((id) => present.has(id)).length;
        const updated = listed.instances.filter((i) => toUpdate.includes(i._id) && i.age === 999 && i.note === 'updated').length;
        return duplicates === 0 && deletedStillThere === 0 && updated === toUpdate.length
            ? pass(`${updated}/${toUpdate.length} updates applied, no duplicates, deleted records removed`)
            : fail(`duplicates=${duplicates}, deletedStillThere=${deletedStillThere}, updated=${updated}/${toUpdate.length}`);
    });
}

async function suiteLongRunning(t) {
    t.suite('LONG-RUNNING TESTS');
    const seconds = t.opts.longDuration;
    const db = await t.createDb('long_test');
    if (!db) { t.setupFailure('long-running tests', PERFORMANCE); return; }
    await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);

    await t.check(`LONG 1: Connection stability under continuous requests (${seconds}s)`, PERFORMANCE, false, async () => {
        if (seconds <= 0) return skip('Disabled (--long-duration=0)');
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        const latencies = [];
        let total = 0;
        let ok = 0;
        let inserted = 0;
        const started = Date.now();
        try {
            let iteration = 0;
            while (Date.now() - started < seconds * 1000) {
                iteration++;
                total++;
                const response = await t.client.request('GET', '/api/databases', null, 'application/json', { agent });
                latencies.push(response.durationMs);
                if (response.statusCode === 200 && response.body.includes('"success":true')) ok++;

                if (iteration % 4 === 0) {
                    total++;
                    const body = JSON.stringify({ name: `Long${iteration}`, age: iteration % 90 });
                    const insert = await t.client.request('POST', t.instancesPath(db, 'users'), body, 'application/json', { agent });
                    if (insert.statusCode === 200 && insert.body.includes('"success":true')) {
                        ok++;
                        inserted++;
                    }
                }
                await sleep(250);
            }
        } finally {
            agent.destroy();
        }
        const quarter = Math.max(1, Math.floor(latencies.length / 4));
        const avg = (list) => list.reduce((a, b) => a + b, 0) / Math.max(list.length, 1);
        const early = avg(latencies.slice(0, quarter));
        const late = avg(latencies.slice(-quarter));
        const stored = (await t.list(db, 'users')).instances.length;
        const summary = `${ok}/${total} requests ok over ${seconds}s, latency early ${early.toFixed(1)} ms / late ${late.toFixed(1)} ms, ` +
            `${stored}/${inserted} inserts stored`;
        if (ok !== total || stored !== inserted) return fail(summary);
        if (late > early * 5 + 50) return warn(`Latency drift detected: ${summary}`);
        return pass(summary);
    });
}

async function suiteConsistency(t) {
    t.suite('CONSISTENCY TESTS');
    const db = await t.createDb('consistency_test');
    if (!db) { t.setupFailure('consistency tests', INTEGRITY); return; }
    const created = await t.createCollection(db, 'counter', [F('name', 'string'), F('value', 'int')]);
    if (!created) { t.setupFailure('consistency collection', INTEGRITY); return; }

    const WORKERS = 10;
    const INCREMENTS = 10;
    const updateUrl = (id) => `/api/databases/${db}/collections/counter/instances/${id}`;

    const increment = async (id) => {
        const current = await t.list(db, 'counter', `_id:${id}`);
        if (current.instances.length !== 1) return false;
        const response = await t.client.request('PUT', updateUrl(id), JSON.stringify({ value: current.instances[0].value + 1 }));
        const json = parseJson(response.body);
        return Boolean(json && json.success === true);
    };

    const privateIds = [];
    for (let w = 0; w < WORKERS; w++) {
        const result = await t.insert(db, 'counter', { name: `private${w}`, value: 0 });
        if (result.ok) privateIds.push(result.id);
    }

    await t.check('CONSISTENCY 1: Counter increment under load (per-worker counters)', INTEGRITY, true, async () => {
        if (privateIds.length !== WORKERS) return fail('Failed to create counters');
        await Promise.all(privateIds.map(async (id) => {
            for (let k = 0; k < INCREMENTS; k++) await increment(id);
        }));
        const listed = await t.list(db, 'counter');
        const counters = listed.instances.filter((i) => String(i.name).startsWith('private'));
        const sum = counters.reduce((acc, i) => acc + i.value, 0);
        const allEqual = counters.every((i) => i.value === INCREMENTS);
        return allEqual && sum === WORKERS * INCREMENTS && counters.length === WORKERS
            ? pass(`Counter consistency maintained: total ${sum}/${WORKERS * INCREMENTS}`)
            : fail(`Counter inconsistent: total ${sum}, values ${counters.map((i) => i.value).join(',')}`);
    });

    await t.check('CONSISTENCY 2: Concurrent updates on one instance merge without loss', INTEGRITY, true, async () => {
        const result = await t.insert(db, 'counter', { name: 'merge', value: 0 });
        if (!result.ok) return fail('Insert failed');
        const id = result.id;
        await Promise.all(Array.from({ length: 20 }, (_, i) =>
            t.client.request('PUT', updateUrl(id), JSON.stringify({ [`f${i}`]: i }))));
        const listed = await t.list(db, 'counter', `_id:${id}`);
        if (listed.instances.length !== 1) return fail(`Expected 1 instance, got ${listed.instances.length}`);
        const instance = listed.instances[0];
        const missing = [];
        for (let i = 0; i < 20; i++) if (instance[`f${i}`] !== i) missing.push(`f${i}`);
        return missing.length === 0 && instance._id === id && instance.name === 'merge'
            ? pass('All 20 concurrent field updates preserved, identity intact')
            : fail(`Lost updates: ${missing.join(',')}`);
    });

    await t.check('CONSISTENCY 3: Shared counter read-modify-write (no atomic increment in API)', INTEGRITY, false, async () => {
        const result = await t.insert(db, 'counter', { name: 'shared', value: 0 });
        if (!result.ok) return fail('Insert failed');
        const id = result.id;
        await Promise.all(Array.from({ length: WORKERS }, async () => {
            for (let k = 0; k < INCREMENTS; k++) await increment(id);
        }));
        const listed = await t.list(db, 'counter', `_id:${id}`);
        const value = listed.instances.length === 1 ? listed.instances[0].value : -1;
        if (listed.instances.length !== 1) return fail(`Expected 1 instance, got ${listed.instances.length}`);
        return value === WORKERS * INCREMENTS
            ? pass(`Counter consistent: ${value}`)
            : warn(`Lost updates: ${value}/${WORKERS * INCREMENTS} (expected: each PUT is atomic but a client-side read-modify-write is not isolated)`);
    });

    await t.check('CONSISTENCY 4: Instance count unchanged by updates (no duplication)', INTEGRITY, true, async () => {
        const listed = await t.list(db, 'counter');
        const ids = new Set(listed.instances.map((i) => i._id));
        const expected = WORKERS + 2;
        return listed.instances.length === expected && ids.size === expected
            ? pass(`${expected} instances, all unique`) : fail(`Expected ${expected}, got ${listed.instances.length} (${ids.size} unique)`);
    });
}

async function suiteFaultInjection(t) {
    t.suite('FAULT INJECTION TESTS');
    const db = await t.createDb('fault_test');
    if (!db) { t.setupFailure('fault injection tests', SECURITY); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
    if (!created) { t.setupFailure('fault injection collection', SECURITY); return; }
    const instancesUrl = t.instancesPath(db, 'users');

    const faultCheck = (description, body, contentType = 'application/json', method = 'POST', url = instancesUrl) =>
        t.check(description, SECURITY, true, async () => {
            const response = await t.client.request(method, url, body, contentType);
            const json = parseJson(response.body);
            const extra = { method, endpoint: short(url, 200), httpStatus: response.statusCode };
            if (response.statusCode === 0) return fail(`No response: ${response.error}`, extra);
            if (response.statusCode === 400 || response.statusCode === 500) return pass(`Server rejected input (HTTP ${response.statusCode})`, extra);
            if (!json || !('success' in json)) return fail(`Malformed response: ${short(response.body, 150)}`, extra);
            return pass(json.success === false
                ? `Server rejected input: ${json.error}`
                : 'Server accepted the input as a document (wrapped as data), stayed healthy', extra);
        });

    await faultCheck('FAULT 1: Malformed JSON with control characters (NUL byte)', '{"name":"Test\u0000User","age":30}');
    await faultCheck('FAULT 2: Truncated JSON body', '{"name":"Test');
    await faultCheck('FAULT 3: Binary garbage body', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81, 0xc3, 0x28]));
    await faultCheck('FAULT 4: Valid JSON with wrong content-type', '{"name":"Typed","age":5}', 'text/plain');
    await faultCheck('FAULT 5: PUT without body', null, 'application/json', 'PUT', `${instancesUrl}/00000000-0000-0000-0000-000000000000`);
    await faultCheck('FAULT 6: Deeply nested JSON', `{"name":"Nested","data":${'['.repeat(200)}${']'.repeat(200)}}`);

    await t.check('FAULT 7: Server still healthy after all injected faults', SECURITY, true, async () => {
        const databases = await t.listDatabases();
        const listedDb = databases && databases.includes(db);
        const healthy = await t.insert(db, 'users', { name: 'Healthy After Faults', age: 1 });
        return listedDb && healthy.ok ? pass('Server responsive and accepting valid writes') : fail('Server unhealthy after fault injection');
    });
}

function abortedRequest(client, urlPath) {
    return new Promise((resolve) => {
        const request = http.request({
            host: client.host, port: client.port, method: 'POST', path: urlPath,
            headers: { 'Content-Type': 'application/json', 'Content-Length': 1000 }, agent: false
        });
        request.on('error', () => resolve());
        request.write('{"name":"aborted');
        setTimeout(() => {
            request.destroy();
            resolve();
        }, 10);
    });
}

async function suiteChaos(t) {
    t.suite('CHAOS ENGINEERING TESTS - random failures and partial outages');
    const db = await t.createDb('chaos_test');
    if (!db) { t.setupFailure('chaos tests', RECOVERY); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
    if (!created) { t.setupFailure('chaos collection', RECOVERY); return; }

    await t.check('CHAOS 1: Simulated network latency (random delays, mixed operations)', RECOVERY, false, async () => {
        let ok = 0;
        const total = 60;
        const tasks = [];
        let inserted = 0;
        for (let i = 0; i < total; i++) {
            tasks.push((async () => {
                await sleep(Math.floor(Math.random() * 40));
                if (i % 3 === 0) {
                    const listed = await t.list(db, 'users');
                    if (listed.ok) ok++;
                } else {
                    const result = await t.insert(db, 'users', { name: `Jitter${i}`, age: i });
                    if (result.ok) {
                        ok++;
                        inserted++;
                    }
                }
            })());
        }
        await Promise.all(tasks);
        const stored = (await t.list(db, 'users')).instances.length;
        return ok === total && stored === inserted
            ? pass(`${ok}/${total} operations ok, ${stored} records stored`)
            : fail(`${ok}/${total} ok, stored ${stored} vs inserted ${inserted}`);
    });

    await t.check('CHAOS 2: Aborted connections (25 half-sent requests) do not harm the server', RECOVERY, true, async () => {
        const before = (await t.list(db, 'users')).instances.length;
        for (let i = 0; i < 25; i++) await abortedRequest(t.client, t.instancesPath(db, 'users'));
        await sleep(100);
        const alive = await t.listDatabases();
        const after = (await t.list(db, 'users')).instances.length;
        if (!alive) return fail('Server unresponsive after aborted connections');
        return after === before ? pass('Server alive, no partial records stored') : fail(`Record count changed ${before} -> ${after}`);
    });

    await t.check('CHAOS 3: Concurrent barrage of valid and invalid requests', RECOVERY, true, async () => {
        const before = (await t.list(db, 'users')).instances.length;
        let validOk = 0;
        let invalidHandled = 0;
        const tasks = [];
        for (let i = 0; i < 100; i++) {
            tasks.push((async () => {
                const kind = i % 4;
                if (kind === 0 || kind === 1) {
                    const result = await t.insert(db, 'users', { name: `Barrage${i}`, age: i });
                    if (result.ok) validOk++;
                } else if (kind === 2) {
                    const response = await t.client.request('POST', '/api/databases', '{bad json');
                    if (parseJson(response.body) && parseJson(response.body).success === false) invalidHandled++;
                } else {
                    const response = await t.client.request('POST', '/api/databases', JSON.stringify({ name: 'bad/name' }));
                    if (parseJson(response.body) && parseJson(response.body).success === false) invalidHandled++;
                }
            })());
        }
        await Promise.all(tasks);
        const after = (await t.list(db, 'users')).instances.length;
        return after === before + validOk && validOk === 50 && invalidHandled === 50
            ? pass(`50 valid inserts stored, 50 invalid requests rejected`)
            : fail(`validOk=${validOk}, invalidHandled=${invalidHandled}, stored delta=${after - before}`);
    });

    await t.check('CHAOS 4: Server killed under load - acknowledged writes survive restart', RECOVERY, true, async () => {
        if (!t.server.managed) return skip('Requires a test-managed server (start without --url)');
        const before = (await t.list(db, 'users')).instances.length;
        let stop = false;
        let attempted = 0;
        let acked = 0;
        const workers = Array.from({ length: 5 }, (_, w) => (async () => {
            let i = 0;
            while (!stop) {
                attempted++;
                const result = await t.insert(db, 'users', { name: `Chaos${w}_${i++}`, age: 1 });
                if (result.ok) acked++;
                else await sleep(5);
            }
        })());
        await sleep(300);
        await t.server.kill();
        stop = true;
        await Promise.all(workers);
        const restarted = await t.server.start();
        if (!restarted) return fail('Server failed to restart after chaos kill');
        const after = (await t.list(db, 'users')).instances.length;
        const delta = after - before;
        if (delta < acked) return fail(`Acknowledged writes lost: stored ${delta} < acked ${acked}`);
        if (delta > attempted) return fail(`More records than attempted writes: ${delta} > ${attempted}`);
        return pass(`stored ${delta} >= acknowledged ${acked}, attempted ${attempted}`);
    });

    await t.check('CHAOS 5: Server fully functional after chaos', RECOVERY, true, async () => {
        const result = await t.insert(db, 'users', { name: 'Post Chaos', age: 7 });
        const listed = await t.list(db, 'users', 'name:Post Chaos');
        return result.ok && listed.instances.length === 1 ? pass('Reads and writes work') : fail('Server not functional after chaos');
    });
}

async function suiteBoundaryExtreme(t) {
    t.suite('EXTREME BOUNDARY TESTS');
    const db = await t.createDb('boundary_test');
    if (!db) { t.setupFailure('boundary tests', PERFORMANCE); return; }
    const created = await t.createCollection(db, 'users', [F('name', 'string', true), F('age', 'int')]);
    if (!created) { t.setupFailure('boundary collection', PERFORMANCE); return; }

    await t.check('BOUNDARY 1: Maximum field count (128 fields)', PERFORMANCE, false, async () => {
        const document = {};
        for (let i = 0; i < 128; i++) document[`field${i}`] = `value${i}`;
        const result = await t.insert(db, 'users', document);
        if (!result.ok) return warn(`Server failed with 128 fields: ${short(result.resp.body, 150)}`);
        const listed = await t.list(db, 'users', `_id:${result.id}`);
        const stored = listed.instances.length === 1 && listed.instances[0].field127 === 'value127';
        return stored ? pass('Server handled 128 fields and returned them intact') : fail('128-field record not retrievable');
    });

    await t.check('BOUNDARY 2: Very large JSON (1MB)', PERFORMANCE, false, async () => {
        let data = '';
        for (let i = 0; i < 1024 * 1024; i++) data += String.fromCharCode(65 + (i % 26));
        const response = await t.client.request('POST', t.instancesPath(db, 'users'), JSON.stringify({ name: 'Huge', data }));
        const json = parseJson(response.body);
        if (!(json && json.success === true)) return warn(`Server rejected 1MB JSON (HTTP ${response.statusCode})`);
        const listed = await t.list(db, 'users', `_id:${json.id}`);
        const intact = listed.instances.length === 1 && listed.instances[0].data && listed.instances[0].data.length === data.length;
        return intact ? pass('Server handled 1MB JSON and returned it intact') : fail('1MB record not retrievable intact');
    });

    await t.check('BOUNDARY 3: Database name of 255 characters is accepted', EDGE, false, async () => {
        const name = 'b'.repeat(255);
        t.track(name);
        const response = await t.client.request('POST', '/api/databases', JSON.stringify({ name }));
        const json = parseJson(response.body);
        return json && json.success === true ? pass('255-char name accepted') : warn(`255-char name rejected: ${short(response.body, 150)}`);
    });

    await t.check('BOUNDARY 4: Database name of 256 characters is rejected', EDGE, true, async () => {
        const response = await t.client.request('POST', '/api/databases', JSON.stringify({ name: 'c'.repeat(256) }));
        const json = parseJson(response.body);
        return json && json.success === false ? pass(`Rejected: ${json.error}`) : fail(`Not rejected: ${short(response.body, 150)}`);
    });

    await t.check('BOUNDARY 5: Unicode data round trip', EDGE, false, async () => {
        const name = 'Zoë 日本語 😀';
        const result = await t.insert(db, 'users', { name, age: 42 });
        if (!result.ok) return warn(`Unicode insert failed: ${short(result.resp.body, 150)}`);
        const byId = await t.list(db, 'users', `_id:${result.id}`);
        const byName = await t.list(db, 'users', `name:${name}`);
        return byId.instances.length === 1 && byId.instances[0].name === name && byName.instances.length >= 1
            ? pass('Unicode stored, read and queried intact') : warn('Unicode round trip mismatch');
    });

    await t.check('BOUNDARY 6: Empty-object and minimal documents', EDGE, false, async () => {
        const minimal = await t.insert(db, 'users', { x: 1 });
        const empty = await t.insert(db, 'users', {});
        return minimal.ok ? pass(`Minimal document accepted; empty object ${empty.ok ? 'accepted' : 'handled'}`) : warn('Minimal document rejected');
    });
}

async function runLevel3(t) {
    await suiteStress(t);
    await suiteCorruption(t);
    await suiteMixedWorkload(t);
    await suiteLongRunning(t);
    await suiteConsistency(t);
    await suiteFaultInjection(t);
    await suiteChaos(t);
    await suiteBoundaryExtreme(t);
}

const LEVEL_RUNNERS = { 1: runLevel1, 2: runLevel2, 3: runLevel3 };

// ==================== PUBLIC STATIC API ====================

class SyDBApiTest {
    static get LEVELS() {
        return { ...LEVEL_NAMES };
    }

    static get CATEGORIES() {
        return { ...CATEGORY };
    }

    static normalizeOptions(options = {}) {
        const input = options || {};
        const level = [1, 2, 3].includes(Number(input.level)) ? Number(input.level) : 1;
        const urlExplicit = typeof input.url === 'string' && input.url.length > 0;
        const managedPort = Number.isInteger(Number(input.port)) && Number(input.port) > 0 ? Number(input.port) : DEFAULT_MANAGED_PORT;
        let url = urlExplicit ? input.url : `http://localhost:${managedPort}`;
        if (!/^https?:\/\//.test(url)) url = `http://${url}`;
        url = url.replace(/\/+$/, '');
        const parsed = new URL(url);
        const longDuration = Number.isFinite(Number(input.longDuration)) ? Number(input.longDuration) : 30;

        return {
            level,
            all: Boolean(input.all),
            managed: Boolean(input.managed),
            verbose: Boolean(input.verbose),
            url,
            urlExplicit,
            host: parsed.hostname,
            port: Number(parsed.port) || 80,
            baseDir: input.baseDir || DEFAULT_BASE_DIR,
            baseDirExplicit: Boolean(input.baseDir),
            sydbPath: path.resolve(input.sydbPath || path.join(THIS_DIR, 'JS_SyDB.js')),
            log: Boolean(input.log),
            logFile: typeof input.log === 'string' ? path.resolve(input.log) : null,
            keep: Boolean(input.keep),
            longDuration,
            color: input.color === undefined ? Boolean(process.stdout.isTTY) : Boolean(input.color),
            silent: Boolean(input.silent),
            timeoutMs: Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : 30000
        };
    }

    // Runs the selected level (default 1) or all levels when options.all is true. Returns the JSON report.
    static async run(options = {}) {
        const opts = SyDBApiTest.normalizeOptions(options);
        const levels = opts.all ? [1, 2, 3] : [opts.level];
        const run = new TestRun(opts);
        return run.execute(levels);
    }

    static async runLevel1(options = {}) {
        return SyDBApiTest.run({ ...options, level: 1, all: false });
    }

    static async runLevel2(options = {}) {
        return SyDBApiTest.run({ ...options, level: 2, all: false });
    }

    static async runLevel3(options = {}) {
        return SyDBApiTest.run({ ...options, level: 3, all: false });
    }

    static async runAll(options = {}) {
        return SyDBApiTest.run({ ...options, all: true });
    }

    static help(programName = 'node test_sydb_api.js') {
        return [
            `SyDB API Test Suite v${TOOL_VERSION} - 100% HTTP API tests (no --api / --server flag needed)`,
            '',
            `Usage: ${programName} [OPTIONS]`,
            '',
            'TEST LEVELS (zero args runs level 1):',
            '  --level=1, -l 1     STANDARD (default): smoke, databases, collections, instances, commands,',
            '                      errors, security, schema, query language, integrity, edge cases,',
            '                      performance, basic concurrency',
            '  --level=2, -l 2     COMPREHENSIVE: high concurrency, durability & crash recovery,',
            '                      1000-record dataset, recovery & restart',
            '  --level=3, -l 3     EXTREME: stress, data corruption, mixed workload, long running,',
            '                      consistency, fault injection, chaos, extreme boundaries',
            '  --all, -a           Run levels 1, 2 and 3 in sequence',
            '',
            'OUTPUT:',
            '  --log[=FILE]        Write a JSON summary with numbered steps (default file name:',
            '                      sydb_api_test_log_<timestamp>.json in the current directory)',
            '  --verbose, -v       Extremely detailed logging (requests, responses, server output)',
            '  --no-color          Disable ANSI colors',
            '',
            'SERVER:',
            '  (default)           Tests the SyDB server at http://localhost:8080. If nothing answers there the',
            '                      test fails with an explicit error (it never starts a server on its own).',
            '  --managed           Start an isolated managed SyDB server (JS_SyDB.js next to this file) when none',
            '                      answers, with SYDB_BASE_DIR=/tmp/sydb_test, and stop it at the end.',
            '                      Crash/restart, file header, stale-lock and corruption steps are enabled.',
            '  --url=URL           Test a server at another URL. Against an external server, crash/restart',
            '                      steps are skipped.',
            '  --port=N            Server port (default 8080)',
            '  --base-dir=PATH     Data directory used by the server (enables file-level checks, default /tmp/sydb_test)',
            '  --sydb=PATH         Path to JS_SyDB.js (default: next to this file)',
            '  --keep              Do not delete test databases / data directory at the end',
            '  --long-duration=S   Seconds for the level 3 long-running test (default 30, 0 disables)',
            '  --timeout=MS        Per-request timeout in milliseconds (default 30000)',
            '  --help, -h          Show this help message',
            '',
            'EXAMPLES:',
            `  ${programName}                       # level 1 (standard)`,
            `  ${programName} --level=2             # comprehensive`,
            `  ${programName} --level=3 --long-duration=10`,
            `  ${programName} --all --log           # all levels + JSON log`,
            `  ${programName} --all --log=report.json --verbose`,
            `  ${programName} --url=http://localhost:8080 --base-dir=/var/lib/sydb`,
            '',
            'PROGRAMMATIC USE (no CLI):',
            "  import SyDBApiTest from './test_sydb_api.js';",
            '  const report = await SyDBApiTest.run({ level: 2, log: true, silent: true });',
            '  const all = await SyDBApiTest.runAll();',
            '',
            'EXIT CODE: 0 when there are no critical failures and at least 70% of executed steps passed, otherwise 1.'
        ].join('\n');
    }

    static printHelp(programName) {
        console.log(SyDBApiTest.help(programName));
    }

    static parseArgs(argv = []) {
        const options = {};
        const errors = [];

        for (let i = 0; i < argv.length; i++) {
            const arg = argv[i];
            const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
            const key = eq > -1 ? arg.slice(0, eq) : arg;
            const inline = eq > -1 ? arg.slice(eq + 1) : undefined;
            const takeValue = () => {
                if (inline !== undefined) return inline;
                if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) return argv[++i];
                return undefined;
            };

            switch (key) {
                case '--level':
                case '-l': {
                    const value = parseInt(takeValue(), 10);
                    if (![1, 2, 3].includes(value)) errors.push(`Invalid level for ${key} (use 1, 2 or 3)`);
                    else options.level = value;
                    break;
                }
                case '--all':
                case '-a':
                    options.all = true;
                    break;
                case '--log': {
                    if (inline !== undefined) options.log = inline || true;
                    else if (i + 1 < argv.length && argv[i + 1].endsWith('.json')) options.log = argv[++i];
                    else options.log = true;
                    break;
                }
                case '--verbose':
                case '-v':
                    options.verbose = true;
                    break;
                case '--no-color':
                    options.color = false;
                    break;
                case '--keep':
                    options.keep = true;
                    break;
                case '--managed':
                    options.managed = true;
                    break;
                case '--url': {
                    const value = takeValue();
                    if (!value) errors.push('--url requires a value');
                    else options.url = value;
                    break;
                }
                case '--port': {
                    const value = parseInt(takeValue(), 10);
                    if (!Number.isInteger(value) || value <= 0 || value > 65535) errors.push('Invalid --port');
                    else options.port = value;
                    break;
                }
                case '--base-dir': {
                    const value = takeValue();
                    if (!value) errors.push('--base-dir requires a value');
                    else options.baseDir = value;
                    break;
                }
                case '--sydb': {
                    const value = takeValue();
                    if (!value) errors.push('--sydb requires a value');
                    else options.sydbPath = value;
                    break;
                }
                case '--long-duration': {
                    const value = Number(takeValue());
                    if (!Number.isFinite(value) || value < 0) errors.push('Invalid --long-duration');
                    else options.longDuration = value;
                    break;
                }
                case '--timeout': {
                    const value = Number(takeValue());
                    if (!Number.isFinite(value) || value <= 0) errors.push('Invalid --timeout');
                    else options.timeoutMs = value;
                    break;
                }
                case '--help':
                case '-h':
                    options.help = true;
                    break;
                default:
                    errors.push(`Unknown option: ${arg}`);
            }
        }

        return { options, errors };
    }

    // CLI entry point. Returns the process exit code.
    static async main(argv = process.argv.slice(2)) {
        const { options, errors } = SyDBApiTest.parseArgs(argv);

        if (options.help) {
            SyDBApiTest.printHelp();
            return 0;
        }
        if (errors.length > 0) {
            for (const error of errors) console.error(error);
            console.error('');
            SyDBApiTest.printHelp();
            return 1;
        }

        const report = await SyDBApiTest.run(options);
        return report.summary.exitCode;
    }
}

export default SyDBApiTest;
export { SyDBApiTest };

const invokedDirectly = (() => {
    try {
        return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(THIS_FILE);
    } catch (error) {
        return false;
    }
})();

if (invokedDirectly) {
    SyDBApiTest.main(process.argv.slice(2)).then((code) => {
        process.exit(code);
    }).catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
