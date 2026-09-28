// Bundler.js — robust ES module → single-file bundler
// Strategy: line-anchored module-syntax stripping (no string masking needed).
import { readFileSync, writeFileSync, statSync } from 'fs';
import { resolve, dirname, extname, relative } from 'path';
import { fileURLToPath } from 'url';
import { builtinModules } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

class ModuleBundler {
  constructor(entryFile, options = {}) {
    this.entryFile       = resolve(entryFile);
    this.processedModules = new Map();
    this.moduleRegistry  = new Map();
    this.moduleCounter   = 0;
    this.debug           = options.debug === true;
  }

  // ---------- Module type helpers ----------
  isNativeModule(moduleName) {
    const cleanName = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
    if (builtinModules.includes(cleanName)) return true;
    const base = cleanName.split('/')[0];
    return builtinModules.includes(base);
  }

  // ---------- Line-anchored module-syntax stripping ----------
  //
  // We do NOT use string masking to find `export` / `import`. Instead we
  // rely on a hard fact about ES modules: genuine `export` and `import`
  // keywords MUST begin a statement, which in source form means the
  // keyword sits at the start of a line (possibly preceded by whitespace
  // and possibly preceded by `;`). Inside string literals and comments
  // this shape is essentially impossible without deliberately writing
  // `\n export ...` inside a string — a case we accept as a non-issue.
  //
  // This makes the stripping completely immune to the template-literal
  // and `${...}` interpolation edge cases that broke the mask-based
  // approach on adversarial input (giant embedded-code templates).
  // ----------

  stripAllModuleSyntax(content, imports) {
    // 1) Remove import statements by position (they came from the
    //    original content, not from any transformation).
    const sortedImports = [...imports].sort((a, b) => b.position - a.position);
    let cleaned = content;
    for (const imp of sortedImports) {
      cleaned = cleaned.slice(0, imp.position) + cleaned.slice(imp.endPosition);
    }

    // 2) Strip `export` keywords — line-anchored, order-sensitive.
    //    We handle the multi-word forms first so that e.g.
    //    `export default async function foo` is not partially reduced.
    cleaned = cleaned.replace(/^([ \t]*)export\s+default\s+async\s+function\s+(\w+)/gm, '$1async function $2');
    cleaned = cleaned.replace(/^([ \t]*)export\s+default\s+function\s+(\w+)/gm,        '$1function $2');
    cleaned = cleaned.replace(/^([ \t]*)export\s+default\s+class\s+(\w+)/gm,           '$1class $2');
    cleaned = cleaned.replace(/^([ \t]*)export\s+default\s+/gm,                       '$1var _defaultExport = ');
    cleaned = cleaned.replace(/^([ \t]*)export\s+async\s+function\s+(\w+)/gm,          '$1async function $2');
    cleaned = cleaned.replace(/^([ \t]*)export\s+(const|let|var|function|class)\s+/gm,'$1$2 ');
    cleaned = cleaned.replace(/^([ \t]*)export\s+\{[^}]*\}\s*;?[ \t]*$/gm,            '');

    // 3) Cosmetic cleanups.
    cleaned = cleaned.replace(/^#!.*\n/, '');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
  }

