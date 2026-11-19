import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { pathToFileURL, fileURLToPath } from 'url';
import SyAPP from '../../../SyAPP.js'
import v8 from 'v8'

// Node's default V8 heap limit is computed by Node from the host's
// system RAM. Using the real value (instead of a hardcoded constant)
// keeps the parent-side crash-prevention threshold accurate on any
// machine.
const _NODE_HEAP_LIMIT_MB = (() => {
    try {
        const limit = v8.getHeapStatistics().heap_size_limit;
        if (Number.isFinite(limit) && limit > 0) return Math.floor(limit / 1048576);
    } catch (_) {}
    return 2048;
})();
// ETE (Estimated Time-to-crash Event) threshold for the in-process /
// normal mode. Derived from the actual Node heap limit (which itself
// tracks system RAM). 85% leaves a safe margin while still being an
// accurate representation of the process crash point.
const _PARENT_ETE_MB = Math.max(400, Math.floor(_NODE_HEAP_LIMIT_MB * 0.85));

const SyAPP_Func = SyAPP.Func();

let _findingsFd = null;
let _minimalFd = null;
let _findingsPath = null;
let _minimalPath = null;

function _ensureOutputFiles(baseDir) {
    if (_findingsFd !== null && _minimalFd !== null) {
        return { findingsPath: _findingsPath, minimalPath: _minimalPath };
    }
    const dir = baseDir || process.cwd();
    _findingsPath = path.join(dir, 'sydb_corruption_findings.jsonl');
    _minimalPath = path.join(dir, 'sydb_corruption_minimal.txt');
    try { fs.writeFileSync(_findingsPath, ''); } catch (_) {}
    try { fs.writeFileSync(_minimalPath, ''); } catch (_) {}
    try {
        _findingsFd = fs.openSync(_findingsPath, 'a');
        _minimalFd = fs.openSync(_minimalPath, 'a');
    } catch (_) {
        _findingsFd = null;
        _minimalFd = null;
    }
    return { findingsPath: _findingsPath, minimalPath: _minimalPath };
}

function _appendFinding(record) {
    if (_findingsFd === null) return;
    try { fs.writeSync(_findingsFd, JSON.stringify(record) + '\n'); } catch (_) {}
}

function _appendMinimal(line) {
    if (_minimalFd === null) return;
    try { fs.writeSync(_minimalFd, line + '\n'); } catch (_) {}
}

const CURATED = [
    { group: 'ascii', label: 'A', val: 'A' },
    { group: 'ascii', label: 'a', val: 'a' },
    { group: 'ascii', label: '0', val: '0' },
    { group: 'ascii', label: '9', val: '9' },
    { group: 'ascii', label: '_', val: '_' },
    { group: 'ascii', label: '-', val: '-' },

    { group: 'json', label: 'brace_open',    val: '{' },
    { group: 'json', label: 'brace_close',   val: '}' },
    { group: 'json', label: 'bracket_open',  val: '[' },
    { group: 'json', label: 'bracket_close', val: ']' },
    { group: 'json', label: 'dquote',        val: '"' },
    { group: 'json', label: 'squote',        val: "'" },
    { group: 'json', label: 'colon',         val: ':' },
    { group: 'json', label: 'comma',         val: ',' },
    { group: 'json', label: 'backslash',     val: '\\' },
    { group: 'json', label: 'slash',         val: '/' },

    { group: 'sql', label: 'semicolon',   val: ';' },
    { group: 'sql', label: 'dashdash',    val: '--' },
    { group: 'sql', label: 'sql_comment', val: '/* */' },
    { group: 'sql', label: 'sql_union',   val: "' UNION SELECT * FROM users --" },
    { group: 'sql', label: 'sql_drop',    val: "'; DROP TABLE x; --" },
    { group: 'shell', label: 'dollar',      val: '$' },
    { group: 'shell', label: 'backtick',    val: '`' },
    { group: 'shell', label: 'pipe',        val: '|' },
    { group: 'shell', label: 'amp',         val: '&' },
    { group: 'shell', label: 'semicolon_sh',val: '; rm -rf /' },
    { group: 'shell', label: 'cmd_subst',   val: '$(id)' },
    { group: 'shell', label: 'backtick_id', val: '`id`' },

    { group: 'html', label: 'lt',        val: '<' },
    { group: 'html', label: 'gt',        val: '>' },
    { group: 'html', label: 'script',    val: '<script>alert(1)</script>' },
    { group: 'html', label: 'img_xss',   val: '<img src=x onerror=alert(1)>' },
    { group: 'html', label: 'svg_xss',   val: '<svg/onload=alert(1)>' },
    { group: 'html', label: 'js_proto',  val: 'javascript:alert(1)' },

    { group: 'url', label: 'percent',    val: '%' },
    { group: 'url', label: 'pct00',      val: '%00' },
    { group: 'url', label: 'pct_ff',     val: '%FF' },
    { group: 'url', label: 'pct_bad',    val: '%ZZ' },
    { group: 'url', label: 'double_enc', val: '%2527' },

    { group: 'space', label: 'space',       val: ' ' },
    { group: 'space', label: 'tab',         val: '\t' },
    { group: 'space', label: 'newline',     val: '\n' },
    { group: 'space', label: 'carriage',    val: '\r' },
    { group: 'space', label: 'crlf',        val: '\r\n' },
    { group: 'space', label: 'vtab',        val: '\v' },
    { group: 'space', label: 'formfeed',    val: '\f' },
    { group: 'space', label: 'nbsp',        val: '\u00A0' },
    { group: 'space', label: 'emspace',     val: '\u2003' },
    { group: 'space', label: 'ideographic', val: '\u3000' },

    { group: 'ctrl', label: 'nul',   val: '\u0000' },
    { group: 'ctrl', label: 'soh',   val: '\u0001' },
    { group: 'ctrl', label: 'stx',   val: '\u0002' },
    { group: 'ctrl', label: 'etx',   val: '\u0003' },
    { group: 'ctrl', label: 'bel',   val: '\u0007' },
    { group: 'ctrl', label: 'bs',    val: '\b' },
    { group: 'ctrl', label: 'vt',    val: '\u000B' },
    { group: 'ctrl', label: 'esc',   val: '\u001B' },
    { group: 'ctrl', label: 'us',    val: '\u001F' },
    { group: 'ctrl', label: 'del',   val: '\u007F' },
    { group: 'ctrl', label: 'c1_80', val: '\u0080' },
    { group: 'ctrl', label: 'c1_9f', val: '\u009F' },

    { group: 'ansi', label: 'csi_reset',   val: '\x1B[0m' },
    { group: 'ansi', label: 'csi_clear',   val: '\x1B[2J' },
    { group: 'ansi', label: 'osc_title',   val: '\x1B]0;pwn\x07' },
    { group: 'ansi', label: 'cursor_hide', val: '\x1B[?25l' },

    { group: 'unicode', label: 'zwsp',          val: '\u200B' },
    { group: 'unicode', label: 'zwnj',          val: '\u200C' },
    { group: 'unicode', label: 'zwj',           val: '\u200D' },
    { group: 'unicode', label: 'lrm',           val: '\u200E' },
    { group: 'unicode', label: 'rtl',           val: '\u202E' },
    { group: 'unicode', label: 'bom',           val: '\uFEFF' },
    { group: 'unicode', label: 'replacement',   val: '\uFFFD' },
    { group: 'unicode', label: 'emoji',         val: '😀' },
    { group: 'unicode', label: 'emoji_zwj',     val: '👨‍👩‍👧‍👦' },
    { group: 'unicode', label: 'cjk',           val: '漢字' },
    { group: 'unicode', label: 'arabic',        val: 'مرحبا' },
    { group: 'unicode', label: 'combining',     val: 'e\u0301' },
    { group: 'unicode', label: 'overlong_slash',val: '\uFF0F' },
    { group: 'unicode', label: 'surrogate_pair',val: '\uD83D\uDE00' },

    { group: 'length', label: 'empty',    val: '' },
    { group: 'length', label: 'len_1',    val: 'x' },
    { group: 'length', label: 'len_63',   val: 'x'.repeat(63) },
    { group: 'length', label: 'len_64',   val: 'x'.repeat(64) },
    { group: 'length', label: 'len_255',  val: 'x'.repeat(255) },
    { group: 'length', label: 'len_256',  val: 'x'.repeat(256) },
    { group: 'length', label: 'len_4095', val: 'x'.repeat(4095) },
    { group: 'length', label: 'len_4096', val: 'x'.repeat(4096) },
    { group: 'length', label: 'len_4097', val: 'x'.repeat(4097) },
    { group: 'length', label: 'len_65535',val: 'x'.repeat(65535) },

    { group: 'path', label: 'dotdot',         val: '../' },
    { group: 'path', label: 'dotdot_deep',    val: '../../../../etc/passwd' },
    { group: 'path', label: 'null_in_path',   val: 'a\u0000b' },
    { group: 'path', label: 'abs',            val: '/etc/passwd' },
    { group: 'path', label: 'win_traversal',  val: '..\\..\\windows\\system32' },
    { group: 'path', label: 'percent_dotdot', val: '%2e%2e%2f' },

    { group: 'escape', label: 'raw_quote',     val: 'a"b' },
    { group: 'escape', label: 'raw_backslash', val: 'a\\b' },
    { group: 'escape', label: 'escape_n',      val: '\\n' },
    { group: 'escape', label: 'escape_u',      val: '\\u0041' },
    { group: 'escape', label: 'bad_escape',    val: '\\x' },
    { group: 'escape', label: 'json_within',   val: '{"nested":1}' },

    { group: 'number', label: 'int_max',  val: '9007199254740991' },
    { group: 'number', label: 'int_over', val: '9007199254740992' },
    { group: 'number', label: 'inf',      val: 'Infinity' },
    { group: 'number', label: 'neg_inf',  val: '-Infinity' },
    { group: 'number', label: 'nan',      val: 'NaN' },
    { group: 'number', label: 'exp',      val: '1e309' },
    { group: 'number', label: 'hex',      val: '0xFF' },
    { group: 'number', label: 'plus',     val: '+1' },
    { group: 'number', label: 'leading0', val: '007' },

    { group: 'literal', label: 'true',    val: 'true' },
    { group: 'literal', label: 'false',   val: 'false' },
    { group: 'literal', label: 'null',    val: 'null' },
    { group: 'literal', label: 'undef',   val: 'undefined' },
];

const BOUNDARY_BYTES = [
    0x00, 0x01, 0x02, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D,
    0x1B, 0x1F, 0x20, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28, 0x29,
    0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x30, 0x39, 0x3A, 0x3B,
    0x3C, 0x3D, 0x3E, 0x3F, 0x40, 0x41, 0x5B, 0x5C, 0x5D, 0x5E,
    0x5F, 0x60, 0x7A, 0x7B, 0x7C, 0x7D, 0x7E, 0x7F, 0x80, 0xFF
];

