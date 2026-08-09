import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Broker, PublishPacket } from '@/cloud/mqtt-broker'
import { Device, DeviceAcceptor } from '@/cloud/thinq2/device'
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

    it('forwards a cloud modem command JSON without changing its mid, cmd or data', () => {
        const broker = new Broker()
        const device = new Device(broker, 'lime/devices/aircon', 'aircon', {
            modelId: 'PAC_910604_WW',
            modelName: 'PAC_910604_WW',
        })
        const published: PublishPacket[] = []
        broker.on('publish', (packet) => published.push(packet))

        const command = {
            did: 'aircon',
            mid: 1786291393406,
            cmd: 'modem_cmd',
            type: 1,
            data: 'reserv-get-3',
        } as ClipMessage

        device.forward_message(command)

        assert.equal(published.length, 1)
        assert.deepEqual(JSON.parse(published[0].payload.toString()), command)
    })

    it('emits the original device modem response for transparent cloud forwarding', () => {
        const broker = new Broker()
        const acceptor = new DeviceAcceptor(broker)
        const device = new Device(broker, 'lime/devices/aircon', 'aircon', {
            modelId: 'PAC_910604_WW',
            modelName: 'PAC_910604_WW',
        })
        const client = { deviceObj: device, deployMsg: undefined }
        const received: ClipMessage[] = []
        device.onBridgeMessage((payload) => received.push(payload))

        const response = {
            did: 'aircon',
            mid: 112139777,
            cmd: 'modem_cmd',
            type: 1,
            data: 'reserv-result-3',
        } as ClipMessage

        acceptor.mqtt('clip/message/devices/aircon', response, client as never)

        assert.deepEqual(received, [response])
    })
})
