// codeParser.js — v7.0
// Parser/filtro estrutural de arquivos JS/TS.
// Integrated with Struct.js for fluid parsing during file selection.
//
// Arquitetura (cada camada é independente e testável isoladamente):
//   Tokenizer      -> transforma o texto em registros de linha (código limpo, spans de
//                     comentário, profundidade de chaves). Nenhuma decisão semântica.
//   StructureParser-> constrói a árvore (imports/exports/containers/functions/variables).
//   Selection      -> normaliza o objeto de seleção (aceita formato legado v5).
//   CommentStripper-> aplica os modos de remoção de comentário/JSDoc sobre as linhas emitidas.
//   CodeEmitter    -> monta o código filtrado de forma hierárquica (header + membros + footer),
//                     que é o que garante saída sem erro de sintaxe.
//   CodeParser     -> fachada estática (API pública).
//   CLIMenu        -> interface de linha de comando.
//   TestRunner     -> suíte de testes automatizados (ativada com --test).

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

/* ============================================================================
 * CONSTANTES
 * ========================================================================== */

const COMMENT_MODES = ['keep', 'top-level', 'all'];

const MODE_LABEL = {
    'keep': 'KEEP        (mantém todos)',
    'top-level': 'TOP-LEVEL   (remove só a camada principal)',
    'all': 'ALL         (remove tudo, inclusive dentro de classes)'
};

const OPENERS = '([{';
const CLOSERS = ')]}';

const RE_CONTINUES = /[,+\-*/%&|^~=<>?:.([{!]$/;
const RE_CONTINUATION_START = /^(?:[.)\]},]|\?\.|&&|\|\||=>|\+|-|\*|\/|:|extends\b|implements\b)/;
const RE_KEYWORD_BEFORE_REGEX = /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw)$/;

/* ============================================================================
 * 1. TOKENIZER
 * ========================================================================== */

class Tokenizer {
    static tokenize(code) {
        const raw = code.split('\n');
        const lines = [];

        let depth = 0;
        let inBlock = false;
        let blockIsDoc = false;
        let blockDepth = 0;
        let blockId = 0;
        let idCounter = 0;
        let inTemplate = false;
        let tail = '';

        for (let i = 0; i < raw.length; i++) {
            const original = raw[i];
            const rec = {
                num: i + 1,
                original,
                clean: '',
                comments: [],
                depthStart: depth,
                hasCode: false,
                commentOnly: false
            };

            let clean = '';
            let span = null;
            let inString = false;
            let stringChar = '';
            let inLine = false;
            let j = 0;

            const openSpan = (col, kind, isDoc, d, id) => {
                span = { start: col, end: original.length, kind, isDoc, depth: d, blockId: id };
            };
            const closeSpan = (col) => {
                if (!span) return;
                span.end = Math.min(col, original.length);
                if (span.end > span.start) rec.comments.push(span);
                span = null;
            };

            if (inBlock) openSpan(0, 'block', blockIsDoc, blockDepth, blockId);

            while (j < original.length) {
                const ch = original[j];
                const next = j + 1 < original.length ? original[j + 1] : '';

                if (inBlock) {
                    if (ch === '*' && next === '/') {
                        inBlock = false;
                        clean += '  ';
                        j += 2;
                        closeSpan(j);
                        continue;
                    }
                    clean += ' ';
                    j++;
                    continue;
                }

                if (inLine) { clean += ' '; j++; continue; }

                if (inTemplate) {
                    if (ch === '\\') { clean += '  '; j += 2; continue; }
                    if (ch === '`') { inTemplate = false; tail = (tail + '_').slice(-24); clean += ' '; j++; continue; }
                    clean += ' '; j++;
                    continue;
                }

                if (inString) {
                    if (ch === '\\') { clean += '  '; j += 2; continue; }
                    if (ch === stringChar) { inString = false; tail = (tail + '_').slice(-24); }
                    clean += ' '; j++;
                    continue;
                }

                if (ch === '/' && next === '/') {
                    inLine = true;
                    openSpan(j, 'line', false, depth, ++idCounter);
                    clean += '  ';
                    j += 2;
                    continue;
                }

                if (ch === '/' && next === '*') {
                    inBlock = true;
                    blockIsDoc = original[j + 2] === '*';
                    blockDepth = depth;
                    blockId = ++idCounter;
                    openSpan(j, 'block', blockIsDoc, blockDepth, blockId);
                    clean += '  ';
                    j += 2;
                    continue;
                }

                if (ch === '/' && this.#regexAllowedAfter(tail)) {
                    const end = this.#findRegexEnd(original, j);
                    if (end !== -1) {
                        clean += ' '.repeat(end - j + 1);
                        tail = (tail + '_').slice(-24);
                        j = end + 1;
                        continue;
                    }
                }

                if (ch === '"' || ch === "'") {
                    inString = true;
                    stringChar = ch;
                    clean += ' ';
                    j++;
                    continue;
                }

                if (ch === '`') { inTemplate = true; clean += ' '; j++; continue; }

                if (ch === '{') depth++;
                else if (ch === '}') depth = Math.max(0, depth - 1);

                clean += ch;
                tail = (tail + ch).slice(-24);
                j++;
            }

            closeSpan(original.length);

            rec.clean = clean;
            rec.hasCode = clean.trim().length > 0;
            rec.commentOnly = !rec.hasCode && rec.comments.length > 0;
            lines.push(rec);
        }

        return lines;
    }

    static #regexAllowedAfter(tail) {
        const t = tail.replace(/\s+$/, '');
        if (!t) return true;
        const last = t[t.length - 1];
        if (last === ')' || last === ']') return false;
        if (/[\w$]/.test(last)) return RE_KEYWORD_BEFORE_REGEX.test(t);
        return true;
    }

    static #findRegexEnd(line, start) {
        let inClass = false;
        for (let i = start + 1; i < line.length; i++) {
            const ch = line[i];
            if (ch === '\\') { i++; continue; }
            if (inClass) { if (ch === ']') inClass = false; continue; }
            if (ch === '[') { inClass = true; continue; }
            if (ch === '/') return i;
        }
        return -1;
    }

    static collectBlocks(lines) {
        const byId = new Map();
        for (const rec of lines) {
            for (const span of rec.comments) {
                let entry = byId.get(span.blockId);
                if (!entry) {
                    entry = {
                        type: span.kind,
                        isDoc: span.isDoc,
                        depth: span.depth,
                        lineStart: rec.num,
                        lineEnd: rec.num,
                        content: []
                    };
                    byId.set(span.blockId, entry);
                }
                entry.lineEnd = rec.num;
                entry.content.push(rec.original.slice(span.start, span.end));
            }
        }
        return [...byId.values()].map(e => ({ ...e, content: e.content.join('\n') }));
    }
}

/* ============================================================================
 * 2. UTILITÁRIOS DE VARREDURA
 * ========================================================================== */

class Scanner {
    static findBlockEnd(lines, startIdx, startCol, maxIdx) {
        let depth = 0;
        let started = false;

        for (let i = startIdx; i <= maxIdx && i < lines.length; i++) {
            const text = lines[i].clean;
            const from = i === startIdx ? startCol : 0;
            for (let j = from; j < text.length; j++) {
                const ch = text[j];
                if (ch === '{') { depth++; started = true; }
                else if (ch === '}') {
                    depth--;
                    if (started && depth === 0) return { idx: i, col: j };
                }
            }
        }
        return { idx: Math.min(maxIdx, lines.length - 1), col: -1 };
    }

    static findBodyStart(lines, startIdx, startCol, maxIdx) {
        let paren = 0;
        let angle = 0;
        let seenParen = false;

        for (let i = startIdx; i <= maxIdx && i < lines.length; i++) {
            const text = lines[i].clean;
            const from = i === startIdx ? startCol : 0;
            for (let j = from; j < text.length; j++) {
                const ch = text[j];

                if (!seenParen) {
                    if (ch === '<') { angle++; continue; }
                    if (ch === '>' && angle > 0 && text[j - 1] !== '=') { angle--; continue; }
                }

                if (ch === '(' || ch === '[') { paren++; seenParen = true; }
                else if (ch === ')' || ch === ']') paren--;
                else if (ch === '{') {
                    if (angle > 0) { paren++; continue; }
                    if (paren <= 0) return { idx: i, col: j };
                }
                else if (ch === '}') {
                    if (angle > 0) { paren--; continue; }
                    if (paren <= 0) return null;
                }
                else if (ch === ';' && paren <= 0) return null;
            }
        }
        return null;
    }

    static findStatementEnd(lines, startIdx, startCol, maxIdx, opts = {}) {
        const commaEnds = opts.commaEnds === true;
        let depth = 0;

        for (let i = startIdx; i <= maxIdx && i < lines.length; i++) {
            const text = lines[i].clean;
            const from = i === startIdx ? startCol : 0;

            for (let j = from; j < text.length; j++) {
                const ch = text[j];
                if (OPENERS.includes(ch)) depth++;
                else if (CLOSERS.includes(ch)) {
                    if (depth === 0) return Math.max(startIdx, i - 1);
                    depth--;
                    if (depth === 0 && ch === '}' && text.slice(j + 1).trim() === '') return i;
                }
                else if (ch === ';' && depth === 0) return i;
                else if (ch === ',' && depth === 0 && commaEnds) return i;
            }

            if (depth !== 0) continue;

            const trimmed = text.trimEnd();
            if (!trimmed) continue;
            if (RE_CONTINUES.test(trimmed)) continue;

            const nextCode = Scanner.nextCodeLine(lines, i + 1, maxIdx);
            if (nextCode && RE_CONTINUATION_START.test(nextCode.clean.trim())) continue;

            return i;
        }
        return Math.min(maxIdx, lines.length - 1);
    }

    static nextCodeLine(lines, from, maxIdx) {
        for (let i = from; i <= maxIdx && i < lines.length; i++) {
            if (lines[i].hasCode) return lines[i];
        }
        return null;
    }

    static docRangeAbove(lines, idx) {
        let k = idx - 1;
        let end = null;
        while (k >= 0 && lines[k].commentOnly) { end = end ?? k; k--; }
        if (end === null) return null;
        return { startIdx: k + 1, endIdx: end };
    }

    static firstCodeCol(rec) {
        const idx = rec.clean.search(/\S/);
        return idx === -1 ? 0 : idx;
    }

    static indentOf(text) {
        const m = text.match(/^[ \t]*/);
        return m ? m[0] : '';
    }
}

