declare module 'ssh2' {
    import { EventEmitter } from 'node:events'

    export type ConnectConfig = {
        host: string
        port?: number
        username: string
        password?: string
        readyTimeout?: number
    }

    export class Client extends EventEmitter {
        connect(config: ConnectConfig): this
        exec(command: string, callback: (err: Error | undefined, stream: any) => void): void
        end(): void
    }
}
