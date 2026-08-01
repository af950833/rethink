import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// Korean top-loading washer (Hd0C_F).
//
// AA/BB 0xEB contains one 27-byte record. 0xEC contains two chronological
// records, with the newest state in the second record. The offsets below were checked against a
// live Hd0C_F response and the same appliance's ThinQ2 washerDryer snapshot.
const STATUS: Record<number, string> = {
    0x00: '꺼짐',
    0x01: '초기 설정',
    0x02: '일시 정지',
    0x03: '무게 감지',
    0x04: '불림',
    0x05: '세탁 중',
    0x06: '헹굼 중',
    0x07: '탈수 중',
    0x08: '완료',
    0x09: '예약',
}

const COURSE: Record<number, string> = {
    0x01: '표준',
    0x02: '울/섬세',
    0x03: '급속',
    0x04: '이불',
    0x08: '통세척',
    0x0c: '수건',
    0x0d: '기능성의류',
    0x10: '애벌 + 표준',
    0x18: '안심 표준',
}

const WASH: Record<number, string> = {
    0x00: '-',
    0x01: '3분',
    0x02: '6분',
    0x03: '10분',
    0x04: '12분',
    0x05: '14분',
    0x06: '17분',
    0x07: '19분',
    0x08: '21분',
    0x09: '23분',
    0x0a: '25분',
}

const SPIN: Record<number, string> = {
    0x00: '-',
    0x01: '약',
    0x02: '중',
    0x03: '강',
    0x04: '최강',
    0x05: '맞춤건조',
    0x06: '섬세',
}

const TEMP: Record<number, string> = {
    0x00: '-',
    0x01: '냉수',
    0x02: '온수',
    0x03: '미온수',
    0x04: '냉수 + 온수',
}

const RINSE: Record<number, string> = {
    0x00: '-',
    0x01: '1회',
    0x02: '2회',
    0x03: '강력 3회',
    0x04: '강력 4회',
    0x05: '강력 5회',
    0x06: '강력 1회',
    0x07: '강력 2회',
    0x08: '3회',
    0x09: '4회',
    0x0a: '5회',
}

const ERROR: Record<number, string> = {
    0x00: '-',
    0x01: '도어 오류 (dE)',
    0x02: '급수 오류 (IE)',
    0x03: '배수 오류 (OE)',
    0x04: '불균형 오류 (UE)',
    0x05: '과급수 오류 (FE)',
    0x06: '수압 오류 (PE)',
    0x07: '온도 센서 오류 (tE)',
    0x08: '모터 오류 (LE)',
}

// Commands captured from this washer while its physical Remote Start mode was
// enabled. Remote start includes the complete selected programme, so only the
// captured Normal-course layout is exposed until other courses are validated.
const REMOTE_START_NORMAL = Buffer.from('f026010702010200060300000000d01000', 'hex')
const PAUSE = Buffer.from('f024040100', 'hex')
const POWER_OFF = Buffer.from('f024010100', 'hex')

function sensor(name: string, icon: string) {
    return {
        platform: 'sensor',
        unique_id: `$deviceid-${name}`,
        state_topic: `$this/${name}`,
        name,
        icon,
    }
}

