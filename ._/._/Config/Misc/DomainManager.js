// GoDaddyManager.js
// ⚠️ ADJUST THE IMPORT PATH BELOW to match your SyAPP_Func location.
import SyAPP from '../../../SyAPP.js'
import SyPM from '../../../SyPM.js'
import https from 'node:https'
import { URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

const GODADDY_API  = 'https://api.godaddy.com/v3/domains'
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'SOA', 'CAA']

// ------------------------------------------------------------------
// Let's Encrypt — shared constants
// ------------------------------------------------------------------
const LE_PROCESS_NAME = 'sypm_certbot_renew'
const LE_DIR          = path.join(os.homedir(), '.sypm', 'letsencrypt')
const LE_RENEWER      = path.join(LE_DIR, 'renewer.mjs')

// Snap restriction: certbot-snap CANNOT execute files inside $HOME.
// We must place the auth hooks in a system directory that snap can read.
const LE_HOOK_DIR     = '/etc/letsencrypt/sypm'
const LE_AUTH_HOOK    = path.join(LE_HOOK_DIR, 'auth-hook.cjs')
const LE_CLEANUP_HOOK = path.join(LE_HOOK_DIR, 'cleanup-hook.cjs')
const LE_LIVE         = '/etc/letsencrypt/live'
const LE_INTERVAL_MS  = 12 * 60 * 60 * 1000

/**
 * Small promise wrapper around node:https so we don't depend on global fetch.
 * Returns { ok, status, data }.
 */
function godaddyRequest(method, path, token, body) {
  return new Promise((resolve) => {
    const url = new URL(GODADDY_API + path)
    const payload = body ? JSON.stringify(body) : null
    const options = {
      method,
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    }
    if (payload) {
      options.headers['Content-Type']   = 'application/json'
      options.headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = https.request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        if (text) { try { parsed = JSON.parse(text) } catch { parsed = text } }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          data: parsed
        })
      })
    })
    req.on('error', (e) => resolve({ ok: false, status: 0, data: { error: e.message } }))
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * Small GET helper returning the response body as text (or null on failure).
 */
function httpGetText(urlStr) {
  return new Promise((resolve) => {
    try {
      const req = https.get(urlStr, { timeout: 8000 }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(Buffer.concat(chunks).toString('utf8').trim())
          } else {
            resolve(null)
          }
        })
      })
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.on('error', () => resolve(null))
    } catch (_) { resolve(null) }
  })
}

/**
 * Detects the public IPv4 address of this machine.
 */
async function detectPublicIPv4() {
  const sources = [
    'https://api.ipify.org',
    'https://ipv4.icanhazip.com',
    'https://ifconfig.me/ip'
  ]
  for (const s of sources) {
    const txt = await httpGetText(s)
    if (txt && /^(\d{1,3}\.){3}\d{1,3}$/.test(txt)) return txt
  }
  return null
}

class GoDaddyManager extends SyAPP.Func() {
  constructor() {
    super(
      'GoDaddyManager',
      async (props) => { await this._render(props) },
      { refreshMode: true, log: false }
    )
  }

  // ------------------------------------------------------------------
  // State helpers
  // ------------------------------------------------------------------
  _token(id)    { return this.Storages.Get(id, 'godaddy_token') || '' }
  _page(id)     { return this.Storages.Get(id, 'gd_page') || 'main' }
  _domain(id)   { return this.Storages.Get(id, 'gd_domain') || '' }
  _recordId(id) { return this.Storages.Get(id, 'gd_recordId') || '' }
  _form(id)     { return this.Storages.Get(id, 'gd_form') || { type: 'A' } }
  _go(id, p)    { this.Storages.Set(id, 'gd_page', p) }

  _err(id, prefix, res) {
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    this.Alert(id, `❌ ${prefix} (${res.status}): ${String(body).slice(0, 220)}`, { duration: 5000 })
  }

  _clearFormFields(id) {
    for (const f of ['name', 'data', 'ttl', 'priority', 'service',
                     'port', 'weight', 'protocol', 'flag', 'tag']) {
      this.Storages.Delete(id, 'field_gd_rec_' + f)
    }
  }

  // ------------------------------------------------------------------
  // Let's Encrypt — per-domain certificate generation + auto-renew
  // daemon. The auto-renew daemon is a SyPM-managed process that keeps
  // running 100% via autoRestart + daemon:true. Access is guarded by
  // the persistent acid lock `le_auto_renew` in the user's storage:
  // _leReconcile() runs on every render and enforces state consistency
  // between the lock and the actual daemon process.
  // ------------------------------------------------------------------

  _leCertPath(domain) { return path.join(LE_LIVE, domain, 'fullchain.pem') }
  _leKeyPath(domain)  { return path.join(LE_LIVE, domain, 'privkey.pem')  }

  _leHasCert(domain) {
    if (!domain) return false
    try { return fs.existsSync(this._leCertPath(domain)) } catch (_) { return false }
  }

  _leEmail(id)          { return this.Storages.Get(id, 'le_email') || '' }
  _setEmail(id, e)      { this.Storages.Set(id, 'le_email', String(e || '')) }
  _leAutoRenew(id)      { return this.Storages.Get(id, 'le_auto_renew') === true }
  _setAutoRenew(id, v)  { this.Storages.Set(id, 'le_auto_renew', !!v) }
  _leStatus(id, domain) { return this.Storages.Get(id, 'le_status_' + domain) || null }
  _setStatus(id, domain, s) { this.Storages.Set(id, 'le_status_' + domain, s) }

  _leCertbotPath() {
    for (const c of ['/usr/bin/certbot', '/usr/local/bin/certbot', '/snap/bin/certbot']) {
      try { if (fs.existsSync(c)) return c } catch (_) {}
    }
    try {
      const w = execSync('command -v certbot 2>/dev/null', { encoding: 'utf-8' }).trim()
      if (w) return w
    } catch (_) {}
    return null
  }

