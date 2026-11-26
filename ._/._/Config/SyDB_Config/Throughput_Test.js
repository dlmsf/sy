import fs from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';
import SyAPP from '../../../SyAPP.js'

const SyAPP_Func = SyAPP.Func();

// ============================================================================
// SyDB THROUGHPUT TESTER
//
// Same skeleton as SyDB_CorruptTest.js (SyAPP_Func + Storages + Buttons/Fields
// + forked workers + findings files), but the goal here is different: flood
// the SyDB HTTP server with RANDOM requests (insert / find / update / delete /
// list / schema ...) using as much CPU as possible, to find the limit of the
// database.
//
// Load generation
//   Node is single threaded, so ONE process cannot use 100% of a multi-core
//   CPU. The tester forks N worker processes (default = number of cores).
//   Each worker runs `concurrency` parallel lanes of requests against its own
//   private collection (so workers never collide with each other).
//
// POWER REGULATION (% of power)
//   Mode "duty"  : power = duty cycle. In every 100ms window the lanes are
//                  allowed to fire requests for `power`% of the window and
//                  are paused for the rest. 100% = flat out.
//   Mode "cpu"   : power = TARGET CPU % of each worker process. A small
//                  closed-loop controller adjusts the duty cycle until the
//                  measured CPU of the worker matches the target.
//   Power can be changed live (Field, -10/+10/MAX buttons) and an automatic
//   RAMP can step the power up until 100% to map where the server saturates.
//
// The server side is observed through GET /api/metrics/{instance,performance,
// requests} (cpu %, event loop utilization, req/s, in-flight, p95).
// ============================================================================

const DB_NAME = '__throughput_test__';
const WINDOW_MS = 100;
const WORKER_REPORT_MS = 500;
const REQUEST_TIMEOUT_MS = 10000;
const TAGS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];

// [operation, weight] - weights sum to 100
const OPS = [
    ['insert', 35],
    ['find_query', 14],
    ['find_id', 10],
    ['update', 16],
    ['delete', 9],
    ['list_all', 4],
    ['schema', 5],
    ['list_collections', 4],
    ['list_databases', 3]
];

const _ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const _BASE_STRING = (() => {
    let s = '';
    for (let i = 0; i < 4096; i++) s += _ALPHABET[Math.floor(Math.random() * _ALPHABET.length)];
    return s;
})();

// ---------------------------------------------------------------------------
// Output files (append-only, truncated on every Start)
// ---------------------------------------------------------------------------
let _samplesFd = null;
let _errorsFd = null;
let _stepsFd = null;

function _outPaths(baseDir) {
    const dir = baseDir || process.cwd();
    return {
        samplesPath: path.join(dir, 'sydb_throughput_samples.jsonl'),
        errorsPath: path.join(dir, 'sydb_throughput_errors.txt'),
        stepsPath: path.join(dir, 'sydb_throughput_steps.txt')
    };
}

function _openOutputs(baseDir) {
    for (const fd of [_samplesFd, _errorsFd, _stepsFd]) {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    }
    _samplesFd = null; _errorsFd = null; _stepsFd = null;

    const p = _outPaths(baseDir);
    try { fs.writeFileSync(p.samplesPath, ''); } catch (_) {}
    try { fs.writeFileSync(p.errorsPath, ''); } catch (_) {}
    try { fs.writeFileSync(p.stepsPath, ''); } catch (_) {}
    try {
        _samplesFd = fs.openSync(p.samplesPath, 'a');
        _errorsFd = fs.openSync(p.errorsPath, 'a');
        _stepsFd = fs.openSync(p.stepsPath, 'a');
    } catch (_) {
        _samplesFd = null; _errorsFd = null; _stepsFd = null;
    }
    return p;
}

