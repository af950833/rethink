import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Broker, PublishPacket } from '@/cloud/mqtt-broker'
import { Device } from '@/cloud/thinq2/device'
import type { ClipMessage } from '@/cloud/thinq2/clip'

describe('ThinQ2 device message forwarding', () => {
    it('forwards a cloud ack JSON without changing its mid, cmd or data', () => {
        const broker = new Broker()
        const device = new Device(broker, 'lime/devices/fridge', 'fridge', {
            modelId: '2RES2VE300UA2',
            modelName: '2RES2VE300UA2',
        })
        const published: PublishPacket[] = []
        broker.on('publish', (packet) => published.push(packet))

        const ack = {
            did: 'fridge',
            mid: 1785283454163,
            cmd: 'ack',
            type: 1,
            data: 'AA08F000C5043EBB',
        } as ClipMessage

        device.forward_message(ack)

        assert.equal(published.length, 1)
        assert.equal(published[0].topic, 'lime/devices/fridge')
        assert.deepEqual(JSON.parse(published[0].payload.toString()), ack)
    })
})
