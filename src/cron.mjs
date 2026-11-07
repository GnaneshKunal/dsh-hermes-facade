/**
 * Tasks/cron mapping: DSH schedules → the Hermes host's /api/cron shapes.
 *
 * DSH's scheduler owns the durable record (title, prompt, timing, target,
 * status, delivery history) and has no price/cost or per-run file. Hermex's
 * Tasks screens read the host's cron contract, so this module translates:
 * a schedule entry becomes a job row, one delivery becomes a run (its session
 * is the handle the app reads the output from), and the editor's schedule text
 * is parsed into a timing DSH's own validators accept.
 *
 * @module dsh-hermes-facade/src/cron
 */

/** The host's time zone, used for daily/cron schedules that name none. */
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/** Weekday names → DSH's ISO weekday (Monday = 1 … Sunday = 7). */
const WEEKDAYS = {
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
  sun: 7, sunday: 7,
}

/**
 * A refusal the HTTP layer answers with a status and a detail.
 */
export class CronRefusal extends Error {
  /**
   * @param {number} status HTTP status.
   * @param {string} detail message for the phone.
   */
  constructor(status, detail) {
    super(detail)
    this.status = status
    this.detail = detail
  }
}

/**
 * Validate one numeric cron field (values, ranges, lists, steps).
 * @param {string} field field text.
 * @param {number} min allowed minimum.
 * @param {number} max allowed maximum.
 * @returns {boolean} valid.
 */
function validCronField(field, min, max) {
  if (field === '*') return true
  return field.split(',').every(part => {
    if (part.length === 0) return false
    const pieces = part.split('/')
    if (pieces.length > 2) return false
    const [rangeText, step] = pieces
    if (step !== undefined && (!/^\d+$/.test(step) || Number.parseInt(step, 10) < 1)) return false
    if (rangeText === '*') return true
    const bounds = rangeText.split('-')
    if (bounds.length > 2) return false
    if (!bounds.every(value => /^\d+$/.test(value))) return false
    const numbers = bounds.map(value => Number.parseInt(value, 10))
    if (!numbers.every(value => value >= min && value <= max)) return false
    return bounds.length === 1 || numbers[0] <= numbers[1]
  })
}

/**
 * Validate and pad an HH:MM clock into DSH's HH:mm:ss form.
 * @param {string} hour hour text.
 * @param {string} minute minute text.
 * @returns {string} HH:mm:ss.
 */
function clock(hour, minute) {
  const h = Number.parseInt(hour, 10)
  const m = Number.parseInt(minute, 10)
  if (h > 23 || m > 59) throw new CronRefusal(400, 'schedule time is invalid')
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00'
}

/**
 * Parse the editor's schedule text into a DSH ScheduleTiming.
 *
 * Accepted: `every 5m` (60 s minimum; s/m/h/d or spelled units), `hourly`,
 * `daily at 09:00`, `weekdays at 09:00`, `weekly on monday at 09:00`, a
 * five-field numeric cron expression, an ISO timestamp with an explicit offset
 * in the future, or the two-line DTSTART/RRULE form DSH requires.
 * @param {string} text schedule text.
 * @returns {object} ScheduleTiming.
 */
