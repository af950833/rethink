import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/PAC_910604_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'PAC_910604_WW', modelName: 'PAC_910604_WW', swVersion: '640903' }

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => dev.setProperty(prop, value))
    return { ha, thinq, dev }
}

function configureDevice() {
    const result = makeDevice()
    result.dev.raw_clip_state[0x1f7] = 1
    result.dev.raw_clip_state[0x1f9] = 0
    result.dev.raw_clip_state[0x2cc] = 0
    result.dev.raw_clip_state[0x2b3] = 1
    ;(result.dev as unknown as { initMakeSetConfig(): void }).initMakeSetConfig()
    return result
}

describe('PAC_910604_WW', () => {
    test('exposes its live-confirmed controls and raw power value', () => {
        const { ha, thinq, dev } = configureDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        for (const component of [
            'energysave',
            'autodry',
            'displaylight',
            'smartcare',
            'humidity_sensor_mode',
            'energy_current_hour',
            'energy_today',
            'energy_month',
        ]) {
            assert.equal(
                components[component].platform,
                component.startsWith('energy_') ? 'sensor' : component === 'humidity_sensor_mode' ? 'select' : 'switch',
            )
        }

        for (const [component, expectedTag] of [
            ['energysave', 0x20d],
            ['autodry', 0x20e],
            ['displaylight', 0x21f],
            ['smartcare', 0x23e],
        ] as const) {
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, component, 'command', 'ON')
            assert.equal(thinq.outbox.length, 1)
            assert.deepEqual(TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2)), [
                { t: expectedTag, l: 0, v: 1 },
            ])
        }

        dev.processKeyValue(0x2b3, 550)
        assert.equal(ha.devices[DEVICE_ID].properties['energy_current-'], 550)

        dev.processKeyValue(0x337, 0)
        assert.equal(ha.devices[DEVICE_ID].properties['humidity_sensor_mode-'], '운전 중에만')
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'humidity_sensor_mode', 'command', '항상')
        assert.deepEqual(thinq.outbox, [Buffer.from('01020400000065fd0100050c00000001a140', 'hex')])

        dev.processKeyValue(0x337, 1)
        assert.equal(ha.devices[DEVICE_ID].properties['humidity_sensor_mode-'], '항상')
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'humidity_sensor_mode', 'command', '운전 중에만')
        assert.deepEqual(thinq.outbox, [Buffer.from('01020400000065fd0100050c00000000b161', 'hex')])
        dev.drop()
    })

    test('accumulates B115 interval energy and ignores immediate retransmissions', () => {
        const { ha, dev } = makeDevice()
        const report = (wh: number, seconds: number) => {
            const packet = Buffer.alloc(20)
            packet[6] = 0x87
            packet[7] = 0xfd
            packet[8] = 0x03
            packet[10] = 0xb1
            packet[11] = 0x15
            packet.writeUInt32LE(wh, 12)
            packet.writeUInt32LE(seconds, 16)
            dev.processData(packet)
        }

        report(123, 910)
        report(123, 910)
        report(142, 900)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.energy_current_hour, 265)
        assert.equal(properties.energy_today, 265)
        assert.equal(properties.energy_month, 0.265)
        dev.drop()
    })

    test('leaves fan-only correctly when Cool Power or Long Power is selected', async () => {
        const coolPower = configureDevice()
        coolPower.dev.raw_clip_state[0x1f9] = 5
        coolPower.dev.raw_clip_state[0x1fa] = 0x0404
        coolPower.dev.raw_clip_state[0x1fe] = 56
        coolPower.thinq.resetRecorder()

        const longPower = configureDevice()
        longPower.dev.raw_clip_state[0x1f9] = 5
        longPower.dev.raw_clip_state[0x1fa] = 0x0404
        longPower.dev.raw_clip_state[0x1fe] = 56
        longPower.thinq.resetRecorder()

        let coolPackets: TLV.TLV[][] = []
        let longPackets: TLV.TLV[][] = []
        try {
            coolPower.ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', '쿨파워')
            longPower.ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', '롱파워')

            await new Promise((resolve) => setTimeout(resolve, 1800))

            coolPackets = coolPower.thinq.outbox.map((packet) => TLV.parse(packet.subarray(11, packet.length - 2)))
            longPackets = longPower.thinq.outbox.map((packet) => TLV.parse(packet.subarray(11, packet.length - 2)))
        } finally {
            coolPower.dev.drop()
            longPower.dev.drop()
        }

        assert.deepEqual(coolPackets, [
            [{ t: 0x236, l: 0, v: 1 }],
            [{ t: 0x20f, l: 0, v: 0 }],
        ])
        assert.deepEqual(longPackets, [
            [
                { t: 0x1f9, l: 0, v: 0 },
                { t: 0x1fa, l: 2, v: 0x0404 },
                { t: 0x1fe, l: 1, v: 56 },
            ],
            [{ t: 0x20f, l: 0, v: 0 }],
            [
                { t: 0x1fa, l: 2, v: 0x0909 },
                { t: 0x1f9, l: 0, v: 0 },
                { t: 0x1fe, l: 1, v: 56 },
            ],
        ])
    })
})
