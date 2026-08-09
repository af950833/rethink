import type { RouterDeviceEntry, RouterSSHConfig } from './config-store'
import { RouterSSHClient } from './ssh-client'

export type DNATState = 'on' | 'off' | 'partial' | 'unknown'

const IPTABLES = '/usr/sbin/iptables'
const CONNTRACK = '/usr/sbin/conntrack'
const CHAIN = 'RETHINK_DNAT'

function rule(deviceIp: string, dport: number, rethinkIp: string, targetPort: number) {
    return `-s ${deviceIp}/32 -p tcp -m tcp --dport ${dport} -j DNAT --to-destination ${rethinkIp}:${targetPort}`
}

export class DNATManager {
    private static queue = Promise.resolve()

    constructor(readonly config: RouterSSHConfig) {}

    private serialized<T>(action: () => Promise<T>) {
        const result = DNATManager.queue.then(action, action)
        DNATManager.queue = result.then(
            () => undefined,
            () => undefined,
        )
        return result
    }

    private async withClient<T>(action: (client: RouterSSHClient) => Promise<T>) {
        const client = new RouterSSHClient(this.config)
        await client.connect()
        try {
            return await action(client)
        } finally {
            client.close()
        }
    }

    test() {
        return this.withClient(async (client) => {
            const iptables = await client.exec(`${IPTABLES} --version`)
            if (iptables.code !== 0) throw new Error(iptables.stderr || 'iptables is unavailable')
            const conntrack = await client.exec(`${CONNTRACK} -V`)
            if (conntrack.code !== 0) throw new Error(conntrack.stderr || 'conntrack is unavailable')
            return { iptables: iptables.stdout.trim(), conntrack: (conntrack.stdout || conntrack.stderr).trim() }
        })
    }

    status(devices: RouterDeviceEntry[]) {
        return this.withClient(async (client) => {
            const states: Record<string, DNATState> = {}
            for (const device of devices) states[device.entryId] = await this.deviceStatus(client, device.ip)
            return states
        })
    }

    enable(device: RouterDeviceEntry) {
        return this.serialized(() =>
            this.withClient(async (client) => {
                await this.ensureChain(client)
                for (const [dport, targetPort] of [
                    [443, 4433],
                    [8883, 8883],
                ] as const) {
                    const args = rule(device.ip, dport, this.config.rethinkIp, targetPort)
                    if (!(await this.hasRule(client, args))) {
                        const added = await client.exec(`${IPTABLES} -t nat -A ${CHAIN} ${args}`)
                        if (added.code !== 0) throw new Error(added.stderr || `Unable to add DNAT port ${dport}`)
                    }
                }
                await this.clearConntrack(client, device.ip)
                const state = await this.deviceStatus(client, device.ip)
                if (state !== 'on') throw new Error(`DNAT verification failed: ${state}`)
                return state
            }),
        )
    }

    disable(device: RouterDeviceEntry) {
        return this.serialized(() =>
            this.withClient(async (client) => {
                for (const [dport, targetPort] of [
                    [443, 4433],
                    [8883, 8883],
                ] as const) {
                    const args = rule(device.ip, dport, this.config.rethinkIp, targetPort)
                    for (const location of [CHAIN, 'PREROUTING']) {
                        for (let duplicate = 0; duplicate < 10; duplicate++) {
                            if ((await client.exec(`${IPTABLES} -t nat -C ${location} ${args}`)).code !== 0) break
                            const removed = await client.exec(`${IPTABLES} -t nat -D ${location} ${args}`)
                            if (removed.code !== 0)
                                throw new Error(removed.stderr || `Unable to remove DNAT port ${dport}`)
                        }
                    }
                }
                await this.clearConntrack(client, device.ip)
                const state = await this.deviceStatus(client, device.ip)
                if (state !== 'off') throw new Error(`DNAT verification failed: ${state}`)
                return state
            }),
        )
    }

    private async ensureChain(client: RouterSSHClient) {
        if ((await client.exec(`${IPTABLES} -t nat -nL ${CHAIN}`)).code !== 0) {
            const created = await client.exec(`${IPTABLES} -t nat -N ${CHAIN}`)
            if (created.code !== 0) throw new Error(created.stderr || 'Unable to create RETHINK_DNAT chain')
        }
        if ((await client.exec(`${IPTABLES} -t nat -C PREROUTING -j ${CHAIN}`)).code !== 0) {
            const linked = await client.exec(`${IPTABLES} -t nat -I PREROUTING 1 -j ${CHAIN}`)
            if (linked.code !== 0) throw new Error(linked.stderr || 'Unable to link RETHINK_DNAT chain')
        }
    }

    private async deviceStatus(client: RouterSSHClient, ip: string): Promise<DNATState> {
        const https = rule(ip, 443, this.config.rethinkIp, 4433)
        const mqtt = rule(ip, 8883, this.config.rethinkIp, 8883)
        const hasHttps = await this.hasRule(client, https)
        const hasMqtt = await this.hasRule(client, mqtt)
        if (hasHttps && hasMqtt) return 'on'
        if (!hasHttps && !hasMqtt) return 'off'
        return 'partial'
    }

    private async hasRule(client: RouterSSHClient, args: string) {
        if ((await client.exec(`${IPTABLES} -t nat -C ${CHAIN} ${args}`)).code === 0) return true
        return (await client.exec(`${IPTABLES} -t nat -C PREROUTING ${args}`)).code === 0
    }

    private async clearConntrack(client: RouterSSHClient, ip: string) {
        await client.exec(`${CONNTRACK} -D -s ${ip} -p tcp --dport 443`)
        await client.exec(`${CONNTRACK} -D -s ${ip} -p tcp --dport 8883`)
    }
}
