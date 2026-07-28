import { randomBytes, X509Certificate } from 'node:crypto'
import { createSecureContext, SecureContext } from 'node:tls'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CA } from './config'

const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function runOpenSSL(args: string[]) {
    const result = spawnSync('openssl', args, { encoding: 'utf-8' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`openssl failed (${result.status}): ${result.stderr.trim()}`)
}

/** Creates and caches leaf certificates signed by rethink's device-trusted CA. */
export class SNICertificateProvider {
    readonly cache = new Map<string, SecureContext>()

    constructor(readonly ca: CA) {}

    forServerName(serverName: string): SecureContext {
        const hostname = serverName.trim().toLowerCase().replace(/\.$/, '')
        if (!DNS_NAME.test(hostname)) throw new Error(`Invalid TLS SNI hostname: ${serverName}`)

        const cached = this.cache.get(hostname)
        if (cached) return cached

        const generated = this.generate(hostname)
        this.cache.set(hostname, generated)
        return generated
    }

    private generate(hostname: string): SecureContext {
        const dir = mkdtempSync(join(tmpdir(), 'rethink-sni-'))
        try {
            const caKey = join(dir, 'ca-key.pem')
            const caCert = join(dir, 'ca-cert.pem')
            const leafKey = join(dir, 'leaf-key.pem')
            const leafCsr = join(dir, 'leaf.csr')
            const leafCert = join(dir, 'leaf-cert.pem')
            const extensions = join(dir, 'extensions.cnf')

            writeFileSync(caKey, this.ca.key, { mode: 0o600 })
            writeFileSync(caCert, this.ca.cert, { mode: 0o600 })
            writeFileSync(
                extensions,
                [
                    'basicConstraints=critical,CA:FALSE',
                    'keyUsage=critical,digitalSignature,keyEncipherment',
                    'extendedKeyUsage=serverAuth',
                    `subjectAltName=DNS:${hostname}`,
                    '',
                ].join('\n'),
                { mode: 0o600 },
            )

            runOpenSSL(['genrsa', '-out', leafKey, '2048'])
            runOpenSSL(['req', '-new', '-key', leafKey, '-out', leafCsr, '-subj', `/CN=${hostname}`])
            runOpenSSL([
                'x509',
                '-req',
                '-in',
                leafCsr,
                '-CA',
                caCert,
                '-CAkey',
                caKey,
                '-set_serial',
                `0x${randomBytes(16).toString('hex')}`,
                '-out',
                leafCert,
                '-days',
                '825',
                '-sha256',
                '-extfile',
                extensions,
            ])

            const key = readFileSync(leafKey, 'utf-8')
            const cert = readFileSync(leafCert, 'utf-8')
            if (!new X509Certificate(cert).checkHost(hostname)) {
                throw new Error(`Generated certificate does not cover ${hostname}`)
            }
            return createSecureContext({ key, cert })
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}