const INTERESTING_CODEPOINTS = [
    0x00, 0x01, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x1B,
    0x1F, 0x20, 0x7F, 0x80, 0x9F, 0xA0, 0xAD, 0xFF,
    0x100, 0x17F, 0x180, 0x1FF,
    0x200, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
    0x2028, 0x2029, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
    0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
    0x300, 0x301, 0x30C, 0x36F,
    0x3FF, 0x400, 0x5D0, 0x627, 0x6D4,
    0x900, 0x93F, 0xE01,
    0x1100, 0x1200,
    0x1F00, 0x1F01,
    0x2000, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D,
    0x2026, 0x2030, 0x20AC, 0x20BF, 0x2122,
    0x2300, 0x2329, 0x232A,
    0x25A0, 0x25B6, 0x2600, 0x2603, 0x2665, 0x266A, 0x26A0,
    0x2700, 0x2764, 0x2795,
    0x3000, 0x3001, 0x3002, 0x3008, 0x3009, 0x3042, 0x30A2, 0x30F6,
    0x4E00, 0x4E8C, 0x9FFF,
    0xA000, 0xAC00, 0xD7A3,
    0xE000, 0xF8FF, 0xF900, 0xFAFF,
    0xFB00, 0xFB50, 0xFE00, 0xFE0F, 0xFEFF,
    0xFF00, 0xFF01, 0xFF5E, 0xFF60, 0xFFE0, 0xFFE5, 0xFFFD, 0xFFFF,
    0x10000, 0x10001, 0x1D100, 0x1D11E, 0x1D400, 0x1D7CE,
    0x1F300, 0x1F600, 0x1F900, 0x1F1E6, 0x1F1E7,
    0x20000, 0x2FFFF,
    0xE0001, 0xE0020, 0xE0100,
    0x10FFFD, 0x10FFFF
];

const STRUCTURE_TEMPLATES = [
    (s) => `{"k":${s}}`,
    (s) => `{"k":"${s}"}`,
    (s) => `[${s}]`,
    (s) => `["${s}"]`,
    (s) => `{"a":${s},"b":1}`,
    (s) => `${s}`,
    (s) => `$${s}$`,
    (s) => `{{${s}}}`,
    (s) => `<<${s}>>`,
    (s) => `\x1b[31m${s}\x1b[0m`,
    (s) => `SELECT * FROM t WHERE x='${s}'`,
    (s) => `SELECT ${s} FROM t`,
    (s) => `INSERT INTO t VALUES('${s}')`,
    (s) => `-- ${s}`,
    (s) => `/* ${s} */`,
    (s) => `<x>${s}</x>`,
    (s) => `<x a="${s}">`,
    (s) => `<script>var a=${s}</script>`,
    (s) => `javascript:${s}`,
    (s) => `data:text/plain,${s}`,
    (s) => `file://${s}`,
    (s) => `http://x/?q=${s}`,
    (s) => `ftp://${s}@x/`,
    (s) => `${s}${s}${s}`,
];

const ENCODERS = [
    { label: 'raw',     fn: (s) => s },
    { label: 'pct',     fn: (s) => encodeURIComponent(s) },
    { label: 'pct_naive', fn: (s) => Array.from(s).map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join('') },
    { label: 'json',    fn: (s) => JSON.stringify(s) },
    { label: 'b64',     fn: (s) => Buffer.from(s, 'utf8').toString('base64') },
    { label: 'hex',     fn: (s) => Buffer.from(s, 'utf8').toString('hex') },
    { label: 'u16le',   fn: (s) => Buffer.from(s, 'utf16le').toString('latin1') },
    { label: 'reverse', fn: (s) => Array.from(s).reverse().join('') },
    { label: 'upcase',  fn: (s) => s.toUpperCase() },
    { label: 'downcase', fn: (s) => s.toLowerCase() },
    { label: 'csv_quote', fn: (s) => `"${s.replace(/"/g, '""')}"` },
    { label: 'sql_quote', fn: (s) => `'${s.replace(/'/g, "''")}'` }
];

const XSS_AND_SQL_PAYLOADS = [
    '<script>alert(1)</script>',
    '"><script>alert(1)</script>',
    "' OR '1'='1",
    "'; DROP TABLE users;--",
    "1' UNION SELECT NULL--",
    "' OR 1=1--",
    '${7*7}',
    '{{7*7}}',
    '<%= 7*7 %>',
    '%{7*7}',
    '#{7*7}',
    '@(7*7)',
    '&{7*7}',
    '`7*7`',
    '$(7*7)',
    '$(touch /tmp/pwned)',
    '|id',
    ';id',
    '&&id',
    '||id',
    '`id`',
    '"; id; "',
    "'; id; '"
];

function _short(s, n) {
    const str = String(s);
    return str.length > n ? str.slice(0, n) + '…' : str;
}

function _prng(seed) {
    let s = seed >>> 0;
    return function next() {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s;
    };
}

function _mutate(seedStr, round) {
    const src = String(seedStr);
    const rng = _prng(0xC0FFEE ^ round);
    const arr = Array.from(src);
    const ops = ['flip', 'insert', 'delete', 'dup', 'replace_hi'];
    const nOps = 1 + (rng() % 4);
    const applied = [];
    for (let i = 0; i < nOps; i++) {
        if (arr.length === 0) { arr.push('A'); applied.push('insert'); continue; }
        const op = ops[rng() % ops.length];
        const idx = rng() % arr.length;
        applied.push(op);
        switch (op) {
            case 'flip':
                arr[idx] = String.fromCharCode((arr[idx].charCodeAt(0) ^ (1 + (rng() % 0x1F))) & 0xFFFF);
                break;
            case 'insert':
                arr.splice(idx, 0, String.fromCharCode(rng() & 0xFF));
                break;
            case 'delete':
                arr.splice(idx, 1);
                break;
            case 'dup':
                arr.splice(idx, 0, arr[idx]);
                break;
            case 'replace_hi': {
                const cp = rng() % 0x10FFFF;
                try { arr[idx] = String.fromCodePoint(cp); } catch (_) { arr[idx] = '?'; }
                break;
            }
        }
    }
    return { val: arr.join(''), ops: applied };
}

function _generateInput(step, srand) {
    const strategyIdx = step % 14;
    switch (strategyIdx) {
        case 0: return _strategyCurated(step);
        case 1: return _strategySingleByte(step);
        case 2: return _strategyBytePair(step);
        case 3: return _strategyByteRun(step);
        case 4: return _strategyCodepoint(step);
        case 5: return _strategyMutation(step);
        case 6: return _strategyStructure(step);
        case 7: return _strategyEncoding(step);
        case 8: return _strategyLengthSweep(step);
        case 9: return _strategyEscapeContext(step);
        case 10: return _strategyPureRandom(step, srand);
        case 11: return _strategyRepeat(step);
        case 12: return _strategyBoundaryNumeric(step);
        case 13: return _strategyWellformed(step);
        default: return _strategyCurated(step);
    }
}

function _strategyCurated(step) {
    const entry = CURATED[(step >> 4) % CURATED.length];
    return { group: 'curated.' + entry.group, label: entry.label, val: entry.val };
}

function _strategySingleByte(step) {
    const b = (step >> 4) & 0xFF;
    const ch = String.fromCharCode(b);
    return {
        group: 'single_byte',
        label: '0x' + b.toString(16).padStart(2, '0'),
        val: ch
    };
}

function _strategyBytePair(step) {
    const i = (step >> 3) % BOUNDARY_BYTES.length;
    const j = ((step >> 3) >> 6) % BOUNDARY_BYTES.length;
    const a = BOUNDARY_BYTES[i], b = BOUNDARY_BYTES[j];
    const val = String.fromCharCode(a) + String.fromCharCode(b);
    return {
        group: 'byte_pair',
        label: `0x${a.toString(16).padStart(2, '0')}+0x${b.toString(16).padStart(2, '0')}`,
        val
    };
}

function _strategyByteRun(step) {
    const b = (step >> 4) & 0xFF;
    const reps = 1 + ((step >> 12) % 64);
    const val = String.fromCharCode(b).repeat(reps);
    return {
        group: 'byte_run',
        label: `0x${b.toString(16).padStart(2, '0')}*${reps}`,
        val
    };
}

function _strategyCodepoint(step) {
    const cp = INTERESTING_CODEPOINTS[(step >> 3) % INTERESTING_CODEPOINTS.length];
    let val;
    try { val = String.fromCodePoint(cp); }
    catch (_) { val = '\uFFFD'; }
    return {
        group: 'codepoint',
        label: 'U+' + cp.toString(16).padStart(4, '0').toUpperCase(),
        val
    };
}

function _strategyMutation(step) {
    const seedEntry = CURATED[(step >> 3) % CURATED.length];
    const round = (step >> 7) & 0xFF;
    const mutated = _mutate(seedEntry.val, round ^ (seedEntry.val.charCodeAt(0) || 0x41));
    return {
        group: 'mutation.' + seedEntry.group,
        label: `${seedEntry.label}[${mutated.ops.join(',')}]`,
        val: mutated.val
    };
}

function _strategyStructure(step) {
    const templateIdx = (step >> 3) % STRUCTURE_TEMPLATES.length;
    const tpl = STRUCTURE_TEMPLATES[templateIdx];
    const seedEntry = CURATED[(step >> 10) % CURATED.length];
    const inner = seedEntry.val;
    let val;
    try { val = tpl(inner); } catch (_) { val = inner; }
    return {
        group: 'structure',
        label: `tpl${templateIdx}(${seedEntry.label})`,
        val
    };
}

function _strategyEncoding(step) {
    const enc = ENCODERS[(step >> 3) % ENCODERS.length];
    const seedEntry = CURATED[(step >> 9) % CURATED.length];
    let val;
    try { val = enc.fn(seedEntry.val); } catch (_) { val = seedEntry.val; }
    return {
        group: 'encoding.' + enc.label,
        label: seedEntry.label,
        val
    };
}

function _strategyLengthSweep(step) {
    const boundaries = [0, 1, 2, 3, 7, 8, 15, 16, 31, 32, 63, 64, 100,
        127, 128, 200, 255, 256, 512, 1000, 1023, 1024, 1025,
        2047, 2048, 4095, 4096, 4097, 8191, 8192, 16383, 16384, 65535, 65536];
    const len = boundaries[(step >> 3) % boundaries.length];
    const ch = ['x', '\u00e9', '\u4e2d', '\u{1F600}', 'A'][(step >> 8) % 5];
    const val = ch.repeat(len);
    return {
        group: 'length_sweep',
        label: `${len}x${ch.codePointAt(0).toString(16)}`,
        val
    };
}

