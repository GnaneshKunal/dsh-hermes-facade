import assert from 'node:assert/strict'
import test from 'node:test'

import { deliveryTargetsOf, jobOf, parseTiming, runsOf, scheduleDisplayOf, scheduleObjectOf } from '../src/cron.mjs'

test('schedule text parses into DSH-valid timings', () => {
  assert.deepEqual(parseTiming('every 5m'), { kind: 'every', every_seconds: 300 })
  assert.equal(parseTiming('every 2h').every_seconds, 7200)
  assert.equal(parseTiming('every 1d').every_seconds, 86400)
  assert.equal(parseTiming('hourly').every_seconds, 3600)
  assert.throws(() => parseTiming('every 30s'), /at least every 60 seconds/)

  // DSH's daily/weekly time is HH:mm:ss, not the editor's HH:mm.
  const daily = parseTiming('daily at 9:5')
  assert.equal(daily.kind, 'daily')
  assert.equal(daily.daily.time, '09:05:00')
  const weekdays = parseTiming('weekdays at 9:30')
  assert.deepEqual(weekdays.weekly.weekdays, [1, 2, 3, 4, 5])
  assert.equal(weekdays.weekly.time, '09:30:00')
  const monday = parseTiming('weekly on monday at 9:30')
  assert.deepEqual(monday.weekly.weekdays, [1])
  // DSH's ISO weekday is Monday=1 … Sunday=7.
  assert.deepEqual(parseTiming('weekly on sunday at 9:30').weekly.weekdays, [7])

  const cron = parseTiming('0 9 * * *')
  assert.equal(cron.kind, 'cron')
  assert.equal(cron.cron.expression, '0 9 * * *')
  assert.equal(parseTiming('0 9 * * 1-5').kind, 'cron')
  assert.throws(() => parseTiming('0 30 9 * * *'), /five fields/)
  assert.throws(() => parseTiming('61 9 * * *'), /out of range/)
  assert.throws(() => parseTiming('0 25 * * *'), /out of range/)

  // `at` needs an explicit offset and a future instant.
  assert.equal(parseTiming('2030-01-02T03:04:05Z').kind, 'at')
  assert.throws(() => parseTiming('2030-01-02T03:04:05'), /explicit Z or numeric offset/)
  assert.throws(() => parseTiming('2020-01-02T03:04:05Z'), /must be in the future/)

  // DSH's RRULE is exactly DTSTART + RRULE, not a lone RRULE line.
  assert.throws(() => parseTiming('RRULE:FREQ=DAILY;COUNT=2'), /DTSTART line/)
  const rrule = parseTiming('DTSTART:20261107T000000Z\nRRULE:FREQ=DAILY;COUNT=2')
  assert.equal(rrule.kind, 'rrule')
  assert.match(rrule.rrule, /^DTSTART:/)

  assert.throws(() => parseTiming('whenever'), /schedule must be/)
  assert.throws(() => parseTiming(''), /schedule is required/)
})

test('a schedule entry maps to a job row', () => {
  const entry = {
    id: 's1',
    kind: 'every',
    everySeconds: 300,
    title: 'Report',
    prompt: 'write it',
    scheduledAt: '2030-01-01T00:00:00.000Z',
    status: 'active',
    target: { kind: 'new' },
    lastDelivery: {
      scheduledAt: '2030-01-01T00:00:00.000Z',
      deliveredAt: '2030-01-01T00:05:00.000Z',
      messageId: 'm1',
      targetSessionId: 'sess-x',
    },
  }
  const job = jobOf(entry)
  assert.equal(job.id, 's1')
  assert.equal(job.job_id, 's1')
  assert.equal(job.name, 'Report')
  assert.equal(job.schedule.kind, 'every')
  assert.equal(job.schedule.every, '5m')
  assert.equal(job.schedule_display, 'Every 5m')
  assert.equal(job.enabled, true)
  assert.equal(job.state, 'active')
  assert.equal(job.next_run_at, '2030-01-01T00:00:00.000Z')
  assert.equal(job.last_run_at, '2030-01-01T00:05:00.000Z')
  assert.equal(job.last_status, undefined)
  assert.deepEqual(job.skills, [])
  assert.equal(job.deliver, 'local')

  // A paused task's scheduledAt is its final, often past occurrence: no next run.
  const paused = jobOf({ ...entry, status: 'paused' })
  assert.equal(paused.enabled, false)
  assert.equal(paused.state, 'paused')
  assert.equal(job.next_run_at === undefined, false)
  assert.equal(paused.next_run_at, undefined)
})

test('daily and weekly rows keep their time/zone/weekdays', () => {
  const daily = { kind: 'daily', time: '09:05:30.500', timeZone: 'Asia/Kolkata' }
  assert.equal(scheduleDisplayOf(daily), 'Daily at 09:05 (Asia/Kolkata)')
  assert.deepEqual(scheduleObjectOf(daily), { kind: 'daily', time: '09:05', time_zone: 'Asia/Kolkata' })
  const weekly = { kind: 'weekly', time: '09:30:00.000', timeZone: 'UTC', weekdays: [1, 7] }
  assert.equal(scheduleDisplayOf(weekly), 'Weekly at 09:30 on Monday, Sunday')
  assert.deepEqual(scheduleObjectOf(weekly), { kind: 'weekly', time: '09:30', time_zone: 'UTC', weekdays: [1, 7] })
})

test('deliveries map to newest-first runs on their sessions', () => {
  const result = {
    records: [
      { scheduledAt: '2030-01-01T00:00:00Z', deliveredAt: '2030-01-01T00:00:00Z', messageId: 'a', targetSessionId: 'sess-a' },
      { scheduledAt: '2030-01-01T00:10:00Z', deliveredAt: '2030-01-01T00:10:00Z', messageId: 'b', targetSessionId: 'sess-b' },
      { scheduledAt: '2030-01-01T00:20:00Z', deliveredAt: '2030-01-01T00:20:00Z', messageId: 'c' },
    ],
  }
  const page = runsOf(result)
  assert.deepEqual(page.runs.map(run => run.id), ['sess-b', 'sess-a'])
  assert.equal(page.total, 2)
  assert.equal(page.offset, 0)
  assert.equal(page.runs[0].started_at, Date.parse('2030-01-01T00:10:00Z') / 1000)
  assert.equal(page.runs[0].is_active, false)
})

test('delivery targets offer only local', () => {
  const targets = deliveryTargetsOf()
  assert.equal(targets.targets.length, 1)
  assert.equal(targets.targets[0].id, 'local')
})
