// Proxy.js
import SyAPP from '../../../SyAPP.js'
import SyPM from '../../../SyPM.js'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { writeFileSync, readdirSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const PROCESS_NAME = 'sypm_proxy_server'
const LE_LIVE = '/etc/letsencrypt/live'
const LE_ARCHIVE = '/etc/letsencrypt/archive'

// ------------------------------------------------------------------
// Persistent, GLOBAL storage for the Proxy module (never /tmp).
//
//   ~/.sypm/proxy/config.json   → ACTIVE config (daemon reads this on boot)
//   ~/.sypm/proxy/saves/*.json  → NAMED snapshots (user-defined)
//
// Each named save contains rules + opts, and opts carries daemon and
// autoRestart, so those settings travel with the save too.
// ------------------------------------------------------------------
const SYPM_HOME       = path.join(os.homedir(), '.sypm')
const PROXY_DIR       = path.join(SYPM_HOME, 'proxy')
const PROXY_SAVES_DIR = path.join(PROXY_DIR, 'saves')
const PROXY_CONFIG    = path.join(PROXY_DIR, 'config.json')
const PROXY_SERVER    = path.join(PROXY_DIR, 'proxy_server.mjs')

try {
  if (!existsSync(PROXY_DIR))       fs.mkdirSync(PROXY_DIR,       { recursive: true })
  if (!existsSync(PROXY_SAVES_DIR)) fs.mkdirSync(PROXY_SAVES_DIR, { recursive: true })
} catch (e) {
  console.warn('[proxy] Failed to create config directories:', e.message)
}

// ------------------------------------------------------------------
// Certificate discovery — mirrors the original behaviour, but now also
// lets the UI list every certificate available on the machine so the
// user can pick one per rule instead of relying on a hard-coded path.
// ------------------------------------------------------------------
function listCertificates() {
  const out = []
  const seen = new Set()

  const pushCert = (domain, keyPath, certPath) => {
    if (!domain || seen.has(domain)) return
    if (!existsSync(keyPath) || !existsSync(certPath)) return
    seen.add(domain)
    out.push({ domain, key: keyPath, cert: certPath })
  }

  // Primary source: Let's Encrypt live directory (symlinks to archive)
  try {
    if (existsSync(LE_LIVE)) {
      for (const d of readdirSync(LE_LIVE)) {
        pushCert(
          d,
          path.join(LE_LIVE, d, 'privkey.pem'),
          path.join(LE_LIVE, d, 'fullchain.pem')
        )
      }
    }
  } catch { /* ignore */ }

  // Fallback: archive directory (in case live symlinks are broken)
  try {
    if (existsSync(LE_ARCHIVE)) {
      for (const d of readdirSync(LE_ARCHIVE)) {
        if (seen.has(d)) continue
        let files = []
        try { files = readdirSync(path.join(LE_ARCHIVE, d)) } catch { continue }
        const keyFile  = files.filter(f => f.startsWith('privkey')).sort().pop()
        const certFile = files.filter(f => f.startsWith('fullchain')).sort().pop()
        if (keyFile && certFile) {
          pushCert(
            d,
            path.join(LE_ARCHIVE, d, keyFile),
            path.join(LE_ARCHIVE, d, certFile)
          )
        }
      }
    }
  } catch { /* ignore */ }

  return out
}

// ------------------------------------------------------------------
// Server script — written to a temp .mjs file and launched by SyPM.
// Certificates are now passed in as explicit {domain,key,cert} pairs
// resolved at start time from the rule's `certDomain` (or the rule's
// own domain as fallback), so rules can point at ANY cert on disk.
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// Server script template — lives at a STABLE path
// (~/.sypm/proxy/proxy_server.mjs) and reads its rules/opts from the
// active config JSON at startup. Daemon mode points systemd at this
// permanent file (not /tmp), so it survives reboots.
// ------------------------------------------------------------------
const buildServerSource = (configPath) => `
import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { createSecureContext } from 'node:tls'

const CONFIG_PATH = ${JSON.stringify(configPath)}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch (e) {
    console.error('[proxy] Cannot read config ' + CONFIG_PATH + ': ' + e.message)
    return { rules: [], opts: { httpPort: 80, httpsPort: 443 } }
  }
}

const cfg   = loadConfig()
const rules = (cfg.rules || []).filter(r => r.domain && r.target)
const opts  = cfg.opts || {}

const certs = {}
for (const r of rules) {
  if (r.useHttps === false) continue
  const cd = r.certDomain || r.domain
  if (!cd || !r.certKey || !r.certCert) continue
  try {
    certs[cd] = { key: readFileSync(r.certKey), cert: readFileSync(r.certCert) }
  } catch (e) { console.warn('[cert] ' + cd + ': ' + e.message) }
}

function forward(req, res, rule, isHttps) {
  const t   = new URL(rule.target)
  const mod = t.protocol === 'https:' ? https : http
  const ip  = req.socket.remoteAddress
  const pr  = mod.request({
    hostname: t.hostname,
    port:     t.port || (t.protocol === 'https:' ? 443 : 80),
    path:     req.url,
    method:   req.method,
    headers: {
      ...req.headers,
      'X-Forwarded-For':   ip,
      'X-Real-IP':         ip,
      'X-Forwarded-Proto': isHttps ? 'https' : 'http',
      'X-Forwarded-Host':  req.headers.host
    }
  }, (pres) => { res.writeHead(pres.statusCode, pres.headers); pres.pipe(res) })
  pr.on('error', (e) => { console.error('[proxy]', e.message); res.writeHead(502); res.end('Bad Gateway') })
  req.pipe(pr)
}

const hp = opts.httpPort  || 80
const sp = opts.httpsPort || 443

console.log('[proxy] Starting with ' + rules.length + ' rule(s) from ' + CONFIG_PATH)

http.createServer((req, res) => {
  const rule = rules.find(r => r.domain === req.headers.host)
  if (rule && rule.useHttps === false) return forward(req, res, rule, false)
  res.writeHead(301, { Location: 'https://' + req.headers.host + req.url }); res.end()
}).listen(hp, '0.0.0.0', () => console.log('[proxy] HTTP  on ' + hp))

https.createServer({
  SNICallback: (domain, cb) => {
    const cert = certs[domain] || certs[Object.keys(certs)[0]]
    if (cert) return cb(null, createSecureContext(cert))
    cb(new Error('No cert for ' + domain))
  }
}, (req, res) => {
  const rule = rules.find(r => r.domain === req.headers.host)
  if (rule) return forward(req, res, rule, true)
  res.writeHead(404); res.end('No rule')
}).listen(sp, '0.0.0.0', () => console.log('[proxy] HTTPS on ' + sp))
`

// Bootstrap the stable server script (idempotent — content never changes).
try {
  if (!existsSync(PROXY_DIR)) fs.mkdirSync(PROXY_DIR, { recursive: true })
  const wanted = buildServerSource(PROXY_CONFIG)
  if (!existsSync(PROXY_SERVER) || fs.readFileSync(PROXY_SERVER, 'utf-8') !== wanted) {
    writeFileSync(PROXY_SERVER, wanted, 'utf-8')
  }
} catch (e) {
  console.warn('[proxy] Failed to bootstrap server script:', e.message)
}

class Proxy extends SyAPP.Func() {
  constructor() {
    super('Proxy', async (p) => { await this._render(p) }, { refreshMode: true })
  }

  _page(id)        { return this.Storages.Get(id, 'px_page') || 'main' }
  _rules(id)       { return this.Storages.Get(id, 'px_rules') || [] }
  _opts(id)        { return this.Storages.Get(id, 'px_opts') || { httpPort: 80, httpsPort: 443, daemon: false, autoRestart: false } }
  _go(id, p)       { this.Storages.Set(id, 'px_page', p) }
  // Return EVERY process tracked by SyPM under our name. There must never
  // be more than one, but if a previous transition left an orphan behind we
  // want to see it (so we can clean it up) instead of hiding it.
  _procs() {
    try { return SyPM.list().filter(x => x.name === PROCESS_NAME) } catch { return [] }
  }

  _proc() {
    const all = this._procs()
    return all.find(p => p.status === 'Running' || p.status === 'Restarting') || all[0] || null
  }

  // SyPM.kill() disables a daemon unit but does NOT stop a running one.
  // systemd keeps running services alive even after the unit file is
  // removed, and it can respawn them. Explicitly stop the service here so
  // no duplicate can come back to life mid-transition.
  _stopDaemonServices() {
    for (const p of this._procs()) {
      if (p.daemon !== 'Yes') continue
      try { execSync(`systemctl stop sypm-${p.id}.service 2>/dev/null || true`, { stdio: 'ignore' }) } catch {}
      try { execSync(`rc-service sypm-${p.id} stop 2>/dev/null || true`,        { stdio: 'ignore' }) } catch {}
    }
  }

  // Bring the tracked process count to ZERO. Returns the number of
  // instances still reported as running at the end (0 == clean slate).
  async _killAllProxy(timeoutMs = 6000) {
    // 1. Stop daemon services first so nothing can respawn.
    this._stopDaemonServices()

    // 2. Kill every tracked instance (dead entries included – SyPM.kill
    //    is safe on those too and clears their daemon unit if any).
    for (const p of this._procs()) {
      try { SyPM.kill(p.id) } catch {}
    }

    // 3. Second pass in case a service was still up during step 1.
    this._stopDaemonServices()

    // 4. Wait until the process tree has actually died.
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const alive = this._procs().filter(p => {
        if (p.daemon === 'Yes') return p.status === 'Running' || p.status === 'Restarting'
        try { return SyPM.isAlive(p.id) } catch { return false }
      })
      if (alive.length === 0) break
      await new Promise(r => setTimeout(r, 200))
    }

    // 5. Prune dead entries out of the registry so we start from a clean
    //    slate (no accumulating ghost rows after many Apply toggles).
    try { SyPM.cleanup() } catch {}

    // 6. Final sweep – anything that somehow survived gets one more kill.
    for (const p of this._procs()) {
      try { SyPM.kill(p.id) } catch {}
    }
    try { SyPM.cleanup() } catch {}

    return this._procs().filter(p => p.status === 'Running' || p.status === 'Restarting').length
  }
  _setRules(id, r) { this.Storages.Set(id, 'px_rules', r); this._persistConfig(id) }
  _setOpts(id, o)  { this.Storages.Set(id, 'px_opts', o);  this._persistConfig(id) }
  _newId()         { return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` }

  // ------------------------------------------------------------------
  // Save-name sanitisation — keeps filenames portable and blocks
  // directory traversal. Only [A-Za-z0-9._-] survive.
  // ------------------------------------------------------------------
  _safeName(name) {
    return String(name || '')
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^[._-]+/, '')
      .replace(/[._-]+$/, '')
      .slice(0, 64)
  }

  // ------------------------------------------------------------------
  // Snapshot current rules + opts, resolving cert paths into the
  // snapshot so it is self-contained. daemon and autoRestart ride
  // inside opts, so they are part of the save.
  // ------------------------------------------------------------------
  _snapshot(id) {
    const rules = this._rules(id)
    const opts  = this._opts(id)
    const certs = this._certs(id)

    const resolved = rules.map(r => {
      let certDomain = r.certDomain || ''
      let cert = null

      if (r.useHttps !== false && r.domain) {
        if (!certDomain) {
          cert = certs.find(c => c.domain === r.domain) || certs[0] || null
          certDomain = cert ? cert.domain : ''
        } else {
          cert = certs.find(c => c.domain === certDomain) || null
        }
      }

      return {
        ...r,
        certDomain,
        certKey:  cert ? cert.key  : '',
        certCert: cert ? cert.cert : ''
      }
    })

    return { rules: resolved, opts }
  }

  // Active config — written on every change so the daemon always boots
  // with the last-known-good ruleset.
  _persistConfig(id) {
    try {
      const snap = this._snapshot(id)
      const payload = { rules: snap.rules, opts: snap.opts, savedAt: new Date().toISOString() }
      if (!existsSync(PROXY_DIR)) fs.mkdirSync(PROXY_DIR, { recursive: true })
      writeFileSync(PROXY_CONFIG, JSON.stringify(payload, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[proxy] Failed to persist active config:', e.message)
    }
  }

  _loadConfigFromDisk() {
    try {
      if (!existsSync(PROXY_CONFIG)) return { rules: [], opts: null }
      const parsed = JSON.parse(fs.readFileSync(PROXY_CONFIG, 'utf-8'))
      return {
        rules: Array.isArray(parsed.rules) ? parsed.rules : [],
        opts:  parsed.opts || null
      }
    } catch (e) {
      console.warn('[proxy] Failed to load active config:', e.message)
      return { rules: [], opts: null }
    }
  }

  // ------------------------------------------------------------------
  // NAMED SAVES — one JSON file per user-defined snapshot under
  // ~/.sypm/proxy/saves/<name>.json
  // ------------------------------------------------------------------
  _listSaves() {
    try {
      if (!existsSync(PROXY_SAVES_DIR)) return []
      const files = readdirSync(PROXY_SAVES_DIR).filter(f => f.endsWith('.json'))
      const out = []
      for (const f of files) {
        try {
          const full = path.join(PROXY_SAVES_DIR, f)
          const stat = fs.statSync(full)
          const data = JSON.parse(fs.readFileSync(full, 'utf-8'))
          const opts = data.opts || {}
          out.push({
            name:        f.replace(/\.json$/, ''),
            mtime:       stat.mtimeMs,
            rulesCount:  (data.rules || []).length,
            daemon:      !!opts.daemon,
            autoRestart: !!opts.autoRestart,
            savedAt:     data.savedAt || new Date(stat.mtimeMs).toISOString()
          })
        } catch { /* skip broken file */ }
      }
      return out.sort((a, b) => b.mtime - a.mtime)
    } catch { return [] }
  }

  _saveNamed(id, name) {
    const clean = this._safeName(name)
    if (!clean) return { ok: false, error: 'Empty or invalid save name' }

    const snap = this._snapshot(id)
    const payload = {
      name: clean,
      savedAt: new Date().toISOString(),
      rules: snap.rules,
      opts:  snap.opts
    }

    try {
      if (!existsSync(PROXY_SAVES_DIR)) fs.mkdirSync(PROXY_SAVES_DIR, { recursive: true })
      const file = path.join(PROXY_SAVES_DIR, `${clean}.json`)
      const existed = existsSync(file)
      writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8')
      return { ok: true, clean, existed, rulesCount: snap.rules.length }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  _loadNamed(id, name) {
    const clean = this._safeName(name)
    if (!clean) return { ok: false, error: 'Invalid name' }

    const file = path.join(PROXY_SAVES_DIR, `${clean}.json`)
    if (!existsSync(file)) return { ok: false, error: `Save "${clean}" not found` }

    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
      const defaults = { httpPort: 80, httpsPort: 443, daemon: false, autoRestart: false }

      this.Storages.Set(id, 'px_rules', Array.isArray(data.rules) ? data.rules : [])
      this.Storages.Set(id, 'px_opts',  { ...defaults, ...(data.opts || {}) })

      // Keep the daemon-readable active config in sync with what was loaded.
      this._persistConfig(id)

      return { ok: true, clean, rulesCount: (data.rules || []).length }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  _deleteNamed(id, name) {
    const clean = this._safeName(name)
    if (!clean) return { ok: false, error: 'Invalid name' }

    const file = path.join(PROXY_SAVES_DIR, `${clean}.json`)
    try {
      if (!existsSync(file)) return { ok: false, error: 'Not found' }
      fs.unlinkSync(file)
      return { ok: true, clean }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  // ------------------------------------------------------------------
  // Daemon hardening. SyPM's default systemd unit hard-codes
  // /usr/bin/node (wrong under nvm/n/volta) and omits
  // AmbientCapabilities, so binding to :80/:443 after a fresh boot
  // fails. Patch the installed unit — scoped to Proxy only.
  // ------------------------------------------------------------------
  _fixDaemonService(procId) {
    const systemInfo = (() => {
      try { return SyPM._detectSystem() } catch { return { initSystem: 'unknown' } }
    })()
    if (systemInfo.initSystem !== 'systemd') return false

    const localUnit  = path.join(SYPM_HOME, 'daemons', `sypm-${procId}.service`)
    const systemUnit = `/etc/systemd/system/sypm-${procId}.service`
    if (!existsSync(localUnit)) return false

    try {
      let content = fs.readFileSync(localUnit, 'utf-8')
      const original = content

      const nodeBin = process.execPath || '/usr/bin/node'
      content = content.replace(/^ExecStart=\S+\s+/m, `ExecStart=${nodeBin} `)

      if (!/AmbientCapabilities=/.test(content)) {
        content = content.replace(
          /\[Service\]\s*/,
          `[Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n`
        )
      }

      if (!/network-online\.target/.test(content)) {
        content = content.replace(
          /^After=network\.target\s*$/m,
          'After=network-online.target\nWants=network-online.target'
        )
      }

      if (content === original) return false

      fs.writeFileSync(localUnit, content, 'utf-8')
      try { execSync(`sudo cp "${localUnit}" "${systemUnit}"`, { stdio: 'ignore' }) } catch { return false }
      try { execSync('sudo systemctl daemon-reload', { stdio: 'ignore' }) } catch {}
      try { execSync(`sudo systemctl enable sypm-${procId}.service`, { stdio: 'ignore' }) } catch {}
      return true
    } catch (e) {
      console.warn('[proxy] Failed to patch daemon service:', e.message)
      return false
    }
  }

  // Cert cache — refreshed every render so newly-issued certs show up.
  _certs(id) {
    const cached = this.Storages.Get(id, 'px_certs_cache')
    const stamp  = this.Storages.Get(id, 'px_certs_stamp') || 0
    const now    = Date.now()
    // Cache for 30s to avoid hammering the disk on every keystroke.
    if (cached && (now - stamp) < 30_000) return cached
    const fresh = listCertificates()
    this.Storages.Set(id, 'px_certs_cache', fresh)
    this.Storages.Set(id, 'px_certs_stamp', now)
    return fresh
  }

  _certByDomain(id, domain) {
    if (!domain) return null
    return this._certs(id).find(c => c.domain === domain) || null
  }

  async _render(props) {
    const id = props.session.UniqueID
    const cp = this.Builds.get(id)?.Session?.ActualProps || {}
    if(!this.Storages.Has(id,'parentfunc')){this.Storages.Set(id,'parentfunc',props.session.PreviousPath)}
    // First render — hydrate rules/opts from the ACTIVE global config.
    // Bypass _setRules/_setOpts to avoid re-saving what we just read.
    if (!this.Storages.Has(id, 'px_rules') || !this.Storages.Has(id, 'px_opts')) {
      const disk = this._loadConfigFromDisk()
      const defaults = { httpPort: 80, httpsPort: 443, daemon: false, autoRestart: false }
      this.Storages.Set(id, 'px_rules', Array.isArray(disk.rules) ? disk.rules : [])
      this.Storages.Set(id, 'px_opts',  { ...defaults, ...(disk.opts || {}) })
    }

    await this._events(id, cp)

    await this.PinnedTop(id, async () => {
      this.Text(id, '🔀 Proxy Manager')
      const page = this._page(id)
      const certCount = this._certs(id).length
      this.Buttons(id, [
        { name: page === 'main'     ? '● Status'   : 'Status',   props: { px_nav: 'main' } },
        { name: page === 'rules'    ? '● Rules'    : 'Rules',    props: { px_nav: 'rules' } },
        { name: page === 'certs'    ? `● Certs`    : `Certs`,    props: { px_nav: 'certs' } },
        { name: page === 'settings' ? '● Settings' : 'Settings', props: { px_nav: 'settings' } },
        ...(this.Storages.Get(id,'parentfunc') !== undefined ? [{ name: '<- Return', path: this.Storages.Get(id,'parentfunc') }] : [])
      ])
    })

    const page = this._page(id)
    if (page === 'rules')    return this._renderRules(id)
    if (page === 'certs')    return this._renderCerts(id)
    if (page === 'settings') return this._renderSettings(id)
    return this._renderMain(id)
  }

  async _events(id, p) {
    if (p.px_nav !== undefined) { this._go(id, p.px_nav); delete p.px_nav }

    if (p.px_refresh_certs) {
      delete p.px_refresh_certs
      this.Storages.Delete(id, 'px_certs_cache')
      this.Storages.Delete(id, 'px_certs_stamp')
      this.Alert(id, `🔄 Certificates refreshed (${this._certs(id).length} found)`, { duration: 2000 })
    }

    if (p.px_start)   { delete p.px_start;   await this._start(id) }
    if (p.px_stop)    { delete p.px_stop;    await this._stop(id) }
    if (p.px_restart) { delete p.px_restart; await this._restart(id) }
    if (p.px_cleanup) { delete p.px_cleanup; try { SyPM.cleanup() } catch {} }

    // Add a new blank rule
    if (p.px_add_rule) {
      delete p.px_add_rule
      const r = this._rules(id)
      r.push({ id: this._newId(), domain: '', target: '', useHttps: true, certDomain: '' })
      this._setRules(id, r)
    }

    // Delete a rule
    if (p.px_del_rule !== undefined) {
      const i = p.px_del_rule; delete p.px_del_rule
      const r = this._rules(id); r.splice(i, 1)
      this._setRules(id, r)
    }

    // Toggle HTTPS on a rule
    if (p.px_toggle_https !== undefined) {
      const i = p.px_toggle_https; delete p.px_toggle_https
      const r = this._rules(id)
      if (r[i]) r[i].useHttps = r[i].useHttps === false
      this._setRules(id, r)
    }

    // Cycle to the NEXT available certificate for a rule
    if (p.px_cycle_cert !== undefined) {
      const i = p.px_cycle_cert; delete p.px_cycle_cert
      const r = this._rules(id)
      const rule = r[i]
      if (!rule) return
      const certs = this._certs(id)
      if (certs.length === 0) { this.Alert(id, 'ℹ No certificates found on this machine', { duration: 2500 }); return }
      const curIdx = certs.findIndex(c => c.domain === rule.certDomain)
      const nextIdx = (curIdx + 1) % (certs.length + 1) // +1 = "auto" slot
      if (nextIdx === certs.length) {
        rule.certDomain = ''            // auto → use rule.domain
      } else {
        rule.certDomain = certs[nextIdx].domain
      }
      this._setRules(id, r)
    }

    // Pick a specific certificate for a rule (from Certs page)
    if (p.px_pick_cert_for !== undefined) {
      const [iStr, certDomain] = String(p.px_pick_cert_for).split('::')
      delete p.px_pick_cert_for
      const i = parseInt(iStr, 10)
      const r = this._rules(id)
      if (r[i]) { r[i].certDomain = certDomain === '__auto__' ? '' : certDomain; this._setRules(id, r) }
    }

    if (p.px_toggle_daemon) {
      delete p.px_toggle_daemon
      const o = this._opts(id); o.daemon = !o.daemon
      this._setOpts(id, o)
    }
    if (p.px_toggle_restart) {
      delete p.px_toggle_restart
      const o = this._opts(id); o.autoRestart = !o.autoRestart
      this._setOpts(id, o)
    }

    // ================================================================
    // NAMED SAVES — daemon + autoRestart ride inside opts, so they are
    // captured by every save and restored on every load.
    // px_selected_save = row picked in the list (target of actions)
    // px_active_save   = save currently applied (marked ★ in the header)
    // ================================================================

    if (p.px_save_named) {
      delete p.px_save_named
      const nameInput = this.Storages.Get(id, 'field_px_save_name') || ''
      const r = this._saveNamed(id, nameInput)
      if (r.ok) {
        this.Storages.Set(id, 'field_px_save_name', '')
        this.Storages.Set(id, 'px_selected_save', r.clean)
        this.Storages.Set(id, 'px_active_save',   r.clean)
        this.Alert(id,
          r.existed
            ? `💾 Overwrote "${r.clean}" (${r.rulesCount} rule(s))`
            : `💾 Saved as "${r.clean}" (${r.rulesCount} rule(s))`,
          { duration: 2500 })
      } else {
        this.Alert(id, `❌ ${r.error}`, { duration: 3000 })
      }
    }

    if (p.px_overwrite_named) {
      const name = p.px_overwrite_named; delete p.px_overwrite_named
      const r = this._saveNamed(id, name)
      if (r.ok) {
        this.Storages.Set(id, 'px_selected_save', r.clean)
        this.Storages.Set(id, 'px_active_save',   r.clean)
        this.Alert(id, `💾 Updated "${r.clean}" (${r.rulesCount} rule(s))`, { duration: 2500 })
      } else {
        this.Alert(id, `❌ ${r.error}`, { duration: 3000 })
      }
    }

    if (p.px_select_save) {
      const name = p.px_select_save; delete p.px_select_save
      this.Storages.Set(id, 'px_selected_save', name)
    }

    if (p.px_load_named !== undefined) {
      const name = p.px_load_named; delete p.px_load_named
      const r = this._loadNamed(id, name)
      if (r.ok) {
        this.Storages.Set(id, 'px_selected_save', r.clean)
        this.Storages.Set(id, 'px_active_save',   r.clean)
        this.Alert(id, `📂 Loaded "${r.clean}" (${r.rulesCount} rule(s))`, { duration: 2500 })
      } else {
        this.Alert(id, `❌ ${r.error}`, { duration: 3000 })
      }
    }

    if (p.px_delete_named !== undefined) {
      const name = p.px_delete_named; delete p.px_delete_named
      const r = this._deleteNamed(id, name)
      if (r.ok) {
        if (this.Storages.Get(id, 'px_selected_save') === r.clean) this.Storages.Delete(id, 'px_selected_save')
        if (this.Storages.Get(id, 'px_active_save')   === r.clean) this.Storages.Delete(id, 'px_active_save')
        this.Alert(id, `🗑 Deleted "${r.clean}"`, { duration: 2000 })
      } else {
        this.Alert(id, `❌ ${r.error}`, { duration: 3000 })
      }
    }
  }

  async _start(id) {
    const rulesRaw = this._rules(id)
    const rules = rulesRaw.filter(r => r.domain && r.target)

    if (!rules.length) { this.Alert(id, '❌ Add at least one rule first', { duration: 3000 }); return }

    // Resolve certificates for HTTPS rules
    const certs = this._certs(id)
    const resolved = []
    for (const r of rules) {
      let certDomain = r.certDomain
      let cert = null

      if (r.useHttps !== false) {
        if (!certDomain) {
          // Auto: try to match the rule's own domain, else take the first cert available.
          cert = certs.find(c => c.domain === r.domain) || certs[0] || null
          certDomain = cert ? cert.domain : ''
        } else {
          cert = certs.find(c => c.domain === certDomain) || null
        }
        if (!cert) {
          this.Alert(id, `❌ HTTPS rule "${r.domain}" has no certificate (looked for "${certDomain || r.domain}")`, { duration: 5000 })
          return
        }
      }

      resolved.push({
        domain:     r.domain,
        target:     r.target,
        useHttps:   r.useHttps !== false,
        certDomain: certDomain,
        certKey:    cert ? cert.key  : '',
        certCert:   cert ? cert.cert : ''
      })
    }

    // ------------------------------------------------------------------
    // CLEAN TRANSITION
    // There must NEVER be more than one proxy process. Kill EVERY tracked
    // instance (including any orphans), stop every daemon unit, wait for
    // the process tree to fully die and the registry to be pruned, then
    // start the fresh one. If the old tree refuses to die we abort the
    // start rather than risk spawning a duplicate.
    // ------------------------------------------------------------------
    const remaining = await this._killAllProxy()
    if (remaining > 0) {
      this.Alert(id, `⚠ Could not fully stop ${remaining} old process(es) — start aborted to avoid duplicates`, { duration: 5000 })
      return
    }

    // Persist rules+opts (including daemon/autoRestart) to the ACTIVE
    // config BEFORE launching so the daemon always reads the freshest
    // ruleset on boot. Named saves are unaffected by this step.
    this._persistConfig(id)

    // Ensure the stable server script exists (idempotent bootstrap).
    try {
      const wanted = buildServerSource(PROXY_CONFIG)
      if (!existsSync(PROXY_SERVER) || fs.readFileSync(PROXY_SERVER, 'utf-8') !== wanted) {
        writeFileSync(PROXY_SERVER, wanted, 'utf-8')
      }
    } catch (e) {
      this.Alert(id, `❌ Cannot write server script: ${e.message}`, { duration: 5000 })
      return
    }

    const opts = this._opts(id)

    try {
      const res = SyPM.run(PROXY_SERVER, {
        name: PROCESS_NAME,
        daemon: !!opts.daemon,
        autoRestart: !!opts.autoRestart,
        restartTries: opts.autoRestart ? 999 : 0,
        workingDir: PROXY_DIR
      })

      // Post-start sanity check: prune everything except the new entry.
      const after = this._procs()
      if (after.length > 1) {
        for (const p of after) {
          if (p.id !== res.id) { try { SyPM.kill(p.id) } catch {} }
        }
        try { SyPM.cleanup() } catch {}
      }

      // Harden the freshly-installed systemd unit so it actually comes
      // back up after a reboot (correct node path + port-bind capability).
      let daemonNote = ''
      if (opts.daemon) {
        const fixed = this._fixDaemonService(res.id)
        daemonNote = fixed ? '  [daemon: hardened]' : '  [daemon]'
      }

      this.Alert(id, `✅ Proxy started  PID ${res.pid}${daemonNote}${opts.autoRestart ? '  [auto-restart]' : ''}`, { duration: 3500 })
    } catch (e) {
      this.Alert(id, `❌ ${e.message}`, { duration: 5000 })
    }
  }

  async _stop(id) {
    try {
      if (this._procs().length === 0) { this.Alert(id, 'ℹ Not running', { duration: 2000 }); return }
      const remaining = await this._killAllProxy()
      if (remaining === 0) this.Alert(id, '🛑 Stopped', { duration: 2500 })
      else                 this.Alert(id, `⚠ ${remaining} process(es) still alive`, { duration: 4000 })
    } catch (e) { this.Alert(id, `❌ ${e.message}`, { duration: 4000 }) }
  }

  async _restart(id) {
    try {
      if (this._procs().length === 0) { this.Alert(id, 'ℹ Not running', { duration: 2000 }); return }
      // _start() performs its own kill-everything-first transition, so a
      // restart is simply "start again" — no risky deferred SyPM.restart().
      await this._start(id)
    } catch (e) { this.Alert(id, `❌ ${e.message}`, { duration: 4000 }) }
  }

  // ------------------------------------------------------------------
  // Pages
  // ------------------------------------------------------------------
  _renderMain(id) {
    const procs = this._procs()
    const proc  = this._proc()
    const rules = this._rules(id)
    const certs = this._certs(id)
    const running = !!(proc && (proc.status === 'Running' || proc.status === 'Restarting'))

    this.Text(id, ' ')
    this.Text(id, running ? `🟢 ${proc.status}   PID ${proc.pid}` : '🔴 Proxy is not running')
    this.Text(id, `📋 ${rules.length} rule(s)   •   🔐 ${certs.length} certificate(s) found`)

    // Warn loudly if the registry somehow contains more than one instance.
    if (procs.length > 1) {
      this.Text(id, `⚠ ${procs.length} proxy instances detected — click Restart or Stop to clean up`)
    }

    this.Text(id, ' ')

    const btns = running
      ? [{ name: '🔄 Restart', props: { px_restart: 1 } }, { name: '🛑 Stop', props: { px_stop: 1 } }]
      : [{ name: '▶ Start', props: { px_start: 1 } }]
    btns.push({ name: '🧹 Cleanup dead', props: { px_cleanup: 1 } })
    this.Buttons(id, btns)

    if (proc) {
      this.Text(id, ' ')
      this.Text(id, `Daemon: ${proc.daemon || 'No'}  •  Auto-restart: ${proc.autoRestart || 'No'}  •  Tries: ${proc.tries || 0}`)
    }
  }

  _renderRules(id) {
    const rules = this._rules(id)
    const certs = this._certs(id)

    this.Text(id, `📋 ${rules.length} rule(s)   •   🔐 ${certs.length} cert(s)`)

    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]
      const isHttps = r.useHttps !== false

      this.Text(id, `── Rule #${i + 1} ──`)

      this.Field(id, `px_r_${r.id}_domain`, {
        label: 'Domain',
        initialValue: r.domain || '',
        onChange: (v) => { const rr = this._rules(id); const x = rr.find(y => y.id === r.id); if (x) { x.domain = v; this._setRules(id, rr) } }
      })

      this.Field(id, `px_r_${r.id}_target`, {
        label: 'Target (e.g. http://127.0.0.1:3000)',
        initialValue: r.target || '',
        onChange: (v) => { const rr = this._rules(id); const x = rr.find(y => y.id === r.id); if (x) { x.target = v; this._setRules(id, rr) } }
      })

      // Certificate selector — only meaningful for HTTPS rules.
      if (isHttps) {
        const chosen = r.certDomain || ''
        const autoMatch = certs.find(c => c.domain === r.domain)
        const label = chosen
          ? `🔐 Cert: ${chosen}`
          : autoMatch
            ? `🔐 Cert: auto → ${autoMatch.domain}`
            : `🔐 Cert: auto (none matched!)`
        this.Button(id, {
          name: certs.length > 0 ? `${label}   (click to cycle)` : `${label}   (no certs on disk)`,
          props: { px_cycle_cert: i }
        })
      }

      this.Buttons(id, [
        { name: `🔐 HTTPS ${isHttps ? '✓' : '✗'}`, props: { px_toggle_https: i } },
        { name: '🗑 Delete', props: { px_del_rule: i } }
      ])

      this.Text(id, ' ')
    }

    this.Buttons(id, [
      { name: '＋ Add Rule',   props: { px_add_rule: 1 } },
      { name: '▶ Start/Apply', props: { px_start: 1 } }
    ])
  }

  _renderCerts(id) {
    const certs = this._certs(id)

    this.Text(id, `🔐 ${certs.length} certificate(s) discovered`)
    this.Text(id, `📁 ${LE_LIVE}`)
    this.Text(id, ' ')

    this.Buttons(id, [
      { name: '🔄 Refresh', props: { px_refresh_certs: 1 } },
      { name: '← Rules',    props: { px_nav: 'rules' } }
    ])

    if (certs.length === 0) {
      this.Text(id, ' ')
      this.Text(id, 'No certificates found.')
      this.Text(id, 'Expected layout:')
      this.Text(id, `  ${LE_LIVE}/<domain>/privkey.pem`)
      this.Text(id, `  ${LE_LIVE}/<domain>/fullchain.pem`)
      return
    }

    // Group rules by which cert they currently use, so we can render the
    // "assign to which rule" picker inside the cert card.
    const rules = this._rules(id)

    for (let ci = 0; ci < certs.length; ci++) {
      const c = certs[ci]
      this.Text(id, `── 🔐 ${c.domain} ──`)
      this.Text(id, `  ${path.dirname(c.cert)}`)

      if (rules.length === 0) {
        this.Text(id, '  (no rules yet)')
      } else {
        const row = [
          { name: 'Auto (match domain)', props: { px_pick_cert_for: `${0}::__auto__` } } // placeholder replaced below
        ]
        // Build a proper row: for each rule, a button to assign this cert.
        // Keep it compact — cap at 8 rules displayed.
        const limited = rules.slice(0, 8)
        const buttons = []
        for (let ri = 0; ri < limited.length; ri++) {
          const rr = limited[ri]
          const active = rr.certDomain === c.domain
          buttons.push({
            name: `${active ? '●' : '○'} Rule ${ri + 1} (${rr.domain || '?'})`,
            props: { px_pick_cert_for: `${ri}::${c.domain}` }
          })
        }
        buttons.push({ name: '↺ Unassign', props: { px_pick_cert_for: `${0}::__auto__` } })
        this.Buttons(id, buttons)
      }
      this.Text(id, ' ')
    }
  }

  async _renderSettings(id) {
    const o     = this._opts(id)
    const certs = this._certs(id)

    // === Network (compact) ===
    this.Text(id, '⚙ Settings')
    this.Field(id, 'px_http_port', {
      label: 'HTTP',
      initialValue: String(o.httpPort || 80),
      onChange: (v) => { const oo = this._opts(id); oo.httpPort = parseInt(v, 10) || 80; this._setOpts(id, oo) }
    })
    this.Field(id, 'px_https_port', {
      label: 'HTTPS',
      initialValue: String(o.httpsPort || 443),
      onChange: (v) => { const oo = this._opts(id); oo.httpsPort = parseInt(v, 10) || 443; this._setOpts(id, oo) }
    })
    this.Buttons(id, [
      { name: `🛡 Daemon ${o.daemon ? '✓' : '✗'}`,             props: { px_toggle_daemon: 1 } },
      { name: `🔄 Auto ${o.autoRestart ? '✓' : '✗'}`,          props: { px_toggle_restart: 1 } },
      { name: `🔄 Certs (${certs.length})`,                     props: { px_refresh_certs: 1 } }
    ])

    // === Save management (compact) ===
    this.Text(id, ' ')
    await this._renderSaveManager(id)

    this.Text(id, ' ')
    this.Buttons(id, [{ name: '▶ Apply & Start', props: { px_start: 1 } }])
  }

  // ------------------------------------------------------------------
  // Compact save manager. Whole block is ~4 visible rows:
  //   1. header:  ★ <active save> · <rules> · 🛡🔄   (or "(unsaved)")
  //   2. field:   Save as  [_______]
  //   3. buttons: [💾 Save new]
  //   4. actions: [📂 Load] [💾 Overwrite] [🗑 Delete]  ← only when selected
  //   5. dropdown: [▼ 📚 Presets (n)]                   ← collapsed by default
  // daemon + autoRestart are read straight from each save's opts and
  // shown as 🛡/🔄 badges both in the header and in each preset row.
  // ------------------------------------------------------------------
  async _renderSaveManager(id) {
    const saves        = this._listSaves()
    const activeName   = this.Storages.Get(id, 'px_active_save')   || ''
    const selectedName = this.Storages.Get(id, 'px_selected_save') || ''
    const activeSave   = saves.find(s => s.name === activeName)
    const selectedSave = saves.find(s => s.name === selectedName)
    const o            = this._opts(id)

    const fmt    = (ms)  => new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
    const badges = (d, r) => (`${d ? '🛡' : ''}${r ? '🔄' : ''}` || '—')

    // Header line: active save (or "unsaved") + current daemon/restart
    const curBadges = badges(o.daemon, o.autoRestart)
    const header = activeSave
      ? `★ ${activeSave.name}  ·  ${this._rules(id).length}r  ·  ${curBadges}`
      : `(unsaved)  ·  ${this._rules(id).length}r  ·  ${curBadges}`
    const selTag = (selectedSave && selectedSave.name !== activeName)
      ? `    ● ${selectedSave.name}`
      : ''

    this.Text(id, `💾 Saves   ${header}${selTag}`)

    // Save-as field + button
    this.Field(id, 'px_save_name', {
      label: 'Save as',
      initialValue: '',
      maxWidth: 32
    })
    this.Buttons(id, [{ name: '💾 Save new', props: { px_save_named: 1 } }])

    // Contextual actions — only shown when a save is selected
    if (selectedSave) {
      this.Buttons(id, [
        { name: '📂 Load',      props: { px_load_named:      selectedName } },
        { name: '💾 Overwrite', props: { px_overwrite_named: selectedName } },
        { name: '🗑 Delete',    props: { px_delete_named:    selectedName } }
      ])
    }

    // Collapsed preset list — one row per save, click to select
    await this.DropDown(id, 'px_saves_list', async () => {
      if (saves.length === 0) {
        this.Button(id, { name: '  (no saves yet)', props: {} })
        return
      }
      for (const s of saves) {
        const mark = s.name === selectedName ? '●' : '○'
        const star = s.name === activeName   ? ' ★' : ''
        this.Button(id, {
          name: `${mark} ${s.name}${star}  ·  ${s.rulesCount}r  ·  ${badges(s.daemon, s.autoRestart)}  ·  ${fmt(s.mtime)}`,
          props: { px_select_save: s.name }
        })
      }
    }, {
      up_buttontext:   `📚 Presets (${saves.length})`,
      down_buttontext: 'Hide presets',
      up_emoji:   '▶',
      down_emoji: '▼'
    })

    this.Text(id, `📁 ${PROXY_DIR}`)
  }
}

export default Proxy