function _strategyEscapeContext(step) {
    const payload = XSS_AND_SQL_PAYLOADS[(step >> 3) % XSS_AND_SQL_PAYLOADS.length];
    const ctx = ['json_str', 'json_key', 'sql', 'shell', 'html', 'url', 'regex', 'template'][(step >> 7) % 8];
    let val = payload;
    switch (ctx) {
        case 'json_str': val = JSON.stringify(payload); break;
        case 'json_key': val = JSON.stringify({ [payload]: 1 }); break;
        case 'sql': val = `'${payload.replace(/'/g, "''")}'`; break;
        case 'shell': val = `echo ${JSON.stringify(payload)}`; break;
        case 'html': val = `<div>${payload}</div>`; break;
        case 'url': val = `?q=${encodeURIComponent(payload)}`; break;
        case 'regex': val = `/(${payload})/`; break;
        case 'template': val = '`' + payload.replace(/`/g, '\\`') + '`'; break;
    }
    return {
        group: 'escape_ctx.' + ctx,
        label: `pl${(step >> 3) % XSS_AND_SQL_PAYLOADS.length}`,
        val
    };
}

function _strategyPureRandom(step, srand) {
    const rng = _prng(srand ^ (step >>> 0));
    const lens = [1, 2, 4, 8, 16, 32, 64, 128, 256];
    const len = lens[rng() % lens.length];
    const bytes = Buffer.alloc(len);
    for (let i = 0; i < len; i++) bytes[i] = rng() & 0xFF;
    let val;
    try { val = bytes.toString('utf8'); } catch (_) { val = ''; }
    return {
        group: 'pure_random',
        label: `${len}B`,
        val
    };
}

function _strategyRepeat(step) {
    const blocks = ['00', 'ff', '1f', '7f', 'ab', '0d0a', 'e282ac', 'f09f9880'];
    const block = blocks[(step >> 3) % blocks.length];
    const reps = 1 + ((step >> 8) % 32);
    const hexStr = block.repeat(reps);
    let val;
    try { val = Buffer.from(hexStr, 'hex').toString('utf8'); }
    catch (_) { val = ''; }
    return {
        group: 'repeat',
        label: `${block}*${reps}`,
        val
    };
}

function _strategyBoundaryNumeric(step) {
    const vals = [
        '0', '-0', '1', '-1',
        '9007199254740991', '9007199254740992', '9007199254740993',
        '-9007199254740992', '18014398509481984',
        '2147483647', '2147483648', '-2147483648', '-2147483649',
        '9223372036854775807', '9223372036854775808',
        '1.7976931348623157e308', '5e-324', '-5e-324',
        '1e309', '-1e309', '1e-309',
        'NaN', 'Infinity', '-Infinity',
        '0x7FFFFFFF', '0xFFFFFFFF', '0xDEADBEEF',
        '1.5', '-1.5', '.5', '5.', '+1', '+.5', '-.5',
        '0000000001', '1_000', '1,000',
        '1e+10', '1E10', '1.5e10', '1.5E-10'
    ];
    const v = vals[(step >> 3) % vals.length];
    return { group: 'numeric', label: 'v' + ((step >> 3) % vals.length), val: v };
}

function _strategyWellformed(step) {
    const vals = [
        '', 'a', 'abc', 'hello', 'Hello, World!',
        '123', '-456', '3.14', '-2.71',
        'true', 'false', 'null', 'undefined',
        'hello world', 'hello\tworld', 'hello\nworld',
        '{"a":1}', '{"a":"b"}', '[1,2,3]', '[]', '{}',
        'null', '1e10', '-1e10',
        'user@example.com', 'http://example.com',
        'ABC123', 'a_b_c', 'kebab-case', 'camelCase',
        'a'.repeat(100), 'a'.repeat(1000),
        '\u00e9', '\u4e2d\u6587', '\u{1F600}'
    ];
    const v = vals[(step >> 3) % vals.length];
    return {
        group: 'wellformed',
        label: 'w' + ((step >> 3) % vals.length),
        val: v
    };
}

function _classifyCorruption(mismatch, entry, sanity) {
    const parts = [];
    parts.push(`kind=${mismatch.kind}`);

    if (mismatch.kind === 'value_mismatch') {
        const sent = String(mismatch.sent);
        const got  = typeof mismatch.got === 'string' ? mismatch.got : JSON.stringify(mismatch.got);
        parts.push(`sent_len=${sent.length}`);
        parts.push(`got_len=${got.length}`);

        let diffAt = -1;
        const max = Math.max(sent.length, got.length);
        for (let i = 0; i < max; i++) {
            if (sent[i] !== got[i]) { diffAt = i; break; }
        }
        if (diffAt >= 0) {
            parts.push(`first_diff_at=${diffAt}`);
            const sentChar = sent[diffAt];
            const gotChar  = got[diffAt];
            parts.push(`sent_char=${JSON.stringify(sentChar ?? null)}`);
            parts.push(`got_char=${JSON.stringify(gotChar ?? null)}`);
            if (sentChar !== undefined) {
                parts.push(`sent_cp=U+${sentChar.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
            }
            if (gotChar !== undefined) {
                parts.push(`got_cp=U+${gotChar.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
            }
        }

        if (sent.length > got.length) parts.push('got_truncated=true');
        if (got.length > sent.length) parts.push('got_expanded=true');
    } else if (mismatch.kind === 'insert_failed') {
        if (mismatch.status != null) parts.push(`http=${mismatch.status}`);
        if (mismatch.error) parts.push(`err=${_short(mismatch.error, 80)}`);
        if (mismatch.body) parts.push(`body=${_short(mismatch.body, 100)}`);
    } else if (mismatch.kind === 'readback_failed') {
        parts.push(`detail=${_short(mismatch.detail || '', 100)}`);
    } else if (mismatch.kind === 'disk_structure') {
        const d = mismatch.detail || {};
        parts.push(`disk=${d.reason}`);
        if (d.at !== undefined) parts.push(`at=${d.at}`);
        if (d.seen !== undefined) parts.push(`seen=${d.seen}`);
        if (d.byte !== undefined) parts.push(`byte=0x${Number(d.byte).toString(16)}`);
        if (d.recordCount !== undefined) parts.push(`recordCount=${d.recordCount}`);
        if (d.fileSize !== undefined) parts.push(`fileSize=${d.fileSize}`);
        if (d.freeOffset !== undefined) parts.push(`freeOffset=${d.freeOffset}`);
    }
    return parts.join(' ');
}

function _inputDescriptor(entry) {
    const s = String(entry.val);
    const bytes = Buffer.from(s, 'utf8');
    const hexAll = bytes.toString('hex');
    const hexShown = hexAll.length > 64 ? hexAll.slice(0, 64) + '…' : hexAll;
    const shown = s.length > 40 ? s.slice(0, 40) + '…' : s;
    return {
        lenBytes: bytes.length,
        lenChars: s.length,
        hex: hexShown,
        preview: shown,
        previewJson: JSON.stringify(shown)
    };
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
                timeout: opts.timeoutMs || 10000
            }, (res) => {
                const chunks = [];
                let total = 0;
                res.on('data', (c) => {
                    total += c.length;
                    if (total > 32 * 1024 * 1024) {
                        try { req.destroy(); } catch (_) {}
                        done({ ok: false, error: 'response_too_large' });
                        return;
                    }
                    chunks.push(c);
                });
                res.on('end', () => done({
                    ok: true,
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8')
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

// Detect connection-level failures that mean the SERVER IS DOWN /
// UNREACHABLE — as opposed to a real data corruption. When this returns
// true, the fuzz loop must NOT count the failure as corruption: it
// simply waits and retries (the server may come back).
//
// Only low-level socket / DNS / timeout errors are treated as
// "unreachable". HTTP responses with 4xx/5xx status codes are NOT
// unreachable — the server answered, so they must still be evaluated
// normally.
function _isServerUnreachable(res) {
    if (!res) return true;
    if (res.ok) return false;
    const err = String(res.error || '').toLowerCase();
    const networkCodes = [
        'econnrefused',
        'econnreset',
        'etimedout',
        'ehostunreach',
        'enetunreach',
        'enotfound',
        'epipe',
        'eaddrnotavail',
        'econnaborted',
        'timeout'
    ];
    for (const code of networkCodes) {
        if (err.includes(code)) return true;
    }
    return false;
}

function sydbBaseDir() {
    return process.env.SYDB_BASE_DIR || '/var/lib/sydb';
}

function _sydbFileSanity(dbName, collName) {
    const filePath = path.join(sydbBaseDir(), dbName, collName, 'data.sydb');
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing_file' };

    let buf;
    try { buf = fs.readFileSync(filePath); }
    catch (e) { return { ok: false, reason: 'unreadable:' + e.message }; }

    if (buf.length < 136) return { ok: false, reason: 'header_truncated', size: buf.length };

    const magic = buf.readUInt32LE(0);
    if (magic !== 0x53594442) return { ok: false, reason: 'bad_magic', magic };

    const version = buf.readUInt32LE(4);
    if (version !== 2) return { ok: false, reason: 'bad_version', version };

    let recordCount, fileSize, freeOffset;
    try {
        recordCount = Number(buf.readBigUInt64LE(8));
        fileSize    = Number(buf.readBigUInt64LE(16));
        freeOffset  = Number(buf.readBigUInt64LE(24));
    } catch (e) {
        return { ok: false, reason: 'header_unreadable:' + e.message };
    }

    if (!Number.isFinite(recordCount) || recordCount < 0)
        return { ok: false, reason: 'bad_recordCount', recordCount };
    if (!Number.isFinite(fileSize) || fileSize < 136)
        return { ok: false, reason: 'bad_fileSize', fileSize };
    if (fileSize > buf.length + 1)
        return { ok: false, reason: 'fileSize_gt_actual', fileSize, actual: buf.length };
    if (!Number.isFinite(freeOffset) || freeOffset > fileSize)
        return { ok: false, reason: 'bad_freeOffset', freeOffset, fileSize };

    let off = 136;
    let seen = 0;
    while (seen < recordCount) {
        if (off + 88 > buf.length)
            return { ok: false, reason: 'record_header_oob', at: off, seen, recordCount };

        let dataSize;
        try { dataSize = Number(buf.readBigUInt64LE(off)); }
        catch (e) { return { ok: false, reason: 'record_dataSize_unreadable', at: off, seen, err: e.message }; }

        if (!Number.isFinite(dataSize) || dataSize < 0)
            return { ok: false, reason: 'record_dataSize_invalid', at: off, seen, dataSize };

        const total = 88 + dataSize + 1;
        if (off + total > buf.length + 1)
            return { ok: false, reason: 'record_oob', at: off, seen, dataSize, actual: buf.length };

        const termAt = off + 88 + dataSize;
        if (termAt < buf.length && buf[termAt] !== 0)
            return { ok: false, reason: 'record_missing_terminator', at: termAt, seen, byte: buf[termAt] };

        off += total;
        seen++;
    }
    return { ok: true, recordCount, fileSize, actualSize: buf.length };
}

function _extractValueFromListResponse(res, id, fieldName) {
    if (!res || !res.ok) return { ok: false, reason: 'no_response' };
    let json;
    try { json = JSON.parse(res.body); }
    catch (e) { return { ok: false, reason: 'response_not_json:' + e.message, raw: _short(res.body, 200) }; }

    if (!json || json.success !== true || !Array.isArray(json.instances))
        return { ok: false, reason: 'unexpected_shape' };

    for (const raw of json.instances) {
        let obj;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            obj = raw;
        } else if (typeof raw === 'string') {
            try { obj = JSON.parse(raw); }
            catch (e) { return { ok: false, reason: 'instance_not_json:' + e.message, raw: _short(raw, 200) }; }
        } else {
            return { ok: false, reason: 'unexpected_instance_type', type: typeof raw };
        }
        if (obj && obj._id === id) return { ok: true, value: obj[fieldName], obj };
    }
    return { ok: false, reason: 'id_not_found', id };
}

function _display(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const hex = Buffer.from(String(s), 'utf8').toString('hex');
    const short = s.length > 40 ? s.slice(0, 40) + '…' : s;
    return JSON.stringify(short) + ' (hex: ' + (hex.length > 120 ? hex.slice(0, 120) + '…' : hex) + ')';
}

function _formatMinimalCause(info) {
    const esc = (v) => {
        if (v === undefined) return 'undefined';
        if (v === null) return 'null';
        const s = String(v);
        const hex = Buffer.from(s, 'utf8').toString('hex');
        return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"(hex:${hex.slice(0, 80)}${hex.length > 80 ? '…' : ''})`;
    };
    return [
        `step=${info.step}`,
        `group=${info.group}`,
        `label=${info.label}`,
        `value=${esc(info.value)}`,
        _classifyCorruption(info.mismatch, { val: info.value }, info.sanity)
    ].join(' | ');
}

const FIELD_NAME = 'f';

const _MAX_LOG_BODY = 8192;
const _MAX_CURATED_INPUT_BYTES = 65536;

class SyDBCorruptionTester extends SyAPP_Func {

    static _childHandles = new Map();
    static _WORKER_FILE = (() => {
        try { return decodeURIComponent(new URL(import.meta.url).pathname); }
        catch (_) { return import.meta.url; }
    })();

    constructor() {
        super(
            'sydb-corruption-tester',
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
                speedMs: 25,
                maxSteps: 0,
                runId: null,
                step: 0,
                lastGroup: '-',
                lastLabel: '-',
                lastValue: '',
                lastOutcome: '-',
                corruptionCount: 0,
                lastCorruption: null,
                lastError: null,
                lastCycleWipeAt: 0,
                srand: (crypto.randomBytes(4).readUInt32LE(0)) || 0xC0FFEE,
                outFiles: _ensureOutputFiles(process.cwd()),
                abortFlag: false,
                loopActive: false,
                showView: 'main',
                showDetail: false,
                rssPeakMb: 0,
                heapPeakMb: 0,
                gcRuns: 0,
                recentLinesCache: null,
                protectedMode: false,
                childRssMb: 0,
                childHeapMb: 0,
                childRssGrowthPerSec: 0,
                mainRssGrowthPerSec: 0,
                stepsPerSec: 0,
                childRestartCount: 0,
                childMemoryLimitHit: false,
                _rateMain: { t: 0, rss: 0, v: 0, init: false },
                _rateChild: { t: 0, rss: 0, v: 0, init: false },
                _rateSteps: { t: 0, step: 0, v: 0, init: false },
                _eteSec: null,
                _eteHit: false,
                _lastUiRefresh: 0,
                _lastParentGc: 0,
                _parentGcRuns: 0
            });
        }
        return this.Storages.Get(id, 'state');
    }

    async _build(props) {
        const session = props && props.session;
        if (!session) return;
        const id = session.UniqueID;

        const P = this._stateFor(id);
        const outFiles = _ensureOutputFiles(process.cwd());
        P.outFiles = outFiles;

        const userBuild = this.Builds.get(id);
        const actualProps = (userBuild && userBuild.Session && userBuild.Session.ActualProps) || {};

        if (actualProps.__tester_protected === '1') {
            delete actualProps.__tester_protected;
            if (P.phase === 'running' || P.phase === 'stopping') {
                P.lastOutcome = this.TextColor.yellow('wait — currently ' + P.phase);
                this.Storages.Set(id, 'state', P);
            } else {
                P.protectedMode = !P.protectedMode;
                P.lastOutcome = P.protectedMode
                    ? this.TextColor.cyan('mode: protected (child process)')
                    : this.TextColor.cyan('mode: default (in-process)');
                this.Storages.Set(id, 'state', P);
            }
        }

        if (actualProps.__tester_toggle === '1') {
            delete actualProps.__tester_toggle;

            if (P.phase === 'running') {
                P.phase = 'stopping';
                P.abortFlag = true;
                if (P.protectedMode) {
                    const child = SyDBCorruptionTester._childHandles.get(id);
                    if (child) {
                        try { child.send({ type: 'stop' }); } catch (_) {}
                    } else {
                        P.phase = 'idle';
                        P.abortFlag = false;
                        P.loopActive = false;
                        P.lastOutcome = this.TextColor.green('stopped (no worker)');
                    }
                }
                this.Storages.Set(id, 'state', P);
            } else if (P.phase !== 'stopping') {
                P.phase = 'running';
                P.abortFlag = false;
                P.step = 0;
                P.lastError = null;
                P.runId = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                P.rssPeakMb = 0;
                P.heapPeakMb = 0;
                P.gcRuns = 0;
                P.childRestartCount = 0;
                P.childMemoryLimitHit = false;
                P.childRssMb = 0;
                P.childHeapMb = 0;
                P.childRssGrowthPerSec = 0;
                P.mainRssGrowthPerSec = 0;
                P.stepsPerSec = 0;
                P._rateMain = { t: 0, rss: 0, v: 0, init: false };
                P._rateChild = { t: 0, rss: 0, v: 0, init: false };
                P._rateSteps = { t: 0, step: 0, v: 0, init: false };
                P._eteSec = null;
                P._eteHit = false;
                P._lastUiRefresh = 0;
                P._lastParentGc = 0;
                P._parentGcRuns = 0;
                this.Storages.Set(id, 'state', P);

                // Clear any stale allocations from previous runs before
                // starting fresh (especially valuable in protected mode).
                if (P.protectedMode) {
                    if (typeof globalThis.__sydbGc === 'function') {
                        for (let _i = 0; _i < 3; _i++) { try { globalThis.__sydbGc(); } catch (_) {} }
                    } else if (typeof global.gc === 'function') {
                        for (let _i = 0; _i < 3; _i++) { try { global.gc(); } catch (_) {} }
                    }
                }

                if (P.protectedMode) {
                    if (!P.loopActive) {
                        P.loopActive = true;
                        this.Storages.Set(id, 'state', P);
                        this._spawnWorker(id, P, 0, P.srand).catch(() => {});
                    }
                } else {
                    if (!P.loopActive) {
                        P.loopActive = true;
                        this.Storages.Set(id, 'state', P);
                        setImmediate(() => {
                            this._runFuzzLoop(id).catch((e) => {
                                try {
                                    const st = this._stateFor(id);
                                    st.phase = 'idle';
                                    st.loopActive = false;
                                    st.lastError = 'Fuzz loop crashed: ' + (e && (e.stack || e.message) || e);
                                    this.Storages.Set(id, 'state', st);
                                    this._refreshUi(id);
                                } catch (_) {}
                            });
                        });
                    }
                }
            }
        }

        if (actualProps.__tester_reset === '1') {
            delete actualProps.__tester_reset;
            P.step = 0;
            P.corruptionCount = 0;
            P.lastCorruption = null;
            P.lastOutcome = '-';
            P.lastGroup = '-';
            P.lastLabel = '-';
            P.lastValue = '';
            P.lastError = null;
            P.srand = (crypto.randomBytes(4).readUInt32LE(0)) || 0xC0FFEE;
            P.rssPeakMb = 0;
            P.heapPeakMb = 0;
            P.gcRuns = 0;
            P.recentLinesCache = null;
            if (P.phase !== 'running') P.phase = 'idle';
            P.abortFlag = false;
            this.Storages.Set(id, 'state', P);
        }

        if (actualProps.__tester_view_main === '1') {
            delete actualProps.__tester_view_main;
            P.showView = 'main';
            this.Storages.Set(id, 'state', P);
        }
        if (actualProps.__tester_view_findings === '1') {
            delete actualProps.__tester_view_findings;
            P.showView = 'findings';
            this.Storages.Set(id, 'state', P);
        }
        if (actualProps.__tester_view_minimal === '1') {
            delete actualProps.__tester_view_minimal;
            P.showView = 'minimal';
            this.Storages.Set(id, 'state', P);
        }
        if (actualProps.__tester_detail === '1') {
            delete actualProps.__tester_detail;
            P.showDetail = !P.showDetail;
            this.Storages.Set(id, 'state', P);
        }

        const running = P.phase === 'running' || P.phase === 'stopping';

        this.Text(id, this.TextColor.brightCyan('SyDB Corruption Tester'));

        this.Buttons(id, [
            {
                name: running
                    ? this.TextColor.bgRed(this.TextColor.black(' Stop '))
                    : this.TextColor.bgGreen(this.TextColor.black(' Start ')),
                props: { __tester_toggle: '1' }
            },
            {
                name: P.protectedMode
                    ? this.TextColor.bgMagenta(this.TextColor.black(' Protected '))
                    : this.TextColor.magenta('Protected'),
                props: { __tester_protected: '1' }
            },
            {
                name: P.showView === 'findings'
                    ? this.TextColor.bgYellow(this.TextColor.black(' Findings '))
                    : this.TextColor.brightYellow('Findings'),
                props: { __tester_view_findings: '1' }
            },
            {
                name: P.showView === 'minimal'
                    ? this.TextColor.bgYellow(this.TextColor.black(' Minimal '))
                    : this.TextColor.brightYellow('Minimal'),
                props: { __tester_view_minimal: '1' }
            },
            {
                name: P.showView === 'main'
                    ? this.TextColor.bgCyan(this.TextColor.black(' Main '))
                    : this.TextColor.brightCyan('Main'),
                props: { __tester_view_main: '1' }
            },
            {
                name: this.TextColor.brightRed('Reset'),
                props: { __tester_reset: '1' }
            }
        ]);

        if (P.showView === 'findings') {
            this.Button(id, { name: this.TextColor.dim('findings.jsonl') });
            this._fileAsButtons(id, P.outFiles.findingsPath, 25);
            return;
        }

        if (P.showView === 'minimal') {
            this.Button(id, { name: this.TextColor.dim('minimal.txt') });
            this._fileAsButtons(id, P.outFiles.minimalPath, 40);
            return;
        }

        const phaseText =
            P.phase === 'running'  ? this.TextColor.green('running') :
            P.phase === 'stopping' ? this.TextColor.yellow('stopping') :
            P.phase === 'done'     ? this.TextColor.brightGreen('done') :
                                     this.TextColor.dim('idle');

        this.Button(id, {
            name: this.TextColor.bold('Phase: ') + phaseText
        });

        this.Button(id, {
            name: this.TextColor.bold('Step: ') + String(P.step) +
                (P.maxSteps > 0 ? this.TextColor.dim(` / ${P.maxSteps}`) : '')
        });

        this.Button(id, {
            name: this.TextColor.bold('Input: ') +
                this.TextColor.yellow(`[${P.lastGroup}] ${P.lastLabel}`)
        });

        this.Button(id, {
            name: this.TextColor.bold('Value: ') + this.TextColor.dim(_display(P.lastValue))
        });

        this.Button(id, {
            name: this.TextColor.bold('Outcome: ') + P.lastOutcome
        });

        this.Button(id, {
            name: this.TextColor.bold('Corruptions: ') +
                (P.corruptionCount > 0
                    ? this.TextColor.brightRed(String(P.corruptionCount))
                    : this.TextColor.green('0'))
        });

        const mem = process.memoryUsage();
        const rssMbExact = mem.rss / 1048576;
        const heapMbExact = mem.heapUsed / 1048576;
        const rssMb = Math.round(rssMbExact);
        const heapMb = Math.round(heapMbExact);
        if (rssMb > P.rssPeakMb) P.rssPeakMb = rssMb;
        if (heapMb > P.heapPeakMb) P.heapPeakMb = heapMb;

        if (!P._rateMain) P._rateMain = { t: 0, rss: 0, v: 0, init: false };
        if (!P._rateChild) P._rateChild = { t: 0, rss: 0, v: 0, init: false };
        if (!P._rateSteps) P._rateSteps = { t: 0, step: 0, v: 0, init: false };
        if (typeof P.childRssMb !== 'number') P.childRssMb = 0;
        if (typeof P.childHeapMb !== 'number') P.childHeapMb = 0;
        if (typeof P.childRestartCount !== 'number') P.childRestartCount = 0;
        if (typeof P.stepsPerSec !== 'number') P.stepsPerSec = 0;
        if (typeof P.mainRssGrowthPerSec !== 'number') P.mainRssGrowthPerSec = 0;
        if (typeof P.childRssGrowthPerSec !== 'number') P.childRssGrowthPerSec = 0;
        if (typeof P._parentGcRuns !== 'number') P._parentGcRuns = 0;

        _updateRateEMA(P._rateMain, rssMbExact);
        _updateRateEMA(P._rateChild, P.childRssMb);
        P.mainRssGrowthPerSec = P._rateMain.v;
        P.childRssGrowthPerSec = P._rateChild.v;

        // Steps/sec — same EMA-of-instantaneous-delta approach used by
        // the protected-mode worker's rateState.stepsV. In normal mode
        // the loop runs here, so update it from P.step. In protected
        // mode the worker's IPC value stays authoritative (no override).
        _updateStepRateEMA(P._rateSteps, P.step);
        if (!P.protectedMode) {
            P.stepsPerSec = P._rateSteps.v;
        }

        // ETE — projected elapsed-time-to-hit for the normal-mode
        // crash-memory threshold (Node heap limit, derived from system
        // RAM). Purely a display metric; the loop's safety check below
        // performs the actual stop when RSS really reaches the limit.
        P._eteSec = _computeEteSec(rssMbExact, P.mainRssGrowthPerSec);
        P._eteHit = rssMbExact >= _PARENT_ETE_MB;

        // Progressive GC in protected mode: keep parent heap low WITHOUT
        // stopping the run. Runs at most every ~5s (throttled via _lastParentGc).
        if (P.protectedMode) {
            const _nowGc = Date.now();
            if (_nowGc - (P._lastParentGc || 0) >= 5000) {
                P._lastParentGc = _nowGc;
                if (typeof globalThis.__sydbGc === 'function') {
                    for (let _i = 0; _i < 2; _i++) {
                        try { globalThis.__sydbGc(); P._parentGcRuns++; } catch (_) {}
                    }
                } else if (typeof global.gc === 'function') {
                    for (let _i = 0; _i < 2; _i++) {
                        try { global.gc(); P._parentGcRuns++; } catch (_) {}
                    }
                }
            }
        }

        this.Storages.Set(id, 'state', P);

        this.Button(id, {
            name: this.TextColor.bold('Rate: ') +
                this.TextColor.dim(P.stepsPerSec.toFixed(2) + ' steps/sec')
        });

        this.Button(id, {
            name: this.TextColor.bold('Memory: ') +
                this.TextColor.dim(`main rss ${rssMb}MB (peak ${P.rssPeakMb}MB, ${_fmtRate(P.mainRssGrowthPerSec)}MB/s) · heap ${heapMb}MB (peak ${P.heapPeakMb}MB) · gc ${P.gcRuns}${P.protectedMode ? ` (parent ${P._parentGcRuns})` : ''}`)
        });

        if (!P.protectedMode) {
            this.Button(id, {
                name: this.TextColor.bold('ETE: ') +
                    (P._eteHit
                        ? this.TextColor.brightRed(`hit @ ${_PARENT_ETE_MB}MB (node heap limit ${_NODE_HEAP_LIMIT_MB}MB) — stopping`)
                        : (P._eteSec === null
                            ? this.TextColor.dim(`— (no growth) · threshold ${_PARENT_ETE_MB}MB · node heap limit ${_NODE_HEAP_LIMIT_MB}MB`)
                            : this.TextColor.cyan(`${_fmtEte(P._eteSec)} to hit ${_PARENT_ETE_MB}MB · node heap limit ${_NODE_HEAP_LIMIT_MB}MB`)))
            });
        }

        if (P.protectedMode) {
            this.Button(id, {
                name: this.TextColor.bold('Child: ') +
                    this.TextColor.dim(`rss ${P.childRssMb.toFixed(1)}MB (${_fmtRate(P.childRssGrowthPerSec)}MB/s) · heap ${P.childHeapMb.toFixed(1)}MB · restarts ${P.childRestartCount} · kill@400MB`)
            });
        }

        if (P.lastCorruption) {
            this.Button(id, {
                name: this.TextColor.brightRed('Last: ' + P.lastCorruption)
            });
        }

        if (P.lastError) {
            this.Button(id, {
                name: this.TextColor.brightRed('Error: ' + P.lastError)
            });
        }

        this.Field(id, 'tester_host', {
            label: 'Host',
            initialValue: P.host,
            maxWidth: 24,
            onChange: (v) => {
                P.host = String(v || '127.0.0.1').trim() || '127.0.0.1';
                this.Storages.Set(id, 'state', P);
            }
        });

        this.Field(id, 'tester_port', {
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

        this.Field(id, 'tester_speed', {
            label: 'Speed (ms)',
            initialValue: String(P.speedMs),
            maxWidth: 8,
            onChange: (v) => {
                const n = parseInt(String(v || '').trim(), 10);
                if (!isNaN(n) && n >= 0 && n <= 10000) {
                    P.speedMs = n;
                    this.Storages.Set(id, 'state', P);
                }
            }
        });

        this.Field(id, 'tester_maxSteps', {
            label: 'Max steps (0=inf)',
            initialValue: String(P.maxSteps),
            maxWidth: 10,
            onChange: (v) => {
                const n = parseInt(String(v || '').trim(), 10);
                if (!isNaN(n) && n >= 0) {
                    P.maxSteps = n;
                    this.Storages.Set(id, 'state', P);
                }
            }
        });

        let recentLines = Array.isArray(P.recentLinesCache) ? P.recentLinesCache : null;
        if (recentLines === null) {
            try {
                if (fs.existsSync(P.outFiles.minimalPath)) {
                    const stat = fs.statSync(P.outFiles.minimalPath);
                    if (stat.size === 0) {
                        recentLines = [];
                    } else {
                        const READ = 64 * 1024;
                        const start = Math.max(0, stat.size - READ);
                        const fd = fs.openSync(P.outFiles.minimalPath, 'r');
                        const buf = Buffer.alloc(stat.size - start);
                        try { fs.readSync(fd, buf, 0, buf.length, start); }
                        finally { try { fs.closeSync(fd); } catch (_) {} }
                        const text = buf.toString('utf8');
                        const lines = text.split('\n').filter(Boolean);
                        recentLines = lines.slice(-5);
                    }
                    P.recentLinesCache = recentLines;
                    this.Storages.Set(id, 'state', P);
                } else {
                    recentLines = [];
                }
            } catch (_) {
                recentLines = [];
            }
        }

        if (recentLines.length > 0) {
            this.Button(id, { name: this.TextColor.brightCyan('Recent corruptions:') });
            for (const l of recentLines) {
                this.Button(id, {
                    name: this.TextColor.dim(l.length > 120 ? l.slice(0, 120) + '…' : l)
                });
            }
        }
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
            if (stat.size > 8 * 1024 * 1024) {
                const fd = fs.openSync(filePath, 'r');
                const READ = 64 * 1024;
                const start = Math.max(0, stat.size - READ);
                const buf = Buffer.alloc(stat.size - start);
                fs.readSync(fd, buf, 0, buf.length, start);
                fs.closeSync(fd);
                const text = buf.toString('utf8');
                const all = text.split('\n').filter(Boolean);
                const tail = all.slice(-maxLines);
                this.Button(id, { name: this.TextColor.dim(`(file ${Math.round(stat.size / 1024 / 1024)}MB — showing last ${tail.length} line(s))`) });
                for (const l of tail) {
                    this.Button(id, {
                        name: l.length > 140 ? l.slice(0, 140) + '…' : l
                    });
                }
                return;
            }
            const content = fs.readFileSync(filePath, 'utf8');
            const all = content.split('\n').filter(Boolean);
            if (all.length === 0) {
                this.Button(id, { name: this.TextColor.dim('(empty)') });
                return;
            }
            const tail = all.slice(-maxLines);
            const skipped = all.length - tail.length;
            if (skipped > 0) {
                this.Button(id, {
                    name: this.TextColor.dim(`… ${skipped} earlier line(s) hidden`)
                });
            }
            for (const l of tail) {
                this.Button(id, {
                    name: l.length > 140 ? l.slice(0, 140) + '…' : l
                });
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
                    if (attempt < maxRetries) {
                        setTimeout(() => tryOnce(attempt + 1), 60);
                    }
                    return;
                }

                const _m = process.memoryUsage();
                const _heapMb = _m.heapUsed / 1048576;
                if (_heapMb >= 550) {
                    if (typeof globalThis.__sydbGc === 'function') {
                        for (let i = 0; i < 3; i++) {
                            try { globalThis.__sydbGc(); } catch (_) {}
                        }
                    }
                    if (attempt < maxRetries) {
                        setTimeout(() => tryOnce(attempt + 1), 250);
                    }
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

    async _runFuzzLoop(id) {
        const tester = this;
        const DB   = '__corruption_test__';
        const COLL = '__corruption_coll__';

        const P = tester._stateFor(id);

        try { await tester._wipeTestNamespace(P, DB, COLL); } catch (_) {}

        try {
            await tester._ensureCollection(P, DB, COLL);
        } catch (e) {
            P.phase = 'idle';
            P.loopActive = false;
            P.lastError = 'Setup failed: ' + (e && e.message || e);
            tester.Storages.Set(id, 'state', P);
            tester._refreshUi(id);
            return;
        }

        let lastRefresh = 0;
        let iterationSinceGc = 0;
        const REFRESH_EVERY_MS = 1200;

        while (true) {
            const st = tester._stateFor(id);

            if (st.abortFlag) {
                st.phase = 'idle';
                st.abortFlag = false;
                st.loopActive = false;
                st.lastOutcome = tester.TextColor.green('stopped by user');
                tester.Storages.Set(id, 'state', st);
                tester._refreshUi(id);
                return;
            }

            if (st.maxSteps > 0 && st.step >= st.maxSteps) {
                st.phase = 'done';
                st.loopActive = false;
                st.lastOutcome = tester.TextColor.green(`reached maxSteps=${st.maxSteps}`);
                tester.Storages.Set(id, 'state', st);
                tester._refreshUi(id);
                return;
            }

            // ETE (Estimated Time-to-crash Event) — normal-mode equivalent
            // of the worker's 400MB restart threshold. Uses the actual
            // Node heap limit (derived from system RAM) as the crash
            // point. Try GC, then namespace wipe, then stop before the
            // process can actually crash.
            {
                const _rssNow = process.memoryUsage().rss / 1048576;
                if (_rssNow >= _PARENT_ETE_MB) {
                    if (typeof globalThis.__sydbGc === 'function') {
                        for (let _i = 0; _i < 3; _i++) { try { globalThis.__sydbGc(); } catch (_) {} }
                    } else if (typeof global.gc === 'function') {
                        for (let _i = 0; _i < 3; _i++) { try { global.gc(); } catch (_) {} }
                    }
                    let _afterGc = process.memoryUsage().rss / 1048576;
                    if (_afterGc >= _PARENT_ETE_MB) {
                        try {
                            await tester._wipeTestNamespace(st, DB, COLL);
                            await tester._ensureCollection(st, DB, COLL);
                        } catch (_) {}
                        if (typeof globalThis.__sydbGc === 'function') {
                            for (let _i = 0; _i < 3; _i++) { try { globalThis.__sydbGc(); } catch (_) {} }
                        } else if (typeof global.gc === 'function') {
                            for (let _i = 0; _i < 3; _i++) { try { global.gc(); } catch (_) {} }
                        }
                        _afterGc = process.memoryUsage().rss / 1048576;
                    }
                    if (_afterGc >= _PARENT_ETE_MB) {
                        st.phase = 'idle';
                        st.abortFlag = false;
                        st.loopActive = false;
                        st.lastOutcome = tester.TextColor.brightRed(
                            'ETE hit: rss ' + Math.round(_afterGc) + 'MB >= ' + _PARENT_ETE_MB +
                            'MB (node heap limit ' + _NODE_HEAP_LIMIT_MB + 'MB) — stopped before crash'
                        );
                        st._eteHit = true;
                        st._eteSec = 0;
                        tester.Storages.Set(id, 'state', st);
                        tester._refreshUi(id);
                        return;
                    }
                }
            }

            const entry = _generateInput(st.step, st.srand);

            if (typeof entry.val === 'string' && entry.val.length * 4 > _MAX_CURATED_INPUT_BYTES * 4) {
                entry.val = entry.val.slice(0, _MAX_CURATED_INPUT_BYTES);
            }

            st.step += 1;
            st.lastGroup = entry.group;
            st.lastLabel = entry.label;
            st.lastValue = entry.val;

            const bodyObj = {};
            bodyObj[FIELD_NAME] = entry.val;
            const bodyStr = JSON.stringify(bodyObj);

            const insertRes = await httpRequest({
                host: st.host,
                port: st.port,
                method: 'POST',
                path: `/api/databases/${encodeURIComponent(DB)}/collections/${encodeURIComponent(COLL)}/instances`,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(bodyStr)
                },
                body: bodyStr,
                timeoutMs: 15000
            });

            // Server-down short-circuit: if the insert failed at the
            // connection level (ECONNREFUSED / timeout / DNS / …) the
            // server is simply unreachable. This is NOT a data
            // corruption — wait and retry instead of counting it.
            if (_isServerUnreachable(insertRes)) {
                st.serverOffline = true;
                st.lastOutcome = tester.TextColor.yellow('server unreachable — waiting (not counted)');
                tester.Storages.Set(id, 'state', st);
                tester._refreshUi(id);
                const waitMs = Math.max(1000, Math.max(0, st.speedMs | 0));
                await new Promise((r) => setTimeout(r, waitMs));
                continue;
            }
            if (st.serverOffline) {
                st.serverOffline = false;
                tester.Storages.Set(id, 'state', st);
            }

            let insertOk = false;
            let insertedId = null;
            if (insertRes.ok && insertRes.status >= 200 && insertRes.status < 300) {
                try {
                    const j = JSON.parse(insertRes.body);
                    if (j && j.success === true && typeof j.id === 'string') {
                        insertOk = true;
                        insertedId = j.id;
                    }
                } catch (_) {}
            }

            let mismatch = null;
            if (insertOk) {
                const listRes = await httpRequest({
                    host: st.host,
                    port: st.port,
                    method: 'GET',
                    path: `/api/databases/${encodeURIComponent(DB)}/collections/${encodeURIComponent(COLL)}/instances?query=_id:${encodeURIComponent(insertedId)}`,
                    timeoutMs: 15000
                });

                // Same server-down short-circuit for the readback step:
                // a connection-level failure here means the server went
                // away between the insert and the readback — not a
                // corruption.
                if (_isServerUnreachable(listRes)) {
                    st.serverOffline = true;
                    st.lastOutcome = tester.TextColor.yellow('server unreachable during readback — waiting (not counted)');
                    tester.Storages.Set(id, 'state', st);
                    tester._refreshUi(id);
                    const waitMs = Math.max(1000, Math.max(0, st.speedMs | 0));
                    await new Promise((r) => setTimeout(r, waitMs));
                    continue;
                }
                if (st.serverOffline) {
                    st.serverOffline = false;
                    tester.Storages.Set(id, 'state', st);
                }

                const extracted = _extractValueFromListResponse(listRes, insertedId, FIELD_NAME);
                if (!extracted.ok) {
                    mismatch = { kind: 'readback_failed', detail: extracted.reason };
                } else if (extracted.value !== entry.val) {
                    mismatch = { kind: 'value_mismatch', sent: entry.val, got: extracted.value };
                }
            } else {
                mismatch = {
                    kind: 'insert_failed',
                    status: insertRes.ok ? insertRes.status : null,
                    error: insertRes.ok ? null : insertRes.error,
                    body: insertRes.ok ? _short(insertRes.body, 200) : null
                };
            }

            const sanity = _sydbFileSanity(DB, COLL);
            if (!mismatch && !sanity.ok) {
                mismatch = { kind: 'disk_structure', detail: sanity };
            }

            if (mismatch) {
                st.corruptionCount += 1;

                const desc = _inputDescriptor(entry);
                const classifier = _classifyCorruption(mismatch, entry, sanity);

                _appendMinimal(_formatMinimalCause({
                    group: entry.group,
                    label: entry.label,
                    value: entry.val,
                    field: FIELD_NAME,
                    db: DB,
                    coll: COLL,
                    mismatch,
                    sanity,
                    step: st.step
                }));

                const full = {
                    ts: new Date().toISOString(),
                    runId: st.runId,
                    step: st.step,
                    host: st.host,
                    port: st.port,
                    db: DB,
                    coll: COLL,
                    field: FIELD_NAME,
                    strategy: entry.group,
                    strategyLabel: entry.label,
                    inputPreview: desc.preview,
                    inputPreviewJson: desc.previewJson,
                    inputLenChars: desc.lenChars,
                    inputLenBytes: desc.lenBytes,
                    inputHex: desc.hex,
                    inputValueUtf8: _short(entry.val, 512),
                    mismatch: {
                        kind: mismatch.kind,
                        status: mismatch.status,
                        error: mismatch.error ? _short(mismatch.error, 200) : undefined,
                        body: mismatch.body ? _short(mismatch.body, 200) : undefined,
                        detail: typeof mismatch.detail === 'string' ? _short(mismatch.detail, 200) : mismatch.detail,
                        sent: typeof mismatch.sent === 'string' ? _short(mismatch.sent, 512) : undefined,
                        got: typeof mismatch.got === 'string' ? _short(mismatch.got, 512) : undefined
                    },
                    classifier,
                    insertedId,
                    insertHttpStatus: insertRes.ok ? insertRes.status : null,
                    insertHttpBody: insertRes.ok ? _short(insertRes.body, _MAX_LOG_BODY) : null,
                    diskSanity: sanity
                };

                try {
                    const listResForLog = await httpRequest({
                        host: st.host,
                        port: st.port,
                        method: 'GET',
                        path: `/api/databases/${encodeURIComponent(DB)}/collections/${encodeURIComponent(COLL)}/instances`,
                        timeoutMs: 15000
                    });
                    if (listResForLog.ok && listResForLog.body && listResForLog.body.length < _MAX_LOG_BODY) {
                        full.listHttpBody = listResForLog.body;
                    }
                } catch (_) {}

                _appendFinding(full);

                st.recentLinesCache = null;
                st.lastCorruption =
                    `[${entry.group}/${entry.label}] ` + classifier;
                st.lastOutcome = tester.TextColor.brightRed('CORRUPTION (recovering)');
                tester.Storages.Set(id, 'state', st);
                tester._refreshUi(id);

                try {
                    await tester._wipeTestNamespace(st, DB, COLL);
                    await tester._ensureCollection(st, DB, COLL);
                    st.lastCycleWipeAt = Date.now();
                    tester.Storages.Set(id, 'state', st);
                    if (typeof globalThis.__sydbGc === 'function') {
                        try { globalThis.__sydbGc(); } catch (_) {}
                    }
                } catch (e) {
                    st.lastError = 'Recovery wipe failed: ' + (e && e.message || e);
                    tester.Storages.Set(id, 'state', st);
                }

                _maybeForceGc(st, ++iterationSinceGc);
                iterationSinceGc = 0;

                const waitMs = Math.max(0, st.speedMs | 0);
                if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
                else await Promise.resolve();

                const now = Date.now();
                if (now - lastRefresh >= REFRESH_EVERY_MS) {
                    lastRefresh = now;
                    tester._refreshUi(id);
                }

                continue;
            }

            st.lastOutcome = tester.TextColor.green('ok');
            tester.Storages.Set(id, 'state', st);

            _maybeForceGc(st, ++iterationSinceGc);

            const waitMs = Math.max(0, st.speedMs | 0);
            if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
            else await Promise.resolve();

            const now = Date.now();
            if (now - lastRefresh >= REFRESH_EVERY_MS) {
                lastRefresh = now;
                tester._refreshUi(id);
            }
        }
    }

    async _spawnWorker(id, st, resumeStep, resumeSrand) {
        const _CH = SyDBCorruptionTester._childHandles;
        const _WF = SyDBCorruptionTester._WORKER_FILE;

        const existing = _CH.get(id);
        if (existing) {
            try { existing.kill('SIGTERM'); } catch (_) {}
            _CH.delete(id);
        }

        // Dynamic import — no top-level import needed for child_process.
        let forkFn = null;
        try {
            const cp = await import('child_process');
            if (cp) {
                if (typeof cp.fork === 'function') forkFn = cp.fork;
                else if (cp.default && typeof cp.default.fork === 'function') forkFn = cp.default.fork;
            }
        } catch (_) {}
        if (typeof forkFn !== 'function') {
            try {
                const mod = await import('module');
                const createRequire = mod && (mod.createRequire || (mod.default && mod.default.createRequire));
                if (typeof createRequire === 'function') {
                    const cp2 = createRequire(import.meta.url)('child_process');
                    if (cp2 && typeof cp2.fork === 'function') forkFn = cp2.fork;
                }
            } catch (_) {}
        }
        if (typeof forkFn !== 'function') {
            const cur = this._stateFor(id);
            cur.phase = 'idle';
            cur.loopActive = false;
            cur.lastError = 'Failed to spawn worker: dynamic import of child_process failed';
            this.Storages.Set(id, 'state', cur);
            this._refreshUi(id);
            return;
        }

        let child;
        try {
            child = forkFn(_WF, [], {
                env: { ...process.env, SYDB_CORRUPT_WORKER: '1' },
                stdio: ['ignore', 'inherit', 'inherit', 'ipc']
            });
        } catch (e) {
            const cur = this._stateFor(id);
            cur.phase = 'idle';
            cur.loopActive = false;
            cur.lastError = 'Failed to spawn worker: ' + (e && e.message || e);
            this.Storages.Set(id, 'state', cur);
            this._refreshUi(id);
            return;
        }

        _CH.set(id, child);

        child.on('message', (msg) => {
            if (!msg) return;
            try {
                if (msg.type === 'ready') {
                    try {
                        child.send({
                            type: 'init',
                            state: {
                                host: st.host,
                                port: st.port,
                                speedMs: st.speedMs,
                                maxSteps: st.maxSteps,
                                srand: (resumeSrand !== undefined) ? resumeSrand : st.srand,
                                step: (resumeStep !== undefined) ? resumeStep : st.step,
                                corruptionCount: st.corruptionCount || 0,
                                runId: st.runId || null,
                                cwd: process.cwd()
                            }
                        });
                    } catch (_) {}
                } else if (msg.type === 'progress') {
                    const s = msg.state || {};
                    const cur = this._stateFor(id);
                    const _prevPhase = cur.phase;
                    const _oldCorruptionCount = cur.corruptionCount;

                    cur.step = (typeof s.step === 'number') ? s.step : cur.step;
                    cur.corruptionCount = (typeof s.corruptionCount === 'number') ? s.corruptionCount : cur.corruptionCount;
                    if (cur.corruptionCount > _oldCorruptionCount) {
                        cur.recentLinesCache = null;
                    }
                    if (typeof s.srand === 'number') cur.srand = s.srand;
                    if (s.lastGroup) cur.lastGroup = s.lastGroup;
                    if (s.lastLabel) cur.lastLabel = s.lastLabel;

                    // Truncate display-only lastValue at 512 chars. Full
                    // value lives in the worker; parent UI only needs a
                    // preview (display truncates to 40 chars anyway).
                    if (typeof s.lastValue === 'string') {
                        cur.lastValue = s.lastValue.length > 512 ? s.lastValue.slice(0, 512) : s.lastValue;
                    }

                    if (s.lastOutcome) cur.lastOutcome = s.lastOutcome;
                    if (s.lastCorruption) cur.lastCorruption = s.lastCorruption;
                    if (s.lastError) cur.lastError = s.lastError;
                    if (typeof s.childRssMb === 'number') cur.childRssMb = s.childRssMb;
                    if (typeof s.childHeapMb === 'number') cur.childHeapMb = s.childHeapMb;
                    if (typeof s.gcRuns === 'number') cur.gcRuns = s.gcRuns;
                    if (typeof s.stepsPerSec === 'number') cur.stepsPerSec = s.stepsPerSec;

                    if (s.phase === 'restarting' && !cur.childMemoryLimitHit) {
                        cur.childMemoryLimitHit = true;
                        cur.childRestartCount = (cur.childRestartCount || 0) + 1;
                        cur.recentLinesCache = null;
                    } else if (s.phase === 'idle' || s.phase === 'done') {
                        cur.phase = s.phase;
                        cur.loopActive = false;
                    }

                    // Progressive parent GC — keep parent heap flat while
                    // worker runs. Uses __sydbGc when available, else global.gc.
                    const _nowGc = Date.now();
                    if (cur.protectedMode && _nowGc - (cur._lastParentGc || 0) >= 5000) {
                        cur._lastParentGc = _nowGc;
                        if (typeof globalThis.__sydbGc === 'function') {
                            for (let _i = 0; _i < 2; _i++) {
                                try { globalThis.__sydbGc(); cur._parentGcRuns = (cur._parentGcRuns || 0) + 1; } catch (_) {}
                            }
                        } else if (typeof global.gc === 'function') {
                            for (let _i = 0; _i < 2; _i++) {
                                try { global.gc(); cur._parentGcRuns = (cur._parentGcRuns || 0) + 1; } catch (_) {}
                            }
                        }
                    }

                    this.Storages.Set(id, 'state', cur);

                    // Throttle UI refresh — same cadence as the in-process
                    // loop's REFRESH_EVERY_MS to avoid LoadScreen churn.
                    // Force refresh immediately on phase transition.
                    const _now = Date.now();
                    const _phaseChanged = cur.phase !== _prevPhase;
                    if (_phaseChanged || (_now - (cur._lastUiRefresh || 0) >= 1200)) {
                        cur._lastUiRefresh = _now;
                        this._refreshUi(id);
                    }
                } else if (msg.type === 'fatal') {
                    const cur = this._stateFor(id);
                    cur.lastError = 'Worker fatal: ' + msg.error;
                    this.Storages.Set(id, 'state', cur);
                }
            } catch (_) {}
        });

        child.on('exit', (code, signal) => {
            _CH.delete(id);
            const cur = this._stateFor(id);

            if (cur.abortFlag) {
                cur.abortFlag = false;
                cur.childMemoryLimitHit = false;
                cur.phase = 'idle';
                cur.loopActive = false;
                cur.lastOutcome = this.TextColor.green('stopped by user');
                if (cur.protectedMode) {
                    if (typeof globalThis.__sydbGc === 'function') {
                        for (let _i = 0; _i < 2; _i++) { try { globalThis.__sydbGc(); } catch (_) {} }
                    } else if (typeof global.gc === 'function') {
                        for (let _i = 0; _i < 2; _i++) { try { global.gc(); } catch (_) {} }
                    }
                }
                this.Storages.Set(id, 'state', cur);
                this._refreshUi(id);
                return;
            }

            if (cur.childMemoryLimitHit) {
                cur.childMemoryLimitHit = false;
                cur.phase = 'running';
                cur.loopActive = true;
                this.Storages.Set(id, 'state', cur);
                if (typeof globalThis.__sydbGc === 'function') {
                    for (let _i = 0; _i < 3; _i++) { try { globalThis.__sydbGc(); } catch (_) {} }
                } else if (typeof global.gc === 'function') {
                    for (let _i = 0; _i < 3; _i++) { try { global.gc(); } catch (_) {} }
                }
                setTimeout(() => {
                    this._spawnWorker(id, cur, cur.step, cur.srand).catch((err) => {
                        try {
                            const st = this._stateFor(id);
                            st.phase = 'idle';
                            st.loopActive = false;
                            st.lastError = 'Restart failed: ' + (err && err.message || err);
                            this.Storages.Set(id, 'state', st);
                            this._refreshUi(id);
                        } catch (_) {}
                    });
                }, 150);
                return;
            }

            if (cur.phase === 'running' || cur.phase === 'stopping') {
                cur.phase = 'idle';
                cur.loopActive = false;
                if (code !== 0 && code !== null && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
                    cur.lastError = `Worker exited unexpectedly (code=${code}, signal=${signal})`;
                } else {
                    cur.lastOutcome = this.TextColor.green('worker stopped');
                }
                if (cur.protectedMode) {
                    if (typeof globalThis.__sydbGc === 'function') {
                        for (let _i = 0; _i < 3; _i++) { try { globalThis.__sydbGc(); } catch (_) {} }
                    } else if (typeof global.gc === 'function') {
                        for (let _i = 0; _i < 3; _i++) { try { global.gc(); } catch (_) {} }
                    }
                }
                this.Storages.Set(id, 'state', cur);
                this._refreshUi(id);
            }
        });

        child.on('error', (e) => {
            const cur = this._stateFor(id);
            cur.lastError = 'Worker error: ' + (e && e.message || e);
            this.Storages.Set(id, 'state', cur);
        });
    }

    async _ensureCollection(st, dbName, collName) {
        await httpRequest({
            host: st.host,
            port: st.port,
            method: 'POST',
            path: '/api/databases',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: dbName }),
            timeoutMs: 10000
        });

        const schema = [{
            name: FIELD_NAME,
            type: 'string',
            required: false,
            indexed: false
        }];
        await httpRequest({
            host: st.host,
            port: st.port,
            method: 'POST',
            path: `/api/databases/${encodeURIComponent(dbName)}/collections`,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: collName, schema }),
            timeoutMs: 10000
        });
    }

    async _wipeTestNamespace(st, dbName, collName) {
        await httpRequest({
            host: st.host,
            port: st.port,
            method: 'DELETE',
            path: `/api/databases/${encodeURIComponent(dbName)}/collections/${encodeURIComponent(collName)}`,
            timeoutMs: 5000
        });
        await httpRequest({
            host: st.host,
            port: st.port,
            method: 'DELETE',
            path: `/api/databases/${encodeURIComponent(dbName)}`,
            timeoutMs: 5000
        });
    }
}

