import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import { racAirTemp, racPipeTemp } from '@/util/ac_tables'
import log from '@/util/logging'
import HADevice from './base'
import { dirname, join, resolve } from 'node:path'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

type PowerModeChangeHook = () => void
type CheckMode = (arg: number) => boolean

type EnergyStats = {
    hour: string
    date: string
    month: string
    hourWh: number
    dayWh: number
    monthWh: number
    lastReportSignature?: string
    lastReportAt?: number
}

function localDate(timestamp = Date.now()) {
    const parts = new Intl.DateTimeFormat('en', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(timestamp)
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value
    return `${part('year')}-${part('month')}-${part('day')}`
}

function localHour(timestamp = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(timestamp)
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}`
}

function localMonth(timestamp = Date.now()) {
    return localDate(timestamp).slice(0, 7)
}

function dataDirectory() {
    if (!process.argv[1]?.includes('rethink-cloud')) return
    return dirname(resolve(process.argv[2] ?? './config.json'))
}

export default class Device extends TLVDevice {
    meta: Metadata
    initialValuesReceived: boolean = false
    powerChangeHooks: PowerModeChangeHook[] = []
    powerStatePrev?: boolean
    modeChangeHooks: PowerModeChangeHook[] = []
    modePrev?: string
    airClean: boolean = false
    jetMode: boolean = false
    energySave: boolean = false
    tlvBlacklistDisableTimer: ReturnType<typeof setTimeout> | undefined
    increasedQueryIntervalTimeout: ReturnType<typeof setTimeout> | undefined
    filterUsedTime: number = 0
    filterLifeTime: number = 0
    filterChangedDate: number = 0
    filterInitialQueryTimeout: ReturnType<typeof setTimeout> | undefined
    filterQueryTimer: ReturnType<typeof setInterval> | undefined
    pacFanOnlyStopTimeout: ReturnType<typeof setTimeout> | undefined
    energyResetTimer: ReturnType<typeof setInterval> | undefined
    energyStats: EnergyStats

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.meta = meta
        this.energyStats = this.loadEnergyStats()
        if (meta.modelId === 'PAC_910604_WW') {
            this.energyResetTimer = setInterval(() => this.rollEnergyPeriods(), 60_000)
            this.energyResetTimer.unref()
        }
    }

    drop() {
        if (this.tlvBlacklistDisableTimer != undefined) {
            clearTimeout(this.tlvBlacklistDisableTimer)
            this.tlvBlacklistDisableTimer = undefined
        }

        if (this.increasedQueryIntervalTimeout != undefined) {
            clearTimeout(this.increasedQueryIntervalTimeout)
            this.increasedQueryIntervalTimeout = undefined
        }

        if (this.filterInitialQueryTimeout != undefined) {
            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined
        }

        if (this.filterQueryTimer != undefined) {
            clearInterval(this.filterQueryTimer)
            this.filterQueryTimer = undefined
        }

        if (this.pacFanOnlyStopTimeout != undefined) {
            clearTimeout(this.pacFanOnlyStopTimeout)
            this.pacFanOnlyStopTimeout = undefined
        }

        if (this.energyResetTimer != undefined) {
            clearInterval(this.energyResetTimer)
            this.energyResetTimer = undefined
        }

        super.drop()
    }

    processData(buf: Buffer) {
        super.processData(buf)

        // PAC_910604_WW private B115 statistics report:
        //   uint32 LE interval energy (Wh), uint32 LE interval duration (seconds).
        // A non-zero report is normally emitted about every 15 minutes, with
        // zero-filled status reports in between.
        if (
            this.meta.modelId === 'PAC_910604_WW' &&
            buf.length >= 20 &&
            buf[0] === 0x00 &&
            buf[6] === 0x87 &&
            buf[7] === 0xfd &&
            buf[8] === 0x03 &&
            buf[10] === 0xb1 &&
            buf[11] === 0x15
        ) {
            const intervalWh = buf.readUInt32LE(12)
            const intervalSeconds = buf.readUInt32LE(16)
            if (intervalWh > 0 && intervalSeconds >= 600 && intervalSeconds <= 1200) {
                this.processEnergyInterval(intervalWh, intervalSeconds)
            }
        }
    }

    processPrivData(cmd: number, buf9: number, data: Buffer) {
        if (cmd == 0x02) this.processFilterData(buf9, data)
    }

    processPrivDataCmdResp(success: boolean, buf1: number, cmd: number, data: Buffer) {
        if (cmd == 0x2) this.processFilterCmdResp(success, data)
    }

    sendFilterQuery() {
        this.sendPrivCommand(0x02, 0x02)
    }

    sendFilterReset() {
        if (!this.filterLifeTime) throw new Error('Filter lifetime not known')

        const now = new Date()
        const date = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate()

        const buf = Buffer.alloc(4 * 3)
        // yes, it's opposite endianness vs read cmd
        buf.writeUInt32BE(this.filterLifeTime, 1 * 4)
        buf.writeUInt32BE(date, 2 * 4)

        log('status', this.id, 'sending filter reset')
        this.sendPrivCommand(0x02, 0x01, buf)
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* eeprom checksum */
        return tlvArray.some(({ t, v }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        /* power */
        return tlvArray.length >= 10 && tlvArray.some(({ t, v }) => t === 0x1f7)
    }

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true

        // we want to be informed about all TLV changes - set an empty blacklist
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })

        // give modem some time to process the command before continuing
        this.tlvBlacklistDisableTimer = setTimeout(() => {
            this.tlvBlacklistDisableTimer = undefined

            if (!(this.raw_clip_state[0x2f1] & 1 || this.raw_clip_state[0x2f1] & 0x200)) {
                // no mFilter, check basic filter management support
                this.initProbeForFilter()
            } else {
                // unsupported mFilter management support
                this.initMakeSetConfig()
            }
        }, 500)
    }

    initProbeForFilter() {
        log('status', this.id, 'sending initial filter data query')
        this.sendFilterQuery()

        this.filterInitialQueryTimeout = setTimeout(() => {
            this.filterInitialQueryTimeout = undefined

            log('status', this.id, 'filter data query timeout, assuming no filter')
            this.initMakeSetConfig()
        }, 5 * 1000)
    }

    processFilterData(buf9: number, data: Buffer) {
        if (data.length < 1 + 3 * 4) {
            log('status', this.id, 'filter data too short:', data.length)
            return
        }

        this.filterUsedTime = data.readUInt32LE(1 + 0 * 4)
        this.filterLifeTime = data.readUInt32LE(1 + 1 * 4)
        this.filterChangedDate = data.readUInt32LE(1 + 2 * 4)

        // if this was the initial filter query the device config is ready now
        if (this.filterInitialQueryTimeout != undefined) {
            log('status', this.id, 'received initial filter data')

            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined

            this.initMakeSetConfig()
        } else {
            // if this was not the initial query just update the HA values
            this.publishFilterData()
        }
    }

    publishFilterData() {
        const changedDate =
            Math.floor(this.filterChangedDate / 10000)
                .toString()
                .padStart(4, '0') +
            '-' +
            (Math.floor(this.filterChangedDate / 100) % 100).toString().padStart(2, '0') +
            '-' +
            (this.filterChangedDate % 100).toString().padStart(2, '0')

        this.HA.publishProperty(this.id, 'filterused', this.filterUsedTime)
        this.HA.publishProperty(this.id, 'filterlife', this.filterLifeTime)
        this.HA.publishProperty(this.id, 'filterchangeddate', changedDate)
    }

    processFilterCmdResp(success: boolean, data: Buffer) {
        if (!success) {
            log('status', this.id, 'filter reset failed')
            return
        }

        log('status', this.id, 'filter reset okay, re-querying')
        this.sendFilterQuery()
    }

    updateClimateAction() {
        // also updates query interval
        const modeTLV = this.getModeTLV()

        let iduRunning = true
        const iduRunningTLVNum = this.getIDUActionRunningTLVNum()
        if (iduRunningTLVNum != null) {
            iduRunning = this.raw_clip_state[iduRunningTLVNum] !== 0
        }

        const modes2ha =
            this.meta.modelId === 'PAC_910604_WW'
                ? ['cooling', 'drying', undefined, undefined, undefined, 'fan']
                : ['cooling', 'drying', 'fan', undefined, 'heating']
        let action: string | undefined = undefined
        let increaseQueryInterval = false
        if (this.getPowerTLV() === 0) {
            action = 'off'
        } else if ((modeTLV === 0 || modeTLV === 1 || modeTLV === 4 || modeTLV === 6) && !iduRunning) {
            action = 'idle'
        } else if (modeTLV === 6) {
            // TODO: figure out how to detect the actual running mode in Auto
            // For now, clear the reported action.
            action = 'None'
            increaseQueryInterval = true // assume it is running
        } else {
            action = modes2ha[modeTLV]
            increaseQueryInterval = action != null && action !== 'fan'
        }

        if (action != null) this.HA.publishProperty(this.id, 'climate-action', action)
        this.updateQueryInterval(increaseQueryInterval)
    }

    updateQueryInterval(increaseQueryInterval: boolean) {
        if (increaseQueryInterval) {
            if (this.increasedQueryIntervalTimeout != undefined) {
                clearTimeout(this.increasedQueryIntervalTimeout)
                this.increasedQueryIntervalTimeout = undefined
            }

            /*
             * When in one of active modes update more frequently
             * since parameters can change rapidly:
             * every a bit less than half a minute.
             *
             * This matches the observed ODU parameter recalculation intervals:
             * compressor Hz - every 30 seconds,
             * EEV openings - every 30 seconds during transient periods.
             */
            this.setQueryInterval((30 - 2) * 1000)
        } else if (this.increasedQueryIntervalTimeout == null) {
            /*
             * Reset to the default interval after 15 minutes,
             * hopefully things returned to steady idle state by this time.
             */
            this.increasedQueryIntervalTimeout = setTimeout(
                () => {
                    this.increasedQueryIntervalTimeout = undefined
                    this.setQueryInterval()
                },
                15 * 60 * 1000,
            )
        }
    }

    getPowerTLV() {
        return this.raw_clip_state[0x1f7]
    }

    getModeTLV() {
        return this.raw_clip_state[0x1f9]
    }

    getIDUActionRunningTLVNum() {
        if (this.raw_clip_state[0x189] != null) {
            return 0x189 // IDUThermoOnOff
        }
        if (this.raw_clip_state[0x6c] != null) {
            return 0x6c
        }

        return undefined
    }

    initMakeSetConfig() {
        const isPac910604 = this.meta.modelId === 'PAC_910604_WW'
        const config: DeviceDiscovery & { components: { climate: ClimateComponent } } = allowExtendedType({
            ...HADevice.config(this.meta, { name: 'LG Air Conditioner' }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    action_topic: '$this/climate-action',
                    temperature_unit: 'C',
                    /* TODO: detect 0.5 C vs 1 C step */
                    temp_step: 0.5,
                    precision: 0.5,
                    /* TODO: some devices report these temp ranges via tags 0x2e1 - 0x2ec */
                    min_temp: 18,
                    max_temp: 30,
                    ...(isPac910604 ? { modes: ['off', 'cool', 'dry', 'fan_only'] } : {}),
                    /* TODO: get from 0x2c2 */
                    fan_modes: isPac910604
                        ? ['약풍', '중풍', '강풍', '롱파워', '쿨파워']
                        : ['auto', 'very low', 'low', 'medium', 'high', 'very high'],
                    /* TODO: get allowed op modes from 0x2c1 */
                } satisfies ClimateComponent,
            },
        })

        this.addField(config, {
            id: 0x1fd,
            name: 'current_temperature',
            comp: 'climate',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })
        if (isPac910604) {
            this.addField(config, {
                id: 0x336,
                name: 'current_humidity',
                comp: 'climate',
                state_topic: 'topic',
                writable: false,
            })
        }
        this.addField(config, {
            id: 0x1f7,
            name: 'power',
            comp: 'climate',
            readable: false,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            /*  0x1f7 is not necessary for ON but does not seem to hurt either */
            write_attach: (raw) => (raw ? [0x1f9, 0x1fa, 0x1fe] : []),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                // update 'mode' instead
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])

                const powerState = val === 'ON'
                if (this.powerStatePrev !== powerState) for (const hook of this.powerChangeHooks) hook()
                this.powerStatePrev = powerState

                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                if (isPac910604) {
                    const pacModes: Record<number, string> = { 0: 'cool', 1: 'dry', 5: 'fan_only' }
                    if (this.getPowerTLV() === 0) return 'off'
                    return pacModes[raw]
                }
                const modes2ha = ['cool', 'dry', 'fan_only', undefined, 'heat', undefined, 'auto']
                if (this.getPowerTLV() === 0) return 'off'
                return modes2ha[raw]
            },
            read_callback: (val) => {
                if (typeof val !== 'string') return true
                if (this.modePrev !== val) for (const hook of this.modeChangeHooks) hook()
                this.modePrev = val
                return true
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = isPac910604
                    ? { cool: 0, dry: 1, fan_only: 5 }
                    : { cool: 0, dry: 1, fan_only: 2, heat: 4, auto: 6 }
                if (val === 'off') {
                    // Call function power (0x1f7) with value OFF
                    this.setProperty('climate-power', 'OFF')
                    return null
                }
                return modes2clip[val]
            },
            write_callback: (raw) => {
                if (isPac910604 && this.getModeTLV() === 5 && (raw === 0 || raw === 1)) {
                    if (this.pacFanOnlyStopTimeout != undefined) clearTimeout(this.pacFanOnlyStopTimeout)
                    this.pacFanOnlyStopTimeout = setTimeout(() => {
                        this.pacFanOnlyStopTimeout = undefined
                        this.send([1, 1, 2, 1, 0], [{ t: 0x20f, v: 0 }])
                    }, 1400)
                }
                return true
            },
            write_attach: [0x1fa, 0x1fe],
        })

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => {
                if (isPac910604) {
                    const pacModes: Record<number, string> = {
                        0x0202: '약풍',
                        0x0404: '중풍',
                        0x0606: '강풍',
                        0x0909: '롱파워',
                    }
                    return pacModes[raw]
                }
                const modes2ha = [
                    undefined,
                    undefined,
                    'very low',
                    'low',
                    'medium',
                    'high',
                    'very high',
                    undefined,
                    'auto',
                    'long power',
                ]
                return modes2ha[raw]
            },
            write_xform: (val) => {
                if (isPac910604) {
                    if (val === '쿨파워') {
                        if (!this.jetMode) {
                            this.setProperty('coolpower-', 'ON')
                            this.jetMode = true
                        }
                        return null
                    }
                    if (this.jetMode) {
                        this.setProperty('coolpower-', 'OFF')
                        this.jetMode = false
                    }
                    const pacModes: Record<string, number> = {
                        약풍: 0x0202,
                        중풍: 0x0404,
                        강풍: 0x0606,
                        롱파워: 0x0909,
                    }
                    return pacModes[val]
                }
                const modes2clip: Record<string, number> = {
                    'very low': 2,
                    low: 3,
                    medium: 4,
                    high: 5,
                    'very high': 6,
                    auto: 8,
                    'long power': 9,
                }
                return modes2clip[val]
            },
            write_attach: [0x1f9, 0x1fe],
        })

        this.addField(config, {
            id: 0x1fe,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            write_xform: (val) => Math.round(Number(val) * 2),
            write_attach: [0x1f9, 0x1fa],
        })

        if (isPac910604) {
            config['components']['climate']['swing_modes'] = ['정지', '회전']
            config['components']['climate']['swing_horizontal_modes'] = ['정지', '우측', '좌측', '좌우']
            this.addField(config, {
                id: 0x205,
                name: 'swing_mode',
                comp: 'climate',
                read_xform: (raw) => (raw ? '회전' : '정지'),
                write_xform: (val) => (val === '회전' ? 1 : 0),
            })
            this.addField(config, {
                id: 0x206,
                name: 'swing_horizontal_mode',
                comp: 'climate',
                read_xform: (raw) => ({ 0x0000: '정지', 0x0001: '우측', 0x0100: '좌측', 0x0101: '좌우' })[raw],
                write_xform: (val) => ({ 정지: 0x0000, 우측: 0x0001, 좌측: 0x0100, 좌우: 0x0101 })[val],
            })
        } else if (this.raw_clip_state[0x2cd] & 4) {
            config['components']['climate']['swing_modes'] = ['1', '2', '3', '4', '5', '6', 'on', 'off']
            this.addField(config, {
                id: 0x321,
                name: 'swing_mode',
                comp: 'climate',
                read_xform: (raw) => {
                    const modes2ha = ['off', '1', '2', '3', '4', '5', '6']
                    modes2ha[100] = 'on'
                    return modes2ha[raw]
                },
                write_xform: (val) => {
                    const modes2clip: Record<string, number> = {
                        off: 0,
                        '1': 1,
                        '2': 2,
                        '3': 3,
                        '4': 4,
                        '5': 5,
                        '6': 6,
                        on: 100,
                    }
                    return modes2clip[val]
                },
            })
        }

        if (this.raw_clip_state[0x2cd] & 8) {
            config['components']['climate']['swing_horizontal_modes'] = [
                '1',
                '2',
                '3',
                '4',
                '5',
                '1-3',
                '3-5',
                'on',
                'off',
            ]
            this.addField(config, {
                id: 0x322,
                name: 'swing_horizontal_mode',
                comp: 'climate',
                read_xform: (raw) => {
                    const modes2ha = ['off', '1', '2', '3', '4', '5']
                    modes2ha[13] = '1-3'
                    modes2ha[35] = '3-5'
                    modes2ha[100] = 'on'
                    return modes2ha[raw]
                },
                write_xform: (val) => {
                    const modes2clip: Record<string, number> = {
                        off: 0,
                        '1': 1,
                        '2': 2,
                        '3': 3,
                        '4': 4,
                        '5': 5,
                        '1-3': 13,
                        '3-5': 35,
                        on: 100,
                    }
                    return modes2clip[val]
                },
            })
        }

        this.addOptionalSensorField(config, 0x221, 'error', 'Error code', 'mdi:alert')
        this.addOptionalSensorField(
            config,
            0x32e,
            'capacity',
            'Capacity nominal',
            undefined,
            {
                device_class: 'power',
                unit_of_measurement: 'kW',
                suggested_display_precision: 1,
            },
            (raw) => (raw !== 0 ? Math.round(raw * 0.293 * 10) / 10 : undefined),
        ) // raw is in kBTU / hour

        /*
         * Whether the IDU will report its EEV opening correctly during its
         * active operation is highly inconsistent between IDUs.
         * For example, from two Standard2 IDUs with 0x690409 software version
         * connected to common ODU one IDU works as expected while the other
         * one reports the EEV opening value of the other Standard2 IDU (?).
         * This may be an ODU firmware bug. On the other hand, another Deluxe
         * IDU connected to the same ODU always reports correct EEV values.
         * None of tested IDUs seem to usually notify by itself when this value changes.
         */
        this.addOptionalSensorField(config, 0x330, 'eev', 'EEV opening', 'mdi:valve', {
            state_class: 'measurement',
            suggested_display_precision: 0,
        })

        /*
         * IDUs send notifications about the updates of the temperatures below
         * at their own pace, sometimes in clusters with other attributes.
         * Deluxe IDUs send notifications noticeably more often than Standard2 IDUs.
         *
         * Pipe temps are sometimes reported as 0 (-100 C) for a moment after a shutdown.
         * Make sure to filter out such updates.
         */
        this.addOptionalSensorTempField(
            config,
            0x2f9,
            'pipeintemp',
            'Pipe liquid temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x2fa,
            'pipeouttemp',
            'Pipe gas temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )

        this.addOptionalSensorTempField(
            config,
            [0x7a, 0x32c],
            'oduhextemp',
            'ODU HEX temperature', // "HEX" = "heat exchanger"
            'mdi:heating-coil',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x332,
            'oduairtemp',
            'ODU air temperature',
            'mdi:thermometer-lines',
            (raw) => racAirTemp[255 - raw],
        )

        /*
         * [ 0x22a, 0x32f ] - ODU compressor Hz
         * Standard2 IDUs even notify about the former
         * tag changes.
         *
         * But the value seems to be capped at 15 Hz
         * regardless of the actual compressor speed,
         * which makes it of limited usability.
         */

        // 0x2fb is the target fan RPM, while this is the current RPM
        this.addOptionalSensorField(
            config,
            0x331,
            'fanrpm',
            'Fan RPM',
            'mdi:fan',
            {
                state_class: 'measurement',
                unit_of_measurement: 'rpm',
                suggested_display_precision: 0,
            },
            (raw) => raw * 10,
        )

        if (this.raw_clip_state[0x2cc] & 1) {
            this.addModeDependentConfigSwitchField(
                config,
                0x20f,
                'airclean',
                /* Same desc as in lg_thinq */
                'Air purify',
                'mdi:air-purifier',
                'airClean',
            )
        }

        const jetCool: boolean = !!(this.raw_clip_state[0x2cd] & 1)
        const jetHeat: boolean = !!(this.raw_clip_state[0x2cd] & 2)
        if (isPac910604) {
            this.addField(
                config,
                {
                    id: 0x236,
                    name: '',
                    comp: 'coolpower',
                    read_xform: (raw) => (raw ? 'ON' : 'OFF'),
                    write_xform: (val) => (val === 'ON' ? 1 : 0),
                    read_callback: (val) => {
                        this.jetMode = val === 'ON'
                        if (this.jetMode) this.HA.publishProperty(this.id, 'climate-fan_mode', '쿨파워')
                        return false
                    },
                },
                false,
            )
        } else if (jetCool || jetHeat) {
            this.addJetField(
                config,
                0x323,
                'jet',
                isPac910604 ? 'Cool power' : 'Jet',
                'mdi:wind-power',
                jetCool,
                jetHeat,
            )
        }

        if (this.raw_clip_state[0x2d3] & 1) {
            // 15h - displayed in hex as "FH"
            this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', 15)
        }

        if (this.raw_clip_state[0x2d3] & 4) {
            this.addTimerField(config, 0x21c, 'starttimer', 'Turn-on timer', 'mdi:timer-play', 24)
            this.addTimerField(config, 0x21b, 'stoptimer', 'Turn-off timer', 'mdi:timer-stop', 24)
        }

        if (isPac910604) {
            // This PAC reports 0x20D in every full state response, so expose a
            // regular state-backed switch instead of an assumed-state control.
            this.addConfigSwitchField(config, 0x20d, 'energysave', 'Energy saving', 'mdi:flower')
        } else if (this.raw_clip_state[0x2cc] & 2) {
            // Can be enabled only when running in the cooling mode
            this.addModeDependentConfigSwitchField(
                config,
                0x20d,
                'energysave',
                'Energy saving',
                'mdi:flower',
                'energySave',
                (mode) => mode === 0,
            )
        }

        if (isPac910604) {
            // PAC_910604_WW reports these live values even though its legacy
            // 0x2CC capability bits do not advertise them.
            this.addConfigSwitchField(config, 0x20e, 'autodry', 'Auto dry', 'mdi:hair-dryer')
        } else if (this.raw_clip_state[0x2cc] & 4) {
            const compADry = {
                platform: 'binary_sensor',
                unique_id: '$deviceid-autodry',
                name: 'Auto dry',
                icon: 'mdi:hair-dryer',
                entity_category: 'diagnostic',
            }
            const compADryRem = {
                platform: 'sensor',
                unique_id: '$deviceid-autodryremain',
                name: 'Auto dry remaining',
                icon: 'mdi:hair-dryer-outline',
                unit_of_measurement: '%',
                suggested_display_precision: 0,
                entity_category: 'diagnostic',
            }
            config['components']['autodry'] = compADry
            config['components']['autodryremain'] = compADryRem

            this.addField(config, {
                id: 0x20e,
                name: '',
                comp: 'autodry',
                writable: false,
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            })

            this.addField(config, {
                id: 0x225,
                name: '',
                comp: 'autodryremain',
                writable: false,
            })
        }

        if (isPac910604) {
            // Live command captures from this model:
            //   0x21F: front display light (1=on)
            //   0x23E: smart-care wind mode (1=on)
            this.addConfigSwitchField(config, 0x21f, 'displaylight', 'Display light', 'mdi:lightbulb')
            this.addConfigSwitchField(config, 0x23e, 'smartcare', 'Smart care', 'mdi:creation')
        }

        if (this.getIDUActionRunningTLVNum() != null) {
            this.addField(
                config,
                {
                    id: this.getIDUActionRunningTLVNum(),
                    name: 'action',
                    comp: 'climate',
                    read_callback: (val) => {
                        this.updateClimateAction()
                        return false
                    },
                },
                false,
            )
        }

        this.powerChangeHooks.push(() => {
            this.updateClimateAction()
        })
        this.modeChangeHooks.push(() => {
            this.updateClimateAction()
        })

        // 0x21f - "display light" value is inverted in some devices,
        // but in some devices it is not - not shown in ThinQ app either

        if (this.filterLifeTime) {
            const filterUsed = {
                platform: 'sensor',
                unique_id: '$deviceid-filterused',
                state_topic: '$this/filterused',
                name: 'Filter used time',
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                state_class: 'total_increasing',
                entity_category: 'diagnostic',
            }
            config['components']['filterused'] = filterUsed
            const filterLife = {
                platform: 'sensor',
                unique_id: '$deviceid-filterlife',
                state_topic: '$this/filterlife',
                name: 'Filter life time',
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                entity_category: 'diagnostic',
            }
            config['components']['filterlife'] = filterLife
            const filterChanged = {
                platform: 'sensor',
                unique_id: '$deviceid-filterchangeddate',
                state_topic: '$this/filterchangeddate',
                name: 'Filter usage last reset',
                icon: 'mdi:calendar-refresh-outline',
                device_class: 'date',
                entity_category: 'diagnostic',
            }
            config['components']['changeddate'] = filterChanged

            const filterReset = {
                platform: 'button',
                unique_id: '$deviceid-filterreset',
                command_topic: '$this/filterreset/set',
                name: 'Reset filter usage',
                icon: 'mdi:calendar-refresh-outline',
                entity_category: 'diagnostic',
            }
            config['components']['filterreset'] = filterReset
            this.fields_by_ha['filterreset'] = {
                name: '',
                comp: '',
                write_xform: (val) => (val === 'PRESS' ? 1 : 0),
                write_callback: (val) => {
                    if (val === 1) this.sendFilterReset()
                    return false
                },
            }
        }

        // this value is reported as zero by multi-split units
        if (this.raw_clip_state[0x2b3]) {
            const energyCurrent = {
                platform: 'sensor',
                unique_id: '$deviceid-energy_current',
                state_topic: '$this/energy_current',
                name: 'Power',
                device_class: 'power',
                unit_of_measurement: 'W',
                state_class: 'measurement',
                suggested_display_precision: 0,
            }

            config['components']['energy_current'] = energyCurrent

            // The measurements reported by RAC_056905_WW appear to be Watts, but they are not accurate in several aspects:
            // - the value is biased by +50
            // - idle consumption (around 4W) and the 4-way valve is not included
            // - fan modes' consumption appears to be approximated
            //
            // The formula below is expected to be within +/-10% of the actual power consumption. The discrepancy may
            // be highest in fan-only modes.
            //
            // PAC_910604_WW live measurements were compared against an external power meter and match the raw value,
            // so the upstream RAC-specific correction must not be applied to that model.
            this.addField(config, {
                id: 0x2b3,
                name: '',
                comp: 'energy_current',
                writable: false,
                read_xform: (raw) => (isPac910604 ? raw : Math.max(5, raw - 60)),
            })
        }

        if (isPac910604) {
            const energyCurrentHour = {
                platform: 'sensor',
                device_class: 'energy',
                unique_id: '$deviceid-energy_current_hour',
                state_topic: '$this/energy_current_hour',
                name: '현재 시간 누적 사용량',
                unit_of_measurement: 'Wh',
                state_class: 'total',
                icon: 'mdi:lightning-bolt',
            }
            const energyToday = {
                platform: 'sensor',
                device_class: 'energy',
                unique_id: '$deviceid-energy_today',
                state_topic: '$this/energy_today',
                name: '오늘 누적 사용량',
                unit_of_measurement: 'Wh',
                state_class: 'total',
                icon: 'mdi:calendar-today',
            }
            const energyMonth = {
                platform: 'sensor',
                device_class: 'energy',
                unique_id: '$deviceid-energy_month',
                state_topic: '$this/energy_month',
                name: '금월 누적 사용량',
                unit_of_measurement: 'kWh',
                state_class: 'total',
                suggested_display_precision: 3,
                icon: 'mdi:calendar-month',
            }
            config['components']['energy_current_hour'] = energyCurrentHour
            config['components']['energy_today'] = energyToday
            config['components']['energy_month'] = energyMonth
        }

        this.setConfig(config)
        if (isPac910604) this.publishEnergyStats()

        if (this.filterLifeTime) {
            this.publishFilterData()

            /*
             * Refresh only once a day since a query might do an EEPROM
             * write.
             */
            this.filterQueryTimer = setInterval(
                () => {
                    log('status', this.id, 'sending periodic filter data refresh query')
                    this.sendFilterQuery()
                },
                24 * 60 * 60 * 1000,
            )
        }

        this.query()
    }

    private energyStatsPath() {
        const dir = dataDirectory()
        return dir ? join(dir, `air-conditioner-energy-${this.id}.json`) : undefined
    }

    private loadEnergyStats(now = Date.now()): EnergyStats {
        const current = { hour: localHour(now), date: localDate(now), month: localMonth(now) }
        const empty: EnergyStats = { ...current, hourWh: 0, dayWh: 0, monthWh: 0 }
        const path = this.energyStatsPath()
        if (!path) return empty
        try {
            const saved = JSON.parse(readFileSync(path, 'utf-8')) as EnergyStats
            return {
                ...current,
                hourWh: saved.hour === current.hour ? Number(saved.hourWh) || 0 : 0,
                dayWh: saved.date === current.date ? Number(saved.dayWh) || 0 : 0,
                monthWh: saved.month === current.month ? Number(saved.monthWh) || 0 : 0,
                ...(saved.lastReportSignature ? { lastReportSignature: saved.lastReportSignature } : {}),
                ...(Number.isFinite(saved.lastReportAt) ? { lastReportAt: Number(saved.lastReportAt) } : {}),
            }
        } catch {
            return empty
        }
    }

    private saveEnergyStats() {
        const path = this.energyStatsPath()
        if (!path) return
        const temporary = `${path}.tmp`
        try {
            writeFileSync(temporary, JSON.stringify(this.energyStats))
            renameSync(temporary, path)
        } catch (err) {
            console.warn(`Unable to save air conditioner energy statistics: ${err}`)
        }
    }

    private publishEnergyStats() {
        this.HA.publishProperty(this.id, 'energy_current_hour', this.energyStats.hourWh)
        this.HA.publishProperty(this.id, 'energy_today', this.energyStats.dayWh)
        this.HA.publishProperty(this.id, 'energy_month', Number((this.energyStats.monthWh / 1000).toFixed(3)))
    }

    private processEnergyInterval(intervalWh: number, intervalSeconds: number, now = Date.now()) {
        this.rollEnergyPeriods(now)
        const signature = `${intervalWh}:${intervalSeconds}`
        if (
            this.energyStats.lastReportSignature === signature &&
            this.energyStats.lastReportAt != null &&
            now - this.energyStats.lastReportAt < 2 * 60_000
        )
            return

        this.energyStats.lastReportSignature = signature
        this.energyStats.lastReportAt = now
        this.energyStats.hourWh += intervalWh
        this.energyStats.dayWh += intervalWh
        this.energyStats.monthWh += intervalWh
        this.publishEnergyStats()
        this.saveEnergyStats()
    }

    private rollEnergyPeriods(now = Date.now()) {
        const hour = localHour(now)
        const date = localDate(now)
        const month = localMonth(now)
        let changed = false
        if (this.energyStats.month !== month) {
            this.energyStats.month = month
            this.energyStats.monthWh = 0
            changed = true
        }
        if (this.energyStats.date !== date) {
            this.energyStats.date = date
            this.energyStats.dayWh = 0
            changed = true
        }
        if (this.energyStats.hour !== hour) {
            this.energyStats.hour = hour
            this.energyStats.hourWh = 0
            changed = true
        }
        if (changed) {
            this.publishEnergyStats()
            this.saveEnergyStats()
        }
    }

    addTimerField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string, max: number) {
        const comp = {
            platform: 'number',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            device_class: 'duration',
            unit_of_measurement: 'h',
            min: 0,
            max: max,
            step: 0.25,
            mode: 'slider',
        } as const
        config['components'][name] = comp

        /*
         * Upon setting this field the device starts counting down and
         * every minute sends the remaining time.
         */
        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => Math.ceil(raw / 60 / 0.25) * 0.25,
            write_xform: (val) => Math.round(Number(val) * 60),
        })
    }

    addJetField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        jetCool: boolean,
        jetHeat: boolean,
    ) {
        const descFull =
            desc === 'Cool power'
                ? desc
                : desc + ' ' + (jetCool ? 'cool' : '') + (jetCool && jetHeat ? '/' : '') + (jetHeat ? 'heat' : '')

        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: descFull,
            icon: icon,
            entity_category: 'config',
            optimistic: true,
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => {
                this.jetMode = val === 'ON'
                if (!this.jetMode) return 0

                /* ON */
                if (jetCool && this.getModeTLV() === 0) return 1
                if (jetHeat && this.getModeTLV() === 4) return 2
                return 0
            },
            read_xform: (raw) => {
                if (jetCool && this.getModeTLV() === 0 && raw == 1) return 'ON'
                if (jetHeat && this.getModeTLV() === 4 && raw == 2) return 'ON'
                return 'OFF'
            },
            read_callback: (val) => {
                // Ignore read value if not running
                const powerTLV = this.getPowerTLV()
                if (powerTLV === 0 || powerTLV == null) return false

                // Ignore read value if not in the right mode
                if (!((jetCool && this.getModeTLV() === 0) || (jetHeat && this.getModeTLV() === 4))) return false

                this.jetMode = val === 'ON'
                return true
            },
            write_callback: (val) => {
                /*
                 * Writing '1' in OFF state seem to immediately
                 * power on into the cooling mode, while writing
                 * '2' in the OFF state is ignored.
                 * Be consistent and only allow enabling Jet mode
                 * when running in the right mode.
                 */
                return (
                    this.getPowerTLV() !== 0 &&
                    ((jetCool && this.getModeTLV() === 0) || (jetHeat && this.getModeTLV() === 4))
                )
            },
        })

        /*
         * This value needs to be written at each power up in heat/cool mode,
         * but in a separate message.
         */
        this.powerChangeHooks.push(() => {
            if (this.getPowerTLV() === 0) return
            this.setProperty(name + '-', this.jetMode ? 'ON' : 'OFF')
        })
        this.modeChangeHooks.push(() => {
            this.setProperty(name + '-', this.jetMode ? 'ON' : 'OFF')
        })
    }

    addOptionalSensorField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        if (typeof ids === 'number') {
            ids = [ids]
        }

        let id = ids.find(
            (val) =>
                this.raw_clip_state[val] != null &&
                (read_xform == null || read_xform(this.raw_clip_state[val]) != null),
        )
        if (id == null) return

        const comp = {
            icon: icon ?? undefined,
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            name: desc,
            entity_category: 'diagnostic',
            ...extra,
        }

        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            writable: false,
            read_xform: read_xform,
        })
    }

    addOptionalSensorTempField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        this.addOptionalSensorField(
            config,
            ids,
            name,
            desc,
            icon,
            {
                device_class: 'temperature',
                unit_of_measurement: '°C',
                state_class: 'measurement',
                suggested_display_precision: 2,
            },
            read_xform,
        )
    }

    addConfigSwitchField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string) {
        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
        })
    }

    addModeDependentConfigSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        field_name: 'airClean' | 'jetMode' | 'energySave',
        check_mode?: CheckMode,
    ) {
        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
            optimistic: true,
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                // Ignore read value if not running
                const powerTLV = this.getPowerTLV()
                if (powerTLV === 0 || powerTLV == null) return false

                // Ignore read value if not in the right mode
                if (!!check_mode && !check_mode(this.getModeTLV())) return false

                this[field_name] = val === 'ON'
                return true
            },
            write_callback: (val) => {
                this[field_name] = val === 1

                // No need to write the value if not running in the right mode
                return this.getPowerTLV() !== 0 && (!check_mode || check_mode(this.getModeTLV()))
            },
        })

        this.powerChangeHooks.push(() => {
            if (this.getPowerTLV() === 0) return
            /*
             * This value needs to be written at each power up,
             * but in a separate message.
             */
            this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
        })

        if (!!check_mode) {
            this.modeChangeHooks.push(() => {
                this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
            })
        }
    }
}