/* ============================================================================
 * 3. STRUCTURE PARSER
 * ========================================================================== */

const RE_CONTAINER = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const\s+)?(class|interface|enum)\s+([#\w$]+)/;
const RE_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/;
const RE_VARIABLE = /^(?:export\s+)?(?:declare\s+)?(const|let|var)\s+/;
const RE_TYPEALIAS = /^(?:export\s+)?(?:declare\s+)?type\s+([\w$]+)/;
const RE_MEMBER_MODIFIER = /^(public|private|protected|readonly|static|async|abstract|override|declare|accessor)\s+/;
const RE_FN_INIT = /=\s*(?:async\s+)?(?:function\b|\(|<|[\w$]+\s*=>)/;

class StructureParser {
    static parse(code, filePath) {
        const lines = Tokenizer.tokenize(code);
        const blocks = Tokenizer.collectBlocks(lines);

        const tree = {
            filePath,
            code,
            lines,
            imports: [],
            exports: [],
            containers: [],
            functions: [],
            variables: [],
            comments: blocks.filter(b => !b.isDoc),
            jsdoc: blocks.filter(b => b.isDoc),
            raw: {
                lines: code.split('\n'),
                totalLines: lines.length,
                totalChars: code.length
            }
        };

        for (const block of [...tree.comments, ...tree.jsdoc]) {
            block.charCount = this.#charCount(lines, block.lineStart, block.lineEnd);
        }

        this.#parseTopLevel(tree);
        return tree;
    }

    static #parseTopLevel(tree) {
        const lines = tree.lines;
        const max = lines.length - 1;
        let i = 0;

        while (i <= max) {
            const rec = lines[i];

            if (!rec.hasCode || rec.depthStart > 0) { i++; continue; }

            const col = Scanner.firstCodeCol(rec);
            const clean = rec.clean.trim();
            const doc = Scanner.docRangeAbove(lines, i);

            if (/^import\b/.test(clean) && !/^import\s*\(/.test(clean)) {
                const endIdx = Scanner.findStatementEnd(lines, i, col, max);
                tree.imports.push(this.#buildStatement(tree, 'import', i, endIdx, doc, {
                    ...this.#parseImportMeta(this.#joinClean(lines, i, endIdx))
                }));
                i = endIdx + 1;
                continue;
            }

            const cm = clean.match(RE_CONTAINER);
            if (cm) {
                const container = this.#parseContainer(tree, i, max, cm[1], cm[2], doc);
                if (container) {
                    tree.containers.push(container);
                    i = container.endIdx + 1;
                    continue;
                }
            }

            const fm = clean.match(RE_FUNCTION);
            if (fm) {
                const body = Scanner.findBodyStart(lines, i, col, max);
                const endIdx = body
                    ? Scanner.findBlockEnd(lines, body.idx, body.col, max).idx
                    : Scanner.findStatementEnd(lines, i, col, max);
                tree.functions.push(this.#buildStatement(tree, 'function', i, endIdx, doc, {
                    name: fm[1],
                    isAsync: /\basync\b/.test(clean),
                    isExported: /^export\b/.test(clean),
                    form: 'declaration',
                    params: this.#parseParams(this.#joinClean(lines, i, body ? body.idx : endIdx))
                }));
                i = endIdx + 1;
                continue;
            }

            const vm = clean.match(RE_VARIABLE);
            if (vm) {
                const endIdx = Scanner.findStatementEnd(lines, i, col, max);
                const full = this.#joinClean(lines, i, endIdx);
                const nameMatch = clean.match(/^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\w$]+)/);
                const name = nameMatch ? nameMatch[1] : clean.slice(0, 40).trim();
                const isFn = RE_FN_INIT.test(full) && (/=>/.test(full) || /\bfunction\b/.test(full));

                if (isFn) {
                    tree.functions.push(this.#buildStatement(tree, 'function', i, endIdx, doc, {
                        name,
                        isAsync: /=\s*async\b/.test(full),
                        isExported: /^export\b/.test(clean),
                        form: /\bfunction\b/.test(full) ? 'expression' : 'arrow',
                        params: this.#parseParams(full.slice(full.indexOf('=') + 1))
                    }));
                } else {
                    tree.variables.push(this.#buildStatement(tree, 'variable', i, endIdx, doc, {
                        name,
                        kind: vm[1],
                        isExported: /^export\b/.test(clean),
                        declaration: rec.original.trim()
                    }));
                }
                i = endIdx + 1;
                continue;
            }

            const tm = clean.match(RE_TYPEALIAS);
            if (tm) {
                const endIdx = Scanner.findStatementEnd(lines, i, col, max);
                tree.variables.push(this.#buildStatement(tree, 'variable', i, endIdx, doc, {
                    name: tm[1],
                    kind: 'type',
                    isExported: /^export\b/.test(clean),
                    declaration: rec.original.trim()
                }));
                i = endIdx + 1;
                continue;
            }

            if (/^export\b/.test(clean)) {
                const endIdx = Scanner.findStatementEnd(lines, i, col, max);
                tree.exports.push(this.#buildStatement(tree, 'export', i, endIdx, doc, {
                    statement: rec.original.trim(),
                    name: rec.original.trim().slice(0, 60),
                    kind: /\bdefault\b/.test(clean) ? 'default' : 'named'
                }));
                i = endIdx + 1;
                continue;
            }

            i++;
        }
    }

    static #parseContainer(tree, idx, max, kind, name, doc) {
        const lines = tree.lines;
        const col = Scanner.firstCodeCol(lines[idx]);
        const open = Scanner.findBodyStart(lines, idx, col, max);
        if (!open) return null;

        const close = Scanner.findBlockEnd(lines, open.idx, open.col, max);

        const container = {
            type: 'container',
            kind,
            name,
            isExported: /^export\b/.test(lines[idx].clean.trim()),
            isAbstract: /\babstract\b/.test(lines[idx].clean),
            extends: null,
            implements: [],
            lineStart: lines[idx].num,
            lineEnd: lines[close.idx].num,
            startIdx: idx,
            endIdx: close.idx,
            headerIdx: open.idx,
            headerCol: open.col,
            footerIdx: close.idx,
            footerCol: close.col,
            singleLine: open.idx === close.idx,
            indent: Scanner.indentOf(lines[idx].original),
            doc: this.#docInfo(lines, doc),
            members: []
        };

        const header = this.#joinClean(lines, idx, open.idx);
        const ext = header.match(/\bextends\s+([\w$.]+)/);
        if (ext) container.extends = ext[1];
        const impl = header.match(/\bimplements\s+([^{]+)/);
        if (impl) container.implements = impl[1].split(',').map(s => s.trim()).filter(Boolean);

        if (!container.singleLine) {
            const bodyDepth = lines[idx].depthStart + 1;
            if (kind === 'class') this.#parseClassBody(tree, container, open.idx + 1, close.idx - 1, bodyDepth);
            else this.#parseSignatureBody(tree, container, open.idx + 1, close.idx - 1, bodyDepth);
        }

        container.charCount = this.#charCount(lines, container.lineStart, container.lineEnd);
        this.#assignIds(container);
        return container;
    }

    static #parseClassBody(tree, container, from, to, bodyDepth) {
        const lines = tree.lines;
        let i = from;

        while (i <= to) {
            const rec = lines[i];
            if (!rec.hasCode || rec.depthStart !== bodyDepth) { i++; continue; }

            const member = this.#parseClassMember(tree, container, i, to, bodyDepth);
            if (!member) { i++; continue; }

            container.members.push(member);
            i = Math.max(member.endIdx + 1, i + 1);
        }
    }

    static #parseClassMember(tree, container, idx, to, bodyDepth) {
        const lines = tree.lines;
        const rec = lines[idx];
        const col = Scanner.firstCodeCol(rec);
        let rest = rec.clean.trim();

        const mods = {
            isStatic: false, isAsync: false, isAbstract: false,
            isReadonly: false, isGenerator: false, accessibility: null
        };

        let guard = 0;
        let m;
        while ((m = rest.match(RE_MEMBER_MODIFIER)) && guard++ < 8) {
            const rem = rest.slice(m[0].length);
            if (!rem) break;
            switch (m[1]) {
                case 'static': mods.isStatic = true; break;
                case 'async': mods.isAsync = true; break;
                case 'abstract': mods.isAbstract = true; break;
                case 'readonly': mods.isReadonly = true; break;
                case 'public': case 'private': case 'protected': mods.accessibility = m[1]; break;
                default: break;
            }
            rest = rem;
        }

        if (/^\*/.test(rest)) { mods.isGenerator = true; rest = rest.replace(/^\*\s*/, ''); }

        let kind = null;
        let name = null;
        let hit;

        if (mods.isStatic && /^\{/.test(rest)) {
            const open = rec.clean.indexOf('{', col);
            const close = Scanner.findBlockEnd(lines, idx, open, to);
            const doc = Scanner.docRangeAbove(lines, idx);
            const block = {
                type: 'member', kind: 'static-block', name: 'static{}', container: container.name,
                ...mods, lineStart: rec.num, lineEnd: lines[close.idx].num,
                startIdx: idx, endIdx: Math.min(close.idx, to),
                doc: this.#docInfo(lines, doc), params: [], children: []
            };
            block.charCount = this.#charCount(lines, block.lineStart, block.lineEnd);
            return block;
        }

        if (/^constructor\s*\(/.test(rest)) {
            kind = 'constructor';
            name = 'constructor';
        } else if ((hit = rest.match(/^(get|set)\s+(#?[\w$]+|\[[^\]]*\])\s*\(/))) {
            kind = hit[1] === 'get' ? 'getter' : 'setter';
            name = hit[2];
        } else if ((hit = rest.match(/^(#?[\w$]+|\[[^\]]*\])\s*\??\s*\(/))) {
            kind = 'method';
            name = hit[1];
        } else if ((hit = rest.match(/^(#?[\w$]+|\[[^\]]*\])\s*\??\s*[:=][^=]/))) {
            kind = 'field';
            name = hit[1];
        } else if ((hit = rest.match(/^(#?[\w$]+)\s*\??\s*;\s*$/))) {
            kind = 'property';
            name = hit[1];
        } else {
            return null;
        }

        if (name.startsWith('[')) {
            const open = rec.clean.indexOf('[', col);
            const close = rec.clean.indexOf(']', open);
            if (open !== -1 && close !== -1) name = rec.original.slice(open, close + 1);
        }

        let endIdx;
        let bodyStart = null;

        if (kind === 'field' || kind === 'property') {
            endIdx = Scanner.findStatementEnd(lines, idx, col, to);
        } else {
            bodyStart = Scanner.findBodyStart(lines, idx, col, to);
            endIdx = bodyStart
                ? Scanner.findBlockEnd(lines, bodyStart.idx, bodyStart.col, to).idx
                : Scanner.findStatementEnd(lines, idx, col, to);
        }
        endIdx = Math.max(idx, Math.min(endIdx, to));

        const doc = Scanner.docRangeAbove(lines, idx);
        const member = {
            type: 'member',
            kind,
            name,
            container: container.name,
            ...mods,
            lineStart: rec.num,
            lineEnd: lines[endIdx].num,
            startIdx: idx,
            endIdx,
            doc: this.#docInfo(lines, doc),
            params: this.#parseParams(this.#joinClean(lines, idx, bodyStart ? bodyStart.idx : endIdx)),
            children: []
        };
        member.charCount = this.#charCount(lines, member.lineStart, member.lineEnd);

        if (kind === 'constructor' && bodyStart) {
            this.#parseConstructorProps(tree, member, bodyStart.idx + 1, endIdx - 1, bodyDepth + 1);
        }

        return member;
    }

    static #parseConstructorProps(tree, ctor, from, to, propDepth) {
        const lines = tree.lines;
        let i = from;

        while (i <= to) {
            const rec = lines[i];
            if (!rec.hasCode || rec.depthStart !== propDepth) { i++; continue; }

            const hit = rec.clean.trim().match(/^this\.(#?[\w$]+)\s*=[^=]/);
            if (!hit) { i++; continue; }

            const col = Scanner.firstCodeCol(rec);
            const endIdx = Math.min(Scanner.findStatementEnd(lines, i, col, to), to);
            const doc = Scanner.docRangeAbove(lines, i);

            const child = {
                type: 'member',
                kind: 'constructor-prop',
                name: hit[1],
                container: ctor.container,
                isStatic: false, isAsync: false, isGenerator: false,
                isAbstract: false, isReadonly: false, accessibility: null,
                lineStart: rec.num,
                lineEnd: lines[endIdx].num,
                startIdx: i,
                endIdx,
                doc: this.#docInfo(lines, doc),
                params: [],
                children: []
            };
            child.charCount = this.#charCount(lines, child.lineStart, child.lineEnd);
            ctor.children.push(child);

            i = Math.max(endIdx + 1, i + 1);
        }
    }

    static #parseSignatureBody(tree, container, from, to, bodyDepth) {
        const lines = tree.lines;
        let i = from;

        while (i <= to) {
            const rec = lines[i];
            if (!rec.hasCode || rec.depthStart !== bodyDepth) { i++; continue; }

            const col = Scanner.firstCodeCol(rec);
            let rest = rec.clean.trim();
            const isReadonly = /^readonly\s+/.test(rest);
            if (isReadonly) rest = rest.replace(/^readonly\s+/, '');

            let name = null;
            let kind = container.kind === 'enum' ? 'enum-member' : 'property';
            let hit;

            if ((hit = rest.match(/^(new\s+)?\(/))) {
                name = hit[1] ? 'new()' : '()';
                kind = 'signature';
            } else if ((hit = rest.match(/^(\[[^\]]*\]|#?[\w$]+)\s*\??\s*(\(|<)/))) {
                name = hit[1];
                kind = 'signature';
            } else if ((hit = rest.match(/^(\[[^\]]*\]|#?[\w$]+)\s*(\?)?\s*[:=,;]?/)) && hit[1]) {
                name = hit[1];
            } else {
                i++;
                continue;
            }

            const endIdx = Math.min(Scanner.findStatementEnd(lines, i, col, to, { commaEnds: true }), to);
            const doc = Scanner.docRangeAbove(lines, i);

            const member = {
                type: 'member',
                kind,
                name,
                container: container.name,
                isStatic: false, isAsync: false, isGenerator: false,
                isAbstract: false, isReadonly, accessibility: null,
                isOptional: /\?\s*[:(]?/.test(rest.slice(name.length, name.length + 3)),
                lineStart: rec.num,
                lineEnd: lines[endIdx].num,
                startIdx: i,
                endIdx,
                doc: this.#docInfo(lines, doc),
                params: kind === 'signature' ? this.#parseParams(this.#joinClean(lines, i, endIdx)) : [],
                children: []
            };
            member.charCount = this.#charCount(lines, member.lineStart, member.lineEnd);
            container.members.push(member);

            i = Math.max(endIdx + 1, i + 1);
        }
    }

    static #assignIds(container) {
        const used = new Set();
        const make = (member) => {
            let base = `${container.name}.${member.kind}:${member.name}`;
            let id = base;
            let n = 2;
            while (used.has(id)) id = `${base}#${n++}`;
            used.add(id);
            member.id = id;
            for (const child of member.children) {
                let cbase = `${id}>${child.name}`;
                let cid = cbase;
                let k = 2;
                while (used.has(cid)) cid = `${cbase}#${k++}`;
                used.add(cid);
                child.id = cid;
            }
        };
        container.members.forEach(make);
    }

    static #buildStatement(tree, type, startIdx, endIdx, doc, extra) {
        const lines = tree.lines;
        const safeEnd = Math.max(startIdx, Math.min(endIdx, lines.length - 1));
        const node = {
            type,
            startIdx,
            endIdx: safeEnd,
            lineStart: lines[startIdx].num,
            lineEnd: lines[safeEnd].num,
            doc: this.#docInfo(lines, doc),
            ...extra
        };
        node.charCount = this.#charCount(lines, node.lineStart, node.lineEnd);
        return node;
    }

    static #docInfo(lines, doc) {
        if (!doc) return null;
        return {
            startIdx: doc.startIdx,
            endIdx: doc.endIdx,
            lineStart: lines[doc.startIdx].num,
            lineEnd: lines[doc.endIdx].num
        };
    }

    static #joinClean(lines, from, to) {
        const parts = [];
        for (let i = from; i <= to && i < lines.length; i++) parts.push(lines[i].clean.trim());
        return parts.join(' ');
    }

    static #charCount(lines, lineStart, lineEnd) {
        let total = 0;
        const s = Math.max(0, lineStart - 1);
        const e = Math.min(lines.length - 1, lineEnd - 1);
        for (let i = s; i <= e; i++) {
            total += lines[i].original.length;
            if (i < e) total += 1;
        }
        return total;
    }

    static #parseParams(text) {
        const start = text.indexOf('(');
        if (start === -1) return [];

        let depth = 0;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (OPENERS.includes(ch)) depth++;
            else if (CLOSERS.includes(ch)) {
                depth--;
                if (depth === 0) {
                    const inner = text.slice(start + 1, i);
                    if (!inner.trim()) return [];
                    return this.#splitTopLevel(inner).map(p => {
                        const eq = p.indexOf('=');
                        const head = (eq === -1 ? p : p.slice(0, eq)).trim();
                        const nameOnly = head.split(':')[0].trim().split(/\s+/).pop() || head;
                        return { name: nameOnly, defaultValue: eq === -1 ? null : p.slice(eq + 1).trim() || null };
                    }).filter(p => p.name);
                }
            }
        }
        return [];
    }

    static #splitTopLevel(text) {
        const out = [];
        let depth = 0;
        let buf = '';
        for (const ch of text) {
            if (OPENERS.includes(ch)) depth++;
            else if (CLOSERS.includes(ch)) depth--;
            if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
            buf += ch;
        }
        if (buf.trim()) out.push(buf);
        return out;
    }

    static #parseImportMeta(statement) {
        const m1 = statement.match(/import\s+([\w$]+)\s*,\s*\{\s*([^}]*)\s*\}\s*from\s+/);
        if (m1) return { name: m1[1], names: m1[2].split(',').map(s => s.trim()).filter(Boolean), kind: 'mixed', source: this.#importSource(statement) };

        const m2 = statement.match(/import\s*\{\s*([^}]*)\s*\}\s*from\s+/);
        if (m2) return { names: m2[1].split(',').map(s => s.trim()).filter(Boolean), kind: 'named', source: this.#importSource(statement) };

        const m3 = statement.match(/import\s+\*\s+as\s+([\w$]+)\s+from\s+/);
        if (m3) return { name: m3[1], kind: 'namespace', source: this.#importSource(statement) };

        const m4 = statement.match(/import\s+([\w$]+)\s+from\s+/);
        if (m4) return { name: m4[1], kind: 'default', source: this.#importSource(statement) };

        return { kind: 'side-effect', name: '(side-effect)', source: this.#importSource(statement) };
    }

    static #importSource(statement) {
        const m = statement.match(/from\s+['"]([^'"]+)['"]/);
        return m ? m[1] : null;
    }
}

/* ============================================================================
 * 4. SELECTION
 * ========================================================================== */

class Selection {
    static empty() {
        return {
            version: 7,
            includeImports: false,
            includeExports: false,
            includeVariables: false,
            functions: [],
            containers: {},
            commentMode: 'top-level',
            jsdocMode: 'top-level',
            autoKeepPrivateRefs: true
        };
    }

    static normalize(raw, tree) {
        const sel = this.empty();
        if (!raw) return sel;

        sel.includeImports = !!(raw.includeImports);
        sel.includeExports = !!(raw.includeExports);
        sel.includeVariables = !!(raw.includeVariables);

        if (Array.isArray(raw.functions)) sel.functions = [...raw.functions];
        else if (Array.isArray(raw.includeFunctions)) sel.functions = [...raw.includeFunctions];

        sel.commentMode = this.#mode(raw.commentMode, raw.includeAllComments);
        sel.jsdocMode = this.#mode(raw.jsdocMode, raw.includeAllJSDoc);
        if (typeof raw.autoKeepPrivateRefs === 'boolean') sel.autoKeepPrivateRefs = raw.autoKeepPrivateRefs;

        if (raw.containers && typeof raw.containers === 'object' && !Array.isArray(raw.containers)) {
            for (const [name, value] of Object.entries(raw.containers)) {
                sel.containers[name] = {
                    members: Array.isArray(value?.members) ? [...value.members] : null
                };
            }
            return sel;
        }

        if (Array.isArray(raw.includeClasses)) {
            const legacyMethods = Array.isArray(raw.includeMethods) ? raw.includeMethods : null;
            for (const name of raw.includeClasses) {
                let members = null;
                if (legacyMethods && legacyMethods.length && tree) {
                    const container = tree.containers.find(c => c.name === name);
                    if (container) {
                        members = this.allMemberIds(container)
                            .filter(id => legacyMethods.includes(this.memberById(container, id)?.name));
                    }
                }
                sel.containers[name] = { members };
            }
        }

        return sel;
    }

    static #mode(explicit, legacyBoolean) {
        if (typeof explicit === 'string' && COMMENT_MODES.includes(explicit)) return explicit;
        if (typeof legacyBoolean === 'boolean') return legacyBoolean ? 'keep' : 'top-level';
        return 'top-level';
    }

    static allMembers(container) {
        const out = [];
        for (const member of container.members) {
            out.push(member);
            for (const child of member.children) out.push(child);
        }
        return out;
    }

    static allMemberIds(container) {
        return this.allMembers(container).map(m => m.id);
    }

    static memberById(container, id) {
        return this.allMembers(container).find(m => m.id === id) || null;
    }

    static isContainerSelected(sel, name) {
        return Object.prototype.hasOwnProperty.call(sel.containers, name);
    }

    static isMemberSelected(sel, container, id) {
        const entry = sel.containers[container.name];
        if (!entry) return false;
        if (entry.members === null) return true;
        return entry.members.includes(id);
    }

    static toggleContainer(sel, container) {
        if (this.isContainerSelected(sel, container.name)) delete sel.containers[container.name];
        else sel.containers[container.name] = { members: null };
    }

    static toggleMember(sel, container, id) {
        const entry = sel.containers[container.name];
        if (!entry) return;
        if (entry.members === null) entry.members = this.allMemberIds(container);
        entry.members = entry.members.includes(id)
            ? entry.members.filter(x => x !== id)
            : [...entry.members, id];
    }
}

/* ============================================================================
 * 5. COMMENT STRIPPER
 * ========================================================================== */

class CommentStripper {
    static apply(outLines, lines, { commentMode, jsdocMode }) {
        if (commentMode === 'keep' && jsdocMode === 'keep') return outLines;

        const result = [];
        for (const out of outLines) {
            if (out.num === null) { result.push(out); continue; }

            const rec = lines[out.num - 1];
            if (!rec || rec.comments.length === 0) { result.push(out); continue; }

            const doomed = rec.comments.filter(span => this.#shouldRemove(span, commentMode, jsdocMode));
            if (doomed.length === 0) { result.push(out); continue; }

            const text = this.#removeSpans(rec.original, doomed).replace(/\s+$/, '');
            if (text.trim() === '' && !rec.hasCode) continue;
            result.push({ num: rec.hasCode ? out.num : null, text });
        }
        return result;
    }

    static #shouldRemove(span, commentMode, jsdocMode) {
        const mode = span.isDoc ? jsdocMode : commentMode;
        if (mode === 'keep') return false;
        if (mode === 'all') return true;
        return span.depth === 0;
    }

    static #removeSpans(text, spans) {
        const ordered = [...spans].sort((a, b) => b.start - a.start);
        let out = text;
        for (const span of ordered) out = out.slice(0, span.start) + out.slice(span.end);
        return out;
    }
}

/* ============================================================================
 * 6. CODE EMITTER
 * ========================================================================== */

class CodeEmitter {
    static generate(tree, selection) {
        const sel = Selection.normalize(selection, tree);
        const lines = tree.lines;
        const notes = [];
        const units = [];

        const push = (sortKey, build) => units.push({ sortKey, build });

        if (sel.includeImports) {
            for (const node of tree.imports) push(node.startIdx, () => this.#emitNode(lines, node));
        }
        if (sel.includeExports) {
            const names = this.#emittedNames(tree, sel);
            for (const node of tree.exports) push(node.startIdx, () => this.#emitExport(lines, node, names, notes));
        }
        if (sel.includeVariables) {
            for (const node of tree.variables) push(node.startIdx, () => this.#emitNode(lines, node));
        }
        for (const fn of tree.functions) {
            if (sel.functions.includes(fn.name)) push(fn.startIdx, () => this.#emitNode(lines, fn));
        }
        for (const container of tree.containers) {
            if (!Selection.isContainerSelected(sel, container.name)) continue;
            push(container.startIdx, () => this.#emitContainer(lines, container, sel, notes));
        }

        const attached = this.#attachedDocLines(tree);
        for (const block of tree.comments) {
            if (sel.commentMode === 'keep' && block.depth === 0 && !attached.has(block.lineStart)) {
                push(block.lineStart - 1, () => this.#emitRange(lines, block.lineStart - 1, block.lineEnd - 1));
            }
        }
        for (const block of tree.jsdoc) {
            if (sel.jsdocMode === 'keep' && block.depth === 0 && !attached.has(block.lineStart)) {
                push(block.lineStart - 1, () => this.#emitRange(lines, block.lineStart - 1, block.lineEnd - 1));
            }
        }

        units.sort((a, b) => a.sortKey - b.sortKey);

        let out = [];
        let previousEnd = null;

        for (const unit of units) {
            const chunk = unit.build();
            if (!chunk.length) continue;

            if (previousEnd !== null && chunk[0].num !== null && chunk[0].num > previousEnd + 1) {
                out.push({ num: null, text: '' });
            } else if (previousEnd !== null && chunk[0].num === null) {
                out.push({ num: null, text: '' });
            }

            out.push(...chunk);
            const last = chunk[chunk.length - 1];
            previousEnd = last.num !== null ? last.num : previousEnd;
        }

        out = CommentStripper.apply(out, lines, sel);
        const text = this.#render(out);
        const validation = this.validate(text);

        return { text, notes, validation, selection: sel };
    }

    static #attachedDocLines(tree) {
        const set = new Set();
        const mark = (node) => { if (node?.doc) set.add(node.doc.lineStart); };

        [...tree.imports, ...tree.exports, ...tree.variables, ...tree.functions].forEach(mark);
        for (const container of tree.containers) {
            mark(container);
            for (const member of Selection.allMembers(container)) mark(member);
        }
        return set;
    }

    static #emittedNames(tree, sel) {
        const names = new Set();
        for (const c of tree.containers) if (Selection.isContainerSelected(sel, c.name)) names.add(c.name);
        for (const f of tree.functions) if (sel.functions.includes(f.name)) names.add(f.name);
        if (sel.includeVariables) for (const v of tree.variables) names.add(v.name);
        if (sel.includeImports) {
            for (const imp of tree.imports) {
                if (imp.name) names.add(imp.name);
                for (const n of imp.names || []) names.add(n.split(/\s+as\s+/).pop().trim());
            }
        }
        return names;
    }

    static #emitExport(lines, node, names, notes) {
        const clean = this.#joinClean(lines, node.startIdx, node.endIdx);

        if (/\bfrom\b/.test(clean) || /^export\s*\*/.test(clean)) return this.#emitNode(lines, node);

        const def = clean.match(/^export\s+default\s+([\w$]+)\s*;?\s*$/);
        if (def) {
            const known = names.has(def[1]);
            const declared = this.#isDeclaredName(lines, def[1]);
            if (!known && declared) {
                notes.push(`"export default ${def[1]}" removido: ${def[1]} não está na saída.`);
                return [];
            }
            return this.#emitNode(lines, node);
        }

        const braces = clean.match(/^export\s*\{([^}]*)\}/);
        if (!braces) return this.#emitNode(lines, node);

        const specs = braces[1].split(',').map(s => s.trim()).filter(Boolean);
        const kept = specs.filter(s => {
            const local = s.split(/\s+as\s+/)[0].trim();
            return names.has(local) || !this.#isDeclaredName(lines, local);
        });

        if (kept.length === specs.length) return this.#emitNode(lines, node);

        const dropped = specs.filter(s => !kept.includes(s)).map(s => s.split(/\s+as\s+/)[0].trim());
        const indent = Scanner.indentOf(lines[node.startIdx].original);

        if (!kept.length) {
            notes.push(`"export { ${dropped.join(', ')} }" removido: nenhum desses nomes está na saída.`);
            return [];
        }
        notes.push(`"export {...}" reescrito: removido(s) ${dropped.join(', ')} (não estão na saída).`);

        const chunk = [];
        if (node.doc) chunk.push(...this.#emitRange(lines, node.doc.startIdx, node.doc.endIdx));
        chunk.push({ num: null, text: `${indent}export { ${kept.join(', ')} };` });
        return chunk;
    }

    static #isDeclaredName(lines, name) {
        const re = new RegExp(`\\b(?:class|interface|enum|function|const|let|var)\\s+${name}\\b`);
        return lines.some(rec => re.test(rec.clean));
    }

    static #joinClean(lines, from, to) {
        const parts = [];
        for (let i = from; i <= to && i < lines.length; i++) parts.push(lines[i].clean.trim());
        return parts.join(' ').trim();
    }

    static #emitNode(lines, node) {
        const chunk = [];
        if (node.doc) chunk.push(...this.#emitRange(lines, node.doc.startIdx, node.doc.endIdx));
        chunk.push(...this.#emitRange(lines, node.startIdx, node.endIdx));
        return chunk;
    }

    static #emitRange(lines, fromIdx, toIdx) {
        const chunk = [];
        for (let i = Math.max(0, fromIdx); i <= Math.min(toIdx, lines.length - 1); i++) {
            chunk.push({ num: lines[i].num, text: lines[i].original });
        }
        return chunk;
    }

    static #emitContainer(lines, container, sel, notes) {
        const entry = sel.containers[container.name];
        const filtering = entry && entry.members !== null;

        if (container.singleLine) {
            if (filtering) notes.push(`"${container.name}" está em uma única linha — emitido inteiro, sem filtro de membros.`);
            return this.#emitNode(lines, container);
        }

        if (!filtering) return this.#emitNode(lines, container);

        const keep = this.#resolveKeepSet(lines, container, sel, notes);

        const chunk = [];
        if (container.doc) chunk.push(...this.#emitRange(lines, container.doc.startIdx, container.doc.endIdx));

        chunk.push(...this.#emitRange(lines, container.startIdx, container.headerIdx - 1));
        chunk.push(this.#slice(lines[container.headerIdx], 0, container.headerCol + 1));

        const members = [...container.members].sort((a, b) => a.startIdx - b.startIdx);
        let lastEnd = null;

        for (const member of members) {
            if (!keep.has(member.id)) continue;

            const body = this.#emitMember(lines, container, member, keep);
            if (!body.length) continue;

            if (lastEnd !== null && body[0].num !== null && body[0].num > lastEnd + 1) {
                chunk.push({ num: null, text: '' });
            }
            chunk.push(...body);
            const last = body[body.length - 1];
            lastEnd = last.num !== null ? last.num : lastEnd;
        }

        chunk.push(this.#closing(lines, container));
        return chunk;
    }

    static #resolveKeepSet(lines, container, sel, notes) {
        const keep = new Set(
            Selection.allMembers(container)
                .filter(m => Selection.isMemberSelected(sel, container, m.id))
                .map(m => m.id)
        );

        const privates = new Map();
        for (const member of container.members) {
            if (typeof member.name === 'string' && member.name.startsWith('#')) privates.set(member.name, member);
        }
        if (!privates.size) return keep;

        const restored = new Set();
        let changed = true;

        while (changed) {
            changed = false;
            const used = new Set();

            for (const member of container.members) {
                if (!keep.has(member.id)) continue;
                for (let i = member.startIdx; i <= member.endIdx; i++) {
                    for (const ref of lines[i].original.match(/#[A-Za-z_$][\w$]*/g) || []) used.add(ref);
                }
            }

            for (const name of used) {
                const owner = privates.get(name);
                if (!owner || keep.has(owner.id)) continue;
                if (!sel.autoKeepPrivateRefs) {
                    notes.push(`"${container.name}": ${name} foi removido mas ainda é referenciado — isso é erro de sintaxe em JS.`);
                    continue;
                }
                keep.add(owner.id);
                owner.children.forEach(c => keep.add(c.id));
                restored.add(name);
                changed = true;
            }
        }

        if (restored.size) {
            notes.push(`"${container.name}": mantidos automaticamente ${[...restored].join(', ')} — são #privados ainda referenciados pelos membros selecionados.`);
        }
        return keep;
    }

    static #emitMember(lines, container, member, keep) {
        const chunk = [];
        if (member.doc) chunk.push(...this.#emitRange(lines, member.doc.startIdx, member.doc.endIdx));

        if (member.kind === 'constructor' && member.children.length) {
            const dropped = member.children.filter(c => !keep.has(c.id));
            if (dropped.length) {
                const skip = new Set();
                for (const child of dropped) {
                    for (let i = child.startIdx; i <= child.endIdx; i++) skip.add(i);
                    if (child.doc) for (let i = child.doc.startIdx; i <= child.doc.endIdx; i++) skip.add(i);
                }
                for (let i = member.startIdx; i <= member.endIdx; i++) {
                    if (skip.has(i)) continue;
                    chunk.push({ num: lines[i].num, text: lines[i].original });
                }
                return chunk;
            }
        }

        chunk.push(...this.#emitRange(lines, member.startIdx, member.endIdx));
        return chunk;
    }

    static #closing(lines, container) {
        const rec = lines[container.footerIdx];
        if (container.footerCol < 0) return { num: null, text: `${container.indent}}` };

        const tail = rec.original.slice(container.footerCol).trimEnd();
        const text = container.indent + (tail.startsWith('}') ? tail : '}');
        return { num: text === rec.original.trimEnd() ? rec.num : null, text };
    }

    static #slice(rec, from, to) {
        const text = rec.original.slice(from, to).trimEnd();
        return { num: text === rec.original.trimEnd() ? rec.num : null, text };
    }

    static #render(outLines) {
        const texts = outLines.map(l => l.text);

        const cleaned = [];
        for (const text of texts) {
            const blank = text.trim() === '';
            if (blank && (cleaned.length === 0 || cleaned[cleaned.length - 1].trim() === '')) continue;
            cleaned.push(blank ? '' : text);
        }
        while (cleaned.length && cleaned[cleaned.length - 1].trim() === '') cleaned.pop();

        return cleaned.length ? cleaned.join('\n') + '\n' : '';
    }

    static validate(text) {
        const issues = [];
        if (!text.trim()) return { ok: true, issues, balanced: true };

        const lines = Tokenizer.tokenize(text);
        const stack = [];
        const pairs = { ')': '(', ']': '[', '}': '{' };

        for (const rec of lines) {
            for (let j = 0; j < rec.clean.length; j++) {
                const ch = rec.clean[j];
                if (OPENERS.includes(ch)) stack.push({ ch, line: rec.num });
                else if (CLOSERS.includes(ch)) {
                    const top = stack.pop();
                    if (!top) { issues.push(`Linha ${rec.num}: "${ch}" sem abertura correspondente.`); }
                    else if (top.ch !== pairs[ch]) { issues.push(`Linha ${rec.num}: "${ch}" fecha "${top.ch}" aberto na linha ${top.line}.`); }
                }
            }
        }
        for (const open of stack) issues.push(`Linha ${open.line}: "${open.ch}" nunca é fechado.`);

        return { ok: issues.length === 0, issues, balanced: stack.length === 0 };
    }
}

/* ============================================================================
 * 7. FACHADA
 * ========================================================================== */

class CodeParser {
    static #tree = null;
    static #lastReport = null;
    static #lastSelection = null;

    static parse(filePath) {
        const code = fs.readFileSync(filePath, 'utf8');
        this.#tree = StructureParser.parse(code, filePath);
        return this.#tree;
    }

    static parseSource(code, filePath = '<memory>') {
        this.#tree = StructureParser.parse(code, filePath);
        return this.#tree;
    }

    static getTree() { return this.#tree; }
    static getImports() { return this.#tree?.imports || []; }
    static getExports() { return this.#tree?.exports || []; }
    static getVariables() { return this.#tree?.variables || []; }
    static getComments() { return this.#tree?.comments || []; }
    static getJSDoc() { return this.#tree?.jsdoc || []; }

    static getContainers(options = {}) {
        let list = this.#tree?.containers || [];
        if (options.kind) list = list.filter(c => c.kind === options.kind);
        if (options.include) list = list.filter(c => options.include.includes(c.name));
        if (options.exclude) list = list.filter(c => !options.exclude.includes(c.name));
        return list;
    }

    static getClasses(options = {}) {
        return this.getContainers({
            include: options.includeClasses,
            exclude: options.excludeClasses,
            kind: options.kind
        });
    }

    static getFunctions(options = {}) {
        let list = this.#tree?.functions || [];
        if (options.includeFunctions) list = list.filter(f => options.includeFunctions.includes(f.name));
        if (options.excludeFunctions) list = list.filter(f => !options.excludeFunctions.includes(f.name));
        return list;
    }

    static getMembers(options = {}) {
        const out = [];
        for (const container of this.getClasses(options)) {
            for (const member of Selection.allMembers(container)) {
                if (options.includeMembers && !options.includeMembers.includes(member.id)) continue;
                if (options.excludeMembers && options.excludeMembers.includes(member.id)) continue;
                if (options.includeMethods && !options.includeMethods.includes(member.name)) continue;
                if (options.excludeMethods && options.excludeMethods.includes(member.name)) continue;
                out.push({ ...member, className: container.name });
            }
        }
        return out;
    }

    static getMethods(options = {}) { return this.getMembers(options); }

    static generateFiltered(selection = {}) {
        if (!this.#tree) return '';
        this.#lastReport = CodeEmitter.generate(this.#tree, selection);
        this.#lastSelection = this.#lastReport.selection;
        return this.#lastReport.text;
    }

    static getLastReport() { return this.#lastReport; }
    static getLastSelection() { return this.#lastSelection || Selection.empty(); }

    static validate(text) { return CodeEmitter.validate(text); }

    static getSummary() {
        if (!this.#tree) return null;
        const t = this.#tree;

        const sum = (arr) => arr.reduce((acc, x) => acc + (x.charCount || 0), 0);
        let totalMembers = 0;
        let totalMemberChars = 0;
        for (const container of t.containers) {
            const members = Selection.allMembers(container);
            totalMembers += members.length;
            totalMemberChars += sum(members);
        }

        return {
            filePath: t.filePath,
            totalLines: t.raw.totalLines,
            totalChars: t.raw.totalChars,
            imports: t.imports.length,
            importsChars: sum(t.imports),
            exports: t.exports.length,
            exportsChars: sum(t.exports),
            containers: t.containers.length,
            classes: t.containers.filter(c => c.kind === 'class').length,
            interfaces: t.containers.filter(c => c.kind === 'interface').length,
            enums: t.containers.filter(c => c.kind === 'enum').length,
            containersChars: sum(t.containers),
            functions: t.functions.length,
            functionsChars: sum(t.functions),
            variables: t.variables.length,
            variablesChars: sum(t.variables),
            comments: t.comments.length,
            commentsChars: sum(t.comments),
            jsdoc: t.jsdoc.length,
            jsdocChars: sum(t.jsdoc),
            totalMembers,
            totalMemberChars,
            totalMethods: totalMembers,
            totalMethodChars: totalMemberChars
        };
    }

    static saveSelection(selection, filePath) {
        fs.writeFileSync(filePath, JSON.stringify(selection, null, 2), 'utf8');
        return filePath;
    }

    static loadSelection(filePath) {
        if (!fs.existsSync(filePath)) return null;
        return Selection.normalize(JSON.parse(fs.readFileSync(filePath, 'utf8')), this.#tree);
    }
}

/* ============================================================================
 * 8. CLI
 * ========================================================================== */

class CLIMenu {
    constructor(options = {}) {
        this.sel = options.selection || Selection.empty();
        this.outputPath = options.outputPath || null;
        this.integrationMode = options.integrationMode || false;
        this._resolveExit = null; // Promise resolver for integration mode

        this.eof = false;
        this.queue = [];
        this.waiting = [];
        
        // Use provided readline or create our own
        if (options.rl) {
            this.rl = options.rl;
            this._ownsRL = false;
        } else {
            this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            this._ownsRL = true;
        }

        this._lineHandler = (line) => {
            const resolve = this.waiting.shift();
            if (resolve) resolve(line);
            else this.queue.push(line);
        };
        this._closeHandler = () => {
            this.eof = true;
            while (this.waiting.length) this.waiting.shift()('');
        };
        this.rl.on('line', this._lineHandler);
        this.rl.on('close', this._closeHandler);
    }

    async start(filePath, options = {}) {
        this.#clear();
        console.log('════════════ CODE PARSER v7.0 ════════════\n');
        try {
            CodeParser.parse(filePath);
            const s = CodeParser.getSummary();
            console.log(`File: ${path.basename(filePath)}`);
            console.log(`Stats: ${s.totalLines} lines | ${s.totalChars} chars | ${s.containers} containers | ${s.totalMembers} members | ${s.functions} functions\n`);

            if (options.load) {
                const loaded = CodeParser.loadSelection(options.load);
                if (loaded) {
                    this.sel = loaded;
                    console.log(`Loaded selection: ${options.load}`);
                } else {
                    console.log(`Selection not found: ${options.load}`);
                }
            }
            if (options.commentMode) this.sel.commentMode = options.commentMode;
            if (options.jsdocMode) this.sel.jsdocMode = options.jsdocMode;
            if (options.output) this.outputPath = options.output;

            if (options.auto) {
                await this.generateFile();
                this.close();
                return;
            }

            await this.menu();
            
            // If in integration mode, resolve the promise to signal completion
            if (this.integrationMode && this._resolveExit) {
                this._resolveExit(this.sel);
            }
        } catch (e) {
            console.error(`Error: ${e.message}`);
            if (this.integrationMode && this._resolveExit) {
                this._resolveExit(null);
            } else {
                console.error(e.stack);
                process.exit(1);
            }
        }
    }

    async menu() {
        while (true) {
            console.log('\n─── MAIN MENU ───────────────────────────');
            console.log('1. Imports      2. Exports      3. Classes/Interfaces');
            console.log('4. Members      5. Functions    6. Variables');
            console.log('7. Comments     8. Preview      9. Save File');
            console.log('S. Save State   L. Load State   0. Exit');
            console.log('──────────────────────────────────────────');
            const c = (await this.ask('Choose option: ')).trim().toLowerCase();
            if (this.eof && !c) { console.log('\n(fim da entrada)'); this.close(); return; }
            switch (c) {
                case '1': await this.imports(); break;
                case '2': await this.exports(); break;
                case '3': await this.containers(); break;
                case '4': await this.members(); break;
                case '5': await this.functions(); break;
                case '6': await this.variables(); break;
                case '7': await this.comments(); break;
                case '8': await this.preview(); break;
                case '9': await this.generateFile(); break;
                case 's': await this.saveState(); break;
                case 'l': await this.loadState(); break;
                case '0':
                    console.log('\nReturning to Struct.js...');
                    this.close();
                    return;
                default: console.log('Invalid option');
            }
        }
    }

    async imports() {
        this.#clear();
        const imps = CodeParser.getImports();
        console.log('─── IMPORTS ──────────────────────────────');
        if (!imps.length) console.log('  No imports found');
        else {
            imps.forEach((imp, i) => {
                const label = imp.name || imp.names?.join(', ') || '(side-effect)';
                console.log(`  ${i + 1}. [${imp.kind}] ${label} | lines ${imp.lineStart}-${imp.lineEnd} | ${imp.charCount} chars`);
            });
            console.log(`  Total: ${imps.length} imports, ${imps.reduce((s, x) => s + x.charCount, 0)} chars`);
        }
        console.log(`\nStatus: ${this.sel.includeImports ? 'INCLUDED' : 'EXCLUDED'}`);
        if ((await this.ask('Toggle inclusion? (y/n): ')).toLowerCase() === 'y') {
            this.sel.includeImports = !this.sel.includeImports;
        }
    }

    async exports() {
        this.#clear();
        const exps = CodeParser.getExports();
        console.log('─── EXPORTS ──────────────────────────────');
        if (!exps.length) console.log('  No standalone exports found');
        else {
            exps.forEach((e, i) => console.log(`  ${i + 1}. [${e.kind}] ${e.statement.substring(0, 60)} | lines ${e.lineStart}-${e.lineEnd} | ${e.charCount} chars`));
            console.log(`  Total: ${exps.length} exports, ${exps.reduce((s, x) => s + x.charCount, 0)} chars`);
        }
        console.log(`\nStatus: ${this.sel.includeExports ? 'INCLUDED' : 'EXCLUDED'}`);
        if ((await this.ask('Toggle inclusion? (y/n): ')).toLowerCase() === 'y') {
            this.sel.includeExports = !this.sel.includeExports;
        }
    }

    async containers() {
        while (true) {
            this.#clear();
            const list = CodeParser.getContainers();
            console.log('─── CLASSES / INTERFACES / ENUMS ─────────');
            if (!list.length) {
                console.log('  None found');
                await this.ask('\nPress Enter to continue...');
                return;
            }

            list.forEach((c, i) => {
                const selected = Selection.isContainerSelected(this.sel, c.name) ? '[x]' : '[ ]';
                const total = Selection.allMembers(c).length;
                const entry = this.sel.containers[c.name];
                const active = entry ? (entry.members === null ? total : entry.members.length) : 0;
                const filter = entry && entry.members !== null ? ` | filtered ${active}/${total}` : '';
                console.log(`  ${selected} ${i + 1}. ${c.kind} ${c.name} | ${total} members | ${c.charCount} chars | lines ${c.lineStart}-${c.lineEnd}${filter}`);
                if (c.extends) console.log(`        extends ${c.extends}`);
                if (c.implements.length) console.log(`        implements ${c.implements.join(', ')}`);
            });

            console.log('\nCommands: <n> | 1,3,5 | 2-6 | all | none | done');
            const cmd = (await this.ask('> ')).trim().toLowerCase();
            if (cmd === 'done' || cmd === '') return;
            if (cmd === 'all') { list.forEach(c => { if (!Selection.isContainerSelected(this.sel, c.name)) this.sel.containers[c.name] = { members: null }; }); continue; }
            if (cmd === 'none') { this.sel.containers = {}; continue; }

            for (const idx of this.#parseIndexes(cmd, list.length)) {
                Selection.toggleContainer(this.sel, list[idx]);
            }
        }
    }

    async members() {
        const names = Object.keys(this.sel.containers);
        if (!names.length) {
            console.log('\nSelect at least one class/interface first (option 3).');
            await this.ask('Press Enter to continue...');
            return;
        }

        while (true) {
            this.#clear();
            console.log('─── MEMBERS ──────────────────────────────');
            console.log('Marcados = MANTIDOS na saída. Desmarque para EXCLUIR.\n');

            const rows = [];
            let n = 1;

            for (const name of names) {
                const container = CodeParser.getContainers({ include: [name] })[0];
                if (!container) continue;

                const members = container.members;
                const props = members.reduce((s, m) => s + m.children.length, 0);
                const totalChars = members.reduce((s, m) => s + m.charCount, 0);
                const extra = props ? ` + ${props} ctor props` : '';
                console.log(`  ${container.kind} ${container.name} (${members.length} members${extra}, ${totalChars} chars)`);

                if (!members.length) console.log('      (no members detected)');

                for (const member of members) {
                    const mark = Selection.isMemberSelected(this.sel, container, member.id) ? '[x]' : '[ ]';
                    console.log(`    ${mark} ${n}. ${this.#memberLabel(member)}`);
                    rows.push({ container, member });
                    n++;

                    for (const child of member.children) {
                        const cmark = Selection.isMemberSelected(this.sel, container, child.id) ? '[x]' : '[ ]';
                        console.log(`        ${cmark} ${n}. └─ this.${child.name} = ... (${child.charCount}c, L${child.lineStart})`);
                        rows.push({ container, member: child });
                        n++;
                    }
                }
                console.log('');
            }

            if (!rows.length) {
                console.log('  No members found in the selected containers.');
                await this.ask('Press Enter to continue...');
                return;
            }

            const kept = rows.filter(r => Selection.isMemberSelected(this.sel, r.container, r.member.id));
            console.log(`  Kept: ${kept.length}/${rows.length} members | ${kept.reduce((s, r) => s + r.member.charCount, 0)} chars`);
            console.log('Commands: <n> | 1,3,5 | 2-6 | all | none | inv | done');

            const cmd = (await this.ask('> ')).trim().toLowerCase();
            if (cmd === 'done' || cmd === '') return;

            if (cmd === 'all') {
                for (const name of names) this.sel.containers[name].members = null;
                continue;
            }
            if (cmd === 'none') {
                for (const name of names) this.sel.containers[name].members = [];
                continue;
            }
            if (cmd === 'inv') {
                for (const name of names) {
                    const container = CodeParser.getContainers({ include: [name] })[0];
                    if (!container) continue;
                    const all = Selection.allMemberIds(container);
                    const current = this.sel.containers[name].members;
                    this.sel.containers[name].members = current === null ? [] : all.filter(id => !current.includes(id));
                }
                continue;
            }

            for (const idx of this.#parseIndexes(cmd, rows.length)) {
                Selection.toggleMember(this.sel, rows[idx].container, rows[idx].member.id);
            }
        }
    }

    async functions() {
        while (true) {
            this.#clear();
            const fns = CodeParser.getFunctions();
            console.log('─── FUNCTIONS ────────────────────────────');
            if (!fns.length) {
                console.log('  No functions found');
                await this.ask('\nPress Enter to continue...');
                return;
            }
            fns.forEach((f, i) => {
                const mark = this.sel.functions.includes(f.name) ? '[x]' : '[ ]';
                const params = f.params?.map(p => p.name).join(', ') || '';
                console.log(`  ${mark} ${i + 1}. ${f.isAsync ? 'async ' : ''}${f.name}(${params}) [${f.form}] | ${f.charCount} chars | lines ${f.lineStart}-${f.lineEnd}`);
            });
            console.log(`  Total: ${fns.length} functions, ${fns.reduce((s, f) => s + f.charCount, 0)} chars`);
            console.log('\nCommands: <n> | 1,3,5 | 2-6 | all | none | done');

            const cmd = (await this.ask('> ')).trim().toLowerCase();
            if (cmd === 'done' || cmd === '') return;
            if (cmd === 'all') { this.sel.functions = fns.map(f => f.name); continue; }
            if (cmd === 'none') { this.sel.functions = []; continue; }

            for (const idx of this.#parseIndexes(cmd, fns.length)) {
                const name = fns[idx].name;
                this.sel.functions = this.sel.functions.includes(name)
                    ? this.sel.functions.filter(x => x !== name)
                    : [...this.sel.functions, name];
            }
        }
    }

    async variables() {
        this.#clear();
        const vars = CodeParser.getVariables();
        console.log('─── VARIABLES ────────────────────────────');
        if (!vars.length) console.log('  No variables found');
        else {
            vars.forEach((v, i) => console.log(`  ${i + 1}. [${v.kind}] ${v.declaration.substring(0, 60)} | lines ${v.lineStart}-${v.lineEnd} | ${v.charCount} chars`));
            console.log(`  Total: ${vars.length} variables, ${vars.reduce((s, v) => s + v.charCount, 0)} chars`);
        }
        console.log(`\nStatus: ${this.sel.includeVariables ? 'INCLUDED' : 'EXCLUDED'}`);
        if ((await this.ask('Toggle inclusion? (y/n): ')).toLowerCase() === 'y') {
            this.sel.includeVariables = !this.sel.includeVariables;
        }
    }

    async comments() {
        while (true) {
            this.#clear();
            const cmts = CodeParser.getComments();
            const docs = CodeParser.getJSDoc();
            const cTop = cmts.filter(c => c.depth === 0).length;
            const dTop = docs.filter(d => d.depth === 0).length;

            console.log('─── COMMENTS & JSDOC ─────────────────────');
            console.log(`  Comments: ${cmts.length} total (${cTop} na camada principal, ${cmts.length - cTop} aninhados) | ${cmts.reduce((s, c) => s + c.charCount, 0)} chars`);
            console.log(`  JSDoc:    ${docs.length} total (${dTop} na camada principal, ${docs.length - dTop} aninhados) | ${docs.reduce((s, d) => s + d.charCount, 0)} chars`);
            console.log('');
            console.log(`  1. Comments mode: ${MODE_LABEL[this.sel.commentMode]}`);
            console.log(`  2. JSDoc mode:    ${MODE_LABEL[this.sel.jsdocMode]}`);
            console.log('');
            console.log('Commands: 1, 2 | done');

            const cmd = (await this.ask('> ')).trim().toLowerCase();
            if (cmd === 'done' || cmd === '') return;

            if (cmd === '1') {
                const idx = COMMENT_MODES.indexOf(this.sel.commentMode);
                this.sel.commentMode = COMMENT_MODES[(idx + 1) % COMMENT_MODES.length];
            } else if (cmd === '2') {
                const idx = COMMENT_MODES.indexOf(this.sel.jsdocMode);
                this.sel.jsdocMode = COMMENT_MODES[(idx + 1) % COMMENT_MODES.length];
            }
        }
    }

    async preview() {
        this.#clear();
        console.log('─── PREVIEW ──────────────────────────────');
        const result = CodeEmitter.generate(CodeParser.getTree(), this.sel);
        
        if (result.notes.length) {
            console.log('\nNotes:');
            result.notes.forEach(n => console.log(`  • ${n}`));
        }
        
        if (!result.validation.ok) {
            console.log('\n⚠️  VALIDATION ISSUES:');
            result.validation.issues.forEach(i => console.log(`  • ${i}`));
        }

        console.log('\n' + (result.text || '(empty output)'));
        await this.ask('\nPress Enter to continue...');
    }

    async generateFile() {
        if (!this.outputPath) {
            this.outputPath = await this.ask('Output file path: ');
        }
        if (!this.outputPath) {
            console.log('No output path specified.');
            return;
        }

        const result = CodeEmitter.generate(CodeParser.getTree(), this.sel);
        
        this.#clear();
        console.log('─── SAVE FILE ────────────────────────────');
        
        if (result.notes.length) {
            console.log('\nNotes:');
            result.notes.forEach(n => console.log(`  • ${n}`));
        }
        
        if (!result.validation.ok) {
            console.log('\n⚠️  VALIDATION ISSUES (file may have errors):');
            result.validation.issues.forEach(i => console.log(`  • ${i}`));
        }

        fs.writeFileSync(this.outputPath, result.text, 'utf8');
        
        const stats = fs.statSync(this.outputPath);
        console.log(`\nSaved: ${this.outputPath}`);
        console.log(`Size: ${stats.size} bytes | ${result.text.split('\n').length} lines`);
        
        await this.ask('\nPress Enter to continue...');
    }

    async saveState() {
        const defaultPath = path.join(process.cwd(), 'codeparser-state.json');
        const filePath = await this.ask(`State file path (default: ${defaultPath}): `) || defaultPath;
        CodeParser.saveSelection(this.sel, filePath);
        console.log(`State saved to ${filePath}`);
        await this.ask('\nPress Enter to continue...');
    }

    async loadState() {
        const defaultPath = path.join(process.cwd(), 'codeparser-state.json');
        const filePath = await this.ask(`State file path (default: ${defaultPath}): `) || defaultPath;
        const loaded = CodeParser.loadSelection(filePath);
        if (loaded) {
            this.sel = loaded;
            console.log(`State loaded from ${filePath}`);
        } else {
            console.log(`State not found: ${filePath}`);
        }
        await this.ask('\nPress Enter to continue...');
    }

    #clear() {
        console.log('\n'.repeat(50));
    }

    #memberLabel(member) {
        const mods = [];
        if (member.accessibility) mods.push(member.accessibility);
        if (member.isStatic) mods.push('static');
        if (member.isAbstract) mods.push('abstract');
        if (member.isAsync) mods.push('async');
        if (member.isGenerator) mods.push('*');
        if (member.isReadonly) mods.push('readonly');
        
        const prefix = mods.length ? mods.join(' ') + ' ' : '';
        const params = member.params?.length ? `(${member.params.map(p => p.name).join(', ')})` : '';
        
        let label = `${prefix}${member.name}${params}`;
        if (member.kind === 'constructor-prop') label = `this.${member.name} = ...`;
        else if (member.kind === 'static-block') label = 'static { ... }';
        else label = `${member.kind}: ${label}`;
        
        return `${label} | ${member.charCount}c, L${member.lineStart}`;
    }

    #parseIndexes(input, max) {
        const result = new Set();
        const parts = input.split(',');
        
        for (const part of parts) {
            const range = part.split('-').map(s => s.trim()).filter(Boolean);
            if (range.length === 2) {
                const start = parseInt(range[0], 10);
                const end = parseInt(range[1], 10);
                if (!isNaN(start) && !isNaN(end)) {
                    for (let i = Math.max(1, start); i <= Math.min(end, max); i++) {
                        result.add(i - 1);
                    }
                }
            } else if (range.length === 1) {
                const idx = parseInt(range[0], 10);
                if (!isNaN(idx) && idx >= 1 && idx <= max) {
                    result.add(idx - 1);
                }
            }
        }
        
        return [...result];
    }

    ask(prompt) {
        process.stdout.write(prompt);
        if (this.queue.length) {
            return Promise.resolve(this.queue.shift());
        }
        return new Promise(resolve => {
            this.waiting.push(resolve);
        });
    }

    close() {
        if (this._ownsRL) {
            this.rl.close();
        } else {
            this.rl.off('line', this._lineHandler);
            this.rl.off('close', this._closeHandler);
        }
    }

    getSelection() {
        return this.sel;
    }
    
    // Wait for menu to complete (integration mode)
    waitForCompletion() {
        return new Promise((resolve) => {
            this._resolveExit = resolve;
        });
    }
}

/* ============================================================================
 * 9. TEST RUNNER
 * ========================================================================== */

class TestRunner {
    static #tests = [];
    static #results = {};

    static #assert(condition, message) {
        if (!condition) throw new Error(message || 'Assertion failed');
    }

    static #addTest(group, name, fn) {
        this.#tests.push({ group, name, fn });
    }

    static #runTests() {
        for (const test of this.#tests) {
            const group = test.group;
            if (!this.#results[group]) this.#results[group] = { pass: 0, fail: 0, tests: [] };
            try {
                test.fn();
                this.#results[group].pass++;
                this.#results[group].tests.push({ name: test.name, status: 'PASS' });
            } catch (err) {
                this.#results[group].fail++;
                this.#results[group].tests.push({ name: test.name, status: 'FAIL', error: err.message });
            }
        }
    }

    static #printReport() {
        console.log('\n════════════════════════════════════════════');
        console.log('          TEST REPORT — CODE PARSER v7.0');
        console.log('════════════════════════════════════════════\n');

        let totalPass = 0, totalFail = 0;

        for (const [group, data] of Object.entries(this.#results)) {
            const total = data.pass + data.fail;
            const pct = total ? Math.round((data.pass / total) * 100) : 0;
            totalPass += data.pass;
            totalFail += data.fail;
            console.log(`── ${group} ── ${data.pass}/${total} passed (${pct}%)`);
            for (const t of data.tests) {
                const mark = t.status === 'PASS' ? '✓' : '✗';
                console.log(`   ${mark} ${t.name}${t.error ? ` → ${t.error}` : ''}`);
            }
            console.log('');
        }

        const grandTotal = totalPass + totalFail;
        const grandPct = grandTotal ? Math.round((totalPass / grandTotal) * 100) : 0;
        console.log('════════════════════════════════════════════');
        console.log(`  TOTAL: ${totalPass}/${grandTotal} passed (${grandPct}%)`);
        console.log('════════════════════════════════════════════\n');

        return totalFail === 0;
    }

    static run() {
        console.log('Running test suite...');
        this.#addTest('Tokenizer', 'tokenizes code with comments, strings, templates, regex', () => {
            const code = `
// line comment
const s = "hello"; /* block */
const t = \`template\`;
const r = /regex/;
`;
            const lines = Tokenizer.tokenize(code);
            this.#assert(lines.length === 5, `Expected 5 lines, got ${lines.length}`);
            this.#assert(lines[0].commentOnly === true, 'Line comment should be commentOnly');
            this.#assert(lines[1].hasCode === true, 'Line with const should have code');
            this.#assert(lines[1].clean.includes('const s = "hello";'), 'String should be preserved in clean');
            this.#assert(lines[2].clean.includes('const t = `template`;'), 'Template should be preserved');
            this.#assert(lines[3].clean.includes('const r = /regex/;'), 'Regex should be preserved');
        });

        this.#addTest('Tokenizer', 'handles block comments and depth', () => {
            const code = `/* block */ class A { /* inner */ }`;
            const lines = Tokenizer.tokenize(code);
            this.#assert(lines.length === 1, 'Should be one line');
            this.#assert(lines[0].comments.length === 2, 'Two comments expected');
            this.#assert(lines[0].clean.includes('class A { }'), 'Clean should have class structure');
        });

        this.#addTest('Scanner', 'findBlockEnd works for simple block', () => {
            const code = `function f() {\n  return 1;\n}`;
            const lines = Tokenizer.tokenize(code);
            const bodyStart = Scanner.findBodyStart(lines, 0, 0, lines.length - 1);
            this.#assert(bodyStart !== null, 'body start should exist');
            const end = Scanner.findBlockEnd(lines, bodyStart.idx, bodyStart.col, lines.length - 1);
            this.#assert(end.idx === 2, 'block end should be line 2');
            this.#assert(end.col === 0, 'block end col should be 0');
        });

        this.#addTest('Scanner', 'findStatementEnd with continuation', () => {
            const code = `const x = 1 +\n  2;`;
            const lines = Tokenizer.tokenize(code);
            const end = Scanner.findStatementEnd(lines, 0, 0, lines.length - 1);
            this.#assert(end === 1, `Expected end at line 1, got ${end}`);
        });

        const sampleCode = `
import fs from 'fs';
import { readFile } from 'fs/promises';

export const PI = 3.14;

export function add(a, b) {
    return a + b;
}

class Person {
    constructor(name) {
        this.name = name;
    }

    greet() {
        console.log('Hello');
    }

    static create() {
        return new Person('x');
    }
}

interface Shape {
    area(): number;
}

enum Color { Red, Green }
`;

        this.#addTest('StructureParser', 'parses top-level structures correctly', () => {
            const tree = StructureParser.parse(sampleCode, '<test>');
            this.#assert(tree.imports.length === 2, `Expected 2 imports, got ${tree.imports.length}`);
            this.#assert(tree.variables.length === 1, 'Expected 1 variable');
            this.#assert(tree.functions.length === 1, 'Expected 1 function');
            this.#assert(tree.containers.length === 3, 'Expected 3 containers (class, interface, enum)');
            this.#assert(tree.containers[0].name === 'Person', 'First container should be Person');
            this.#assert(tree.containers[0].members.length === 3, `Person should have 3 members, got ${tree.containers[0].members.length}`);
        });

        this.#addTest('StructureParser', 'detects class members with modifiers', () => {
            const code = `
class Test {
    private x = 1;
    static async method() {}
    get val() { return 1; }
    set val(v) {}
    #privateMethod() {}
}`;
            const tree = StructureParser.parse(code, '<test>');
            const cls = tree.containers[0];
            this.#assert(cls.members.length === 5, `Expected 5 members, got ${cls.members.length}`);
            this.#assert(cls.members[0].kind === 'field', 'First member should be field');
            this.#assert(cls.members[0].accessibility === 'private', 'Should be private');
            this.#assert(cls.members[1].isStatic === true && cls.members[1].isAsync === true, 'Method should be static async');
            this.#assert(cls.members[2].kind === 'getter', 'Should be getter');
            this.#assert(cls.members[3].kind === 'setter', 'Should be setter');
            this.#assert(cls.members[4].name.startsWith('#'), 'Should be private method');
        });

        this.#addTest('Selection', 'normalize legacy selection', () => {
            const legacy = {
                includeImports: true,
                includeFunctions: ['add'],
                includeClasses: ['Person'],
                includeMethods: ['greet'],
                includeAllComments: true,
                includeAllJSDoc: true,
                autoKeepPrivateRefs: false
            };
            const tree = StructureParser.parse(sampleCode, '<test>');
            const sel = Selection.normalize(legacy, tree);
            this.#assert(sel.includeImports === true, 'includeImports should be true');
            this.#assert(sel.functions.includes('add'), 'add should be in functions');
            this.#assert(sel.containers['Person'] !== undefined, 'Person should be selected');
            this.#assert(sel.commentMode === 'keep', 'comment mode should be keep');
            this.#assert(sel.jsdocMode === 'keep', 'jsdoc mode should be keep');
            this.#assert(sel.autoKeepPrivateRefs === false, 'autoKeepPrivateRefs should be false');
        });

        this.#addTest('Selection', 'toggle container and member', () => {
            const sel = Selection.empty();
            const container = { name: 'A' };
            Selection.toggleContainer(sel, container);
            this.#assert(Selection.isContainerSelected(sel, 'A'), 'Container should be selected');
            Selection.toggleMember(sel, container, 'm1');
            this.#assert(sel.containers['A'].members.includes('m1'), 'Member m1 should be selected');
        });

        this.#addTest('CommentStripper', 'removes comments according to modes', () => {
            const code = `// top-level\nclass A {\n  // nested\n  method() {}\n}`;
            const lines = Tokenizer.tokenize(code);
            const outLines = lines.map(l => ({ num: l.num, text: l.original }));
            const keep = CommentStripper.apply(outLines, lines, { commentMode: 'keep', jsdocMode: 'keep' });
            this.#assert(keep.length === 4, 'keep should keep all');
            const topLevel = CommentStripper.apply(outLines, lines, { commentMode: 'top-level', jsdocMode: 'top-level' });
            this.#assert(topLevel.length === 3, 'top-level should remove top-level comment');
            const all = CommentStripper.apply(outLines, lines, { commentMode: 'all', jsdocMode: 'all' });
            this.#assert(all.length === 2, 'all should remove all comments');
        });

        this.#addTest('CodeEmitter', 'generates filtered output with validation', () => {
            const tree = StructureParser.parse(sampleCode, '<test>');
            const selection = {
                includeImports: false,
                includeExports: false,
                includeVariables: false,
                functions: [],
                containers: {
                    Person: { members: [tree.containers[0].members[1].id] }
                },
                commentMode: 'top-level',
                jsdocMode: 'top-level',
                autoKeepPrivateRefs: true
            };
            const result = CodeEmitter.generate(tree, selection);
            this.#assert(result.validation.ok, `Validation should pass, issues: ${result.validation.issues.join(', ')}`);
            this.#assert(result.text.includes('class Person'), 'Should include class header');
            this.#assert(result.text.includes('greet()'), 'Should include greet method');
            this.#assert(!result.text.includes('constructor'), 'Should not include constructor');
        });

        this.#addTest('CodeEmitter', 'handles private refs auto-keep', () => {
            const code = `
class Counter {
    #count = 0;
    increment() {
        this.#count++;
    }
    getCount() {
        return this.#count;
    }
}`;
            const tree = StructureParser.parse(code, '<test>');
            const selection = {
                containers: {
                    Counter: { members: [tree.containers[0].members[1].id] }
                },
                autoKeepPrivateRefs: true
            };
            const result = CodeEmitter.generate(tree, selection);
            this.#assert(result.validation.ok, 'Validation should pass');
            this.#assert(result.text.includes('#count = 0'), 'Should auto-keep private #count');
            this.#assert(result.text.includes('increment()'), 'Should include increment');
        });

        this.#addTest('CodeParser', 'parseSource and getters', () => {
            CodeParser.parseSource(sampleCode, '<test>');
            const imports = CodeParser.getImports();
            this.#assert(imports.length === 2, 'Should have 2 imports');
            const containers = CodeParser.getContainers();
            this.#assert(containers.length === 3, 'Should have 3 containers');
            const functions = CodeParser.getFunctions();
            this.#assert(functions.length === 1, 'Should have 1 function');
            const vars = CodeParser.getVariables();
            this.#assert(vars.length === 1, 'Should have 1 variable');
            const summary = CodeParser.getSummary();
            this.#assert(summary.totalLines > 0, 'Summary should have lines');
        });

        this.#addTest('CodeParser', 'generateFiltered returns output', () => {
            CodeParser.parseSource(sampleCode, '<test>');
            const text = CodeParser.generateFiltered({ includeVariables: true });
            this.#assert(text.includes('PI'), 'Should include variable PI');
            const report = CodeParser.getLastReport();
            this.#assert(report.validation.ok, 'Validation should pass');
        });

        this.#addTest('Validation', 'detects unbalanced braces', () => {
            const result = CodeEmitter.validate('class A {');
            this.#assert(!result.ok, 'Should detect unclosed brace');
            this.#assert(result.issues.length > 0, 'Should have issues');
        });

        this.#addTest('Validation', 'passes balanced code', () => {
            const result = CodeEmitter.validate('class A {}\nfunction f() {}');
            this.#assert(result.ok, 'Should be valid');
        });

        this.#addTest('Integration', 'full flow parse -> select -> emit -> validate', () => {
            const code = `
import x from 'x';
export function util() {}
class Main {
    method1() {}
    method2() {}
}
`;
            CodeParser.parseSource(code, '<test>');
            const tree = CodeParser.getTree();
            const selection = {
                includeImports: false,
                includeExports: false,
                containers: {
                    Main: { members: [tree.containers[0].members[0].id] }
                }
            };
            const text = CodeParser.generateFiltered(selection);
            this.#assert(text.includes('class Main'), 'Should include class');
            this.#assert(text.includes('method1()'), 'Should include method1');
            this.#assert(!text.includes('method2()'), 'Should not include method2');
            const validation = CodeParser.validate(text);
            this.#assert(validation.ok, 'Output should be valid');
        });

        this.#runTests();
        const success = this.#printReport();
        process.exit(success ? 0 : 1);
    }
}