function _updateRateEMA(rate, currentValue) {
    if (!rate) return;
    if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) return;
    const now = Date.now();
    if (!rate.init) {
        rate.init = true;
        rate.t = now;
        rate.rss = currentValue;
        rate.baseT = now;
        rate.baseRss = currentValue;
        rate.v = 0;
        return;
    }
    const elapsed = (now - (rate.baseT || rate.t)) / 1000;
    if (elapsed < 1) return;
    // Cumulative net memory growth per second from the run baseline.
    // This eliminates the GC-induced +/- jitter that an instantaneous
    // delta produces, so the value reflects the net accumulation rate
    // over the whole timeline since the run started.
    rate.v = (currentValue - (rate.baseRss || rate.rss)) / elapsed;
    rate.t = now;
    rate.rss = currentValue;
}

// Steps/sec — identical math to the protected-mode worker's
// rateState.stepsV (EMA of instantaneous delta, dt clamped to [0.5,10]s,
// alpha=0.25). This is the "avg" behaviour the protected mode shows.
function _updateStepRateEMA(rate, currentStep) {
    if (!rate) return;
    if (typeof currentStep !== 'number' || !Number.isFinite(currentStep)) return;
    const now = Date.now();
    if (!rate.init) {
        rate.init = true;
        rate.t = now;
        rate.step = currentStep;
        rate.v = 0;
        return;
    }
    let dt = (now - rate.t) / 1000;
    if (dt < 0.5) return;
    if (dt > 10) dt = 10;
    const delta = (currentStep - rate.step) / dt;
    const alpha = 0.25;
    rate.v = (rate.v * (1 - alpha)) + (delta * alpha);
    rate.t = now;
    rate.step = currentStep;
}

