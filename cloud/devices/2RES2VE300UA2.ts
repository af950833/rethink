import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { dirname, join, resolve } from 'node:path'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const STATUS_LENGTH = 68
const DOOR_WARNING_MS = 60_000

type DoorStats = {
    date: string
    count: number
    durationMinutes: number
    openSince?: number
}

function localDate(timestamp = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(timestamp)
}

function dataDirectory() {
    // Production is launched as `rethink-cloud ... /app/data/config.json`. Avoid
    // writing state files from unit tests or when this handler is imported as a library.
    if (!process.argv[1]?.includes('rethink-cloud')) return
    return dirname(resolve(process.argv[2] ?? './config.json'))
}

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
                    fridge: {
                        platform: 'climate',
                        unique_id: '$deviceid-fridge_climate',
                        name: 'Fridge',
                        temperature_unit: 'C',
                        temperature_state_topic: '$this/fridge_temperature',
                        temperature_command_topic: '$this/fridge_temperature/set',
                        mode_state_topic: '$this/fridge_mode',
                        modes: ['auto'],
                        min_temp: 1,
                        max_temp: 7,
                        temp_step: 1,
                        precision: 1,
                        icon: 'mdi:fridge-top',
                    },
                    freezer: {
                        platform: 'climate',
                        unique_id: '$deviceid-freezer_climate',
                        name: 'Freezer',
                        temperature_unit: 'C',
                        temperature_state_topic: '$this/freezer_temperature',
                        temperature_command_topic: '$this/freezer_temperature/set',
                        mode_state_topic: '$this/freezer_mode',
                        modes: ['auto'],
                        min_temp: -23,
                        max_temp: -15,
                        temp_step: 1,
                        precision: 1,
                        icon: 'mdi:fridge-bottom',
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
                    door_open_count_today: {
                        platform: 'sensor',
                        unique_id: '$deviceid-door_open_count_today',
                        state_topic: '$this/door_open_count_today',
                        name: 'Door open count today',
                        unit_of_measurement: '회',
                        state_class: 'total',
                        icon: 'mdi:counter',
                    },
                    door_open_duration_today: {
                        platform: 'sensor',
                        device_class: 'duration',
                        unique_id: '$deviceid-door_open_duration_today',
                        state_topic: '$this/door_open_duration_today',
                        name: 'Door open duration today',
                        unit_of_measurement: 'min',
                        state_class: 'total',
                        suggested_display_precision: 2,
                        icon: 'mdi:timer-outline',
                    },
                    door_open_warning: {
                        platform: 'binary_sensor',
                        device_class: 'problem',
                        unique_id: '$deviceid-door_open_warning',
                        state_topic: '$this/door_open_warning',
                        name: 'Door open warning',
                        icon: 'mdi:fridge-alert-outline',
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
        this.doorStats = this.loadDoorStats()
        this.scheduleMidnightReset()
        this.publishDoorStats()
    }

    private doorOpen?: boolean
    private doorWarningTimer?: NodeJS.Timeout
    private midnightTimer?: NodeJS.Timeout
    private doorStats: DoorStats

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
        this.publishProperty('fridge_temperature', fridgeRaw(rec[1]))
        this.publishProperty('freezer_temperature', freezerRaw(rec[2]))
        this.publishProperty('fridge_mode', 'auto')
        this.publishProperty('freezer_mode', 'auto')
        this.publishProperty('express_freeze', rec[3] === 2 ? 'ON' : 'OFF')
        this.publishProperty('express_cool', rec[16] === 1 ? 'ON' : 'OFF')
        this.processDoor(rec[7] === 1)
        this.publishProperty('fresh_air_filter', rec[4] === 3 ? '교체 필요' : '양호')
    }

    private statsPath() {
        const dir = dataDirectory()
        return dir ? join(dir, `refrigerator-door-${this.id}.json`) : undefined
    }

    private loadDoorStats(): DoorStats {
        const empty = { date: localDate(), count: 0, durationMinutes: 0 }
        const path = this.statsPath()
        if (!path) return empty
        try {
            const saved = JSON.parse(readFileSync(path, 'utf-8')) as DoorStats
            if (saved.date !== empty.date) return empty
            return {
                date: saved.date,
                count: Number(saved.count) || 0,
                durationMinutes: Number(saved.durationMinutes) || 0,
                ...(saved.openSince ? { openSince: Number(saved.openSince) } : {}),
            }
        } catch {
            return empty
        }
    }

    private saveDoorStats() {
        const path = this.statsPath()
        if (!path) return
        const temporary = `${path}.tmp`
        try {
            writeFileSync(temporary, JSON.stringify(this.doorStats))
            renameSync(temporary, path)
        } catch (err) {
            console.warn(`Unable to save refrigerator door statistics: ${err}`)
        }
    }

    private publishDoorStats() {
        this.publishProperty('door_open_count_today', this.doorStats.count)
        this.publishProperty('door_open_duration_today', Number(this.doorStats.durationMinutes.toFixed(2)))
        this.publishProperty('door_open_warning', 'OFF')
    }

    private processDoor(open: boolean, now = Date.now()) {
        this.rollDoorStatsDay(now)
        this.publishProperty('door', open ? 'ON' : 'OFF')

        if (this.doorOpen === open) return
        const previous = this.doorOpen
        this.doorOpen = open

        if (open) {
            if (previous === false) this.doorStats.count++
            this.doorStats.openSince = now
            this.publishProperty('door_open_count_today', this.doorStats.count)
            this.publishProperty('door_open_warning', 'OFF')
            if (this.doorWarningTimer) clearTimeout(this.doorWarningTimer)
            this.doorWarningTimer = setTimeout(() => {
                if (this.doorOpen) this.publishProperty('door_open_warning', 'ON')
            }, DOOR_WARNING_MS)
            this.doorWarningTimer.unref()
        } else {
            if (this.doorWarningTimer) clearTimeout(this.doorWarningTimer)
            this.doorWarningTimer = undefined
            if (this.doorStats.openSince) {
                this.doorStats.durationMinutes += Math.max(0, now - this.doorStats.openSince) / 60_000
                delete this.doorStats.openSince
                this.publishProperty('door_open_duration_today', Number(this.doorStats.durationMinutes.toFixed(2)))
            }
            this.publishProperty('door_open_warning', 'OFF')
        }
        this.saveDoorStats()
    }

    private rollDoorStatsDay(now = Date.now()) {
        const today = localDate(now)
        if (this.doorStats.date === today) return
        this.doorStats = {
            date: today,
            count: 0,
            durationMinutes: 0,
            ...(this.doorOpen ? { openSince: now } : {}),
        }
        this.publishDoorStats()
        this.saveDoorStats()
    }

    private scheduleMidnightReset() {
        // Check shortly after each minute boundary. This keeps the daily sensors
        // correct even if the refrigerator sends no state packet at midnight.
        this.midnightTimer = setInterval(() => this.rollDoorStatsDay(), 60_000)
        this.midnightTimer.unref()
    }

    private sendSetting(statusOffset: number, value: number) {
        const command = Buffer.from(CONTROL_TEMPLATE, 'hex')
        command[2 + statusOffset] = value
        this.send(command)
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'fridge_temperature') {
            this.sendSetting(1, fridgeRaw(Number(mqttValue)))
        } else if (prop === 'freezer_temperature') {
            this.sendSetting(2, freezerRaw(Number(mqttValue)))
        } else if (prop === 'express_cool') {
            this.sendSetting(16, mqttValue === 'ON' ? 1 : 0)
        } else if (prop === 'express_freeze') {
            this.sendSetting(3, mqttValue === 'ON' ? 2 : 1)
        }
    }
}
