const baseUrl = new URL(window.location)
baseUrl.pathname = baseUrl.pathname.replace(/[^/]*$/, '')
baseUrl.search = ''
baseUrl.hash = ''
let snapshot = { devices: [], unassigned: [] }
const busy = new Set()

document.addEventListener('DOMContentLoaded', async () => {
    M.Modal.init(document.querySelectorAll('.modal'))
    get('refresh').onclick = refresh
    get('save_router').onclick = saveRouter
    get('test_router').onclick = testRouter
    get('toggle_router_password').onclick = toggleRouterPassword
    get('save_device').onclick = addDevice
    await loadConfig()
    await refresh()
})

function get(id) { return document.getElementById(id) }

function toggleRouterPassword() {
    const input = get('router_password')
    const button = get('toggle_router_password')
    const visible = input.type === 'text'
    input.type = visible ? 'password' : 'text'
    button.title = visible ? 'Show password' : 'Hide password'
    button.setAttribute('aria-label', button.title)
    button.setAttribute('aria-pressed', `${!visible}`)
    button.querySelector('i').textContent = visible ? 'visibility' : 'visibility_off'
    input.focus()
}

async function api(path, options = {}) {
    if (options.body && typeof options.body !== 'string') {
        options.headers = { ...(options.headers || {}), 'Content-Type': 'application/json' }
        options.body = JSON.stringify(options.body)
    }
    const response = await fetch(new URL(path, baseUrl), options)
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
    if (response.status === 204) return undefined
    return response.json()
}

async function loadConfig() {
    try {
        const config = await api('api/router/config')
        get('router_host').value = config.host || ''
        get('router_port').value = config.port || 22
        get('router_username').value = config.username || ''
        get('router_password').placeholder = config.passwordSaved ? 'Saved; leave blank to keep' : ''
        get('rethink_ip').value = config.rethinkIp || ''
        M.updateTextFields()
    } catch (err) { toast(err) }
}

async function saveRouter() {
    try {
        await api('api/router/config', {
            method: 'PUT',
            body: {
                host: get('router_host').value,
                port: Number(get('router_port').value),
                username: get('router_username').value,
                password: get('router_password').value,
                rethinkIp: get('rethink_ip').value,
            },
        })
        get('router_password').value = ''
        await loadConfig()
        await refresh()
        M.toast({ html: 'Router settings saved' })
    } catch (err) { toast(err) }
}

async function testRouter() {
    try {
        const result = await api('api/router/test', { method: 'POST' })
        M.toast({ html: `Connected: ${result.iptables}; ${result.conntrack}` })
    } catch (err) { toast(err) }
}

async function addDevice() {
    try {
        await api('api/router/devices', { method: 'POST', body: { ip: get('device_ip').value } })
        get('device_ip').value = ''
        M.Modal.getInstance(get('device_modal')).close()
        await refresh()
    } catch (err) { toast(err) }
}

async function refresh() {
    get('refresh').disabled = true
    try {
        snapshot = await api('api/router/status')
        get('router_status').textContent = snapshot.connected ? 'Connected' : snapshot.configured ? 'Connection failed' : 'Not configured'
        get('router_status').className = snapshot.connected ? 'green-text' : 'red-text'
        get('router_error').textContent = snapshot.error ? ` — ${snapshot.error}` : ''
        renderDevices()
    } catch (err) { toast(err) }
    finally { get('refresh').disabled = false }
}

function renderDevices() {
    const body = get('device_rows')
    body.replaceChildren()
    get('empty_devices').style.display = snapshot.devices.length ? 'none' : 'block'
    snapshot.devices.forEach((device) => body.appendChild(renderDevice(device)))
}