// ETE projection: seconds until RSS crosses the crash-memory threshold,
// based on the current net growth rate. Returns null when growth is
// effectively zero (never hits), 0 when already at/over the threshold.
function _computeEteSec(currentRssMb, growthPerSec) {
    if (typeof currentRssMb !== 'number' || !Number.isFinite(currentRssMb)) return null;
    if (currentRssMb >= _PARENT_ETE_MB) return 0;
    if (typeof growthPerSec !== 'number' || !Number.isFinite(growthPerSec) || growthPerSec <= 0.01) return null;
    return (_PARENT_ETE_MB - currentRssMb) / growthPerSec;
}

function _fmtEte(sec) {
    if (sec === null || !Number.isFinite(sec)) return '—';
    if (sec <= 0) return 'hit';
    if (sec < 60) return Math.round(sec) + 's';
    if (sec < 3600) return (sec / 60).toFixed(1) + 'm';
    return (sec / 3600).toFixed(2) + 'h';
}

function _fmtRate(v) {
    if (!Number.isFinite(v)) return '0.00';
    const sign = v >= 0 ? '+' : '';
    return sign + v.toFixed(2);
}

function _maybeForceGc(st, iteration) {
    const every = iteration <= 10 ? 5 : (iteration <= 100 ? 25 : 100);
    if (iteration % every !== 0) return;

    const mem = process.memoryUsage();
    const rssMb = mem.rss / 1048576;
    const heapMb = mem.heapUsed / 1048576;

    let needGc = false;
    if (heapMb > 256) needGc = true;
    if (rssMb > 512) needGc = true;
    if (iteration % every === 0) needGc = true;

    if (needGc && typeof global.gc === 'function') {
        try {
            global.gc();
            st.gcRuns = (st.gcRuns || 0) + 1;
        } catch (_) {}
    }
}