/* ============================================================================
 * 10. PONTO DE ENTRADA (CLI) - Only runs if this file is executed directly
 * ========================================================================== */

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMainModule) {
    const args = process.argv.slice(2);

    if (args.includes('--test')) {
        TestRunner.run();
    } else {
        const options = {
            load: null,
            output: null,
            commentMode: null,
            jsdocMode: null,
            auto: false
        };

        let filePath = null;

        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg === '--load' || arg === '-l') options.load = args[++i];
            else if (arg === '--output' || arg === '-o') options.output = args[++i];
            else if (arg === '--comment-mode') options.commentMode = args[++i];
            else if (arg === '--jsdoc-mode') options.jsdocMode = args[++i];
            else if (arg === '--auto' || arg === '-a') options.auto = true;
            else if (!filePath) filePath = arg;
        }

        if (!filePath || args.includes('--help') || args.includes('-h')) {
            console.log(`
Usage: node codeParser.js <file> [options]

Options:
  --load, -l <path>        Load selection state from file
  --output, -o <path>      Output file path
  --comment-mode <mode>    Set comment mode (keep|top-level|all)
  --jsdoc-mode <mode>      Set JSDoc mode (keep|top-level|all)
  --auto, -a               Auto-generate and exit (requires --output)
  --help, -h               Show this help
`);
            process.exit(filePath ? 0 : 1);
        }

        const menu = new CLIMenu();
        menu.start(filePath, options).catch(err => {
            console.error('Fatal error:', err);
            process.exit(1);
        });
    }
}

export {
    CodeParser,
    CLIMenu,
    Selection,
    StructureParser,
    Tokenizer,
    Scanner,
    CodeEmitter,
    CommentStripper,
    TestRunner
};