function formatTime(hours: number, minutes: number) {
    const totalSeconds = Math.max(0, hours * 3600 + minutes * 60)
    const displayHours = Math.floor(totalSeconds / 3600)
    const displayMinutes = Math.floor((totalSeconds % 3600) / 60)
    const displaySeconds = totalSeconds % 60
    return `${displayHours}:${String(displayMinutes).padStart(2, '0')}:${String(displaySeconds).padStart(2, '0')}`
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
                    },
                    status: {
                        ...sensor('status', 'mdi:state-machine'),
                        device_class: 'enum',
                        options: [...new Set(Object.values(STATUS))],
                    },
                    previous_status: sensor('previous_status', 'mdi:history'),
                    course: sensor('course', 'mdi:pin-outline'),
                    remaining_time: sensor('remaining_time', 'mdi:timer-outline'),
                    initial_time: sensor('initial_time', 'mdi:clock-start'),
                    reserve_time: sensor('reserve_time', 'mdi:clock-outline'),
                    wash: sensor('wash', 'mdi:waves'),
                    spin: sensor('spin', 'mdi:rotate-3d'),
                    water_temp: sensor('water_temp', 'mdi:thermometer-lines'),
                    rinse: sensor('rinse', 'mdi:waves-arrow-right'),
                    water_level: sensor('water_level', 'mdi:water'),
                    tub_clean_count: {
                        ...sensor('tub_clean_count', 'mdi:washing-machine'),
                        state_class: 'total',
                        suggested_display_precision: 0,
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        device_class: 'problem',
                    },
                    error_message: sensor('error_message', 'mdi:alert-circle-outline'),
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock',
                    },
                    run_completed: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-run_completed',
                        state_topic: '$this/run_completed',
                        name: 'Run completed',
                        icon: 'mdi:check-circle-outline',
                    },
                    remote_start_enabled: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start_enabled',
                        state_topic: '$this/remote_start_enabled',
                        name: 'Remote start enabled',
                        icon: 'mdi:remote',
                    },
                    remote_start: {
                        platform: 'button',
                        unique_id: '$deviceid-remote_start',
                        command_topic: '$this/remote_start/set',
                        name: 'Remote start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        name: 'Power off',
                        icon: 'mdi:power',
                    },
                },
            }),
        )
    }

    private phase = 0
    private course = 0
    private remoteStartEnabled = false

    private processRecord(rec: Buffer) {
        if (rec.length !== 27 || rec[1] !== 0x19) return

        const phase = rec[2]
        const isOff = phase === 0
        const error = rec[22]
        this.phase = phase
        this.course = rec[7]
        // Live comparison: physical Remote Start OFF=0x80, ON=0x10.
        this.remoteStartEnabled = rec[17] === 0x10

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS[phase] ?? `알 수 없음 (${phase})`)
        this.publishProperty('previous_status', STATUS[rec[21]] ?? `알 수 없음 (${rec[21]})`)
        this.publishProperty('course', isOff ? '-' : (COURSE[rec[7]] ?? `알 수 없음 (${rec[7]})`))
        this.publishProperty('remaining_time', isOff ? '0:00:00' : formatTime(rec[3], rec[4]))
        this.publishProperty('initial_time', isOff ? '0:00:00' : formatTime(rec[5], rec[6]))
        this.publishProperty('reserve_time', isOff ? '0:00:00' : formatTime(rec[13], rec[14]))
        this.publishProperty('wash', isOff ? '-' : (WASH[rec[9]] ?? `알 수 없음 (${rec[9]})`))
        this.publishProperty('spin', isOff ? '-' : (SPIN[rec[10]] ?? `알 수 없음 (${rec[10]})`))
        this.publishProperty('water_temp', isOff ? '-' : (TEMP[rec[11]] ?? `알 수 없음 (${rec[11]})`))
        this.publishProperty('rinse', isOff ? '-' : (RINSE[rec[12]] ?? `알 수 없음 (${rec[12]})`))
        // The protocol uses zero-based water-level values.
        this.publishProperty('water_level', isOff ? '-' : rec[23] + 1)
        this.publishProperty('error', error === 0 ? 'OFF' : 'ON')
        this.publishProperty('error_message', ERROR[error] ?? `오류 코드 ${error}`)
        // Hd0C_F sets bit 3 while the lid is locked during a running cycle.
        this.publishProperty('door_lock', (rec[16] & 0x08) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('run_completed', phase === 0x08 ? 'ON' : 'OFF')
        this.publishProperty('remote_start_enabled', this.remoteStartEnabled ? 'ON' : 'OFF')
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20) return

        if (buf[1] === 0xeb && buf.length === 29) this.processRecord(buf.subarray(2, 29))
        else if (buf[1] === 0xec && buf.length === 56) this.processRecord(buf.subarray(29, 56))
        // Full status sent once after the appliance reconnects. Hd0C_F byte 29
        // is TCLCount (washes since the last tub-clean cycle); live value 0x17
        // matched the ThinQ2 snapshot's TCLCount=23 exactly.
        else if (buf[1] === 0xcf && buf.length === 50) this.publishProperty('tub_clean_count', buf[29])
        // A qualifying cycle (including the final spin) sends a compact absolute
        // TCLCount update immediately before Complete. Captured 20 D8 19 when
        // ThinQ changed to 25; incomplete cycles do not send this notification.
        else if (buf[1] === 0xd8 && buf.length === 3) this.publishProperty('tub_clean_count', buf[2])
    }

    setProperty(prop: string, mqttValue: string) {
        if (mqttValue !== 'PRESS') return

        if (prop === 'remote_start') {
            if (!this.remoteStartEnabled || this.phase !== 0x01 || this.course !== 0x01) {
                console.warn('Ignoring washer remote start: Remote Start and the Normal course must be selected')
                return
            }
            this.send(REMOTE_START_NORMAL)
        } else if (prop === 'pause') {
            if (this.phase === 0 || this.phase === 0x02) return
            this.send(PAUSE)
        } else if (prop === 'power_off') {
            if (this.phase === 0) return
            this.send(POWER_OFF)
        }
    }
}
