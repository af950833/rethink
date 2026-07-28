import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Hd0C_F'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'Hd0C_F', modelName: 'Hd0C_F', swVersion: '2.10.93' }
const LIVE_RINSING = buf('aa2120eb001906003201040100010501020000000800000000060002036600fabb')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('washer-id', META)
    new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq }
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
            'error',
            'error_message',
            'door_lock',
            'run_completed',
        ])
            assert.ok(components[name], `${name} component`)
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
})