export function parseTiming(text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) throw new CronRefusal(400, 'schedule is required')

  if (/^hourly$/i.test(raw)) return { kind: 'every', every_seconds: 3600 }

  const every = /^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i.exec(raw)
  if (every !== null) {
    const unit = String(every[2] ?? 'm').toLowerCase()
    const count = Number.parseInt(every[1], 10)
    const seconds = count * (unit.startsWith('s') ? 1 : unit.startsWith('m') ? 60 : unit.startsWith('h') ? 3600 : 86400)
    if (!Number.isSafeInteger(seconds) || seconds < 60) {
      throw new CronRefusal(400, 'schedule must run at least every 60 seconds')
    }
    return { kind: 'every', every_seconds: seconds }
  }

  const weekdays = /^weekdays(?:\s+at)?\s+(\d{1,2}):(\d{1,2})$/i.exec(raw)
  if (weekdays !== null) {
    return {
      kind: 'weekly',
      weekly: { time: clock(weekdays[1], weekdays[2]), time_zone: TIME_ZONE, weekdays: [1, 2, 3, 4, 5] },
    }
  }

  const weekly = /^weekly(?:\s+on)?\s+([a-z]+)(?:\s+at\s+(\d{1,2}):(\d{1,2}))?$/i.exec(raw)
  if (weekly !== null) {
    const day = WEEKDAYS[weekly[1].toLowerCase()]
    if (day === undefined) throw new CronRefusal(400, 'schedule weekday is unknown')
    const time = weekly[2] === undefined ? '09:00:00' : clock(weekly[2], weekly[3])
    return { kind: 'weekly', weekly: { time, time_zone: TIME_ZONE, weekdays: [day] } }
  }

  const daily = /^daily(?:\s+at)?\s+(\d{1,2}):(\d{1,2})$/i.exec(raw)
  if (daily !== null) {
    return { kind: 'daily', daily: { time: clock(daily[1], daily[2]), time_zone: TIME_ZONE } }
  }

  const rruleLines = raw.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  if (rruleLines.length === 2 && /^DTSTART:/.test(rruleLines[0]) && /^RRULE:/.test(rruleLines[1])) {
    return { kind: 'rrule', rrule: rruleLines.join('\n') }
  }
  if (/^(RRULE|FREQ)[:=]/i.test(raw)) {
    throw new CronRefusal(400, 'RRULE needs a DTSTART line followed by an RRULE line')
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
      throw new CronRefusal(400, 'schedule time needs an explicit Z or numeric offset')
    }
    if (Date.parse(raw) <= Date.now()) throw new CronRefusal(400, 'schedule time must be in the future')
    return { kind: 'at', at: raw }
  }

  const fields = raw.split(/\s+/)
  if (fields.length === 6) {
    throw new CronRefusal(400, 'cron expressions have five fields, not six')
  }
  if (fields.length === 5) {
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
    for (let index = 0; index < fields.length; index += 1) {
      if (!validCronField(fields[index], ranges[index][0], ranges[index][1])) {
        throw new CronRefusal(400, 'cron expression field ' + (index + 1) + ' is out of range')
      }
    }
    return { kind: 'cron', cron: { expression: raw, time_zone: TIME_ZONE } }
  }

  throw new CronRefusal(400, 'schedule must be a five-field cron expression, "every 5m", "daily at 09:00", "weekdays at 09:00", "weekly on monday at 09:00" or an ISO time')
}

/**
 * A compact duration for a schedule display.
 * @param {number} seconds every-seconds.
 * @returns {string} e.g. `5m`, `2h`, `1d`.
 */
function duration(seconds) {
  if (seconds % 86400 === 0) return (seconds / 86400) + 'd'
  if (seconds % 3600 === 0) return (seconds / 3600) + 'h'
  if (seconds % 60 === 0) return (seconds / 60) + 'm'
  return seconds + 's'
}

/**
 * An HH:mm:ss(.SSS) time trimmed to HH:mm.
 * @param {string|undefined} value DSH time.
 * @returns {string} HH:mm.
 */
function shortTime(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(value ?? ''))
  return match === null ? String(value ?? '') : String(Number.parseInt(match[1], 10)).padStart(2, '0') + ':' + match[2]
}

/**
 * A weekly day number as its name (ISO 1-7).
 * @param {number} index ISO weekday.
 * @returns {string} day name.
 */
function dayName(index) {
  return ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][index] ?? String(index)
}

/**
 * The `schedule` field the app's editor reads back.
 * @param {object} entry schedule catalog entry.
 * @returns {object} packed schedule.
 */
export function scheduleObjectOf(entry) {
  switch (entry?.kind) {
    case 'cron': return { kind: 'cron', expression: entry.expression }
    case 'every': return { kind: 'every', every: duration(entry.everySeconds) }
    case 'at': return { kind: 'at', runAt: entry.scheduledAt }
    case 'after': return { kind: 'after', runAt: entry.scheduledAt }
    case 'daily': return { kind: 'daily', time: shortTime(entry.time), time_zone: entry.timeZone }
    case 'weekly': return {
      kind: 'weekly', time: shortTime(entry.time), time_zone: entry.timeZone, weekdays: [...(entry.weekdays ?? [])],
    }
    case 'rrule': return { kind: 'rrule', expression: entry.rrule }
    default: return { kind: String(entry?.kind ?? '') }
  }
}

