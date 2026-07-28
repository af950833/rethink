import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2RES2VE300UA2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: '2RES2VE300UA2', modelName: '2RES2VE300UA2', swVersion: '' }
const LIVE_STATUS = buf(
    'aa4a10eb0205040107000000010001ffffff00ff0001ffffffffffffff02020103ff000001ff00ffffffffff01ff00' +
        'ffffffffffffffffffffffffffffffffffffffff0078ff00000abb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('2RES2VE300UA2', () => {
    test('exposes the supported refrigerator components', () => {
        const { ha } = makeDevice()
        const c = ha.devices[DEVICE_ID].config!.components as Record<string, unknown>
        for (const name of [
            'fridge',
            'freezer',
            'express_cool',
            'express_freeze',
            'door',
            'door_open_count_today',
            'door_open_duration_today',
            'door_open_warning',
            'fresh_air_filter',
            'power_experimental',
        ])
            assert.ok(c[name], name)
        assert.equal((c.fridge as { platform: string }).platform, 'climate')
        assert.equal((c.freezer as { platform: string }).platform, 'climate')
        assert.equal(c.flex_setpoint, undefined)
    })

    test('counts door openings and accumulates only completed open time', () => {
        const { ha, dev } = makeDevice()
        const processDoor = (dev as unknown as { processDoor: (open: boolean, now: number) => void }).processDoor.bind(
            dev,
        )

        processDoor(false, 1_000)
        processDoor(true, 2_000)
        processDoor(true, 5_000)
        assert.equal(ha.devices[DEVICE_ID].properties.door_open_count_today, 1)
        assert.equal(ha.devices[DEVICE_ID].properties.door_open_duration_today, 0)

        processDoor(false, 12_000)
        assert.equal(ha.devices[DEVICE_ID].properties.door_open_duration_today, 0.17)
        assert.equal(ha.devices[DEVICE_ID].properties.door_open_warning, 'OFF')
    })

    test('decodes the live status consistently with smartthinq_sensors', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', LIVE_STATUS)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.fridge_temperature, 3)
        assert.equal(p.freezer_temperature, -18)
        assert.equal(p.fridge_mode, 'auto')
        assert.equal(p.freezer_mode, 'auto')
        assert.equal(p.express_cool, 'OFF')
        assert.equal(p.express_freeze, 'OFF')
        assert.equal(p.door, 'OFF')
        assert.equal(p.fresh_air_filter, '양호')
        assert.equal(p.power_experimental, 120)
    })

    test('writes the live-captured fridge and freezer command layouts', () => {
        const { thinq, dev } = makeDevice()

        thinq.resetRecorder()
        dev.setProperty('fridge_temperature', '4')
        assert.equal(
            hex(thinq.outbox[0]),
            'AA7CF017FF0400FFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBABB',
        )

        thinq.resetRecorder()
        dev.setProperty('freezer_temperature', '-19')
        assert.equal(
            hex(thinq.outbox[0]),
            'AA7CF017FF0005FFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA5BB',
        )
    })

    test('writes express controls at their validated offsets', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('express_cool', 'ON')
        assert.equal(thinq.outbox[0][4 + 16], 1)

        thinq.resetRecorder()
        dev.setProperty('express_freeze', 'ON')
        assert.equal(thinq.outbox[0][4 + 3], 2)
    })

    test('starts periodic status polling and clears it when dropped', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA0EF0ED1211010000010400EBBB')
        assert.ok((dev as unknown as { statusPollTimer?: NodeJS.Timeout }).statusPollTimer)

        dev.drop()
        assert.equal((dev as unknown as { statusPollTimer?: NodeJS.Timeout }).statusPollTimer, undefined)
    })
})
