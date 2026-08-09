import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'

export type RouterSSHConfig = {
    host: string
    port: number
    username: string
    password: string
    rethinkIp: string
}

export type RouterDeviceEntry = {
    entryId: string
    ip: string
    deviceId?: string
    detectedName?: string
    customName?: string
}

export type RouterConfig = {
    router: RouterSSHConfig
    devices: RouterDeviceEntry[]
}

const emptyConfig = (): RouterConfig => ({
    router: { host: '', port: 22, username: '', password: '', rethinkIp: '' },
    devices: [],
})

function validIPv4(value: string) {
    return isIP(value) === 4
}

export class RouterConfigStore {
    private config: RouterConfig

    constructor(readonly filename: string) {
        this.config = this.load()
    }

    private load() {
        try {
            const parsed = JSON.parse(readFileSync(this.filename, 'utf-8')) as Partial<RouterConfig>
            return {
                router: { ...emptyConfig().router, ...parsed.router },
                devices: Array.isArray(parsed.devices) ? parsed.devices : [],
            }
        } catch {
            return emptyConfig()
        }
    }

    private save() {
        mkdirSync(path.dirname(this.filename), { recursive: true })
        const temporary = `${this.filename}.tmp`
        writeFileSync(temporary, JSON.stringify(this.config, null, 2), { mode: 0o600 })
        renameSync(temporary, this.filename)
    }

    configured() {
        const r = this.config.router
        return validIPv4(r.host) && validIPv4(r.rethinkIp) && !!r.username && !!r.password && r.port > 0
    }

    router() {
        return { ...this.config.router }
    }

    publicRouter() {
        const { password, ...router } = this.config.router
        return { ...router, passwordSaved: !!password }
    }

    updateRouter(input: Partial<RouterSSHConfig>) {
        const current = this.config.router
        const next = {
            host: `${input.host ?? current.host}`.trim(),
            port: Number(input.port ?? current.port),
            username: `${input.username ?? current.username}`.trim(),
            password: input.password ? `${input.password}` : current.password,
            rethinkIp: `${input.rethinkIp ?? current.rethinkIp}`.trim(),
        }
        if (!validIPv4(next.host)) throw new Error('Invalid router IPv4 address')
        if (!validIPv4(next.rethinkIp)) throw new Error('Invalid rethink IPv4 address')
        if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) throw new Error('Invalid SSH port')
        if (!next.username) throw new Error('SSH username is required')
        if (!next.password) throw new Error('SSH password is required')
        if (this.config.devices.some((entry) => entry.ip === next.host || entry.ip === next.rethinkIp))
            throw new Error('Router or rethink server IP is already registered as a device')
        this.config.router = next
        this.save()
        return this.publicRouter()
    }

    devices() {
        return this.config.devices.map((entry) => ({ ...entry }))
    }

    addDevice(ip: string) {
        ip = `${ip}`.trim()
        if (!validIPv4(ip)) throw new Error('Invalid device IPv4 address')
        if (ip === this.config.router.host || ip === this.config.router.rethinkIp)
            throw new Error('Router or rethink server IP cannot be registered as a device')
        if (this.config.devices.some((entry) => entry.ip === ip)) throw new Error('Device IP is already registered')
        const entry: RouterDeviceEntry = { entryId: randomUUID(), ip }
        this.config.devices.push(entry)
        this.save()
        return { ...entry }
    }

    updateDevice(entryId: string, input: { ip?: string; customName?: string }) {
        const entry = this.requireDevice(entryId)
        if (input.ip !== undefined) {
            const ip = `${input.ip}`.trim()
            if (!validIPv4(ip)) throw new Error('Invalid device IPv4 address')
            if (ip === this.config.router.host || ip === this.config.router.rethinkIp)
                throw new Error('Router or rethink server IP cannot be registered as a device')
            if (this.config.devices.some((other) => other !== entry && other.ip === ip))
                throw new Error('Device IP is already registered')
            entry.ip = ip
            entry.deviceId = undefined
            entry.detectedName = undefined
        }
        if (input.customName !== undefined) entry.customName = `${input.customName}`.trim() || undefined
        this.save()
        return { ...entry }
    }

    deleteDevice(entryId: string) {
        const index = this.config.devices.findIndex((entry) => entry.entryId === entryId)
        if (index < 0) throw new Error('Unknown router device')
        this.config.devices.splice(index, 1)
        this.save()
    }

    linkDevice(entryId: string, deviceId: string, detectedName?: string) {
        const entry = this.requireDevice(entryId)
        const duplicate = this.config.devices.find((item) => item !== entry && item.deviceId === deviceId)
        if (duplicate) throw new Error('Rethink device is already linked to another IP')
        entry.deviceId = `${deviceId}`
        if (detectedName) entry.detectedName = detectedName
        this.save()
        return { ...entry }
    }

    unlinkDevice(entryId: string) {
        const entry = this.requireDevice(entryId)
        entry.deviceId = undefined
        entry.detectedName = undefined
        this.save()
        return { ...entry }
    }

    requireDevice(entryId: string) {
        const entry = this.config.devices.find((item) => item.entryId === entryId)
        if (!entry) throw new Error('Unknown router device')
        return entry
    }

    linkByIp(ip: string | undefined, deviceId: string, detectedName: string | undefined) {
        if (!ip) return false
        const entry = this.config.devices.find((item) => item.ip === ip)
        if (!entry) return false
        const changed = entry.deviceId !== deviceId || (!!detectedName && entry.detectedName !== detectedName)
        entry.deviceId = deviceId
        if (detectedName) entry.detectedName = detectedName
        if (changed) this.save()
        return changed
    }

    refreshDetectedName(deviceId: string, detectedName: string | undefined) {
        if (!detectedName) return false
        const entry = this.config.devices.find((item) => item.deviceId === deviceId)
        if (!entry || entry.detectedName === detectedName) return false
        entry.detectedName = detectedName
        this.save()
        return true
    }
}