  _leProcs() {
    try { return SyPM.list().filter(x => x.name === LE_PROCESS_NAME) } catch (_) { return [] }
  }

  _leProc() {
    const all = this._leProcs()
    return all.find(p => p.status === 'Running' || p.status === 'Restarting') || all[0] || null
  }

  _leShellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'" }

  _leEnsureRenewerScript() {
    try {
      if (!fs.existsSync(LE_DIR)) fs.mkdirSync(LE_DIR, { recursive: true })
      const content =
        '// Auto-generated by SyAPP DomainManager — do not edit manually.\n' +
        "import { execSync } from 'node:child_process'\n" +
        'const INTERVAL_MS = ' + LE_INTERVAL_MS + '\n' +
        'function log(m) { console.log("[" + new Date().toISOString() + "] " + m) }\n' +
        'function runRenew() {\n' +
        '  log("Running certbot renew...")\n' +
        '  try {\n' +
        '    const out = execSync("sudo -n certbot renew --quiet", { encoding: "utf-8", timeout: 10 * 60 * 1000 })\n' +
        '    log("certbot renew OK" + (out.trim() ? ": " + out.trim() : ""))\n' +
        '  } catch (e) { log("certbot renew FAILED: " + (e.message || e)) }\n' +
        '}\n' +
        'log("certbot renewer started (interval " + INTERVAL_MS + "ms)")\n' +
        'runRenew()\n' +
        'setInterval(runRenew, INTERVAL_MS)\n'
      if (!fs.existsSync(LE_RENEWER) || fs.readFileSync(LE_RENEWER, 'utf-8') !== content) {
        fs.writeFileSync(LE_RENEWER, content, 'utf-8')
      }
      return true
    } catch (_) { return false }
  }

  _leWriteHookScripts() {
    try {
      // The temp files below live in LE_DIR, which may not exist yet
      // (it is otherwise only created when auto-renew is ON).
      if (!fs.existsSync(LE_DIR)) fs.mkdirSync(LE_DIR, { recursive: true })

      // Must use sudo to write into /etc/letsencrypt/sypm/ for snap compatibility
      execSync('sudo -n mkdir -p ' + this._leShellQuote(LE_HOOK_DIR))

      const common =
        "const https = require('node:https')\n" +
        "const fs = require('node:fs')\n" +
        "const TOKEN_FILE = '/etc/letsencrypt/sypm-godaddy-token'\n" +
        "function loadToken() { try { return fs.readFileSync(TOKEN_FILE, 'utf-8').trim() } catch { return '' } }\n" +
        "function request(method, p, body, token) {\n" +
        "  return new Promise(resolve => {\n" +
        "    const payload = body ? JSON.stringify(body) : null\n" +
        "    const opts = { method, hostname: 'api.godaddy.com', port: 443, path: p,\n" +
        "      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } }\n" +
        "    if (payload) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(payload) }\n" +
        "    const req = https.request(opts, res => {\n" +
        "      const chunks = []\n" +
        "      res.on('data', c => chunks.push(c))\n" +
        "      res.on('end', () => {\n" +
        "        const text = Buffer.concat(chunks).toString('utf8')\n" +
        "        let data = null\n" +
        "        if (text) { try { data = JSON.parse(text) } catch { data = text } }\n" +
        "        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data })\n" +
        "      })\n" +
        "    })\n" +
        "    req.on('error', e => resolve({ ok: false, status: 0, data: { error: e.message } }))\n" +
        "    if (payload) req.write(payload)\n" +
        "    req.end()\n" +
        "  })\n" +
        "}\n" +
        "async function findZone(token, domain) {\n" +
        "  const parts = domain.split('.')\n" +
        "  for (let i = 0; i < parts.length - 1; i++) {\n" +
        "    const cand = parts.slice(i).join('.')\n" +
        "    const r = await request('GET', '/v3/domains/zones/' + encodeURIComponent(cand) + '/dns-records?pageSize=1', null, token)\n" +
        "    if (r.ok) return cand\n" +
        "  }\n" +
        "  return null\n" +
        "}\n"

      const auth =
        '// Auto-generated — do not edit\n' +
        common +
        "async function main() {\n" +
        "  const token = loadToken()\n" +
        "  if (!token) { console.error('[auth] no token'); process.exit(1) }\n" +
        "  const domain = process.env.CERTBOT_DOMAIN || ''\n" +
        "  const val = process.env.CERTBOT_VALIDATION || ''\n" +
        "  if (!domain || !val) { console.error('[auth] missing env'); process.exit(1) }\n" +
        "  const zone = await findZone(token, domain)\n" +
        "  if (!zone) { console.error('[auth] no zone for ' + domain); process.exit(1) }\n" +
        "  const prefix = domain === zone ? '_acme-challenge' : '_acme-challenge.' + domain.slice(0, -(zone.length + 1))\n" +
        "  console.error('[auth] zone=' + zone + ' name=' + prefix)\n" +
        "  const res = await request('POST', '/v3/domains/zones/' + encodeURIComponent(zone) + '/dns-records', { name: prefix, type: 'TXT', data: '\"' + val + '\"', ttl: 600 }, token)\n" +
        "  if (!res.ok) { console.error('[auth] failed ' + res.status + ' ' + JSON.stringify(res.data)); process.exit(1) }\n" +
        "  console.error('[auth] record added, waiting 30s for propagation')\n" +
        "  await new Promise(r => setTimeout(r, 30000))\n" +
        "  process.exit(0)\n" +
        "}\n" +
        "main().catch(e => { console.error('[auth] err', e.message); process.exit(1) })\n"

      const cleanup =
        '// Auto-generated — do not edit\n' +
        common +
        "async function main() {\n" +
        "  const token = loadToken()\n" +
        "  if (!token) { process.exit(0) }\n" +
        "  const domain = process.env.CERTBOT_DOMAIN || ''\n" +
        "  const val = process.env.CERTBOT_VALIDATION || ''\n" +
        "  if (!domain || !val) { process.exit(0) }\n" +
        "  const zone = await findZone(token, domain)\n" +
        "  if (!zone) { process.exit(0) }\n" +
        "  const prefix = domain === zone ? '_acme-challenge' : '_acme-challenge.' + domain.slice(0, -(zone.length + 1))\n" +
        "  const list = await request('GET', '/v3/domains/zones/' + encodeURIComponent(zone) + '/dns-records?pageSize=100', null, token)\n" +
        "  if (!list.ok) { process.exit(0) }\n" +
        "  const items = Array.isArray(list.data && list.data.items) ? list.data.items : []\n" +
        "  const target = items.find(r => r.type === 'TXT' && (r.name === prefix || r.name === (prefix + '.' + zone)) && String(r.data || '').includes(val))\n" +
        "  if (target && target.recordId) {\n" +
        "    await request('DELETE', '/v3/domains/zones/' + encodeURIComponent(zone) + '/dns-records/' + encodeURIComponent(target.recordId), null, token)\n" +
        "    console.error('[cleanup] removed')\n" +
        "  }\n" +
        "  process.exit(0)\n" +
        "}\n" +
        "main().catch(e => { console.error('[cleanup] err', e.message); process.exit(0) })\n"

      // Write to temporary files first, then sudo-copy to system dir
      const tmpAuth = path.join(LE_DIR, 'auth-tmp.cjs')
      const tmpCleanup = path.join(LE_DIR, 'cleanup-tmp.cjs')
      fs.writeFileSync(tmpAuth, auth, 'utf-8')
      fs.writeFileSync(tmpCleanup, cleanup, 'utf-8')

      execSync('sudo -n cp ' + this._leShellQuote(tmpAuth) + ' ' + this._leShellQuote(LE_AUTH_HOOK))
      execSync('sudo -n cp ' + this._leShellQuote(tmpCleanup) + ' ' + this._leShellQuote(LE_CLEANUP_HOOK))
      execSync('sudo -n chmod 755 ' + this._leShellQuote(LE_AUTH_HOOK) + ' ' + this._leShellQuote(LE_CLEANUP_HOOK))
      
      // Clean up tmps
      try { fs.unlinkSync(tmpAuth); fs.unlinkSync(tmpCleanup) } catch (_) {}

      this._leHookErr = ''
      return true
    } catch (e) {
      const detail = (e && e.stderr) ? String(e.stderr).trim() : ''
      this._leHookErr = detail || (e && e.message) || ''
      return false
    }
  }