function _appendLine(fd, line) {
    if (fd === null) return;
    try { fs.writeSync(fd, line + '\n'); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _short(s, n) {
    const str = String(s);
    return str.length > n ? str.slice(0, n) + '…' : str;
}

function _fmtN(v) {
    if (!Number.isFinite(v)) return '0';
    return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function _fmtMs(v) {
    if (!Number.isFinite(v)) return '0ms';
    if (v >= 1000) return (v / 1000).toFixed(2) + 's';
    return v.toFixed(v >= 100 ? 0 : 1) + 'ms';
}

function _fmtBytes(b) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = Number(b || 0);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 1) + units[i];
}

function _fmtDur(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}

function _clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function _rnd(n) {
    return Math.floor(Math.random() * n);
}

function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function httpRequest(opts) {
    return new Promise((resolve) => {
        let finished = false;
        const done = (v) => { if (!finished) { finished = true; resolve(v); } };

        let req;
        try {
            req = http.request({
                host: opts.host || '127.0.0.1',
                port: opts.port,
                path: opts.path,
                method: opts.method || 'GET',
                headers: opts.headers || {},
                agent: opts.agent,
                timeout: opts.timeoutMs || 10000
            }, (res) => {
                const keep = opts.keepBytes === undefined ? 1048576 : opts.keepBytes;
                const chunks = [];
                let kept = 0;
                let total = 0;
                res.on('data', (c) => {
                    total += c.length;
                    if (kept < keep) {
                        const part = (kept + c.length > keep) ? c.subarray(0, keep - kept) : c;
                        chunks.push(part);
                        kept += part.length;
                    }
                });
                res.on('end', () => done({
                    ok: true,
                    status: res.statusCode,
                    body: Buffer.concat(chunks).toString('utf8'),
                    bytes: total
                }));
                res.on('error', (e) => done({ ok: false, error: String(e && e.message || e) }));
            });
        } catch (e) {
            return done({ ok: false, error: String(e && e.message || e) });
        }

        req.on('error', (e) => done({ ok: false, error: String(e && e.message || e) }));
        req.on('timeout', () => {
            try { req.destroy(); } catch (_) {}
            done({ ok: false, error: 'timeout' });
        });

        if (opts.body !== undefined && opts.body !== null) {
            try { req.write(opts.body); } catch (e) { done({ ok: false, error: String(e) }); return; }
        }
        req.end();
    });
}

function _netErrorKind(error) {
    const e = String(error || '');
    if (e === 'timeout') return 'net_timeout';
    const m = e.match(/E[A-Z]{3,}/);
    return 'net_' + (m ? m[0].toLowerCase() : 'error');
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------
class SyDBThroughputTester extends SyAPP_Func {

    static _children = new Map();   // id -> Map(workerIdx -> child process)
    static _timers = new Map();     // id -> setInterval handle
    static _WORKER_FILE = (() => {
        try { return decodeURIComponent(new URL(import.meta.url).pathname); }
        catch (_) { return import.meta.url; }
    })();

    constructor() {
        super(
            'sydb-throughput-tester',
            async (props) => {
                await this._build(props);
            },
            {
                linked: [],
                group: '',
                refreshMode: true
            }
        );
    }

    _stateFor(id) {
        if (!this.Storages.Has(id, 'state')) {
            this.Storages.Set(id, 'state', {
                phase: 'idle',
                host: '127.0.0.1',
                port: 8080,
                power: 100,
                mode: 'duty',
                workers: Math.max(1, os.cpus().length),
                concurrency: 16,
                maxRecords: 1000,
                durationSec: 0,
                ramp: { enabled: false, stepPct: 10, everySec: 10, stepStartAt: 0 },
                runId: null,
                startedAt: 0,
                abortFlag: false,
                loopActive: false,
                stopReason: null,
                showView: 'main',
                outFiles: _outPaths(process.cwd()),
                workerStats: {},
                workersAlive: 0,
                agg: null,
                clientRpsEma: 0,
                peakRps: 0,
                peakServerRps: 0,
                server: { ok: false },
                stepAcc: { n: 0, rps: 0, srps: 0, scpu: 0, p95: 0, fail: 0, sent: 0 },
                errSeen: {},
                lastOutcome: '-',
                lastError: null,
                _ticking: false,
                _lastUiRefresh: 0
            });
        }
        return this.Storages.Get(id, 'state');
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------
    async _build(props) {
        const session = props && props.session;
        if (!session) return;
        const id = session.UniqueID;

        const P = this._stateFor(id);
        const userBuild = this.Builds.get(id);
        const actualProps = (userBuild && userBuild.Session && userBuild.Session.ActualProps) || {};

        if (actualProps.__tp_toggle === '1') {
            delete actualProps.__tp_toggle;
            if (P.phase === 'running') {
                this._stop(id, 'stopped by user');
            } else if (P.phase !== 'stopping') {
                this._start(id).catch((e) => {
                    try {
                        const st = this._stateFor(id);
                        st.phase = 'idle';
                        st.loopActive = false;
                        st.lastError = 'Start failed: ' + (e && (e.stack || e.message) || e);
                        this.Storages.Set(id, 'state', st);
                        this._refreshUi(id);
                    } catch (_) {}
                });
            } else {
                P.lastOutcome = this.TextColor.yellow('wait — currently stopping');
            }
        }

        if (actualProps.__tp_pow_up === '1') {
            delete actualProps.__tp_pow_up;
            this._setPower(id, P.power + 10);
        }
        if (actualProps.__tp_pow_down === '1') {
            delete actualProps.__tp_pow_down;
            this._setPower(id, P.power - 10);
        }
        if (actualProps.__tp_pow_max === '1') {
            delete actualProps.__tp_pow_max;
            this._setPower(id, 100);
        }

        if (actualProps.__tp_mode === '1') {
            delete actualProps.__tp_mode;
            P.mode = P.mode === 'duty' ? 'cpu' : 'duty';
            this._broadcast(id, { type: 'config', mode: P.mode, power: P.power });
            this._resetStepAcc(P);
        }

        if (actualProps.__tp_ramp === '1') {
            delete actualProps.__tp_ramp;
            P.ramp.enabled = !P.ramp.enabled;
            P.ramp.stepStartAt = Date.now();
            this._resetStepAcc(P);
        }

        if (actualProps.__tp_reset === '1') {
            delete actualProps.__tp_reset;
            if (P.phase !== 'running' && P.phase !== 'stopping') {
                P.workerStats = {};
                P.agg = null;
                P.clientRpsEma = 0;
                P.peakRps = 0;
                P.peakServerRps = 0;
                P.server = { ok: false };
                P.errSeen = {};
                P.lastError = null;
                P.lastOutcome = '-';
                P.startedAt = 0;
                P.stopReason = null;
                this._resetStepAcc(P);
            }
        }

        if (actualProps.__tp_view_main === '1') { delete actualProps.__tp_view_main; P.showView = 'main'; }
        if (actualProps.__tp_view_errors === '1') { delete actualProps.__tp_view_errors; P.showView = 'errors'; }
        if (actualProps.__tp_view_samples === '1') { delete actualProps.__tp_view_samples; P.showView = 'samples'; }
        if (actualProps.__tp_view_steps === '1') { delete actualProps.__tp_view_steps; P.showView = 'steps'; }

        this.Storages.Set(id, 'state', P);

        const running = P.phase === 'running' || P.phase === 'stopping';

        this.Text(id, this.TextColor.brightCyan('SyDB Throughput Tester'));

        this.Buttons(id, [
            {
                name: running
                    ? this.TextColor.bgRed(this.TextColor.black(' Stop '))
                    : this.TextColor.bgGreen(this.TextColor.black(' Start ')),
                props: { __tp_toggle: '1' }
            },
            { name: this.TextColor.brightYellow('Power -10'), props: { __tp_pow_down: '1' } },
            { name: this.TextColor.brightYellow('Power +10'), props: { __tp_pow_up: '1' } },
            { name: this.TextColor.brightRed('MAX 100%'), props: { __tp_pow_max: '1' } },
            {
                name: P.mode === 'cpu'
                    ? this.TextColor.bgMagenta(this.TextColor.black(' Mode: CPU target '))
                    : this.TextColor.magenta('Mode: duty cycle'),
                props: { __tp_mode: '1' }
            },
            {
                name: P.ramp.enabled
                    ? this.TextColor.bgYellow(this.TextColor.black(' Ramp ON '))
                    : this.TextColor.brightYellow('Ramp'),
                props: { __tp_ramp: '1' }
            }
        ]);

        this.Buttons(id, [
            {
                name: P.showView === 'main'
                    ? this.TextColor.bgCyan(this.TextColor.black(' Main '))
                    : this.TextColor.brightCyan('Main'),
                props: { __tp_view_main: '1' }
            },
            {
                name: P.showView === 'errors'
                    ? this.TextColor.bgYellow(this.TextColor.black(' Errors '))
                    : this.TextColor.brightYellow('Errors'),
                props: { __tp_view_errors: '1' }
            },
            {
                name: P.showView === 'samples'
                    ? this.TextColor.bgYellow(this.TextColor.black(' Samples '))
                    : this.TextColor.brightYellow('Samples'),
                props: { __tp_view_samples: '1' }
            },
            {
                name: P.showView === 'steps'
                    ? this.TextColor.bgYellow(this.TextColor.black(' Steps '))
                    : this.TextColor.brightYellow('Steps'),
                props: { __tp_view_steps: '1' }
            },
            { name: this.TextColor.brightRed('Reset'), props: { __tp_reset: '1' } }
        ]);

        if (P.showView === 'errors') {
            this.Button(id, { name: this.TextColor.dim('errors.txt') });
            this._fileAsButtons(id, P.outFiles.errorsPath, 40);
            return;
        }
        if (P.showView === 'samples') {
            this.Button(id, { name: this.TextColor.dim('samples.jsonl (last lines)') });
            this._fileAsButtons(id, P.outFiles.samplesPath, 25);
            return;
        }
        if (P.showView === 'steps') {
            this.Button(id, { name: this.TextColor.dim('steps.txt (ramp results)') });
            this._fileAsButtons(id, P.outFiles.stepsPath, 40);
            return;
        }

        // ------------------------------ MAIN VIEW ------------------------------
        const a = P.agg;
        const now = Date.now();
        const elapsed = P.startedAt ? (running ? now - P.startedAt : (P.endedAt || now) - P.startedAt) : 0;

        const phaseText =
            P.phase === 'running'  ? this.TextColor.green('running') :
            P.phase === 'stopping' ? this.TextColor.yellow('stopping') :
            P.phase === 'done'     ? this.TextColor.brightGreen('done') :
                                     this.TextColor.dim('idle');

        this.Button(id, {
            name: this.TextColor.bold('Phase: ') + phaseText +
                this.TextColor.dim(` · elapsed ${_fmtDur(elapsed)} · workers ${P.workersAlive}/${P.workers}` +
                    (P.durationSec > 0 ? ` · limit ${P.durationSec}s` : ''))
        });

        const barLen = 20;
        const filled = Math.round((P.power / 100) * barLen);
        const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
        this.Button(id, {
            name: this.TextColor.bold('Power: ') +
                this.TextColor.brightYellow(`[${bar}] ${P.power}%`) +
                this.TextColor.dim(P.mode === 'cpu' ? ' (target CPU per worker)' : ' (duty cycle)')
        });

        if (P.ramp.enabled) {
            const left = Math.max(0, Math.ceil((P.ramp.everySec * 1000 - (now - P.ramp.stepStartAt)) / 1000));
            this.Button(id, {
                name: this.TextColor.bold('Ramp: ') +
                    this.TextColor.dim(`+${P.ramp.stepPct}% every ${P.ramp.everySec}s · next step in ${running ? left + 's' : '-'}`)
            });
        }

        if (a) {
            const failPct = a.sent > 0 ? (a.fail / a.sent) * 100 : 0;
            this.Button(id, {
                name: this.TextColor.bold('Client: ') +
                    this.TextColor.brightGreen(`${_fmtN(P.clientRpsEma)} req/s`) +
                    this.TextColor.dim(` (peak ${_fmtN(P.peakRps)}) · sent ${_fmtN(a.sent)} · ok ${_fmtN(a.ok)} · `) +
                    (a.fail > 0
                        ? this.TextColor.brightRed(`fail ${_fmtN(a.fail)} (${failPct.toFixed(2)}%)`)
                        : this.TextColor.green('fail 0'))
            });

            this.Button(id, {
                name: this.TextColor.bold('Latency: ') +
                    this.TextColor.dim(`avg ${_fmtMs(a.avgMs)} · p95≈ ${_fmtMs(a.p95Ms)} · p99≈ ${_fmtMs(a.p99Ms)} · max ${_fmtMs(a.maxMs)} · in-flight ${_fmtN(a.inflight)}`)
            });

            const cores = Math.max(1, os.cpus().length);
            this.Button(id, {
                name: this.TextColor.bold('Load generator CPU: ') +
                    this.TextColor.dim(`${a.cpuSum.toFixed(0)}% of ${cores * 100}% (${(a.cpuSum / cores).toFixed(0)}% of this machine)`)
            });

            this.Button(id, {
                name: this.TextColor.bold('Traffic: ') +
                    this.TextColor.dim(`out ${_fmtBytes(a.bytesOut)} · in ${_fmtBytes(a.bytesIn)} · collection wipes ${_fmtN(a.wipes)}`)
            });

            const opsList = Object.keys(a.ops)
                .map((k) => ({ k, n: a.ops[k].n, err: a.ops[k].err }))
                .sort((x, y) => y.n - x.n)
                .slice(0, 6)
                .map((o) => `${o.k} ${_fmtN(o.n)}${o.err ? '(' + _fmtN(o.err) + ' err)' : ''}`)
                .join(' · ');
            this.Button(id, { name: this.TextColor.bold('Ops: ') + this.TextColor.dim(_short(opsList || '-', 150)) });

            const errList = Object.keys(a.errs)
                .map((k) => ({ k, n: a.errs[k] }))
                .sort((x, y) => y.n - x.n)
                .slice(0, 4)
                .map((e) => `${e.k} ${_fmtN(e.n)}`)
                .join(' · ');
            this.Button(id, {
                name: this.TextColor.bold('Errors: ') +
                    (errList ? this.TextColor.brightRed(_short(errList, 150)) : this.TextColor.green('none'))
            });
        } else {
            this.Button(id, { name: this.TextColor.dim('No data yet — press Start') });
        }

        const sv = P.server;
        this.Button(id, {
            name: this.TextColor.bold('Server: ') +
                (sv && sv.ok
                    ? this.TextColor.cyan(
                        `cpu ${sv.cpu.toFixed(0)}%` +
                        (sv.el !== null ? ` · event loop ${sv.el.toFixed(0)}%` : '') +
                        ` · ${_fmtN(sv.rps)} req/s (peak ${_fmtN(P.peakServerRps)})` +
                        ` · in progress ${_fmtN(sv.inProgress)} · p95 ${_fmtMs(sv.p95)} · rss ${_fmtBytes(sv.rss)}`)
                    : this.TextColor.dim('metrics unavailable (server down, or too saturated to answer)'))
        });

        if (P.lastOutcome && P.lastOutcome !== '-') {
            this.Button(id, { name: this.TextColor.bold('Outcome: ') + P.lastOutcome });
        }
        if (P.lastError) {
            this.Button(id, { name: this.TextColor.brightRed('Error: ' + _short(P.lastError, 200)) });
        }

        this.Field(id, 'tp_host', {
            label: 'Host',
            initialValue: P.host,
            maxWidth: 24,
            onChange: (v) => {
                P.host = String(v || '127.0.0.1').trim() || '127.0.0.1';
                this.Storages.Set(id, 'state', P);
            }
        });

        this.Field(id, 'tp_port', {
            label: 'Port',
            initialValue: String(P.port),
            maxWidth: 8,
            onChange: (v) => {
                const n = parseInt(String(v || '').trim(), 10);
                if (!isNaN(n) && n > 0 && n < 65536) {
                    P.port = n;
                    this.Storages.Set(id, 'state', P);
                }
            }
        });

        this.Field(id, 'tp_power', {
            label: 'Power % (1-100, live)',
            initialValue: String(P.power),
            maxWidth: 6,
            onChange: (v) => {
                const n = parseInt(String(v || '').trim(), 10);
                if (!isNaN(n)) this._setPower(id, n);
            }
        });

        this.Field(id, 'tp_workers', {
            label: 'Workers (next start)',
            initialValue: String(P.workers),
            maxWidth: 6,
            onChange: (v) => {
                const n = parseInt(String(v || '').trim(), 10);
                if (!isNaN(n) && n >= 1 && n <= 256) {
                    P.workers = n;
                    this.Storages.Set(id, 'state', P);
                }
            }
        });

        this.Field(id, 'tp_concurrency', {
            label: 'Concurrency/worker (next start)',
            initialValue: String(P.concurrency),
            maxWidth: 6,
            onChange: (v) => {
                const n = parseInt(String(v || '').trim(), 10);
                if (!isNaN(n) && n >= 1 && n <= 2048) {
                    P.concurrency = n;
                    this.Storages.Set(id, 'state', P);
                }
            }
        });

        this.Field(id, 'tp_maxRecords', {
            label: 'Max records/collection (live)',
            initialValue: String(P.maxRecords),
            maxWidth: 8,
            onChange: (v) => {
                const n = parseInt(String(v || '').trim(), 10);
                if (!isNaN(n) && n >= 10) {
                    P.maxRecords = n;
                    this._broadcast(id, { type: 'config', maxRecords: n });
                    this.Storages.Set(id, 'state', P);
                }
            }
        });

        this.Field(id, 'tp_duration', {
            label: 'Duration s (0=inf)',
            initialValue: String(P.durationSec),
            maxWidth: 8,
            onChange: (v) => {
                const n = parseInt(String(v || '').trim(), 10);
                if (!isNaN(n) && n >= 0) {
                    P.durationSec = n;
                    this.Storages.Set(id, 'state', P);
                }
            }
        });

        this.Field(id, 'tp_rampStep', {
            label: 'Ramp step %',
            initialValue: String(P.ramp.stepPct),
            maxWidth: 6,
            onChange: (v) => {
                const n = parseInt(String(v || '').trim(), 10);
                if (!isNaN(n) && n >= 1 && n <= 100) {
                    P.ramp.stepPct = n;
                    this.Storages.Set(id, 'state', P);
                }
            }
        });

        this.Field(id, 'tp_rampEvery', {
            label: 'Ramp every s',
            initialValue: String(P.ramp.everySec),
            maxWidth: 6,
            onChange: (v) => {
                const n = parseInt(String(v || '').trim(), 10);
                if (!isNaN(n) && n >= 2) {
                    P.ramp.everySec = n;
                    this.Storages.Set(id, 'state', P);
                }
            }
        });
    }

    _fileAsButtons(id, filePath, maxLines) {
        try {
            if (!fs.existsSync(filePath)) {
                this.Button(id, { name: this.TextColor.dim('(file does not exist yet)') });
                return;
            }
            const stat = fs.statSync(filePath);
            if (stat.size === 0) {
                this.Button(id, { name: this.TextColor.dim('(empty)') });
                return;
            }
            const READ = 64 * 1024;
            const start = Math.max(0, stat.size - READ);
            const fd = fs.openSync(filePath, 'r');
            const buf = Buffer.alloc(stat.size - start);
            try { fs.readSync(fd, buf, 0, buf.length, start); }
            finally { try { fs.closeSync(fd); } catch (_) {} }
            const all = buf.toString('utf8').split('\n').filter(Boolean);
            const tail = all.slice(-maxLines);
            if (start > 0 || all.length > tail.length) {
                this.Button(id, { name: this.TextColor.dim(`(file ${_fmtBytes(stat.size)} — showing last ${tail.length} line(s))`) });
            }
            for (const l of tail) {
                this.Button(id, { name: l.length > 140 ? l.slice(0, 140) + '…' : l });
            }
        } catch (e) {
            this.Button(id, { name: this.TextColor.red('error reading file: ' + e.message) });
        }
    }

    _refreshUi(id, retries) {
        const self = this;
        const maxRetries = (retries === undefined) ? 6 : retries;

        const tryOnce = (attempt) => {
            try {
                const syapp = self._syappInstance;
                if (!syapp) return;
                const session = syapp.Sessions.get(syapp.MainSessionID);
                if (!session) return;

                if (session.InAction) {
                    if (attempt < maxRetries) setTimeout(() => tryOnce(attempt + 1), 60);
                    return;
                }

                self.Storages.Set(id, 'state', self._stateFor(id));

                syapp.LoadScreen(self.Name, {
                    props: { ...(session.ActualProps || {}) },
                    resetSelection: false
                }).catch(() => {});
            } catch (_) {}
        };

        setImmediate(() => tryOnce(0));
    }

    // ------------------------------------------------------------------
    // Power regulation
    // ------------------------------------------------------------------
    _resetStepAcc(st) {
        st.stepAcc = { n: 0, rps: 0, srps: 0, scpu: 0, p95: 0, fail: 0, sent: 0 };
    }

    _setPower(id, value) {
        const st = this._stateFor(id);
        const p = _clamp(Math.round(Number(value)), 1, 100);
        if (!Number.isFinite(p)) return;
        const changed = p !== st.power;
        st.power = p;
        if (changed) this._resetStepAcc(st);
        this._broadcast(id, { type: 'config', power: p, mode: st.mode });
        this.Storages.Set(id, 'state', st);
    }

    _broadcast(id, msg) {
        const map = SyDBThroughputTester._children.get(id);
        if (!map) return;
        for (const child of map.values()) {
            try { child.send(msg); } catch (_) {}
        }
    }

    // ------------------------------------------------------------------
    // Run control
    // ------------------------------------------------------------------
    async _start(id) {
        const st = this._stateFor(id);

        st.phase = 'running';
        st.abortFlag = false;
        st.loopActive = true;
        st.stopReason = null;
        st.lastError = null;
        st.lastOutcome = '-';
        st.runId = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        st.startedAt = Date.now();
        st.endedAt = 0;
        st.workerStats = {};
        st.workersAlive = 0;
        st.agg = null;
        st.clientRpsEma = 0;
        st.peakRps = 0;
        st.peakServerRps = 0;
        st.server = { ok: false };
        st.errSeen = {};
        st.ramp.stepStartAt = Date.now();
        this._resetStepAcc(st);
        st.outFiles = _openOutputs(process.cwd());
        this.Storages.Set(id, 'state', st);

        let forkFn = null;
        try {
            const cp = await import('child_process');
            if (cp) {
                if (typeof cp.fork === 'function') forkFn = cp.fork;
                else if (cp.default && typeof cp.default.fork === 'function') forkFn = cp.default.fork;
            }
        } catch (_) {}
        if (typeof forkFn !== 'function') {
            st.phase = 'idle';
            st.loopActive = false;
            st.lastError = 'Failed to spawn workers: dynamic import of child_process failed';
            this.Storages.Set(id, 'state', st);
            this._refreshUi(id);
            return;
        }

        const old = SyDBThroughputTester._children.get(id);
        if (old) {
            for (const c of old.values()) { try { c.kill('SIGTERM'); } catch (_) {} }
        }
        const map = new Map();
        SyDBThroughputTester._children.set(id, map);

        for (let idx = 0; idx < st.workers; idx++) {
            let child;
            try {
                child = forkFn(SyDBThroughputTester._WORKER_FILE, [], {
                    env: { ...process.env, SYDB_THROUGHPUT_WORKER: '1' },
                    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
                });
            } catch (e) {
                st.lastError = 'Failed to spawn worker ' + idx + ': ' + (e && e.message || e);
                continue;
            }
            map.set(idx, child);
            this._wireChild(id, idx, child);
        }

        st.workersAlive = map.size;
        if (map.size === 0) {
            st.phase = 'idle';
            st.loopActive = false;
            this.Storages.Set(id, 'state', st);
            this._refreshUi(id);
            return;
        }
        this.Storages.Set(id, 'state', st);

        const prev = SyDBThroughputTester._timers.get(id);
        if (prev) clearInterval(prev);
        const timer = setInterval(() => {
            this._tick(id).catch(() => {});
        }, 1000);
        SyDBThroughputTester._timers.set(id, timer);

        this._refreshUi(id);
    }

    _wireChild(id, idx, child) {
        child.on('message', (msg) => {
            if (!msg) return;
            try {
                const st = this._stateFor(id);
                if (msg.type === 'ready') {
                    child.send({
                        type: 'init',
                        cfg: {
                            idx,
                            host: st.host,
                            port: st.port,
                            power: st.power,
                            mode: st.mode,
                            concurrency: st.concurrency,
                            maxRecords: st.maxRecords,
                            cwd: process.cwd()
                        }
                    });
                } else if (msg.type === 'progress') {
                    const s = msg.stats || {};
                    st.workerStats[idx] = s;
                    if (Array.isArray(s.errs)) {
                        for (const e of s.errs) {
                            if (!st.errSeen[e.kind]) {
                                st.errSeen[e.kind] = true;
                                const f = e.first || {};
                                _appendLine(_errorsFd,
                                    `${new Date().toISOString()} | kind=${e.kind} | worker=${idx} | op=${f.op || '?'} | ` +
                                    `status=${f.status === undefined ? '-' : f.status} | sample=${JSON.stringify(_short(f.sample || '', 200))}`);
                            }
                        }
                    }
                } else if (msg.type === 'fatal') {
                    st.lastError = `Worker ${idx} fatal: ${msg.error}`;
                }
            } catch (_) {}
        });

        child.on('error', (e) => {
            const st = this._stateFor(id);
            st.lastError = `Worker ${idx} error: ` + (e && e.message || e);
        });

        child.on('exit', (code, signal) => {
            const map = SyDBThroughputTester._children.get(id);
            if (map) map.delete(idx);
            const st = this._stateFor(id);
            st.workersAlive = map ? map.size : 0;

            if (!st.abortFlag && st.phase === 'running' && code !== 0 && code !== null &&
                signal !== 'SIGTERM' && signal !== 'SIGKILL') {
                st.lastError = `Worker ${idx} exited unexpectedly (code=${code}, signal=${signal})`;
            }

            if (!map || map.size === 0) this._finalize(id);
        });
    }

    _stop(id, reason) {
        const st = this._stateFor(id);
        if (st.phase !== 'running') return;
        st.phase = 'stopping';
        st.abortFlag = true;
        st.stopReason = reason || 'stopped';
        this.Storages.Set(id, 'state', st);

        this._broadcast(id, { type: 'stop' });

        const killTimer = setTimeout(() => {
            const map = SyDBThroughputTester._children.get(id);
            if (!map) return;
            for (const c of map.values()) { try { c.kill('SIGTERM'); } catch (_) {} }
        }, 4000);
        if (killTimer.unref) killTimer.unref();

        this._refreshUi(id);
    }

    _finalize(id) {
        const st = this._stateFor(id);
        const timer = SyDBThroughputTester._timers.get(id);
        if (timer) { clearInterval(timer); SyDBThroughputTester._timers.delete(id); }
        SyDBThroughputTester._children.delete(id);

        if (st.phase === 'running' || st.phase === 'stopping') {
            this._aggregate(st);
            const reason = st.stopReason || 'workers exited';
            st.phase = (reason === 'duration reached') ? 'done' : 'idle';
            st.lastOutcome = this.TextColor.green(reason) +
                (st.agg ? this.TextColor.dim(` · sent ${_fmtN(st.agg.sent)} · peak ${_fmtN(st.peakRps)} req/s`) : '');
        }
        st.endedAt = Date.now();
        st.abortFlag = false;
        st.loopActive = false;
        st.workersAlive = 0;
        this.Storages.Set(id, 'state', st);
        this._refreshUi(id);
    }

    // ------------------------------------------------------------------
    // 1 Hz controller: aggregate, poll server, log, ramp, duration
    // ------------------------------------------------------------------
    _aggregate(st) {
        const agg = {
            sent: 0, ok: 0, fail: 0, bytesIn: 0, bytesOut: 0, wipes: 0,
            rps: 0, avgMs: 0, p95Ms: 0, p99Ms: 0, maxMs: 0,
            cpuSum: 0, inflight: 0, ops: {}, errs: {}
        };
        let weighted = 0;
        for (const s of Object.values(st.workerStats)) {
            if (!s) continue;
            agg.sent += s.sent || 0;
            agg.ok += s.ok || 0;
            agg.fail += s.fail || 0;
            agg.bytesIn += s.bytesIn || 0;
            agg.bytesOut += s.bytesOut || 0;
            agg.wipes += s.wipes || 0;
            agg.rps += s.rps || 0;
            weighted += (s.avgMs || 0) * (s.rps || 0);
            agg.p95Ms = Math.max(agg.p95Ms, s.p95Ms || 0);
            agg.p99Ms = Math.max(agg.p99Ms, s.p99Ms || 0);
            agg.maxMs = Math.max(agg.maxMs, s.maxMs || 0);
            agg.cpuSum += s.cpuPct || 0;
            agg.inflight += s.inflight || 0;
            if (s.ops) {
                for (const k of Object.keys(s.ops)) {
                    if (!agg.ops[k]) agg.ops[k] = { n: 0, err: 0 };
                    agg.ops[k].n += s.ops[k].n || 0;
                    agg.ops[k].err += s.ops[k].err || 0;
                }
            }
            if (Array.isArray(s.errs)) {
                for (const e of s.errs) agg.errs[e.kind] = (agg.errs[e.kind] || 0) + (e.count || 0);
            }
        }
        agg.avgMs = agg.rps > 0 ? weighted / agg.rps : 0;
        st.agg = agg;
        return agg;
    }

    async _pollServer(st) {
        const base = { host: st.host, port: st.port, method: 'GET', timeoutMs: 2000 };
        const [a, b, c] = await Promise.all([
            httpRequest({ ...base, path: '/api/metrics/instance' }),
            httpRequest({ ...base, path: '/api/metrics/performance' }),
            httpRequest({ ...base, path: '/api/metrics/requests' })
        ]);

        const parse = (res, key) => {
            try {
                if (!res || !res.ok) return null;
                const j = JSON.parse(res.body);
                return (j && j.success === true) ? j[key] : null;
            } catch (_) { return null; }
        };

        const inst = parse(a, 'instance');
        const perf = parse(b, 'performance');
        const reqs = parse(c, 'requests');

        if (!inst && !perf && !reqs) {
            st.server = { ok: false };
            return;
        }

        const resources = (inst && inst.resources) || {};
        const sv = {
            ok: true,
            cpu: Number(resources.cpu_percent) || 0,
            el: (resources.event_loop_utilization_percent === null || resources.event_loop_utilization_percent === undefined)
                ? null : Number(resources.event_loop_utilization_percent),
            rss: (resources.memory && resources.memory.rss_bytes) || 0,
            rps: (perf && perf.requests_per_second && Number(perf.requests_per_second.current)) || 0,
            p95: (perf && perf.processing_time && Number(perf.processing_time.p95_ms)) || 0,
            inProgress: (reqs && Number(reqs.in_progress)) || 0
        };
        st.server = sv;
        if (sv.rps > st.peakServerRps) st.peakServerRps = sv.rps;
    }

    async _tick(id) {
        const st = this._stateFor(id);
        if (st._ticking) return;
        if (st.phase !== 'running' && st.phase !== 'stopping') return;
        st._ticking = true;

        try {
            const agg = this._aggregate(st);

            st.clientRpsEma = st.clientRpsEma === 0 ? agg.rps : (st.clientRpsEma * 0.6 + agg.rps * 0.4);
            if (agg.rps > st.peakRps) st.peakRps = agg.rps;

            await this._pollServer(st);

            const now = Date.now();
            const sv = st.server;

            _appendLine(_samplesFd, JSON.stringify({
                ts: new Date(now).toISOString(),
                t_sec: Math.round((now - st.startedAt) / 1000),
                phase: st.phase,
                power: st.power,
                mode: st.mode,
                workers: st.workersAlive,
                client_rps: Math.round(agg.rps),
                sent: agg.sent,
                ok: agg.ok,
                fail: agg.fail,
                avg_ms: Number(agg.avgMs.toFixed(2)),
                p95_ms: Number(agg.p95Ms.toFixed(2)),
                p99_ms: Number(agg.p99Ms.toFixed(2)),
                inflight: agg.inflight,
                client_cpu_sum: Number(agg.cpuSum.toFixed(1)),
                server_ok: !!sv.ok,
                server_cpu: sv.ok ? Number(sv.cpu.toFixed(1)) : null,
                server_el: sv.ok ? sv.el : null,
                server_rps: sv.ok ? Math.round(sv.rps) : null,
                server_in_progress: sv.ok ? sv.inProgress : null
            }));

            if (st.phase === 'running') {
                // ---- step accumulator (used by Ramp, also reset on power change) ----
                const acc = st.stepAcc;
                acc.n++;
                acc.rps += agg.rps;
                acc.srps += sv.ok ? sv.rps : 0;
                acc.scpu += sv.ok ? sv.cpu : 0;
                acc.p95 = Math.max(acc.p95, agg.p95Ms);
                acc.fail = agg.fail;
                acc.sent = agg.sent;

                if (st.ramp.enabled && (now - st.ramp.stepStartAt) >= st.ramp.everySec * 1000 && acc.n > 0) {
                    _appendLine(_stepsFd,
                        `power=${st.power}% mode=${st.mode} | client_rps_avg=${_fmtN(acc.rps / acc.n)} | ` +
                        `server_rps_avg=${_fmtN(acc.srps / acc.n)} | server_cpu_avg=${(acc.scpu / acc.n).toFixed(0)}% | ` +
                        `p95_ms_max=${acc.p95.toFixed(1)} | total_fail=${acc.fail}/${acc.sent} | samples=${acc.n}`);

                    if (st.power >= 100) {
                        st.ramp.enabled = false;
                        _appendLine(_stepsFd, '--- ramp complete (reached 100%) ---');
                        this._resetStepAcc(st);
                    } else {
                        this._setPower(id, Math.min(100, st.power + st.ramp.stepPct));
                    }
                    st.ramp.stepStartAt = now;
                }

                if (st.durationSec > 0 && (now - st.startedAt) >= st.durationSec * 1000) {
                    this._stop(id, 'duration reached');
                }
            }

            this.Storages.Set(id, 'state', st);
            this._refreshUi(id);
        } finally {
            st._ticking = false;
        }
    }
}

// ============================================================================
// WORKER PROCESS (forked from the class above)
// ============================================================================
async function _workerRunLoop(init) {
    const cfg = {
        idx: init.idx || 0,
        host: init.host || '127.0.0.1',
        port: init.port || 8080,
        power: _clamp(Number(init.power) || 100, 1, 100),
        mode: init.mode === 'cpu' ? 'cpu' : 'duty',
        concurrency: Math.max(1, init.concurrency | 0 || 16),
        maxRecords: Math.max(10, init.maxRecords | 0 || 1000)
    };

    const COLL = `__tp_coll_w${cfg.idx}__`;
    const base = `/api/databases/${encodeURIComponent(DB_NAME)}`;
    const collBase = `${base}/collections/${encodeURIComponent(COLL)}`;
    const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(8, cfg.concurrency * 2) });

    let abort = false;
    let effDuty = cfg.power;
    let cpuPct = 0;

    process.on('message', (msg) => {
        if (!msg) return;
        if (msg.type === 'stop') {
            abort = true;
            openGate();
        } else if (msg.type === 'config') {
            if (typeof msg.power === 'number') {
                cfg.power = _clamp(msg.power, 1, 100);
                if (cfg.mode === 'duty') effDuty = cfg.power;
            }
            if (msg.mode === 'duty' || msg.mode === 'cpu') {
                cfg.mode = msg.mode;
                effDuty = cfg.power;
            }
            if (typeof msg.maxRecords === 'number' && msg.maxRecords >= 10) cfg.maxRecords = msg.maxRecords;
        }
    });
    process.on('disconnect', () => {
        abort = true;
        openGate();
        setTimeout(() => process.exit(0), 500);
    });

    // ------------------------- stats -------------------------
    const S = { sent: 0, ok: 0, fail: 0, bytesIn: 0, bytesOut: 0, wipes: 0, sinceWipe: 0, ops: {}, errs: new Map() };
    let inflight = 0;
    let iv = { t: Date.now(), n: 0, sum: 0, max: 0, samples: [] };

    function record(op, res, okFlag, kind, sample, outBytes) {
        S.sent++;
        S.bytesOut += outBytes;
        S.bytesIn += (res && res.bytes) || 0;
        if (!S.ops[op]) S.ops[op] = { n: 0, err: 0 };
        S.ops[op].n++;
        if (okFlag) {
            S.ok++;
        } else {
            S.fail++;
            S.ops[op].err++;
            let e = S.errs.get(kind);
            if (!e) {
                e = { count: 0, first: { op, status: res && res.status, sample: _short(sample || '', 200) } };
                S.errs.set(kind, e);
            }
            e.count++;
        }
        const ms = res.ms || 0;
        iv.n++;
        iv.sum += ms;
        if (ms > iv.max) iv.max = ms;
        if (iv.samples.length < 2000) iv.samples.push(ms);
    }

    // ------------------------- request (timed) -------------------------
    async function timedRequest(method, pth, bodyStr) {
        const t0 = process.hrtime.bigint();
        const headers = {};
        if (bodyStr !== null) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }
        const res = await httpRequest({
            host: cfg.host, port: cfg.port, method, path: pth, headers,
            body: bodyStr, agent, timeoutMs: REQUEST_TIMEOUT_MS, keepBytes: 256
        });
        res.ms = Number(process.hrtime.bigint() - t0) / 1e6;
        return res;
    }

    // ------------------------- setup / wipe -------------------------
    async function setupCollection() {
        const dbBody = JSON.stringify({ name: DB_NAME });
        await timedRequest('POST', '/api/databases', dbBody);
        const schema = [
            { name: 'name', type: 'string', required: false, indexed: false },
            { name: 'n', type: 'int', required: false, indexed: false },
            { name: 'tag', type: 'string', required: false, indexed: false },
            { name: 'payload', type: 'string', required: false, indexed: false }
        ];
        await timedRequest('POST', `${base}/collections`, JSON.stringify({ name: COLL, schema }));
    }

    const pool = [];
    let wipeP = null;

    async function doWipe() {
        while (inflight > 0 && !abort) await _sleep(2);
        await timedRequest('DELETE', collBase, null);
        await setupCollection();
        pool.length = 0;
        S.sinceWipe = 0;
        S.wipes++;
    }

    // ------------------------- random operations -------------------------
    function pickOp() {
        let r = Math.random() * 100;
        for (const [name, weight] of OPS) {
            if (r < weight) return name;
            r -= weight;
        }
        return 'insert';
    }

    function randString() {
        const len = 8 + _rnd(Math.random() < 0.1 ? 2048 : 256);
        const start = _rnd(_BASE_STRING.length - len > 0 ? _BASE_STRING.length - len : 1);
        return _BASE_STRING.substr(start, len);
    }

    async function doOne() {
        let op = pickOp();
        if ((op === 'update' || op === 'delete' || op === 'find_id') && pool.length === 0) op = 'insert';

        let method = 'GET';
        let pth = '';
        let bodyStr = null;
        let pickedId = null;

        switch (op) {
            case 'insert':
                method = 'POST';
                pth = `${collBase}/instances`;
                bodyStr = JSON.stringify({
                    name: 'n' + Math.random().toString(36).slice(2, 10),
                    n: _rnd(1000000),
                    tag: TAGS[_rnd(TAGS.length)],
                    payload: randString()
                });
                break;
            case 'find_query':
                pth = `${collBase}/instances?query=tag:${TAGS[_rnd(TAGS.length)]}`;
                break;
            case 'find_id':
                pickedId = pool[_rnd(pool.length)];
                pth = `${collBase}/instances?query=_id:${encodeURIComponent(pickedId)}`;
                break;
            case 'update':
                method = 'PUT';
                pickedId = pool[_rnd(pool.length)];
                pth = `${collBase}/instances/${encodeURIComponent(pickedId)}`;
                bodyStr = JSON.stringify({ n: _rnd(1000000), tag: TAGS[_rnd(TAGS.length)] });
                break;
            case 'delete': {
                method = 'DELETE';
                const i = _rnd(pool.length);
                pickedId = pool[i];
                pool.splice(i, 1);
                pth = `${collBase}/instances/${encodeURIComponent(pickedId)}`;
                break;
            }
            case 'list_all':
                pth = `${collBase}/instances`;
                break;
            case 'schema':
                pth = `${collBase}/schema`;
                break;
            case 'list_collections':
                pth = `${base}/collections`;
                break;
            case 'list_databases':
                pth = '/api/databases';
                break;
        }

        inflight++;
        let res;
        try {
            res = await timedRequest(method, pth, bodyStr);
        } finally {
            inflight--;
        }

        let okFlag = false;
        let kind = null;
        let sample = '';
        if (!res.ok) {
            kind = _netErrorKind(res.error);
            sample = res.error;
        } else if (res.status < 200 || res.status >= 300) {
            kind = 'http_' + res.status;
            sample = res.body;
        } else if (res.body.startsWith('{"success":true')) {
            okFlag = true;
        } else if (res.body.startsWith('{"success":false')) {
            kind = 'success_false';
            sample = res.body;
        } else {
            kind = 'bad_body';
            sample = res.body;
        }

        record(op, res, okFlag, kind, sample, bodyStr ? Buffer.byteLength(bodyStr) : 0);

        if (okFlag && op === 'insert') {
            S.sinceWipe++;
            const m = res.body.match(/"id":"([0-9a-f-]{36})"/);
            if (m) {
                if (pool.length < 500) pool.push(m[1]);
                else pool[_rnd(pool.length)] = m[1];
            }
        }

        return kind;
    }

    // ------------------------- POWER GATE (duty cycle) -------------------------
    let gateOpen = true;
    let waiters = [];
    function openGate() {
        gateOpen = true;
        const w = waiters;
        waiters = [];
        for (const r of w) r();
    }

    let cycleTimer = null;
    function cycle() {
        if (abort) return;
        openGate();
        if (effDuty < 99.5) {
            setTimeout(() => { if (!abort) gateOpen = false; }, Math.max(1, Math.round(WINDOW_MS * effDuty / 100)));
        }
        cycleTimer = setTimeout(cycle, WINDOW_MS);
    }

    // CPU measurement + closed-loop controller ("cpu" mode)
    let lastCpu = process.cpuUsage();
    let lastCpuAt = Date.now();
    const controller = setInterval(() => {
        const now = Date.now();
        const dtMs = now - lastCpuAt;
        if (dtMs <= 0) return;
        const d = process.cpuUsage(lastCpu);
        const inst = ((d.user + d.system) / 1000) / dtMs * 100;
        cpuPct = cpuPct === 0 ? inst : (cpuPct * 0.5 + inst * 0.5);
        lastCpu = process.cpuUsage();
        lastCpuAt = now;

        if (cfg.mode === 'cpu') {
            const err = cfg.power - cpuPct;
            effDuty = _clamp(effDuty + err * 0.4, 1, 100);
        } else {
            effDuty = cfg.power;
        }
    }, 250);

    // ------------------------- lanes -------------------------
    async function lane() {
        while (!abort) {
            if (wipeP) { await wipeP; continue; }
            if (!gateOpen) {
                await new Promise((r) => waiters.push(r));
                continue;
            }
            const kind = await doOne();
            if (S.sinceWipe >= cfg.maxRecords && !wipeP) {
                wipeP = doWipe().then(() => { wipeP = null; }, () => { wipeP = null; });
            }
            if (kind && kind.startsWith('net_')) await _sleep(100);
        }
    }

    // ------------------------- progress -------------------------
    function sendProgress(final) {
        const now = Date.now();
        const dt = Math.max(0.001, (now - iv.t) / 1000);
        const sorted = iv.samples.slice().sort((a, b) => a - b);
        const pct = (f) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : 0;

        const stats = {
            sent: S.sent,
            ok: S.ok,
            fail: S.fail,
            bytesIn: S.bytesIn,
            bytesOut: S.bytesOut,
            wipes: S.wipes,
            ops: S.ops,
            errs: Array.from(S.errs, ([kind, v]) => ({ kind, count: v.count, first: v.first })),
            rps: iv.n / dt,
            avgMs: iv.n ? iv.sum / iv.n : 0,
            p95Ms: pct(0.95),
            p99Ms: pct(0.99),
            maxMs: iv.max,
            cpuPct,
            effDuty,
            rssMb: process.memoryUsage().rss / 1048576,
            inflight
        };
        iv = { t: now, n: 0, sum: 0, max: 0, samples: [] };
        try { process.send({ type: 'progress', idx: cfg.idx, final: !!final, stats }); } catch (_) {}
    }

    // ------------------------- go -------------------------
    try { await setupCollection(); } catch (_) {}

    const reporter = setInterval(() => sendProgress(false), WORKER_REPORT_MS);
    cycle();

    const lanes = [];
    for (let i = 0; i < cfg.concurrency; i++) lanes.push(lane());

    await Promise.race([Promise.all(lanes), new Promise(() => {})].slice(0, 1));

    // lanes only end after abort
    clearInterval(reporter);
    clearInterval(controller);
    if (cycleTimer) clearTimeout(cycleTimer);
    sendProgress(true);
    try { agent.destroy(); } catch (_) {}
    setTimeout(() => process.exit(0), 50);
}

if (process.env.SYDB_THROUGHPUT_WORKER === '1' && typeof process.send === 'function') {
    process.on('message', (msg) => {
        if (msg && msg.type === 'init') {
            _workerRunLoop(msg.cfg || {}).catch((e) => {
                try { process.send({ type: 'fatal', error: String(e && (e.stack || e.message) || e) }); } catch (_) {}
                setTimeout(() => process.exit(1), 50);
            });
        }
    });
    try { process.send({ type: 'ready' }); } catch (_) {}
}

export default SyDBThroughputTester;
export {
    SyDBThroughputTester,
    OPS,
    DB_NAME
};
