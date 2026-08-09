import { Client } from 'ssh2'
import type { RouterSSHConfig } from './config-store'

export type SSHResult = { code: number; stdout: string; stderr: string }

export class RouterSSHClient {
    private client = new Client()
    private connected = false

    constructor(readonly config: RouterSSHConfig) {}

    connect() {
        if (this.connected) return Promise.resolve()
        return new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => reject(err)
            this.client.once('error', onError)
            this.client.once('ready', () => {
                this.client.removeListener('error', onError)
                this.connected = true
                resolve()
            })
            this.client.connect({
                host: this.config.host,
                port: this.config.port,
                username: this.config.username,
                password: this.config.password,
                readyTimeout: 5000,
            })
        })
    }

    exec(command: string) {
        return new Promise<SSHResult>((resolve, reject) => {
            this.client.exec(command, (err, stream) => {
                if (err) return reject(err)
                let stdout = ''
                let stderr = ''
                stream.on('data', (data: Buffer) => (stdout += data.toString('utf-8')))
                stream.stderr.on('data', (data: Buffer) => (stderr += data.toString('utf-8')))
                stream.on('close', (code: number | undefined) => resolve({ code: code ?? 0, stdout, stderr }))
            })
        })
    }

    close() {
        this.client.end()
        this.connected = false
    }
}