  async _leInstallCertbot(id) {
    const tries = [
      'sudo -n apt-get install -y certbot',
      'sudo -n apt-get update -qq && sudo -n apt-get install -y certbot',
      'sudo -n yum install -y certbot',
      'sudo -n dnf install -y certbot',
      'sudo -n apk add certbot',
      'sudo -n snap install --classic certbot',
      'sudo -n python3 -m pip install --upgrade certbot'
    ]
    for (const cmd of tries) {
      try {
        execSync(cmd, { stdio: 'pipe', timeout: 180000 })
        if (this._leCertbotPath()) {
          this.Alert(id, '✅ certbot installed', { duration: 3000 })
          return true
        }
      } catch (_) {}
    }
    this.Alert(id, '❌ Could not install certbot. Install manually: sudo apt install certbot (or yum/dnf/apk equivalent)', { duration: 8000 })
    return false
  }

  async _leGenerateCert(id, domain) {
    if (!domain) throw new Error('Domain required')

    if (!this._leCertbotPath()) {
      const ok = await this._leInstallCertbot(id)
      if (!ok) throw new Error('certbot unavailable')
    }
    const certbot = this._leCertbotPath()
    if (!certbot) throw new Error('certbot not found')

    const email = this._leEmail(id)
    if (!email) throw new Error('LE email not configured (set it on the Certs page)')

    const token = this._token(id)
    if (!token) throw new Error('GoDaddy token not configured')

    if (!this._leWriteHookScripts()) throw new Error('could not write hook scripts to /etc/letsencrypt/sypm (sudo required)' + (this._leHookErr ? ': ' + this._leHookErr : ''))

    // Persist the token so that certbot's renewal config — which stores
    // the hook command but no env vars — can invoke the hooks at renewal
    // time, long after this process has ended.
    try {
      execSync(
        'printf %s ' + this._leShellQuote(token) +
        ' | sudo -n tee /etc/letsencrypt/sypm-godaddy-token > /dev/null' +
        ' && sudo -n chmod 600 /etc/letsencrypt/sypm-godaddy-token',
        { stdio: 'pipe', timeout: 30000 }
      )
    } catch (e) {
      throw new Error('could not persist renewal token (sudo required): ' + e.message)
    }

    // Use the ABSOLUTE path of the Node.js running this SyAPP process.
    // System certbot often lacks /usr/bin/node in PATH (e.g. if node is
    // installed via nvm/volta). process.execPath is always the truth.
    const nodeBin = this._leShellQuote(process.execPath)
    
    const cmd =
      'sudo -n ' + this._leShellQuote(certbot) + ' certonly' +
      ' --manual --preferred-challenges dns' +
      ' --manual-auth-hook ' + this._leShellQuote(nodeBin + ' ' + LE_AUTH_HOOK) +
      ' --manual-cleanup-hook ' + this._leShellQuote(nodeBin + ' ' + LE_CLEANUP_HOOK) +
      ' --disable-hook-validation' +
      ' --non-interactive --agree-tos --force-renewal' +
      ' -m ' + this._leShellQuote(email) +
      ' -d ' + this._leShellQuote(domain)

    try {
      const out = execSync(cmd, { encoding: 'utf-8', timeout: 10 * 60 * 1000, stdio: 'pipe' })
      return { ok: true, output: out, certPath: this._leCertPath(domain), keyPath: this._leKeyPath(domain) }
    } catch (e) {
      const msg = ((e.stdout || '') + '\n' + (e.stderr || '') + '\n' + (e.message || '')).slice(0, 800)
      throw new Error('certbot failed: ' + msg)
    }
  }