function _workerEnsureOutputFiles(baseDir) {
    if (_findingsFd !== null && _minimalFd !== null) {
        return { findingsPath: _findingsPath, minimalPath: _minimalPath };
    }
    const dir = baseDir || process.cwd();
    _findingsPath = path.join(dir, 'sydb_corruption_findings.jsonl');
    _minimalPath = path.join(dir, 'sydb_corruption_minimal.txt');
    try {
        _findingsFd = fs.openSync(_findingsPath, 'a');
        _minimalFd = fs.openSync(_minimalPath, 'a');
    } catch (_) {
        _findingsFd = null;
        _minimalFd = null;
    }
    return { findingsPath: _findingsPath, minimalPath: _minimalPath };
}

async function _workerSetup(st, dbName, collName) {
    await httpRequest({
        host: st.host, port: st.port, method: 'POST', path: '/api/databases',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: dbName }), timeoutMs: 10000
    });
    const schema = [{ name: FIELD_NAME, type: 'string', required: false, indexed: false }];
    await httpRequest({
        host: st.host, port: st.port, method: 'POST',
        path: `/api/databases/${encodeURIComponent(dbName)}/collections`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: collName, schema }), timeoutMs: 10000
    });
}

async function _workerWipe(st, dbName, collName) {
    await httpRequest({
        host: st.host, port: st.port, method: 'DELETE',
        path: `/api/databases/${encodeURIComponent(dbName)}/collections/${encodeURIComponent(collName)}`,
        timeoutMs: 5000
    });
    await httpRequest({
        host: st.host, port: st.port, method: 'DELETE',
        path: `/api/databases/${encodeURIComponent(dbName)}`,
        timeoutMs: 5000
    });
}

