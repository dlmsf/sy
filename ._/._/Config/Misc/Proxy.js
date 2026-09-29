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

// Async sleep helper — used by process transitions to wait for PIDs to
// actually disappear and ports to actually be released, instead of a
// fixed delay that races with the OS teardown.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
const buildServer = (rules, opts) => `
import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { createSecureContext } from 'node:tls'

const rules = ${JSON.stringify(rules)}
const opts  = ${JSON.stringify(opts)}

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

class Proxy extends SyAPP.Func() {
  constructor() {
    super('Proxy', async (p) => { await this._render(p) }, { refreshMode: true })
  }

  _page(id)        { return this.Storages.Get(id, 'px_page') || 'main' }
  _rules(id)       { return this.Storages.Get(id, 'px_rules') || [] }
  _opts(id)        { return this.Storages.Get(id, 'px_opts') || { httpPort: 80, httpsPort: 443, daemon: false, autoRestart: false } }
  _go(id, p)       { this.Storages.Set(id, 'px_page', p) }
  _proc()          { try { return SyPM.list().find(x => x.name === PROCESS_NAME) || null } catch { return null } }
  _setRules(id, r) { this.Storages.Set(id, 'px_rules', r) }
  _setOpts(id, o)  { this.Storages.Set(id, 'px_opts', o) }
  _newId()         { return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` }

  // ------------------------------------------------------------------
  // Process management helpers — used by every process transition
  // (start / stop / restart / hard reset) so that we NEVER leave more
  // than one proxy process alive, and we NEVER leave an orphan holding
  // the HTTP/HTTPS ports.
  // ------------------------------------------------------------------

  /** True if a PID is currently alive. */
  _isAlive(pid) {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  /** Return the PIDs currently listening on a TCP port (empty if none). */
  _pidsOnPort(port) {
    if (!port) return []
    try {
      const out = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf-8' }).trim()
      if (!out) return []
      return out.split(/\s+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 1)
    } catch { return [] }
  }

  /** SIGKILL everything holding the given ports. Returns the killed PIDs. */
  _killPortHolders(ports) {
    const killed = []
    const seen = new Set()
    for (const port of ports) {
      if (!port) continue
      for (const pid of this._pidsOnPort(port)) {
        if (seen.has(pid)) continue
        seen.add(pid)
        try { process.kill(pid, 'SIGKILL'); killed.push(pid) } catch {}
      }
    }
    return killed
  }

  /**
   * Wait (polling) until the given ports have no listeners. Returns true
   * when they are free, false on timeout. This is what makes the "apply
   * settings" flow reliable: we never spawn a new proxy until the old
   * one has actually released its ports.
   */
  async _waitForPortsFree(ports, timeoutMs = 8000) {
    const list = ports.filter(Boolean)
    if (list.length === 0) return true
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const busy = list.filter((p) => this._pidsOnPort(p).length > 0)
      if (busy.length === 0) return true
      await sleep(200)
    }
    return false
  }

  /** Wait (polling) until a PID is gone. */
  async _waitForPidGone(pid, timeoutMs = 6000) {
    if (!pid) return true
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this._isAlive(pid)) return true
      await sleep(150)
    }
    return false
  }

  /**
   * Stop the systemd/OpenRC service backing a daemon-mode SyPM process.
   *
   * IMPORTANT: `SyPM.kill()` only *disables* the daemon unit — it does
   * NOT stop the running service. Because the generated unit uses
   * `Restart=always`, systemd would immediately respawn a fresh node
   * process the moment we kill the tracked PID. This is exactly the
   * "persistent nodejs process" bug. We must therefore `systemctl stop`
   * (or `rc-service stop`) BEFORE asking SyPM to kill anything.
   */
  _stopDaemonService(processId) {
    if (!processId) return
    try {
      execSync(`sudo systemctl stop sypm-${processId}.service 2>/dev/null || true`)
      execSync(`sudo systemctl reset-failed sypm-${processId}.service 2>/dev/null || true`)
    } catch {}
    try {
      execSync(`sudo rc-service sypm-${processId} stop 2>/dev/null || true`)
    } catch {}
  }

  /**
   * Kill + drop every proxy entry from the SyPM registry.
   *
   * This is what guarantees "no more than one process": we always
   * purge *all* rows carrying our process name, not just the one
   * `_proc()` happens to return first. Without this, a stale `Stopped`
   * row can shadow the live `Running` one and the UI lies about state.
   */
  _purgeRegistryEntries() {
    let removed = 0
    try {
      const entries = SyPM.list().filter((x) => x.name === PROCESS_NAME)
      for (const entry of entries) {
        try {
          // 1) Stop the init-system unit first (if daemon), otherwise
          //    systemd/OpenRC will respawn it (Restart=always).
          this._stopDaemonService(entry.id)
          // 2) Kill the process tree via SyPM (also disables the unit).
          SyPM.kill(entry.id)
          // 3) Drop the registry row so it doesn't linger as "Stopped".
          SyPM._removeFromRegistry(entry.id)
          removed++
        } catch {}
      }
    } catch {}
    return removed
  }

  /** Kill any stray `node .../sypm_proxy_*.mjs` process left on the box. */
  _killStrayProxyNodes() {
    let killed = 0
    try {
      // -f matches the full command line: our temp script is named
      //   `sypm_proxy_<timestamp>.mjs` inside os.tmpdir().
      const out = execSync(`pgrep -af "sypm_proxy_" 2>/dev/null || true`, { encoding: 'utf-8' }).trim()
      if (out) {
        for (const line of out.split('\n')) {
          const pid = parseInt(line.split(/\s+/)[0], 10)
          if (Number.isFinite(pid) && pid > 1) {
            try { process.kill(pid, 'SIGKILL'); killed++ } catch {}
          }
        }
      }
    } catch {}
    return killed
  }

  /** Best-effort removal of leftover temp proxy scripts. */
  _cleanupTempScripts() {
    let removed = 0
    try {
      const dir = os.tmpdir()
      for (const f of readdirSync(dir)) {
        if (f.startsWith('sypm_proxy_') && f.endsWith('.mjs')) {
          try { fs.unlinkSync(path.join(dir, f)); removed++ } catch {}
        }
      }
    } catch {}
    return removed
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
    if (!this.Storages.Has(id, 'px_rules')) this._setRules(id, [])
    if (!this.Storages.Has(id, 'px_opts'))  this._setOpts(id, { httpPort: 80, httpsPort: 443, daemon: false, autoRestart: false })

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

    if (p.px_start)      { delete p.px_start;      await this._start(id) }
    if (p.px_stop)       { delete p.px_stop;       await this._stop(id) }
    if (p.px_restart)    { delete p.px_restart;    await this._restart(id) }
    if (p.px_cleanup)    { delete p.px_cleanup;    try { SyPM.cleanup() } catch {} }
    if (p.px_hard_reset) { delete p.px_hard_reset; await this._hardReset(id) }

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
    // CLEAN TRANSITION — always fully tear down the previous process
    // before starting a new one. This is what fixes the "toggling daemon
    // in settings creates a second process without killing the first"
    // bug: we now (a) stop the init-system unit so Restart=always cannot
    // respawn it, (b) kill the process tree, (c) purge the registry row
    // so no stale "Stopped" entry shadows the new "Running" one, (d)
    // wait for the tracked PID to actually disappear, and (e) wait for
    // the ports to actually be released before spawning.
    // ------------------------------------------------------------------
    const opts  = this._opts(id)
    const ports = [opts.httpPort, opts.httpsPort]

    const existing   = this._proc()
    const existingPid = existing ? existing.pid : null

    if (existing) {
      // Stop the systemd/OpenRC unit first (if it was a daemon), so the
      // init system does not respawn it while we are tearing things down.
      this._stopDaemonService(existing.id)
    }

    // Kill + purge every registry entry carrying our name (usually just
    // one; this also clears any legacy rows leaked by earlier runs).
    this._purgeRegistryEntries()

    // Orphans: any node process still pointing at a sypm_proxy_*.mjs.
    this._killStrayProxyNodes()

    // Orphans holding our ports.
    this._killPortHolders(ports)

    // Wait for the tracked PID to disappear (if it was ours).
    if (existingPid) {
      await this._waitForPidGone(existingPid, 5000)
    }

    // Wait for ports to actually be released.
    let portsFreed = await this._waitForPortsFree(ports, 8000)
    if (!portsFreed) {
      this._killPortHolders(ports)
      portsFreed = await this._waitForPortsFree(ports, 3000)
    }
    if (!portsFreed) {
      this.Alert(id, `❌ Ports ${ports.join(', ')} still busy — aborting start`, { duration: 5000 })
      return
    }

    // Small settle delay so the init system / kernel has fully
    // processed the teardown before we ask for new listeners.
    await sleep(250)

    const script = path.join(os.tmpdir(), `sypm_proxy_${Date.now()}.mjs`)
    writeFileSync(script, buildServer(resolved, opts), 'utf-8')

    try {
      const res = SyPM.run(script, {
        name: PROCESS_NAME,
        daemon: !!opts.daemon,
        autoRestart: !!opts.autoRestart,
        restartTries: opts.autoRestart ? 999 : 0
      })
      this.Alert(id, `✅ Proxy started  PID ${res.pid}${opts.daemon ? '  [daemon]' : ''}${opts.autoRestart ? '  [auto-restart]' : ''}`, { duration: 3500 })
    } catch (e) {
      this.Alert(id, `❌ ${e.message}`, { duration: 5000 })
    }
  }

  async _stop(id, silent = false) {
    const p = this._proc()
    if (!p) {
      if (!silent) this.Alert(id, 'ℹ Not running', { duration: 2000 })
      return true
    }

    try {
      // 1) Stop the init-system unit first (if daemon) so systemd/OpenRC
      //    does not respawn the process.
      this._stopDaemonService(p.id)

      // 2) Kill + purge every registry entry with our name.
      this._purgeRegistryEntries()

      // 3) Sweep for stray processes holding our ports / temp scripts.
      const opts  = this._opts(id)
      const ports = [opts.httpPort, opts.httpsPort]
      this._killStrayProxyNodes()
      this._killPortHolders(ports)

      // 4) Wait until the ports are actually free.
      const freed = await this._waitForPortsFree(ports, 6000)

      if (!silent) {
        this.Alert(
          id,
          freed ? '🛑 Stopped & ports released' : '⚠ Stopped, but ports still busy',
          { duration: 3000 }
        )
      }
      return freed
    } catch (e) {
      if (!silent) this.Alert(id, `❌ ${e.message}`, { duration: 4000 })
      return false
    }
  }

  async _restart(id) {
    const p = this._proc()
    if (!p) { this.Alert(id, 'ℹ Not running', { duration: 2000 }); return }

    // Use our own stop → start pair instead of SyPM.restart(): SyPM.restart
    // relies on a fixed 1 s setTimeout between kill and re-spawn, which is
    // exactly the race that was producing "two processes at once". We wait
    // for the ports / PIDs to actually settle before starting again.
    this.Alert(id, '🔄 Restarting…', { duration: 2000 })
    await this._stop(id, true)
    await sleep(300)
    await this._start(id)
  }

  // ------------------------------------------------------------------
  // HARD RESET — "nuclear" stop of the entire Proxy interface.
  //
  // Why this exists: on some hosts, killing the tracked SyPM PID is not
  // enough. The init system (Restart=always) can respawn a daemon unit,
  // orphan `node .../sypm_proxy_*.mjs` processes can survive a normal
  // kill, and a port can stay bound for a few seconds. This routine does
  // ALL of the following, in order, and reports back:
  //
  //   1. stop the systemd/OpenRC unit (so it cannot respawn),
  //   2. disable + remove the daemon unit entirely,
  //   3. kill every proxy registry entry (SyPM.kill → process tree),
  //   4. purge the proxy entries from the registry,
  //   5. pkill every stray `sypm_proxy_*.mjs` process,
  //   6. SIGKILL whoever still holds the HTTP/HTTPS ports,
  //   7. wait for the ports to actually be released,
  //   8. remove leftover temp proxy scripts,
  //   9. run SyPM.cleanup() to drop any remaining dead registry rows.
  // ------------------------------------------------------------------
  async _hardReset(id) {
    const opts  = this._opts(id)
    const ports = [opts.httpPort, opts.httpsPort]
    const report = []

    // 1) Stop the init system unit for every proxy entry we know about.
    try {
      const entries = SyPM.list().filter((x) => x.name === PROCESS_NAME)
      for (const e of entries) this._stopDaemonService(e.id)
    } catch {}

    // 2) Full daemon disable (removes the unit files from /etc).
    try {
      const entries = SyPM.list().filter((x) => x.name === PROCESS_NAME)
      for (const e of entries) {
        try { SyPM._disableDaemon(e.id) } catch {}
      }
    } catch {}

    // 3) + 4) Kill + purge every proxy registry row.
    const purged = this._purgeRegistryEntries()
    if (purged) report.push(`${purged} registry entr${purged === 1 ? 'y' : 'ies'}`)

    // 5) Stray node processes still pointing at our temp scripts.
    const strayKilled = this._killStrayProxyNodes()
    if (strayKilled) report.push(`${strayKilled} stray node proc${strayKilled === 1 ? '' : 's'}`)

    // 6) Whoever is still holding the ports (orphans from previous runs).
    const portKilled = this._killPortHolders(ports)
    if (portKilled.length) report.push(`${portKilled.length} port holder${portKilled.length === 1 ? '' : 's'}`)

    // 7) Wait for the ports to actually be released.
    let freed = await this._waitForPortsFree(ports, 8000)
    if (!freed) {
      this._killPortHolders(ports)
      freed = await this._waitForPortsFree(ports, 3000)
    }
    if (!freed) report.push('⚠ ports still busy')

    // 8) Temp script sweep.
    const tmp = this._cleanupTempScripts()
    if (tmp) report.push(`${tmp} temp script${tmp === 1 ? '' : 's'}`)

    // 9) Registry cleanup (dead rows that belong to ANY process).
    try { SyPM.cleanup() } catch {}

    const summary = report.length ? report.join(', ') : 'nothing to clean'
    this.Alert(id, `💥 Hard reset complete — ${summary}`, { duration: 5000 })
  }

  // ------------------------------------------------------------------
  // Pages
  // ------------------------------------------------------------------
  _renderMain(id) {
    const proc  = this._proc()
    const rules = this._rules(id)
    const certs = this._certs(id)
    const running = !!(proc && (proc.status === 'Running' || proc.status === 'Restarting'))

    this.Text(id, ' ')
    this.Text(id, running ? `🟢 ${proc.status}   PID ${proc.pid}` : '🔴 Proxy is not running')
    this.Text(id, `📋 ${rules.length} rule(s)   •   🔐 ${certs.length} certificate(s) found`)
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

    // Hard reset sits on its own row so it cannot be hit by accident.
    this.Text(id, ' ')
    this.Buttons(id, [
      { name: '💥 Hard Reset (kill everything)', props: { px_hard_reset: 1 } }
    ])
    this.Text(id, '💥 Hard reset stops the daemon unit, kills every stray node process, releases the HTTP/HTTPS ports and cleans temp files.')
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

  _renderSettings(id) {
    const o = this._opts(id)
    const certs = this._certs(id)

    this.Text(id, ' ')
    this.Text(id, '⚙ Settings')
    this.Text(id, `🔐 ${certs.length} certificate(s) available`)
    this.Text(id, ' ')

    this.Field(id, 'px_http_port', {
      label: 'HTTP port',
      initialValue: String(o.httpPort || 80),
      onChange: (v) => { const oo = this._opts(id); oo.httpPort = parseInt(v, 10) || 80; this._setOpts(id, oo) }
    })
    this.Field(id, 'px_https_port', {
      label: 'HTTPS port',
      initialValue: String(o.httpsPort || 443),
      onChange: (v) => { const oo = this._opts(id); oo.httpsPort = parseInt(v, 10) || 443; this._setOpts(id, oo) }
    })
    this.Text(id, ' ')
    this.Buttons(id, [
      { name: `🛡 Daemon ${o.daemon ? '✓' : '✗'}`,              props: { px_toggle_daemon: 1 } },
      { name: `🔄 Auto-restart ${o.autoRestart ? '✓' : '✗'}`,  props: { px_toggle_restart: 1 } },
      { name: '🔄 Refresh certs',                               props: { px_refresh_certs: 1 } }
    ])
    this.Text(id, ' ')
    this.Text(id, 'Daemon: installs a system service (auto-start on boot, needs sudo).')
    this.Text(id, 'Auto-restart: SyPM monitor respawns the process on crash.')
    this.Text(id, ' ')
    this.Buttons(id, [
      { name: '▶ Apply & Start', props: { px_start: 1 } },
      { name: '🛑 Stop',          props: { px_stop: 1 } }
    ])
    this.Text(id, ' ')
    this.Buttons(id, [
      { name: '💥 Hard Reset (kill everything)', props: { px_hard_reset: 1 } }
    ])
    this.Text(id, '💥 Hard reset stops the daemon unit, kills every stray node process, releases the HTTP/HTTPS ports and cleans temp files.')
  }
}

export default Proxy