  async _leDeleteCert(id, domain) {
    if (!domain) return
    try {
      execSync('sudo -n certbot delete --cert-name ' + this._leShellQuote(domain) + ' --non-interactive 2>/dev/null || true', { stdio: 'ignore', timeout: 30000 })
    } catch (_) {}
    this.Storages.Delete(id, 'le_status_' + domain)
  }

  // After a successful certificate generation: make sure the domain's
  // apex (@) and www point (A record, ttl 600) to this machine's public IP.
  //  - existing A record      → edited with the IP
  //  - existing CNAME record  → removed and replaced by the A record
  //  - nothing                → A record created
  async _leSetupARecords(id, domain) {
    const token = this._token(id)
    if (!token) throw new Error('GoDaddy token not configured')

    const ip = await detectPublicIPv4()
    if (!ip) throw new Error('could not detect the machine public IP')

    // Locate the zone (the domain itself, or a parent of it)
    const parts = String(domain).split('.')
    let zone = null
    for (let i = 0; i < parts.length - 1; i++) {
      const cand = parts.slice(i).join('.')
      const r = await godaddyRequest('GET', `/zones/${encodeURIComponent(cand)}/dns-records?pageSize=1`, token)
      if (r.ok) { zone = cand; break }
    }
    if (!zone) throw new Error('no GoDaddy zone found for ' + domain)

    const label = domain === zone ? '@' : domain.slice(0, -(zone.length + 1))
    const names = [label, label === '@' ? 'www' : 'www.' + label]

    const list = await godaddyRequest('GET', `/zones/${encodeURIComponent(zone)}/dns-records?pageSize=100&totalRequired=true`, token)
    if (!list.ok) throw new Error('could not list DNS records (' + list.status + ')')
    const items = Array.isArray(list.data && list.data.items) ? list.data.items
                : (Array.isArray(list.data) ? list.data : [])

    const recPath = (rid) => `/zones/${encodeURIComponent(zone)}/dns-records/${encodeURIComponent(rid)}`

    for (const n of names) {
      const same   = items.filter(r => r && r.name === n)
      const aRecs  = same.filter(r => r.type === 'A')
      const cnames = same.filter(r => r.type === 'CNAME')

      // A CNAME cannot coexist with an A record → remove it first
      for (const c of cnames) {
        if (!c.recordId) continue
        const d = await godaddyRequest('DELETE', recPath(c.recordId), token)
        if (!d.ok) throw new Error('could not remove CNAME for ' + n + ' (' + d.status + ')')
      }

      const body = { name: n, type: 'A', data: ip, ttl: 600 }

      if (aRecs.length > 0 && aRecs[0].recordId) {
        const u = await godaddyRequest('PUT', recPath(aRecs[0].recordId), token, body)
        if (!u.ok) throw new Error('could not update A record for ' + n + ' (' + u.status + ')')
        // Remove duplicate A records so the name points only to this machine
        for (let i = 1; i < aRecs.length; i++) {
          if (!aRecs[i].recordId) continue
          await godaddyRequest('DELETE', recPath(aRecs[i].recordId), token)
        }
      } else {
        const c = await godaddyRequest('POST', `/zones/${encodeURIComponent(zone)}/dns-records`, token, body)
        if (!c.ok) throw new Error('could not create A record for ' + n + ' (' + c.status + ')')
      }
    }

    return `A ${names.join(', ')} → ${ip}`
  }

  async _leReconcile(id) {
    const want  = this._leAutoRenew(id)
    const procs = this._leProcs()
    const alive = procs.filter(p => p.status === 'Running' || p.status === 'Restarting')

    if (want && alive.length === 0) {
      // Cooldown: at most one start attempt per minute, so a failing
      // start does not hammer the render loop.
      const last = this.Storages.Get(id, 'le_last_start_attempt') || 0
      if (Date.now() - last < 60000) return
      this.Storages.Set(id, 'le_last_start_attempt', Date.now())

      if (!this._leEnsureRenewerScript()) return
      try {
        const res = SyPM.run(LE_RENEWER, {
          name: LE_PROCESS_NAME,
          daemon: true,
          autoRestart: true,
          restartTries: 999,
          uniqueNameLock: true,
          workingDir: LE_DIR
        })
        // Best-effort duplicate cleanup
        const after = this._leProcs()
        if (after.length > 1) {
          for (const p of after) { if (p.id !== res.id) { try { SyPM.kill(p.id) } catch (_) {} } }
          try { SyPM.cleanup() } catch (_) {}
        }
      } catch (_) { /* surfaced on the Certs page */ }
      return
    }

    if (!want && procs.length > 0) {
      for (const p of procs) {
        try { execSync('sudo -n systemctl stop sypm-' + p.id + '.service 2>/dev/null || true', { stdio: 'ignore' }) } catch (_) {}
        try { execSync('sudo -n rc-service sypm-' + p.id + ' stop 2>/dev/null || true', { stdio: 'ignore' }) } catch (_) {}
        try { SyPM.kill(p.id) } catch (_) {}
      }
      try { SyPM.cleanup() } catch (_) {}
      return
    }

    if (want && alive.length > 1) {
      for (let i = 1; i < alive.length; i++) { try { SyPM.kill(alive[i].id) } catch (_) {} }
      try { SyPM.cleanup() } catch (_) {}
    }
  }