/**
 * The human schedule line the list shows.
 * @param {object} entry schedule catalog entry.
 * @returns {string} display text.
 */
export function scheduleDisplayOf(entry) {
  switch (entry?.kind) {
    case 'cron': return String(entry.expression ?? '')
    case 'every': return 'Every ' + duration(entry.everySeconds)
    case 'daily': return 'Daily at ' + shortTime(entry.time) + ' (' + entry.timeZone + ')'
    case 'weekly': return 'Weekly at ' + shortTime(entry.time) + ' on ' + (entry.weekdays ?? []).map(dayName).join(', ')
    case 'at': return 'Once at ' + entry.scheduledAt
    case 'after': return 'Once, ' + duration(entry.afterSeconds) + ' after creation'
    case 'rrule': return String(entry.rrule ?? '')
    default: return String(entry?.kind ?? 'recurring')
  }
}

/**
 * An ISO time as epoch seconds (undefined when unusable).
 * @param {string|undefined} value ISO time.
 * @returns {number|undefined} epoch seconds.
 */
function epoch(value) {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined
}

/**
 * One schedule entry as the host's CronJob row.
 * @param {object} entry schedule catalog entry.
 * @returns {object} job row.
 */
export function jobOf(entry) {
  const id = String(entry?.id ?? '')
  const last = entry?.lastDelivery
  return {
    id,
    job_id: id,
    name: String(entry?.title ?? ''),
    prompt: String(entry?.prompt ?? ''),
    schedule: scheduleObjectOf(entry),
    schedule_display: scheduleDisplayOf(entry),
    enabled: entry?.status === 'active',
    state: String(entry?.status ?? 'active'),
    // DSH documents scheduledAt as the next occurrence while active and the
    // final (often past) occurrence otherwise, so a non-active row names none.
    ...(entry?.status === 'active' ? { next_run_at: entry?.scheduledAt } : {}),
    ...(last === undefined || last === null ? {} : { last_run_at: last.deliveredAt }),
    // The app reads fire_claim.at as when the run started; a delivery receipt
    // has no claim time, so the read time is the honest approximation.
    ...(entry?.executionActive === true ? { fire_claim: { at: new Date().toISOString() } } : {}),
    deliver: 'local',
    skills: [],
    profile: 'default',
  }
}

/**
 * One delivery as a run row. The run's session is the app's open handle, so
 * `id` is the target session.
 * @param {object} record schedule delivery record.
 * @returns {object} run row.
 */
function runOf(record) {
  const at = epoch(record?.deliveredAt) ?? epoch(record?.scheduledAt) ?? 0
  return {
    id: String(record?.targetSessionId ?? ''),
    source: 'session',
    started_at: at,
    ended_at: at,
    is_active: false,
  }
}

/**
 * One page of deliveries as the app's run list (newest first).
 *
 * This is the newest page only: the app asks for one page and offers no next
 * page, so `total` is this page's record count and `offset` is always 0.
 * @param {object} result schedule/history result.
 * @returns {object} `{runs, total, offset}`.
 */
export function runsOf(result) {
  const records = Array.isArray(result?.records) ? [...result.records] : []
  records.sort((left, right) => (epoch(right?.deliveredAt) ?? 0) - (epoch(left?.deliveredAt) ?? 0))
  const runs = records.filter(record => String(record?.targetSessionId ?? '').length > 0).map(runOf)
  return { runs, total: runs.length, offset: 0 }
}

/**
 * The delivery destinations a DSH schedule supports: only a local session.
 * @returns {object} delivery targets.
 */
export function deliveryTargetsOf() {
  return { targets: [{ id: 'local', name: 'Local (save only)', home_target_set: true, home_env_var: null }] }
}