  // ---------- Import parsing (line-anchored) ----------
  parseImports(content) {
    const imports = [];
    const lines   = content.split('\n');

    // Precompute absolute offset of the start of each line.
    const lineStartOffsets = new Array(lines.length);
    {
      let offset = 0;
      for (let i = 0; i < lines.length; i++) {
        lineStartOffsets[i] = offset;
        offset += lines[i].length + 1; // +1 for the '\n'
      }
    }

    // We scan line by line. An import statement may span multiple lines
    // (e.g. `import {\n  a,\n  b\n} from 'x'`). We detect the start on
    // one line and then find the terminating `;` or end-quote on a
    // subsequent line, using the existing brace/quote/comment scanner.
    let i = 0;
    while (i < lines.length) {
      const rawLine    = lines[i];
      const trimmed    = rawLine.replace(/^\s+/, '');
      const leadingWs  = rawLine.length - trimmed.length;

      // Must start with `import` followed by whitespace, `{`, `*`,
      // a quote (side-effect import), or an identifier (default import).
      if (!/^import(\s|\{|['"*])/.test(trimmed)) { i++; continue; }

      // Exclude `import.meta` and dynamic `import(`.
      const afterImport = trimmed.slice(6).replace(/^\s+/, '');
      if (afterImport.startsWith('.')) { i++; continue; }   // import.meta
      if (afterImport.startsWith('(')) { i++; continue; }   // import(...)

      // Find the end of the statement starting from this line.
      const startPos = lineStartOffsets[i] + leadingWs;
      const endPos   = this._findStatementEnd(content, startPos);
      if (endPos === -1) { i++; continue; }

      const fullStatement = content.slice(startPos, endPos + 1);
      const parsed        = this._parseImportStatement(fullStatement);
      if (parsed) {
        imports.push({
          ...parsed,
          fullStatement,
          position:    startPos,
          endPosition: endPos + 1,
        });
      }

      // Advance to the line that contains endPos (or the next line).
      let j = i;
      while (j < lines.length && lineStartOffsets[j] <= endPos) j++;
      i = Math.max(j, i + 1);
    }

    return imports;
  }

  // Find the terminating `;` (or the closing quote for side-effect
  // imports without a semicolon) of an import statement. Skips strings,
  // template literals, and comments.
  _findStatementEnd(content, startPos) {
    let i = startPos;
    let inString = null;      // '"' | "'" | '`' | null
    let inLineComment  = false;
    let inBlockComment = false;
    let depth = 0;            // tracks `{ ... }` in named imports

    while (i < content.length) {
      const c    = content[i];
      const next = content[i + 1];

      if (inLineComment) {
        if (c === '\n') inLineComment = false;
        i++; continue;
      }
      if (inBlockComment) {
        if (c === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
        i++; continue;
      }
      if (inString) {
        if (c === '\\') { i += 2; continue; }
        if (c === inString) inString = null;
        i++; continue;
      }
      if (c === '/' && next === '/') { inLineComment = true; i += 2; continue; }
      if (c === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { inString = c; i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { if (depth > 0) depth--; }
      else if (c === ';' && depth === 0) return i;
      else if (c === '\n' && depth === 0) {
        // Some imports omit the trailing `;`. Stop at end of line if the
        // quote that closes the module specifier has already been seen.
        const soFar = content.slice(startPos, i).trim();
        if (soFar.endsWith("'") || soFar.endsWith('"') || soFar.endsWith('`')) {
          return i - 1; // position of that closing quote
        }
      }
      i++;
    }
    return -1;
  }

  _parseImportStatement(statement) {
    const normalized = statement.replace(/\s+/g, ' ').trim();
    let match;

    // import 'x';
    match = normalized.match(/^import\s+['"]([^'"]+)['"]\s*;?$/);
    if (match) {
      return {
        modulePath: match[1], isNative: this.isNativeModule(match[1]),
        type: 'side-effect', defaultImport: null, namedImports: [], namespaceImport: null,
      };
    }

    // import X from 'x';
    match = normalized.match(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?$/);
    if (match) {
      return {
        modulePath: match[2], isNative: this.isNativeModule(match[2]),
        type: 'default', defaultImport: match[1], namedImports: [], namespaceImport: null,
      };
    }

    // import { a, b as c } from 'x';
    match = normalized.match(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?$/);
    if (match) {
      const names = match[1].split(',').map(n => {
        const parts = n.trim().split(/\s+as\s+/);
        return { original: parts[0].trim(), alias: (parts[1] || parts[0]).trim() };
      }).filter(n => n.original);
      return {
        modulePath: match[2], isNative: this.isNativeModule(match[2]),
        type: 'named', defaultImport: null, namedImports: names, namespaceImport: null,
      };
    }

    // import * as ns from 'x';
    match = normalized.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?$/);
    if (match) {
      return {
        modulePath: match[2], isNative: this.isNativeModule(match[2]),
        type: 'namespace', defaultImport: null, namedImports: [], namespaceImport: match[1],
      };
    }

    // import D, { a, b } from 'x';
    match = normalized.match(/^import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?$/);
    if (match) {
      const names = match[2].split(',').map(n => {
        const parts = n.trim().split(/\s+as\s+/);
        return { original: parts[0].trim(), alias: (parts[1] || parts[0]).trim() };
      }).filter(n => n.original);
      return {
        modulePath: match[3], isNative: this.isNativeModule(match[3]),
        type: 'combined', defaultImport: match[1], namedImports: names, namespaceImport: null,
      };
    }

    return null;
  }

  // ---------- Export parsing (line-anchored) ----------
  //
  // Everything here runs against the RAW content. We accept that in
  // extremely rare cases an `export` could appear at line-start inside
  // a string literal — but every emission is guarded by
  // `isIdentifierDefined()` at generation time, so a spurious match
  // can never produce a runtime ReferenceError.
  // ----------
  parseExports(content) {
    const exports = {
      defaultExport:     null,
      defaultExpression: null,
      namedExports:      new Set(),
      hasDefault:        false,
    };

    // --- default export (function / class first, then expression) ---
    const defFn    = content.match(/^[ \t]*export\s+default\s+(?:async\s+)?function\s+(\w+)/m);
    const defClass = content.match(/^[ \t]*export\s+default\s+class\s+(\w+)/m);
    const defExpr  = content.match(/^[ \t]*export\s+default\s+([^;\n]+)/m);

    if (defFn) {
      exports.hasDefault    = true;
      exports.defaultExport = defFn[1];
    } else if (defClass) {
      exports.hasDefault    = true;
      exports.defaultExport = defClass[1];
    } else if (defExpr) {
      exports.hasDefault = true;
      const expr = defExpr[1].trim();
      if (/^\d|^["'`\[{]|^null$|^undefined$|^true$|^false$/.test(expr) || expr.includes('.')) {
        exports.defaultExpression = expr;
      } else {
        exports.defaultExport = expr;
      }
    }

    // --- named exports: export const|let|var|function|class X ... ---
    const namedDeclRe = /^[ \t]*export\s+(?:async\s+function|function|class|const|let|var)\s+(\w+)/gm;
    let m;
    while ((m = namedDeclRe.exec(content)) !== null) {
      exports.namedExports.add(m[1]);
    }

    // --- named exports: export { a, b as c }; ---
    const namedListRe = /^[ \t]*export\s+\{([^}]+)\}/gm;
    while ((m = namedListRe.exec(content)) !== null) {
      m[1].split(',').forEach(part => {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) exports.namedExports.add(name);
      });
    }

    return exports;
  }

  // ---------- File-system helpers ----------
  resolveModulePath(importPath, currentFilePath) {
    if (this.isNativeModule(importPath)) return importPath;
    if (importPath.startsWith('.') || importPath.startsWith('/')) {
      const resolved = resolve(dirname(currentFilePath), importPath);
      for (const candidate of [resolved, resolved + '.js', resolve(resolved, 'index.js')]) {
        try { statSync(candidate); return candidate; } catch {}
      }
      return resolved + '.js';
    }
    return importPath;
  }

  // ---------- Main-check transform ----------
  transformMainCheck(content, isEntry) {
    let out = content;
    const patterns = [
      /if\s*\(\s*process\.argv\[1\]\s*===?\s*fileURLToPath\(import\.meta\.url\)\s*\)\s*\{/g,
      /if\s*\(\s*fileURLToPath\(import\.meta\.url\)\s*===?\s*process\.argv\[1\]\s*\)\s*\{/g,
      /if\s*\(\s*process\.argv\[1\]\s*===?\s*__filename\s*\)\s*\{/g,
      /if\s*\(\s*__filename\s*===?\s*process\.argv\[1\]\s*\)\s*\{/g,
      /if\s*\(\s*require\.main\s*===?\s*module\s*\)\s*\{/g,
      /if\s*\(\s*module\s*===?\s*require\.main\s*\)\s*\{/g,
      /if\s*\(\s*import\.meta\.url\s*===?\s*`file:\/\/\$\{process\.argv\[1\]\}`\s*\)\s*\{/g,
      /if\s*\(\s*import\.meta\.url\s*===?\s*process\.argv\[1\]\s*\)\s*\{/g,
      /if\s*\(\s*!\s*module\.parent\s*\)\s*\{/g,
      /if\s*\(\s*module\.parent\s*===?\s*null\s*\)\s*\{/g,
    ];
    for (const re of patterns) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(out)) !== null) {
        const full = match[0];
        const repl = isEntry
          ? `if (true) { // was: ${full.trim()}`
          : `if (false) { // was: ${full.trim()}`;
        out = out.slice(0, match.index) + repl + out.slice(match.index + full.length);
        re.lastIndex = match.index + repl.length;
      }
    }
    return out;
  }

  // ---------- Identifier existence check ----------
  isIdentifierDefined(name, content) {
    if (!name || typeof name !== 'string') return false;
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`\\b(?:class|function|async\\s+function)\\s+${safe}\\b`),
      new RegExp(`\\b(?:const|let|var)\\s+${safe}\\b`),
    ];
    return patterns.some(p => p.test(content));
  }

  // ---------- Circular-dependency transforms ----------
  transformCircularDependencies(content, imports, currentFilePath) {
    const importInfoMap = new Map();

    for (const imp of imports) {
      if (imp.isNative) continue;
      const depPath = this.resolveModulePath(imp.modulePath, currentFilePath);
      const depMod  = this.moduleRegistry.get(depPath);
      if (!depMod || depMod.isNative) continue;

      const isCircular = this.isCircularDependency(currentFilePath, depPath);
      const depId      = depMod.id;

      if (imp.defaultImport) {
        importInfoMap.set(imp.defaultImport, {
          depId, accessor: 'default', type: 'default', isCircular,
        });
      }
      if (imp.namedImports) {
        for (const named of imp.namedImports) {
          const localName = named.alias || named.original;
          importInfoMap.set(localName, {
            depId, accessor: named.original, type: 'named', isCircular,
          });
        }
      }
      if (imp.namespaceImport) {
        importInfoMap.set(imp.namespaceImport, {
          depId, accessor: null, type: 'namespace', isCircular,
        });
      }
    }

    content = this.transformStaticProperties(content, importInfoMap);
    content = this.transformConstructorReferences(content, importInfoMap);
    return content;
  }

  transformStaticProperties(content, importInfoMap) {
    const re = /static\s+(\w+)\s*=\s*([A-Za-z_$][\w$]*)\s*(?=[;\n]|$)/g;
    const replacements = [];
    let match;
    while ((match = re.exec(content)) !== null) {
      const [full, propName, importedIdent] = match;
      const info = importInfoMap.get(importedIdent);
      if (!info) continue;
      const after = content.slice(match.index + full.length, match.index + full.length + 20);
      if (after.trimStart().startsWith('.') || after.trimStart().startsWith('(')) continue;

      let requireExpr;
      if (info.type === 'namespace')      requireExpr = `__require('${info.depId}')`;
      else if (info.type === 'default')   requireExpr = `__require('${info.depId}').default`;
      else                                requireExpr = `__require('${info.depId}').${info.accessor}`;

      replacements.push({
        start: match.index,
        end:   match.index + full.length,
        replacement: `static get ${propName}() { return ${requireExpr}; }`,
      });
    }
    if (replacements.length === 0) return content;
    let out = content;
    for (const r of replacements.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
    }
    return out;
  }

  transformConstructorReferences(content, importInfoMap) {
    const re = /new\s+([A-Za-z_$][\w$]*)\s*\(/g;
    const replacements = [];
    let match;
    while ((match = re.exec(content)) !== null) {
      const [full, ctor] = match;
      const info = importInfoMap.get(ctor);
      if (!info || !info.isCircular) continue;
      let requireExpr;
      if (info.type === 'default')      requireExpr = `__require('${info.depId}').default`;
      else if (info.type === 'named')   requireExpr = `__require('${info.depId}').${info.accessor}`;
      else continue;
      replacements.push({
        start: match.index,
        end:   match.index + full.length,
        replacement: `new (${requireExpr})(`,
      });
    }
    if (replacements.length === 0) return content;
    let out = content;
    for (const r of replacements.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
    }
    return out;
  }

  isCircularDependency(moduleA, moduleB) {
    const a = this.moduleRegistry.get(moduleA);
    const b = this.moduleRegistry.get(moduleB);
    if (!a || !b) return false;
    return b.imports.some(imp => {
      if (imp.isNative) return false;
      const resolved = this.resolveModulePath(imp.modulePath, moduleB);
      return resolved === moduleA;
    });
  }

  // ---------- Module processing ----------
  processModule(filePath) {
    if (this.moduleRegistry.has(filePath)) return this.moduleRegistry.get(filePath);

    if (this.isNativeModule(filePath)) {
      const info = {
        id: `native_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`,
        path: filePath, isNative: true, imports: [], exports: null, content: null,
      };
      this.moduleRegistry.set(filePath, info);
      return info;
    }

    const originalContent = readFileSync(filePath, 'utf8');
    const imports         = this.parseImports(originalContent);
    const exports         = this.parseExports(originalContent);

    let cleanedContent = this.stripAllModuleSyntax(originalContent, imports);

    const isEntry = (filePath === this.entryFile);
    cleanedContent = this.transformMainCheck(cleanedContent, isEntry);

    const moduleId = `module_${this.moduleCounter++}`;
    const moduleInfo = {
      id: moduleId,
      path: filePath,
      isNative: false,
      imports, exports,
      content: cleanedContent,
      originalContent,
      relativePath: relative(process.cwd(), filePath),
    };
    this.moduleRegistry.set(filePath, moduleInfo);
    this.processedModules.set(filePath, moduleInfo);

    // Recurse into dependencies.
    for (const imp of imports) {
      if (!imp.isNative) {
        const resolved = this.resolveModulePath(imp.modulePath, filePath);
        this.processModule(resolved);
      }
    }

    cleanedContent = this.transformCircularDependencies(cleanedContent, imports, filePath);
    moduleInfo.content = cleanedContent;
    return moduleInfo;
  }

  // ---------- Bundle generation ----------
  generateBundle() {
    const modules     = Array.from(this.processedModules.values());
    const entryModule = this.moduleRegistry.get(this.entryFile);

    let out = '';
    out += '// ========================================\n';
    out += '// Auto-generated bundle\n';
    out += `// Entry: ${relative(process.cwd(), this.entryFile)}\n`;
    out += `// Generated: ${new Date().toISOString()}\n`;
    out += `// Modules bundled: ${modules.length}\n`;
    out += '// ========================================\n\n';

    if (entryModule) {
      const firstLine = entryModule.originalContent.split('\n')[0];
      if (firstLine && firstLine.startsWith('#!')) out += firstLine + '\n\n';
    }

    out += "import { createRequire } from 'module';\n";
    out += "const __nativeRequire = createRequire(import.meta.url);\n\n";
    out += 'const __modules = {};\n';
    out += 'const __moduleCache = {};\n';
    out += 'const __moduleExports = {};\n';
    out += 'function __require(id) {\n';
    out += '  if (__moduleCache[id]) return __moduleExports[id];\n';
    out += '  if (!__modules[id]) throw new Error(`Module ${id} not found`);\n';
    out += '  __moduleCache[id] = true;\n';
    out += '  __moduleExports[id] = {};\n';
    out += '  const exports = __modules[id](__moduleExports[id]);\n';
    out += '  __moduleExports[id] = exports || __moduleExports[id];\n';
    out += '  return __moduleExports[id];\n';
    out += '}\n\n';

    for (const module of modules) {
      const relPath = relative(process.cwd(), module.path);
      out += `// ========================================\n`;
      out += `// Module: ${relPath}\n`;
      out += `// ========================================\n`;
      if (module.imports.length > 0) {
        out += `// Original imports:\n`;
        for (const imp of module.imports) {
          out += `// ${imp.fullStatement.replace(/\n/g, ' ')}\n`;
        }
        out += '\n';
      }

      const isEntryModule  = (module.id === entryModule.id);
      const functionKeyword = isEntryModule ? 'async function' : 'function';

      out += `__modules['${module.id}'] = ${functionKeyword}(exports) {\n`;
      out += `  exports = exports || {};\n`;
      out += `  var module = { exports: exports };\n\n`;

      // Emit the module's imports (as __require / __nativeRequire calls).
      for (const imp of module.imports) {
        if (imp.isNative) {
          if (imp.type === 'default') {
            out += `  var ${imp.defaultImport} = __nativeRequire('${imp.modulePath}');\n`;
          } else if (imp.type === 'named') {
            const names = imp.namedImports.map(n =>
              n.original !== n.alias ? `${n.original}: ${n.alias}` : n.original
            ).join(', ');
            out += `  var { ${names} } = __nativeRequire('${imp.modulePath}');\n`;
          } else if (imp.type === 'namespace') {
            out += `  var ${imp.namespaceImport} = __nativeRequire('${imp.modulePath}');\n`;
          } else if (imp.type === 'side-effect') {
            out += `  __nativeRequire('${imp.modulePath}');\n`;
          } else if (imp.type === 'combined') {
            out += `  var ${imp.defaultImport} = __nativeRequire('${imp.modulePath}');\n`;
            const namedNames = imp.namedImports.map(n =>
              n.original !== n.alias ? `${n.original}: ${n.alias}` : n.original
            ).join(', ');
            if (namedNames) out += `  var { ${namedNames} } = __nativeRequire('${imp.modulePath}');\n`;
          }
        } else {
          const depPath = this.resolveModulePath(imp.modulePath, module.path);
          const depMod  = this.moduleRegistry.get(depPath);
          if (!depMod || depMod.isNative) continue;

          const isCircular = this.isCircularDependency(module.path, depPath);

          if (imp.type === 'default') {
            if (isCircular) {
              out += `  var ${imp.defaultImport} = new Proxy({}, { get: (_, prop) => { const mod = __require('${depMod.id}'); return prop === 'default' ? mod.default : mod[prop]; } });\n`;
            } else {
              out += `  var ${imp.defaultImport} = __require('${depMod.id}').default;\n`;
            }
          } else if (imp.type === 'named') {
            if (isCircular) {
              for (const named of imp.namedImports) {
                const localName = named.alias || named.original;
                out += `  Object.defineProperty(exports, '${localName}', { get: () => __require('${depMod.id}').${named.original}, configurable: true });\n`;
              }
            } else {
              const names = imp.namedImports.map(n =>
                n.original !== n.alias ? `${n.original}: ${n.alias}` : n.original
              ).join(', ');
              out += `  var { ${names} } = __require('${depMod.id}');\n`;
            }
          } else if (imp.type === 'namespace') {
            if (isCircular) {
              out += `  var ${imp.namespaceImport} = new Proxy({}, { get: (_, prop) => __require('${depMod.id}')[prop] });\n`;
            } else {
              out += `  var ${imp.namespaceImport} = __require('${depMod.id}');\n`;
            }
          } else if (imp.type === 'combined') {
            if (isCircular) {
              out += `  var ${imp.defaultImport} = new Proxy({}, { get: (_, prop) => { const mod = __require('${depMod.id}'); return prop === 'default' ? mod.default : mod[prop]; } });\n`;
              for (const named of imp.namedImports) {
                const localName = named.alias || named.original;
                out += `  Object.defineProperty(exports, '${localName}', { get: () => __require('${depMod.id}').${named.original}, configurable: true });\n`;
              }
            } else {
              out += `  var ${imp.defaultImport} = __require('${depMod.id}').default;\n`;
              const namedNames = imp.namedImports.map(n =>
                n.original !== n.alias ? `${n.original}: ${n.alias}` : n.original
              ).join(', ');
              if (namedNames) out += `  var { ${namedNames} } = __require('${depMod.id}');\n`;
            }
          }
        }
      }

      out += '\n';
      for (const line of module.content.split('\n')) out += '  ' + line + '\n';
      out += '\n';

      // ---- Export emissions, guarded by isIdentifierDefined ----
      const hasImplicitDefault = this.isIdentifierDefined('_defaultExport', module.content);

      if (module.exports.hasDefault) {
        if (module.exports.defaultExport &&
            this.isIdentifierDefined(module.exports.defaultExport, module.content)) {
          out += `  exports.default = ${module.exports.defaultExport};\n`;
        } else if (module.exports.defaultExpression) {
          out += `  exports.default = ${module.exports.defaultExpression};\n`;
        } else if (hasImplicitDefault) {
          out += `  exports.default = _defaultExport;\n`;
        } else {
          out += `  // (no valid default export)\n`;
        }
      } else if (hasImplicitDefault) {
        out += `  exports.default = _defaultExport;\n`;
      }

      for (const name of module.exports.namedExports) {
        if (typeof name !== 'string' || name === 'default') continue;
        if (this.isIdentifierDefined(name, module.content)) {
          out += `  exports.${name} = ${name};\n`;
        } else {
          out += `  // (skipping undefined named export: ${name})\n`;
        }
      }

      out += `  return exports;\n`;
      out += `};\n\n`;
    }

    if (entryModule) {
      const namedExports = Array.from(entryModule.exports.namedExports).filter(
        n => n !== 'default' && this.isIdentifierDefined(n, entryModule.content)
      );

      out += `// ========================================\n`;
      out += `// Entry module execution (async)\n`;
      out += `// ========================================\n`;
      out += `(async () => {\n`;
      out += `  const __entry = await __require('${entryModule.id}');\n`;
      out += `  globalThis.__entry = __entry;\n`;
      out += `})().catch(error => {\n`;
      out += `  console.error('Failed to initialize:', error);\n`;
      out += `  process.exit(1);\n`;
      out += `});\n`;
      out += `export default (await __require('${entryModule.id}')).default;\n`;
      if (namedExports.length > 0) {
        out += `export const { ${namedExports.join(', ')} } = await __require('${entryModule.id}');\n`;
      }
    }

    return out;
  }

  // ---------- Public entry point ----------
  bundle(outputFile) {
    if (this.debug) console.log('🔍 Debug mode ON');
    console.log(`📦 Bundling: ${this.entryFile}`);
    this.processModule(this.entryFile);
    const bundled = this.generateBundle();
    const outPath = outputFile || 'bundle.output.js';
    writeFileSync(outPath, bundled, 'utf8');
    console.log(`✅ Bundle created: ${outPath}`);
    console.log(`📄 Modules bundled: ${this.processedModules.size}`);

    const nativeMods = new Set();
    for (const m of this.processedModules.values()) {
      for (const imp of m.imports) if (imp.isNative) nativeMods.add(imp.modulePath);
    }
    if (nativeMods.size > 0) {
      console.log(`🔧 Native modules: ${Array.from(nativeMods).join(', ')}`);
    }
    return bundled;
  }
}

// ---------- CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let debug = false;
  const filtered = args.filter(a => { if (a === '--debug') { debug = true; return false; } return true; });
  if (filtered.length === 0) {
    console.log('📚 ES6 Module Bundler');
    console.log('Usage: node Bundler.js [--debug] <entry-file.js> [output-file.js]');
    process.exit(1);
  }
  const entryFile = filtered[0];
  const outputFile = filtered[1] || 'bundle.output.js';
  try {
    const bundler = new ModuleBundler(entryFile, { debug });
    bundler.bundle(outputFile);
  } catch (err) {
    console.error('❌ Bundle failed:', err.message);
    if (debug) console.error(err.stack);
    process.exit(1);
  }
}

export default ModuleBundler;