  // ------------------------------------------------------------------
  // Render entry
  // ------------------------------------------------------------------
  async _render(props) {
    const id = props.session.UniqueID
    const curProps = this.Builds.get(id)?.Session?.ActualProps || {}
    if(!this.Storages.Has(id,'parentfunc')){this.Storages.Set(id,'parentfunc',props.session.PreviousPath)}

    await this._consumeEvents(id, curProps)

    // Acid-lock reconciliation: on every render, force consistency between
    // the persistent `le_auto_renew` lock and the actual certbot-renew
    // daemon process (start when ON and missing, kill when OFF and running).
    await this._leReconcile(id)

    // -- Pinned top toolbar --
    await this.PinnedTop(id, async () => {
      this.Text(id, `🌐 GoDaddy Manager`)
      const page     = this._page(id)
      const hasToken = !!this._token(id)
      this.Buttons(id, [
        { name: page === 'main'    ? '● Menu'    : 'Menu',    props: { gd_nav: 'main'    } },
        { name: page === 'domains' ? '● Domains' : 'Domains', props: { gd_nav: 'domains' } },
        { name: page === 'certs'   ? '● Certs'   : 'Certs',   props: { gd_nav: 'certs'   } },
        { name: hasToken ? '🔑 Token ✓' : '🔑 Token',         props: { gd_nav: 'token'   } },
        ...(this.Storages.Get(id,'parentfunc') !== undefined ? [{ name: '<- Return', path: this.Storages.Get(id,'parentfunc') }] : [])
      ])
    })

    // -- Route --
    const page = this._page(id)
    if (page === 'token')       return this._renderToken(id)
    if (page === 'domains')     return this._renderDomains(id)
    if (page === 'records')     return this._renderRecords(id)
    if (page === 'record-form') return this._renderRecordForm(id)
    if (page === 'certs')       return this._renderCerts(id)
    return this._renderMain(id)
  }

  // ------------------------------------------------------------------
  // Event processing (all button clicks land here via ActualProps)
  // ------------------------------------------------------------------
  async _consumeEvents(id, p) {
    // -- Navigation --
    if (p.gd_nav !== undefined) {
      this._go(id, p.gd_nav)
      this.Storages.Set(id, 'gd_confirmDelete', false)
      delete p.gd_nav
    }

    // -- Open a domain's records --
    if (p.gd_open_domain !== undefined) {
      const dom = p.gd_open_domain
      delete p.gd_open_domain
      this.Storages.Set(id, 'gd_domain', dom)
      this.Storages.Delete(id, 'gd_records_cache_' + dom)
      this._go(id, 'records')
    }

    // -- New record --
    if (p.gd_new_record) {
      delete p.gd_new_record
      this.Storages.Delete(id, 'gd_recordId')
      this._clearFormFields(id)
      this.Storages.Set(id, 'gd_form', { type: 'A' })
      this.Storages.Set(id, 'gd_confirmDelete', false)
      this._go(id, 'record-form')
    }

    // -- Edit record --
    if (p.gd_edit_record !== undefined) {
      const recId = p.gd_edit_record
      delete p.gd_edit_record
      const c = this.Storages.Get(id, 'gd_record_cache_' + recId)
      if (c) {
        this.Storages.Set(id, 'gd_recordId', recId)
        this.Storages.Set(id, 'gd_form', { type: c.type || 'A' })
        this.Storages.Set(id, 'gd_confirmDelete', false)
        this._clearFormFields(id)
        this.Storages.Set(id, 'field_gd_rec_name',     c.name || '')
        this.Storages.Set(id, 'field_gd_rec_data',     c.data || '')
        this.Storages.Set(id, 'field_gd_rec_ttl',      String(c.ttl || 3600))
        this.Storages.Set(id, 'field_gd_rec_priority', c.priority != null ? String(c.priority) : '')
        this.Storages.Set(id, 'field_gd_rec_service',  c.service || '')
        this.Storages.Set(id, 'field_gd_rec_port',     c.port != null ? String(c.port) : '')
        this.Storages.Set(id, 'field_gd_rec_weight',   c.weight != null ? String(c.weight) : '')
        this.Storages.Set(id, 'field_gd_rec_protocol', c.protocol || '')
        this.Storages.Set(id, 'field_gd_rec_flag',     c.flag != null ? String(c.flag) : '')
        this.Storages.Set(id, 'field_gd_rec_tag',      c.tag || '')
        this._go(id, 'record-form')
      }
    }

    // -- Cycle the record type (form) --
    if (p.gd_cycle_type) {
      delete p.gd_cycle_type
      const form = this._form(id)
      const idx  = RECORD_TYPES.indexOf(form.type)
      form.type  = RECORD_TYPES[(idx + 1) % RECORD_TYPES.length]
      this.Storages.Set(id, 'gd_form', form)
    }

    // -- Save record --
    if (p.gd_save_record) {
      delete p.gd_save_record
      await this._saveRecord(id)
    }

    // -- Delete record (two-step confirmation) --
    if (p.gd_delete_record) {
      delete p.gd_delete_record
      if (this.Storages.Get(id, 'gd_confirmDelete')) {
        await this._deleteRecord(id)
        this.Storages.Set(id, 'gd_confirmDelete', false)
      } else {
        this.Storages.Set(id, 'gd_confirmDelete', true)
      }
    }

    if (p.gd_cancel_delete) {
      delete p.gd_cancel_delete
      this.Storages.Set(id, 'gd_confirmDelete', false)
    }

    // -- Refresh caches --
    if (p.gd_refresh) {
      delete p.gd_refresh
      const dom = this._domain(id)
      this.Storages.Delete(id, 'gd_domains_cache')
      if (dom) this.Storages.Delete(id, 'gd_records_cache_' + dom)
    }

    // -- Test token --
    if (p.gd_test_token) {
      delete p.gd_test_token
      const res = await godaddyRequest('GET', '/domain-names?pageSize=1', this._token(id))
      if (res.ok) this.Alert(id, '✅ Token works', { duration: 2500 })
      else        this._err(id, 'Token test failed', res)
    }

    // -- Let's Encrypt: install certbot --
    if (p.gd_le_install) {
      delete p.gd_le_install
      const self = this
      setImmediate(async () => {
        await self._leInstallCertbot(id)
        setTimeout(() => {
          try { self._syappInstance.LoadScreen(self.Name, {}).catch(() => {}) } catch (_) {}
        }, 300)
      })
      this.Alert(id, '📦 Installing certbot...', { duration: 3000 })
    }

    // -- Let's Encrypt: toggle auto-renew acid lock --
    if (p.gd_le_auto_toggle) {
      delete p.gd_le_auto_toggle
      this._setAutoRenew(id, !this._leAutoRenew(id))
      // Clear cooldown so a manual toggle always attempts reconciliation now
      this.Storages.Delete(id, 'le_last_start_attempt')
      await this._leReconcile(id)
    }

    // -- Let's Encrypt: force reconcile now --
    if (p.gd_le_reconcile) {
      delete p.gd_le_reconcile
      this.Storages.Delete(id, 'le_last_start_attempt')
      await this._leReconcile(id)
    }

    // -- Let's Encrypt: generate certificate for a domain --
    if (p.gd_le_gen) {
      const domain = p.gd_le_gen
      delete p.gd_le_gen
      this._setStatus(id, domain, { status: 'generating', startedAt: Date.now() })
      this._go(id, 'certs')
      const self = this
      setImmediate(async () => {
        try {
          await self._leGenerateCert(id, domain)
          let dnsMsg = null
          try {
            dnsMsg = await self._leSetupARecords(id, domain)
          } catch (dnsErr) {
            dnsMsg = 'DNS A records failed: ' + dnsErr.message
          }
          self.Storages.Delete(id, 'gd_records_cache_' + domain)
          self._setStatus(id, domain, { status: 'ok', finishedAt: Date.now(), dns: dnsMsg })
        } catch (e) {
          self._setStatus(id, domain, { status: 'error', finishedAt: Date.now(), error: e.message })
        }
        setTimeout(() => {
          try { self._syappInstance.LoadScreen(self.Name, {}).catch(() => {}) } catch (_) {}
        }, 300)
      })
      this.Alert(id, `⏳ Generating certificate for ${domain}...`, { duration: 3000 })
    }

    // -- Let's Encrypt: delete a domain's certificate --
    if (p.gd_le_delete) {
      const domain = p.gd_le_delete
      delete p.gd_le_delete
      await this._leDeleteCert(id, domain)
      this.Alert(id, `🗑 Certificate removed for ${domain}`, { duration: 3000 })
    }
  }

