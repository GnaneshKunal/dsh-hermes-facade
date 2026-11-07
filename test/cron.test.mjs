import assert from 'node:assert/strict'
import test from 'node:test'

import { deliveryTargetsOf, jobOf, parseTiming, runsOf } from '../src/cron.mjs'

test('schedule text parses into DSH timings', () => {
  assert.deepEqual(parseTiming('every 5m'), { kind: 'every', every_seconds: 300 })
  assert.equal(parseTiming('every 2h').every_seconds, 7200)
  assert.equal(parseTiming('every 1d').every_seconds, 86400)
  const cron = parseTiming('0 9 * * *')
  assert.equal(cron.kind, 'cron')
  assert.equal(cron.cron.expression, '0 9 * * *')
  const daily = parseTiming('daily at 9:5')
  assert.equal(daily.kind, 'daily')
  assert.equal(daily.daily.time, '09:05')
  assert.equal(parseTiming('hourly').every_seconds, 3600)
  assert.deepEqual(parseTiming('weekdays at 9:30').weekly.weekdays, [1, 2, 3, 4, 5])
  assert.deepEqual(parseTiming('weekly on monday at 9:30').weekly.weekdays, [1])
  assert.equal(parseTiming('weekly on monday at 9:30').weekly.time, '09:30')
  assert.equal(parseTiming('2026-01-02T03:04:05Z').kind, 'at')
  assert.equal(parseTiming('RRULE:FREQ=DAILY;COUNT=2').kind, 'rrule')
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
    scheduledAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    target: { kind: 'new' },
    lastDelivery: {
      scheduledAt: '2026-01-01T00:00:00.000Z',
      deliveredAt: '2026-01-01T00:05:00.000Z',
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
  assert.equal(job.next_run_at, '2026-01-01T00:00:00.000Z')
  assert.equal(job.last_run_at, '2026-01-01T00:05:00.000Z')
  assert.equal(job.last_status, undefined)
  assert.deepEqual(job.skills, [])
  assert.equal(job.deliver, 'local')
  const paused = jobOf({ ...entry, status: 'paused' })
  assert.equal(paused.enabled, false)
  assert.equal(paused.state, 'paused')
})

test('deliveries map to newest-first runs on their sessions', () => {
  const result = {
    records: [
      { scheduledAt: '2026-01-01T00:00:00Z', deliveredAt: '2026-01-01T00:00:00Z', messageId: 'a', targetSessionId: 'sess-a' },
      { scheduledAt: '2026-01-01T00:10:00Z', deliveredAt: '2026-01-01T00:10:00Z', messageId: 'b', targetSessionId: 'sess-b' },
    ],
  }
  const page = runsOf(result)
  assert.deepEqual(page.runs.map(run => run.id), ['sess-b', 'sess-a'])
  assert.equal(page.total, 2)
  assert.equal(page.runs[0].started_at, Date.parse('2026-01-01T00:10:00Z') / 1000)
  assert.equal(page.runs[0].is_active, false)
})

test('delivery targets offer only local', () => {
  const targets = deliveryTargetsOf()
  assert.equal(targets.targets.length, 1)
  assert.equal(targets.targets[0].id, 'local')
})
