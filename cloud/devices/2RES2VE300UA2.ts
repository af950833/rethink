import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

const STATUS_LENGTH = 68

// Live-captured 118-byte control record for 2RES2VE300UA2. The two temperature
// bytes use zero as "unchanged"; all optional fields use 0xFF unless explicitly
// set below. Several fixed bytes near the end are required by this appliance.
const CONTROL_TEMPLATE =
    'f017ff0000ffffffffffffffffffff00ffffffffffffff000000ffff00ffffffff00ffffffffffffffffff00ffffff1effffffffffffffffffffffffffffffffffffffffffffffff0affffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ffffffffffffffffffffffffffffff'

function fridgeRaw(celsius: number) {
    return 8 - celsius
}

function freezerRaw(celsius: number) {
    return -14 - celsius
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Refrigerator' }),
                components: {
                    fridge_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-fridge_setpoint',
                        state_topic: '$this/fridge_setpoint',
                        command_topic: '$this/fridge_setpoint/set',
                        name: 'Fridge temperature',
                        unit_of_measurement: '°C',
                        min: 1,
                        max: 7,
                        step: 1,
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        unit_of_measurement: '°C',
                        min: -23,
                        max: -15,
                        step: 1,
                    },
                    express_cool: {
                        platform: 'switch',
                        unique_id: '$deviceid-express_cool',
                        state_topic: '$this/express_cool',
                        command_topic: '$this/express_cool/set',
                        name: 'Express cool',
                        icon: 'mdi:coolant-temperature',
                    },
                    express_freeze: {
                        platform: 'switch',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        name: 'Express freeze',
                        icon: 'mdi:snowflake',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                    fresh_air_filter: {
                        platform: 'sensor',
                        unique_id: '$deviceid-fresh_air_filter',
                        state_topic: '$this/fresh_air_filter',
                        name: 'Fresh air filter',
                        icon: 'mdi:air-filter',
                        device_class: 'enum',
                        options: ['양호', '교체 필요'],
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x10) return
        if (buf[1] === 0xeb && buf.length === 2 + STATUS_LENGTH) {
            this.processStatus(buf.subarray(2))
        } else if (buf[1] === 0xec && buf.length === 2 + STATUS_LENGTH * 2) {
            this.processStatus(buf.subarray(2 + STATUS_LENGTH))
        }
    }

    private processStatus(rec: Buffer) {
        this.publishProperty('fridge_setpoint', fridgeRaw(rec[1]))
        this.publishProperty('freezer_setpoint', freezerRaw(rec[2]))
        this.publishProperty('express_freeze', rec[3] === 2 ? 'ON' : 'OFF')
        this.publishProperty('express_cool', rec[16] === 1 ? 'ON' : 'OFF')
        this.publishProperty('door', rec[7] === 1 ? 'ON' : 'OFF')
        this.publishProperty('fresh_air_filter', rec[4] === 3 ? '교체 필요' : '양호')
    }

    private sendSetting(statusOffset: number, value: number) {
        const command = Buffer.from(CONTROL_TEMPLATE, 'hex')
        command[2 + statusOffset] = value
        this.send(command)
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'fridge_setpoint') {
            this.sendSetting(1, fridgeRaw(Number(mqttValue)))
        } else if (prop === 'freezer_setpoint') {
            this.sendSetting(2, freezerRaw(Number(mqttValue)))
        } else if (prop === 'express_cool') {
            this.sendSetting(16, mqttValue === 'ON' ? 1 : 0)
        } else if (prop === 'express_freeze') {
            this.sendSetting(3, mqttValue === 'ON' ? 2 : 1)
        }
    }
}