  // ------------------------------------------------------------------
  // Pages
  // ------------------------------------------------------------------
  _renderMain(id) {
    const hasToken = !!this._token(id)
    this.Text(id, ' ')
    this.Text(id, hasToken ? '✅ API token configured.' : '⚠️ No API token configured yet.')
    this.Text(id, ' ')
    this.Buttons(id, [
      { name: '🔑 Configure Token', props: { gd_nav: 'token'   } },
      { name: '🌐 List Domains',    props: { gd_nav: 'domains' } }
    ])
  }

  _renderToken(id) {
    const existing = this._token(id)
    this.Text(id, ' ')
    this.Text(id, 'Paste your GoDaddy Personal Access Token below:')
    this.Text(id, '(stored locally per user session, never sent anywhere else)')
    this.Text(id, ' ')
    this.Field(id, 'godaddy_token', {
      label: 'Token',
      initialValue: existing,
      onChange: (v) => this.Storages.Set(id, 'godaddy_token', v)
    })
    this.Text(id, ' ')
    this.Buttons(id, [
      { name: '🧪 Test Token', props: { gd_test_token: 1 } },
      { name: '← Back',        props: { gd_nav: 'main'   } }
    ])
  }

  _renderCerts(id) {
    const email    = this._leEmail(id)
    const token    = this._token(id)
    const certbot  = this._leCertbotPath()
    const proc     = this._leProc()
    const autoOn   = this._leAutoRenew(id)
    const running  = !!(proc && (proc.status === 'Running' || proc.status === 'Restarting'))
    const isDaemon = !!(proc && proc.daemon === 'Yes')

    // ── Unified Status Panel (Only one this.Text used) ───────────
    let autoStatus = autoOn ? '🟢 ON' : '🔴 OFF'
    if (autoOn && running) {
      autoStatus += ` (${proc.status} PID ${proc.pid} ${isDaemon ? '✅ SysDaemon' : '⚠ Managed'})`
    } else if (autoOn && !running) {
      autoStatus += ' (⚠ Daemon not running!)'
    }

    let topText = `🛡 Let's Encrypt Manager\n`
    topText += `───────────────���────────────\n`
    topText += `Certbot:   ${certbot ? '✅ Installed' : '❌ Missing'}\n`
    topText += `API Token: ${token ? '✅ Configured' : '❌ Missing'}\n`
    topText += `Auto-Renew: ${autoStatus}\n`
    
    this.Text(id, topText)

    // ── Configuration Actions ────────────────────────────────────
    if (!certbot) {
      this.Button(id, { name: '📦 Install Certbot Now', props: { gd_le_install: 1 } })
    }

    this.Buttons(id, [
      { name: autoOn ? '🛑 Turn OFF Auto-Renew' : '▶ Turn ON Auto-Renew', props: { gd_le_auto_toggle: 1 } },
      { name: '↻ Reconcile Daemon Now', props: { gd_le_reconcile: 1 } }
    ])

    this.Field(id, 'le_email_field', {
      label: 'LE Email (for expiry notices)',
      initialValue: email,
      onChange: (v) => this._setEmail(id, v)
    })

    this.Button(id, { name: ' ' })

    // ── Domain List with Full Buttons ────────────────────────────
    const domains = this.Storages.Get(id, 'gd_domains_cache') || []
    
    if (domains.length === 0) {
      this.Buttons(id, [
        { name: '📋 No domains loaded yet', props: {} },
        { name: '🌐 Go to Domains List', props: { gd_nav: 'domains' } }
      ])
      return
    }

    this.Button(id, { name: `📋 Managed Domains (${domains.length})`, props: {} })

    for (const d of domains) {
      const hasCert = this._leHasCert(d.domain)
      const st      = this._leStatus(id, d.domain)
      
      // Determine domain status string
      let statusStr = '○ No Certificate'
      if (hasCert) statusStr = '🔒 Certified'
      
      if (st) {
        if (st.status === 'generating') statusStr = '⏳ Generating...'
        else if (st.status === 'error')  statusStr = `❌ Error: ${String(st.error).slice(0, 40)}...`
        else if (st.status === 'ok')     statusStr = '✅ Generated OK'
      }

      // Full-width domain status button (acts as a section header)
      this.Button(id, { name: `🌐 ${d.domain}  —  ${statusStr}`, props: {} })
      
      // Action buttons for this domain
      this.Buttons(id, [
        { name: hasCert ? '🔄 Regenerate Cert' : '🔒 Generate Cert', props: { gd_le_gen: d.domain } },
        ...(hasCert ? [{ name: '🗑 Delete Cert', props: { gd_le_delete: d.domain } }] : [])
      ])
      
      this.Button(id, { name: ' ' })
    }
  }

