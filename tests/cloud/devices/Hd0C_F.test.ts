import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Hd0C_F'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'Hd0C_F', modelName: 'Hd0C_F', swVersion: '2.10.93' }
const LIVE_RINSING = buf('aa2120eb001906003201040100010501020000000800000000060002036600fabb')
const LIVE_POWER_OFF = buf('aa2120eb0019000110011001000702010200000080000000000200060366005abb')
const LIVE_FULL_STATUS = buf(
    'aa0020cf002e0101070600230104010200020103050101000080000000006617023a0f4604330200000100000000001c00000000a7bb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('washer-id', META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('Hd0C_F', () => {
    test('publishes the expanded component set', () => {
        const { ha } = makeDevice()
        const components = ha.devices['washer-id'].config!.components as Record<string, unknown>
        for (const name of [
            'power',
            'status',
            'previous_status',
            'course',
            'remaining_time',
            'initial_time',
            'reserve_time',
            'wash',
            'spin',
            'water_temp',
            'rinse',
            'water_level',
            'tub_clean_count',
            'error',
            'error_message',
            'door_lock',
            'run_completed',
            'remote_start_enabled',
            'remote_start',
            'pause',
            'power_off',
        ])
            assert.ok(components[name], `${name} component`)

        const tubCleanCount = components.tub_clean_count as Record<string, unknown>
        assert.equal(tubCleanCount.state_class, 'total')
        assert.equal(tubCleanCount.suggested_display_precision, 0)
        assert.equal(tubCleanCount.unit_of_measurement, undefined)
    })

    test('publishes Remote Start state and sends only validated controls', () => {
        const { ha, thinq, dev } = makeDevice()
        const REMOTE_READY = buf('aa2120eb00190100000000010007020102000000c81000000000000603660084bb')
        thinq.emit('data', REMOTE_READY)
        assert.equal(ha.devices['washer-id'].properties.remote_start_enabled, 'ON')

        thinq.resetRecorder()
        dev.setProperty('remote_start', 'PRESS')
        assert.equal(hex(thinq.outbox[0]), 'AA15F026010702010200060300000000D010009EBB')

        thinq.resetRecorder()
        dev.setProperty('pause', 'PRESS')
        assert.equal(hex(thinq.outbox[0]), 'AA09F02404010099BB')

        thinq.resetRecorder()
        dev.setProperty('power_off', 'PRESS')
        assert.equal(hex(thinq.outbox[0]), 'AA09F0240101009CBB')
    })

    test('blocks Remote Start when the physical Remote Start mode is off', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', LIVE_RINSING)
        thinq.resetRecorder()
        dev.setProperty('remote_start', 'PRESS')
        assert.equal(thinq.outbox.length, 0)
    })

    test('decodes a live Korean normal-course rinse response', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', LIVE_RINSING)
        const p = ha.devices['washer-id'].properties

        assert.equal(p.power, 'ON')
        assert.equal(p.status, '헹굼 중')
        assert.equal(p.previous_status, '헹굼 중')
        assert.equal(p.course, '표준')
        assert.equal(p.remaining_time, 50)
        assert.equal(p.initial_time, 64)
        assert.equal(p.reserve_time, 0)
        assert.equal(p.wash, '3분')
        assert.equal(p.spin, '맞춤건조')
        assert.equal(p.water_temp, '냉수')
        assert.equal(p.rinse, '2회')
        assert.equal(p.water_level, 3)
        assert.equal(p.error, 'OFF')
        assert.equal(p.error_message, '-')
        assert.equal(p.door_lock, 'ON')
        assert.equal(p.run_completed, 'OFF')
    })

    test('decodes the live full-status TCLCount value', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', LIVE_FULL_STATUS)
        assert.equal(ha.devices['washer-id'].properties.tub_clean_count, 23)
    })

    test('hides stale course, spin and water level while powered off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', LIVE_POWER_OFF)
        const p = ha.devices['washer-id'].properties

        assert.equal(p.power, 'OFF')
        assert.equal(p.status, '꺼짐')
        assert.equal(p.course, '-')
        assert.equal(p.spin, '-')
        assert.equal(p.water_level, '-')
    })
})