function renderDevice(device) {
    const row = document.createElement('tr')
    const name = cell(device.name || '-')
    const ip = cell(device.ip)
    const identity = document.createElement('td')
    if (device.deviceId) {
        identity.textContent = `${device.model || 'ThinQ'} (${device.deviceId.substring(0, 8)}…)`
        if (!device.connected) identity.innerHTML += '<br><span class="subtle">Offline</span>'
    } else if (snapshot.unassigned.length) {
        const select = document.createElement('select')
        select.innerHTML = '<option value="" disabled selected>Select detected device</option>' + snapshot.unassigned.map((d) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.name || d.model)}${d.sourceIp ? ` — ${escapeHtml(d.sourceIp)}` : ''}</option>`).join('')
        const link = button('Link', 'link')
        link.onclick = () => select.value && run(device.entryId, () => api(`api/router/devices/${device.entryId}/link`, { method: 'POST', body: { deviceId: select.value } }))
        identity.append(select, link)
        setTimeout(() => M.FormSelect.init(select), 0)
    } else identity.textContent = 'Waiting for connection'

    const dnat = document.createElement('td')
    if (device.dnat === 'partial') {
        dnat.innerHTML = '<span class="state-partial">PARTIAL</span><br>'
        const repair = button('Repair', 'build')
        repair.onclick = () => run(device.entryId, () => api(`api/router/devices/${device.entryId}/dnat/enable`, { method: 'POST' }))
        dnat.append(repair)
    } else if (device.dnat === 'unknown') {
        dnat.innerHTML = '<span class="state-unknown">UNKNOWN</span>'
    } else {
        dnat.appendChild(toggle(device.dnat === 'on', async (enabled) => {
            if (!enabled && device.bridgeActive) throw new Error('Suspend Bridge before turning DNAT off')
            if (!enabled && !confirm('Turn DNAT off? Permanent LG cloud return requires ThinQ Wi-Fi re-registration.')) throw new Cancelled()
            return api(`api/router/devices/${device.entryId}/dnat/${enabled ? 'enable' : 'disable'}`, { method: 'POST' })
        }, device.entryId))
    }

    const bridge = document.createElement('td')
    if (!device.deviceId) bridge.textContent = 'Disabled'
    else {
        bridge.appendChild(toggle(device.bridgeActive, async (enabled) => {
            if (enabled && device.dnat !== 'on') throw new Error('Turn DNAT on first')
            return api(`api/router/devices/${device.entryId}/bridge/${enabled ? 'resume' : 'suspend'}`, { method: 'POST' })
        }, device.entryId))
        if (device.bridgeSaved && !device.bridgeActive) {
            bridge.append(document.createElement('br'))
            const saved = document.createElement('span')
            saved.className = 'subtle'
            saved.textContent = 'Certificate saved'
            bridge.append(saved)
        }
    }

    const actions = document.createElement('td')
    actions.className = 'actions'
    const edit = button('Rename', 'edit')
    edit.title = 'Set a custom display name. Leave it blank to use the detected ThinQ name.'
    edit.onclick = async () => {
        const customName = prompt('Custom name (blank = detected name)', device.customName || '')
        if (customName === null) return
        await run(device.entryId, () => api(`api/router/devices/${device.entryId}`, { method: 'PUT', body: { customName } }))
    }
    const remove = button('Remove', 'delete')
    remove.title = 'Remove this IP from the DNAT management list. LG devices and Bridge credentials are not deleted.'
    remove.classList.add('red')
    remove.onclick = async () => {
        if (!confirm(`Remove ${device.ip} from the DNAT management list? The LG device and Bridge credentials will not be deleted.`)) return
        await run(device.entryId, () => api(`api/router/devices/${device.entryId}`, { method: 'DELETE' }))
    }
    actions.append(edit, document.createTextNode(' '), remove)
    row.append(name, ip, identity, dnat, bridge, actions)
    return row
}

function toggle(checked, action, entryId) {
    const div = document.createElement('div')
    div.className = 'switch'
    div.innerHTML = '<label>Off <input type="checkbox"><span class="lever"></span> On</label>'
    const input = div.querySelector('input')
    input.checked = checked
    input.disabled = busy.has(entryId)
    input.onchange = async () => {
        try { await run(entryId, () => action(input.checked)) }
        catch (err) { input.checked = checked; if (!(err instanceof Cancelled)) toast(err) }
    }
    return div
}

async function run(entryId, action) {
    busy.add(entryId)
    renderDevices()
    try { await action(); await refresh() }
    finally { busy.delete(entryId); renderDevices() }
}

function cell(text) { const td = document.createElement('td'); td.textContent = text; return td }
function button(label, icon) { const b = document.createElement('button'); b.className = 'btn-small waves-effect waves-light'; b.innerHTML = `${label} <i class="material-icons right">${icon}</i>`; return b }
function toast(err) { M.toast({ html: escapeHtml(err instanceof Error ? err.message : `${err}`) }) }
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value || ''; return div.innerHTML }
class Cancelled extends Error {}
