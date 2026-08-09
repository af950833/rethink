import type { Request, Response } from 'express'
import type { WebSocketExpress } from 'websocket-express'
import type HA_bridge from '@/cloud/ha_bridge'
import type { AnyDevice, DeviceManager } from '@/cloud/devmgr'
import type { Bridge } from '@/bridge'
import { RouterConfigStore } from '@/router/config-store'
import { DNATManager, type DNATState } from '@/router/dnat-manager'

type Handler = (req: Request, res: Response) => Promise<any>

export class RouterAPI {
    readonly store: RouterConfigStore

    constructor(
        filename: string,
        readonly ha: HA_bridge,
        readonly manager: DeviceManager,
        readonly bridge: Bridge | undefined,
    ) {
        this.store = new RouterConfigStore(filename)
        manager.on('newDevice', (device) => this.syncDevice(device))
        bridge?.on('deviceNamesChanged', () => this.syncAllDevices())
        Object.values(manager.allDevices).forEach((device) => this.syncDevice(device))
    }

    register(app: WebSocketExpress) {
        app.get('/api/router/config', this.wrap(async (_req, res) => res.json(this.store.publicRouter())))

        app.put(
            '/api/router/config',
            this.wrap(async (req, res) => res.json(this.store.updateRouter(req.body || {}))),
        )

        app.post(
            '/api/router/test',
            this.wrap(async (_req, res) => {
                this.requireConfigured()
                res.json(await new DNATManager(this.store.router()).test())
            }),
        )

        app.get(
            '/api/router/status',
            this.wrap(async (_req, res) => res.json(await this.snapshot())),
        )

        app.post(
            '/api/router/devices',
            this.wrap(async (req, res) => {
                const entry = this.store.addDevice(req.body?.ip)
                res.status(201).json(entry)
            }),
        )

        app.put(
            '/api/router/devices/:entryId',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (req.body?.ip !== undefined && `${req.body.ip}`.trim() !== entry.ip) {
                    const state = await this.stateFor(entry.entryId)
                    if (state !== 'off') throw new ConflictError('Turn DNAT off before changing the IP')
                }
                res.json(this.store.updateDevice(entry.entryId, req.body || {}))
            }),
        )

        app.delete(
            '/api/router/devices/:entryId',
            this.wrap(async (req, res) => {
                const entryId = this.param(req, 'entryId')
                const state = await this.stateFor(entryId)
                if (state !== 'off') throw new ConflictError('Turn DNAT off before deleting the device')
                this.store.deleteDevice(entryId)
                res.status(204).end()
            }),
        )

        app.post(
            '/api/router/devices/:entryId/link',
            this.wrap(async (req, res) => {
                const deviceId = `${req.body?.deviceId || ''}`
                const device = this.manager.allDevices[deviceId]
                if (!device) throw new Error('Rethink device is not connected')
                res.json(this.store.linkDevice(this.param(req, 'entryId'), deviceId, this.deviceName(device)))
            }),
        )

        app.delete(
            '/api/router/devices/:entryId/link',
            this.wrap(async (req, res) => res.json(this.store.unlinkDevice(this.param(req, 'entryId')))),
        )

        app.post(
            '/api/router/devices/:entryId/dnat/enable',
            this.wrap(async (req, res) => {
                this.requireConfigured()
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                await new DNATManager(this.store.router()).enable(entry)
                res.json(await this.snapshot())
            }),
        )

        app.post(
            '/api/router/devices/:entryId/dnat/disable',
            this.wrap(async (req, res) => {
                this.requireConfigured()
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (entry.deviceId && this.bridge?.status(entry.deviceId))
                    throw new ConflictError('Suspend Bridge before turning DNAT off')
                await new DNATManager(this.store.router()).disable(entry)
                res.json(await this.snapshot())
            }),
        )

        app.post(
            '/api/router/devices/:entryId/bridge/resume',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId) throw new Error('No Rethink device is linked to this IP')
                if ((await this.stateFor(entry.entryId)) !== 'on')
                    throw new ConflictError('Turn DNAT on before starting Bridge')
                if (!this.bridge) throw new Error('Bridge is not configured')
                const started = await this.bridge.enable(entry.deviceId)
                if (!started) throw new Error('Unable to start Bridge')
                res.json(await this.snapshot())
            }),
        )

        app.post(
            '/api/router/devices/:entryId/bridge/suspend',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId || !this.bridge) throw new Error('Bridge is not configured for this device')
                this.bridge.disable(entry.deviceId)
                res.json(await this.snapshot())
            }),
        )

        app.delete(
            '/api/router/devices/:entryId/bridge/credentials',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId || !this.bridge) throw new Error('Bridge is not configured for this device')
                this.bridge.disable(entry.deviceId)
                res.json(await this.snapshot())
            }),
        )
    }

    private wrap(handler: Handler) {
        return (req: Request, res: Response, next: (err: any) => void) => {
            handler(req, res).catch((err) => {
                if (err instanceof ConflictError) res.status(409).end(err.message)
                else next(err)
            })
        }
    }

    private param(req: Request, name: string) {
        const value = req.params[name]
        if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
        return value
    }

    private requireConfigured() {
        if (!this.store.configured()) throw new Error('Router SSH settings are not configured')
    }

    private async stateFor(entryId: string) {
        this.requireConfigured()
        const states = await new DNATManager(this.store.router()).status([this.store.requireDevice(entryId)])
        return states[entryId]
    }

    private async snapshot() {
        this.syncAllDevices()
        const entries = this.store.devices()
        let connected = false
        let error: string | undefined
        let states: Record<string, DNATState> = Object.fromEntries(entries.map((entry) => [entry.entryId, 'unknown']))
        if (this.store.configured()) {
            try {
                states = await new DNATManager(this.store.router()).status(entries)
                connected = true
            } catch (err) {
                error = `${err}`
            }
        }

        const linkedIds = new Set(entries.map((entry) => entry.deviceId).filter(Boolean))
        return {
            configured: this.store.configured(),
            connected,
            error,
            router: this.store.publicRouter(),
            devices: entries.map((entry) => {
                const device = entry.deviceId ? this.manager.allDevices[entry.deviceId] : undefined
                return {
                    ...entry,
                    name: entry.customName || entry.detectedName || '-',
                    model: device?.meta.modelId,
                    connected: !!device,
                    dnat: states[entry.entryId],
                    bridgeActive: !!(entry.deviceId && this.bridge?.status(entry.deviceId)),
                    bridgeSaved: !!(entry.deviceId && this.bridge?.hasSavedState(entry.deviceId)),
                }
            }),
            unassigned: Object.values(this.manager.allDevices)
                .filter((device) => !linkedIds.has(device.id))
                .map((device) => ({
                    deviceId: device.id,
                    name: this.deviceName(device),
                    model: device.meta.modelId,
                    sourceIp: 'sourceIp' in device ? device.sourceIp : undefined,
                })),
        }
    }

    private syncAllDevices() {
        Object.values(this.manager.allDevices).forEach((device) => this.syncDevice(device))
    }

    private syncDevice(device: AnyDevice) {
        const name = this.deviceName(device)
        const sourceIp = 'sourceIp' in device ? device.sourceIp : undefined
        this.store.linkByIp(sourceIp, device.id, name)
        this.store.refreshDetectedName(device.id, name)
    }

    private deviceName(device: AnyDevice) {
        return this.bridge?.name(device.id) || this.ha.haDevices.get(device.id)?.config?.device?.name || device.meta.modelName
    }
}

class ConflictError extends Error {}