  async _renderDomains(id) {
    const token = this._token(id)
    if (!token) {
      this.Text(id, '⚠️ Configure the API token first.')
      this.Buttons(id, [{ name: '🔑 Token', props: { gd_nav: 'token' } }])
      return
    }

    let domains = this.Storages.Get(id, 'gd_domains_cache')
    if (!domains) {
      this.Text(id, '⏳ Loading domains...')
      const res = await godaddyRequest(
        'GET',
        '/domain-names?statuses=ACTIVE,EXPIRED&pageSize=100',
        token
      )
      if (!res.ok) {
        this._err(id, 'Failed to load domains', res)
        this.Buttons(id, [
          { name: '↻ Retry', props: { gd_refresh: 1 } },
          { name: '← Back',  props: { gd_nav: 'main'  } }
        ])
        return
      }
      domains = Array.isArray(res.data && res.data.items) ? res.data.items : []
      this.Storages.Set(id, 'gd_domains_cache', domains)
    }

    this.Text(id, `🌐 ${domains.length} domain(s)`)
    this.Buttons(id, [
      { name: '↻ Refresh', props: { gd_refresh: 1 } },
      { name: '← Back',    props: { gd_nav: 'main'  } }
    ])

    if (domains.length === 0) {
      this.Text(id, 'No domains found.')
      return
    }

    await this.Pagination.Button(id, 'gd_domains_pg', domains, {
      items_per_page: 10,
      custom: { showNavigation: true, showPageInfo: true, showSeparators: false },
      renderItem: (itemData) => {
        const d       = itemData.item
        const status  = d.status === 'ACTIVE' ? '🟢'
                      : d.status === 'EXPIRED' ? '🔴' : '🟡'
        const expires = d.expiresAt ? new Date(d.expiresAt).toISOString().slice(0, 10) : '?'
        const hasCert = this._leHasCert(d.domain)
        this.Buttons(id, [
          {
            name: `${status} ${d.domain}  (exp ${expires})`,
            props: { gd_open_domain: d.domain }
          },
          {
            name: hasCert ? '🔒 Cert ✓' : '🔒 Cert',
            props: { gd_le_gen: d.domain }
          }
        ])
      }
    })
  }

  async _renderRecords(id) {
    const token  = this._token(id)
    const domain = this._domain(id)
    if (!token || !domain) {
      this.Text(id, '⚠️ Missing token or domain.')
      this.Buttons(id, [{ name: '← Back', props: { gd_nav: 'domains' } }])
      return
    }

    this.Text(id, `📡 Zone: ${domain}`)

    let records = this.Storages.Get(id, 'gd_records_cache_' + domain)
    if (!records) {
      this.Text(id, '⏳ Loading records...')
      const res = await godaddyRequest(
        'GET',
        `/zones/${encodeURIComponent(domain)}/dns-records?pageSize=100&totalRequired=true`,
        token
      )
      if (!res.ok) {
        this._err(id, 'Failed to load records', res)
        this.Buttons(id, [
          { name: '↻ Retry',   props: { gd_refresh: 1 } },
          { name: '← Domains', props: { gd_nav: 'domains' } }
        ])
        return
      }
      records = Array.isArray(res.data && res.data.items) ? res.data.items : []
      this.Storages.Set(id, 'gd_records_cache_' + domain, records)
      for (const r of records) {
        if (r && r.recordId) this.Storages.Set(id, 'gd_record_cache_' + r.recordId, r)
      }
    }

    this.Buttons(id, [
      { name: '＋ New Record', props: { gd_new_record: 1 } },
      { name: this._leHasCert(domain) ? '🔒 Cert ✓' : '🔒 Cert', props: { gd_le_gen: domain } },
      { name: '↻ Refresh',    props: { gd_refresh: 1 } },
      { name: '← Domains',    props: { gd_nav: 'domains' } }
    ])

    this.Text(id, `${records.length} record(s)`)

    if (records.length === 0) {
      this.Text(id, 'No records in this zone.')
      return
    }

    await this.Pagination.Button(id, 'gd_records_pg_' + domain, records, {
      items_per_page: 10,
      custom: { showNavigation: true, showPageInfo: true, showSeparators: false },
      renderItem: (itemData) => {
        const r     = itemData.item
        const name  = r.name || '@'
        const data  = String(r.data || '')
        const short = data.length > 60 ? data.slice(0, 57) + '...' : data
        this.Button(id, {
          name: `[${r.type}] ${name} → ${short}  (ttl ${r.ttl})`,
          props: { gd_edit_record: r.recordId }
        })
      }
    })
  }

