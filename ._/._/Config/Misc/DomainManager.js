// GoDaddyManager.js
// ⚠️ ADJUST THE IMPORT PATH BELOW to match your SyAPP_Func location.
import SyAPP from '../../../SyAPP.js'
import https from 'node:https'
import { URL } from 'node:url'

const GODADDY_API  = 'https://api.godaddy.com/v3/domains'
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'SOA', 'CAA']

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

class GoDaddyManager extends SyAPP.Func() {
  constructor() {
    super(
      'GoDaddyManager',
      async (props) => { await this._render(props) },
      { refreshMode: false, log: false }
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
  // Render entry
  // ------------------------------------------------------------------
  async _render(props) {
    const id = props.session.UniqueID
    const curProps = this.Builds.get(id)?.Session?.ActualProps || {}
    if(!this.Storages.Has(id,'parentfunc')){this.Storages.Set(id,'parentfunc',props.session.PreviousPath)}

    await this._consumeEvents(id, curProps)

    // -- Pinned top toolbar --
    await this.PinnedTop(id, async () => {
      this.Text(id, `🌐 GoDaddy Manager`)
      const page     = this._page(id)
      const hasToken = !!this._token(id)
      this.Buttons(id, [
        { name: page === 'main'    ? '● Menu'    : 'Menu',    props: { gd_nav: 'main'    } },
        { name: page === 'domains' ? '● Domains' : 'Domains', props: { gd_nav: 'domains' } },
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
        this.Button(id, {
          name: `${status} ${d.domain}  (exp ${expires})`,
          props: { gd_open_domain: d.domain }
        })
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