function _workerMaybeGc(st, iteration) {
    // More aggressive than in-process: every 25 iters up to 100, then
    // every 50. Lower threshold (128MB) so GC runs sooner.
    const every = iteration <= 10 ? 5 : (iteration <= 100 ? 25 : 50);
    if (iteration % every !== 0) return;
    const mem = process.memoryUsage();
    const heapMb = mem.heapUsed / 1048576;
    if (heapMb > 128) {
        if (typeof globalThis.__sydbGc === 'function') {
            try { globalThis.__sydbGc(); st.gcRuns = (st.gcRuns || 0) + 1; return; } catch (_) {}
        }
        if (typeof global.gc === 'function') {
            try { global.gc(); st.gcRuns = (st.gcRuns || 0) + 1; } catch (_) {}
        }
    }
}

async function _workerRunLoop(initialState) {
    const st = initialState || {};
    if (!st.host) st.host = '127.0.0.1';
    if (!st.port) st.port = 8080;
    if (typeof st.speedMs !== 'number') st.speedMs = 25;
    if (typeof st.maxSteps !== 'number') st.maxSteps = 0;
    if (typeof st.step !== 'number') st.step = 0;
    if (typeof st.corruptionCount !== 'number') st.corruptionCount = 0;
    if (!st.srand) st.srand = 0xC0FFEE;
    st.phase = 'running';

    const DB = '__corruption_test__';
    const COLL = '__corruption_coll__';

    let abortFlag = false;
    process.on('message', (msg) => {
        if (msg && msg.type === 'stop') abortFlag = true;
    });
    process.on('disconnect', () => {
        abortFlag = true;
        setTimeout(() => process.exit(0), 500);
    });

    const rateState = { t: 0, step: 0, rss: 0, stepsV: 0, rssV: 0, init: false };

    function updateWorkerRates() {
        const now = Date.now();
        const mem = process.memoryUsage();
        const rssMb = mem.rss / 1048576;
        st.childRssMb = rssMb;
        st.childHeapMb = mem.heapUsed / 1048576;
        if (!rateState.init) {
            rateState.init = true;
            rateState.t = now;
            rateState.step = st.step;
            rateState.rss = rssMb;
            return;
        }
        let dt = (now - rateState.t) / 1000;
        if (dt < 0.5) return;
        if (dt > 10) dt = 10;
        const stepsDelta = (st.step - rateState.step) / dt;
        const rssDelta = (rssMb - rateState.rss) / dt;
        const alpha = 0.25;
        rateState.stepsV = (rateState.stepsV * (1 - alpha)) + (stepsDelta * alpha);
        rateState.rssV = (rateState.rssV * (1 - alpha)) + (rssDelta * alpha);
        rateState.t = now;
        rateState.step = st.step;
        rateState.rss = rssMb;
    }

    function sendProgress(isFinal) {
        updateWorkerRates();
        // Truncate lastValue before sending — big win for IPC bandwidth
        // AND for parent-side state storage (Storages.Set clone cost).
        const _lval = (typeof st.lastValue === 'string' && st.lastValue.length > 512)
            ? st.lastValue.slice(0, 512)
            : st.lastValue;
        try {
            process.send({
                type: 'progress',
                final: !!isFinal,
                state: {
                    step: st.step,
                    corruptionCount: st.corruptionCount,
                    srand: st.srand,
                    lastGroup: st.lastGroup,
                    lastLabel: st.lastLabel,
                    lastValue: _lval,
                    lastOutcome: st.lastOutcome,
                    lastCorruption: st.lastCorruption,
                    lastError: st.lastError,
                    phase: st.phase,
                    childRssMb: st.childRssMb,
                    childHeapMb: st.childHeapMb,
                    gcRuns: st.gcRuns || 0,
                    stepsPerSec: rateState.stepsV,
                    childRssGrowthPerSec: rateState.rssV
                }
            });
        } catch (_) {}
    }

    _workerEnsureOutputFiles(st.cwd || process.cwd());

    try { await _workerWipe(st, DB, COLL); } catch (_) {}
    try {
        await _workerSetup(st, DB, COLL);
    } catch (e) {
        st.lastError = 'Setup failed: ' + (e && e.message || e);
        st.phase = 'idle';
        sendProgress(true);
        setTimeout(() => process.exit(0), 50);
        return;
    }

    let lastSend = 0;
    let iterationSinceGc = 0;
    const SEND_EVERY_MS = 500;

    while (true) {
        if (abortFlag) {
            st.phase = 'idle';
            st.lastOutcome = 'stopped by user';
            sendProgress(true);
            break;
        }

        if (st.maxSteps > 0 && st.step >= st.maxSteps) {
            st.phase = 'done';
            st.lastOutcome = `reached maxSteps=${st.maxSteps}`;
            sendProgress(true);
            break;
        }

        const memCheck = process.memoryUsage();
        const rssMbCheck = memCheck.rss / 1048576;
        st.childRssMb = rssMbCheck;
        st.childHeapMb = memCheck.heapUsed / 1048576;

        // Graceful memory threshold handling: try GC first. Only restart
        // if GC cannot bring RSS back under 400MB. This makes restarts
        // much rarer for workloads where growth is mostly garbage.
        if (rssMbCheck >= 400) {
            let reclaimed = false;
            if (typeof globalThis.__sydbGc === 'function') {
                for (let _i = 0; _i < 3; _i++) { try { globalThis.__sydbGc(); } catch (_) {} }
                reclaimed = true;
            } else if (typeof global.gc === 'function') {
                for (let _i = 0; _i < 3; _i++) { try { global.gc(); } catch (_) {} }
                reclaimed = true;
            }
            if (reclaimed) {
                const afterRss = process.memoryUsage().rss / 1048576;
                st.childRssMb = afterRss;
                st.gcRuns = (st.gcRuns || 0) + 1;
                if (afterRss < 400) {
                    // GC succeeded — keep running without restart.
                    sendProgress(false);
                    await Promise.resolve();
                    continue;
                }
            }
            st.phase = 'restarting';
            st.lastOutcome = 'memory limit 400MB reached - restarting gracefully';
            sendProgress(true);
            break;
        }

        const entry = _generateInput(st.step, st.srand);
        if (typeof entry.val === 'string' && entry.val.length > _MAX_CURATED_INPUT_BYTES) {
            entry.val = entry.val.slice(0, _MAX_CURATED_INPUT_BYTES);
        }

        st.step += 1;
        st.lastGroup = entry.group;
        st.lastLabel = entry.label;
        st.lastValue = entry.val;

        const bodyObj = {};
        bodyObj[FIELD_NAME] = entry.val;
        const bodyStr = JSON.stringify(bodyObj);

        const insertRes = await httpRequest({
            host: st.host, port: st.port, method: 'POST',
            path: `/api/databases/${encodeURIComponent(DB)}/collections/${encodeURIComponent(COLL)}/instances`,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
            },
            body: bodyStr, timeoutMs: 15000
        });

        if (_isServerUnreachable(insertRes)) {
            st.lastOutcome = 'server unreachable — waiting (not counted)';
            sendProgress(false);
            await new Promise((r) => setTimeout(r, Math.max(1000, st.speedMs | 0)));
            continue;
        }

        let insertOk = false;
        let insertedId = null;
        if (insertRes.ok && insertRes.status >= 200 && insertRes.status < 300) {
            try {
                const j = JSON.parse(insertRes.body);
                if (j && j.success === true && typeof j.id === 'string') {
                    insertOk = true;
                    insertedId = j.id;
                }
            } catch (_) {}
        }

        let mismatch = null;
        if (insertOk) {
            const listRes = await httpRequest({
                host: st.host, port: st.port, method: 'GET',
                path: `/api/databases/${encodeURIComponent(DB)}/collections/${encodeURIComponent(COLL)}/instances?query=_id:${encodeURIComponent(insertedId)}`,
                timeoutMs: 15000
            });

            if (_isServerUnreachable(listRes)) {
                st.lastOutcome = 'server unreachable during readback — waiting (not counted)';
                sendProgress(false);
                await new Promise((r) => setTimeout(r, Math.max(1000, st.speedMs | 0)));
                continue;
            }

            const extracted = _extractValueFromListResponse(listRes, insertedId, FIELD_NAME);
            if (!extracted.ok) {
                mismatch = { kind: 'readback_failed', detail: extracted.reason };
            } else if (extracted.value !== entry.val) {
                mismatch = { kind: 'value_mismatch', sent: entry.val, got: extracted.value };
            }
        } else {
            mismatch = {
                kind: 'insert_failed',
                status: insertRes.ok ? insertRes.status : null,
                error: insertRes.ok ? null : insertRes.error,
                body: insertRes.ok ? _short(insertRes.body, 200) : null
            };
        }

        const sanity = _sydbFileSanity(DB, COLL);
        if (!mismatch && !sanity.ok) {
            mismatch = { kind: 'disk_structure', detail: sanity };
        }

        if (mismatch) {
            st.corruptionCount += 1;

            const desc = _inputDescriptor(entry);
            const classifier = _classifyCorruption(mismatch, entry, sanity);

            _appendMinimal(_formatMinimalCause({
                group: entry.group,
                label: entry.label,
                value: entry.val,
                field: FIELD_NAME,
                db: DB,
                coll: COLL,
                mismatch,
                sanity,
                step: st.step
            }));

            const full = {
                ts: new Date().toISOString(),
                runId: st.runId || null,
                step: st.step,
                host: st.host,
                port: st.port,
                db: DB,
                coll: COLL,
                field: FIELD_NAME,
                strategy: entry.group,
                strategyLabel: entry.label,
                inputPreview: desc.preview,
                inputPreviewJson: desc.previewJson,
                inputLenChars: desc.lenChars,
                inputLenBytes: desc.lenBytes,
                inputHex: desc.hex,
                inputValueUtf8: _short(entry.val, 512),
                mismatch: {
                    kind: mismatch.kind,
                    status: mismatch.status,
                    error: mismatch.error ? _short(mismatch.error, 200) : undefined,
                    body: mismatch.body ? _short(mismatch.body, 200) : undefined,
                    detail: typeof mismatch.detail === 'string' ? _short(mismatch.detail, 200) : mismatch.detail,
                    sent: typeof mismatch.sent === 'string' ? _short(mismatch.sent, 512) : undefined,
                    got: typeof mismatch.got === 'string' ? _short(mismatch.got, 512) : undefined
                },
                classifier,
                insertedId,
                insertHttpStatus: insertRes.ok ? insertRes.status : null,
                insertHttpBody: insertRes.ok ? _short(insertRes.body, _MAX_LOG_BODY) : null,
                diskSanity: sanity
            };

            try {
                const listResForLog = await httpRequest({
                    host: st.host, port: st.port, method: 'GET',
                    path: `/api/databases/${encodeURIComponent(DB)}/collections/${encodeURIComponent(COLL)}/instances`,
                    timeoutMs: 15000
                });
                if (listResForLog.ok && listResForLog.body && listResForLog.body.length < _MAX_LOG_BODY) {
                    full.listHttpBody = listResForLog.body;
                }
            } catch (_) {}

            _appendFinding(full);

            st.lastCorruption = `[${entry.group}/${entry.label}] ` + classifier;
            st.lastOutcome = 'CORRUPTION (recovering)';

            try {
                await _workerWipe(st, DB, COLL);
                await _workerSetup(st, DB, COLL);
            } catch (e) {
                st.lastError = 'Recovery wipe failed: ' + (e && e.message || e);
            }

            _workerMaybeGc(st, ++iterationSinceGc);
            iterationSinceGc = 0;

            sendProgress(false);

            const waitMs = Math.max(0, st.speedMs | 0);
            if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
            else await Promise.resolve();

            lastSend = Date.now();
            continue;
        }

        st.lastOutcome = 'ok';
        _workerMaybeGc(st, ++iterationSinceGc);

        const waitMs = Math.max(0, st.speedMs | 0);
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        else await Promise.resolve();

        const now = Date.now();
        if (now - lastSend >= SEND_EVERY_MS) {
            lastSend = now;
            sendProgress(false);
        }
    }

    setTimeout(() => process.exit(0), 50);
}

if (process.env.SYDB_CORRUPT_WORKER === '1' && typeof process.send === 'function') {
    process.on('message', (msg) => {
        if (msg && msg.type === 'init') {
            _workerRunLoop(msg.state || {}).catch((e) => {
                try { process.send({ type: 'fatal', error: String(e && (e.stack || e.message) || e) }); } catch (_) {}
                setTimeout(() => process.exit(1), 50);
            });
        }
    });
    try { process.send({ type: 'ready' }); } catch (_) {}
}

export default SyDBCorruptionTester;
export {
    SyDBCorruptionTester,
    CURATED,
    FIELD_NAME,
    _generateInput
};