  _renderRecordForm(id) {
    const form    = this._form(id)
    const isEdit  = !!this._recordId(id)
    const domain  = this._domain(id)
    const type    = form.type || 'A'
    const confirm = this.Storages.Get(id, 'gd_confirmDelete')

    this.Text(id, `${isEdit ? '✎ Edit record' : '＋ New record'}  →  ${domain}`)
    this.Text(id, ' ')

    this.Button(id, {
      name: `🏷 Type: ${type}  (click to cycle)`,
      props: { gd_cycle_type: 1 }
    })

    this.Field(id, 'gd_rec_name', {
      label: 'Name (@ for apex)',
      initialValue: ''
    })
    this.Field(id, 'gd_rec_data', {
      label: 'Data',
      initialValue: ''
    })
    this.Field(id, 'gd_rec_ttl', {
      label: 'TTL (600-86400)',
      initialValue: '3600'
    })

    if (type === 'MX' || type === 'SRV') {
      this.Field(id, 'gd_rec_priority', { label: 'Priority (0-65535)', initialValue: '' })
    }
    if (type === 'SRV') {
      this.Field(id, 'gd_rec_service',  { label: 'Service (_http, _sip)', initialValue: '' })
      this.Field(id, 'gd_rec_port',     { label: 'Port (0-65535)',       initialValue: '' })
      this.Field(id, 'gd_rec_weight',   { label: 'Weight (0-65535)',     initialValue: '' })
      this.Field(id, 'gd_rec_protocol', { label: 'Protocol (_tcp, _udp)', initialValue: '' })
    }
    if (type === 'CAA') {
      this.Field(id, 'gd_rec_flag', { label: 'Flag (0 or 128)',        initialValue: '' })
      this.Field(id, 'gd_rec_tag',  { label: 'Tag (issue, issuewild, iodef)', initialValue: '' })
    }

    this.Text(id, ' ')

    const actions = [
      { name: '✅ Save',   props: { gd_save_record: 1 } },
      { name: '← Cancel',  props: { gd_nav: 'records' } }
    ]
    if (isEdit) {
      if (confirm) {
        actions.push({ name: '⚠ Confirm DELETE', props: { gd_delete_record: 1 } })
        actions.push({ name: '✕ Cancel delete',   props: { gd_cancel_delete: 1 } })
      } else {
        actions.push({ name: '🗑 Delete',        props: { gd_delete_record: 1 } })
      }
    }
    this.Buttons(id, actions)
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------
  async _saveRecord(id) {
    const token    = this._token(id)
    const domain   = this._domain(id)
    const recordId = this._recordId(id)
    const type     = (this._form(id).type) || 'A'

    const name   = (this.Storages.Get(id, 'field_gd_rec_name') || '').trim()
    const data   = (this.Storages.Get(id, 'field_gd_rec_data') || '').trim()
    const ttlRaw = (this.Storages.Get(id, 'field_gd_rec_ttl')  || '').trim()

    if (!name) { this.Alert(id, '❌ Name is required', { duration: 3000 }); return }
    if (!data) { this.Alert(id, '❌ Data is required', { duration: 3000 }); return }
    const ttl = parseInt(ttlRaw, 10)
    if (isNaN(ttl) || ttl < 600 || ttl > 86400) {
      this.Alert(id, '❌ TTL must be between 600 and 86400', { duration: 3500 })
      return
    }

    const body = { name, type, data, ttl }

    if (type === 'MX' || type === 'SRV') {
      const pr = parseInt(this.Storages.Get(id, 'field_gd_rec_priority') || '', 10)
      if (!isNaN(pr)) body.priority = pr
    }
    if (type === 'SRV') {
      const svc   = (this.Storages.Get(id, 'field_gd_rec_service')  || '').trim()
      const port  = parseInt(this.Storages.Get(id, 'field_gd_rec_port')   || '', 10)
      const wght  = parseInt(this.Storages.Get(id, 'field_gd_rec_weight') || '', 10)
      const proto = (this.Storages.Get(id, 'field_gd_rec_protocol') || '').trim()
      if (svc)          body.service  = svc
      if (!isNaN(port)) body.port     = port
      if (!isNaN(wght)) body.weight   = wght
      if (proto)        body.protocol = proto
    }
    if (type === 'CAA') {
      const flg = parseInt(this.Storages.Get(id, 'field_gd_rec_flag') || '', 10)
      const tag = (this.Storages.Get(id, 'field_gd_rec_tag') || '').trim()
      if (!isNaN(flg)) body.flag = flg
      if (tag)         body.tag  = tag
    }

    const path = recordId
      ? `/zones/${encodeURIComponent(domain)}/dns-records/${encodeURIComponent(recordId)}`
      : `/zones/${encodeURIComponent(domain)}/dns-records`

    const res = await godaddyRequest(recordId ? 'PUT' : 'POST', path, token, body)

    if (res.ok) {
      this.Alert(id, recordId ? '✅ Record updated' : '✅ Record created', { duration: 2500 })
      this.Storages.Delete(id, 'gd_records_cache_' + domain)
      this.Storages.Delete(id, 'gd_recordId')
      this._clearFormFields(id)
      this._go(id, 'records')
    } else {
      this._err(id, recordId ? 'Update failed' : 'Create failed', res)
    }
  }

  async _deleteRecord(id) {
    const token    = this._token(id)
    const domain   = this._domain(id)
    const recordId = this._recordId(id)
    if (!recordId) return

    const path = `/zones/${encodeURIComponent(domain)}/dns-records/${encodeURIComponent(recordId)}`
    const res  = await godaddyRequest('DELETE', path, token)

    if (res.ok) {
      this.Alert(id, '✅ Record deleted', { duration: 2500 })
      this.Storages.Delete(id, 'gd_records_cache_' + domain)
      this.Storages.Delete(id, 'gd_recordId')
      this._clearFormFields(id)
      this._go(id, 'records')
    } else {
      this._err(id, 'Delete failed', res)
    }
  }
}

export default GoDaddyManager
