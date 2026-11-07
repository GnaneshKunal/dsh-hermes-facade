/**
 * Tasks/cron mapping: DSH schedules → the Hermes host's /api/cron shapes.
 *
 * DSH's scheduler owns the durable record (title, prompt, timing, target,
 * status, delivery history) and has no price/cost or per-run file. Hermex's
 * Tasks screens read the host's cron contract, so this module translates:
 * a schedule entry becomes a job row, one delivery becomes a run (its session
 * is the handle the app reads the output from), and the editor's schedule text
 * is parsed into a DSH timing.
 *
 * @module dsh-hermes-facade/src/cron
 */

/** The host's time zone, used for daily/cron schedules that name none. */
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/** Weekday names → the DSH weekly index (0 = Sunday). */
const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
}

/**
 * Validate and pad an HH:MM clock.
 * @param {string} hour hour text.
 * @param {string} minute minute text.
 * @returns {string} HH:MM.
 */
function clock(hour, minute) {
  const h = Number.parseInt(hour, 10)
  const m = Number.parseInt(minute, 10)
  if (h > 23 || m > 59) throw new CronRefusal(400, 'schedule time is invalid')
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
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
 * Parse the editor's schedule text into a DSH ScheduleTiming.
 *
 * Accepted: `every 5m` (s/m/h/d), `daily at 09:00`, an ISO timestamp, an
 * RRULE, or a 5/6-field cron expression.
 * @param {string} text schedule text.
 * @returns {object} ScheduleTiming.
 */
export function parseTiming(text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) throw new CronRefusal(400, 'schedule is required')
  const every = /^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i.exec(raw)
  if (every !== null) {
    const unit = String(every[2] ?? 'm').toLowerCase()
    const count = Number.parseInt(every[1], 10)
    const seconds = count * (unit.startsWith('s') ? 1 : unit.startsWith('m') ? 60 : unit.startsWith('h') ? 3600 : 86400)
    if (!Number.isSafeInteger(seconds) || seconds < 1) throw new CronRefusal(400, 'schedule is too short')
    return { kind: 'every', every_seconds: seconds }
  }
  if (/^hourly$/i.test(raw)) return { kind: 'every', every_seconds: 3600 }
  const weekdays = /^weekdays(?:\s+at)?\s+(\d{1,2}):(\d{1,2})$/i.exec(raw)
  if (weekdays !== null) {
    return { kind: 'weekly', weekly: { time: clock(weekdays[1], weekdays[2]), time_zone: TIME_ZONE, weekdays: [1, 2, 3, 4, 5] } }
  }
  const weekly = /^weekly(?:\s+on)?\s+([a-z]+)(?:\s+at\s+(\d{1,2}):(\d{1,2}))?$/i.exec(raw)
  if (weekly !== null) {
    const day = WEEKDAYS[weekly[1].toLowerCase()]
    if (day === undefined) throw new CronRefusal(400, 'schedule weekday is unknown')
    const time = weekly[2] === undefined ? '09:00' : clock(weekly[2], weekly[3])
    return { kind: 'weekly', weekly: { time, time_zone: TIME_ZONE, weekdays: [day] } }
  }
  const daily = /^daily(?:\s+at)?\s+(\d{1,2}):(\d{1,2})$/i.exec(raw)
  if (daily !== null) {
    const hour = Number.parseInt(daily[1], 10)
    const minute = Number.parseInt(daily[2], 10)
    if (hour > 23 || minute > 59) throw new CronRefusal(400, 'schedule time is invalid')
    return { kind: 'daily', daily: { time: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'), time_zone: TIME_ZONE } }
  }
  if (/^RRULE:/i.test(raw) || /^FREQ=/i.test(raw)) return { kind: 'rrule', rrule: raw }
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && Number.isFinite(Date.parse(raw))) return { kind: 'at', at: raw }
  const fields = raw.split(/\s+/)
  if ((fields.length === 5 || fields.length === 6)
    && fields.every(field => /^[0-9A-Za-z*/,?\-]+$/.test(field))) {
    return { kind: 'cron', cron: { expression: raw, time_zone: TIME_ZONE } }
  }
  throw new CronRefusal(400, 'schedule must be a cron expression, "every 5m", "daily at 09:00" or an ISO time')
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
    case 'daily': return { kind: 'daily' }
    case 'weekly': return { kind: 'weekly' }
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
    case 'daily': return 'Daily at ' + entry.time + ' (' + entry.timeZone + ')'
    case 'weekly': return 'Weekly at ' + entry.time + ' on ' + (entry.weekdays ?? []).join(', ')
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
    next_run_at: entry?.scheduledAt,
    ...(last === undefined || last === null ? {} : { last_run_at: last.deliveredAt }),
    // The app reads fire_claim.at as when the run started; the delivery receipt
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
 * @param {object} result schedule/history result.
 * @returns {object} `{runs, total, offset}`.
 */
export function runsOf(result) {
  const records = Array.isArray(result?.records) ? [...result.records] : []
  records.sort((left, right) => (epoch(right?.deliveredAt) ?? 0) - (epoch(left?.deliveredAt) ?? 0))
  return {
    runs: records.filter(record => String(record?.targetSessionId ?? '').length > 0).map(runOf),
    total: records.length,
    offset: 0,
  }
}

/**
 * The delivery destinations a DSH schedule supports: only a local session.
 * @returns {object} delivery targets.
 */
export function deliveryTargetsOf() {
  return { targets: [{ id: 'local', name: 'Local (save only)', home_target_set: true, home_env_var: null }] }
}
