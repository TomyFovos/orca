import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { getProcessedDatabaseInfo, scanOpenCodeUsageDatabases } from './scanner'

const WORKTREE = '/workspace/repo'

function readSqliteChangeCounter(path: string): number {
  return readFileSync(path).readUInt32BE(24)
}

function readFileTimes(path: string): { mtimeMs: number; ctimeMs: number } {
  const fileStat = statSync(path)
  return { mtimeMs: fileStat.mtimeMs, ctimeMs: fileStat.ctimeMs }
}

function createSessionTotalsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT,
      title TEXT,
      model TEXT,
      cost REAL,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_reasoning INTEGER,
      tokens_cache_read INTEGER,
      time_created INTEGER,
      time_updated INTEGER
    );
  `)
}

function insertSessionTotalsRow(
  db: Database.Database,
  sessionId: string,
  inputTokens: number
): void {
  db.prepare(
    `INSERT INTO session (
      id, directory, title, model, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
      time_created, time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    `${WORKTREE}/packages/app`,
    'Session',
    JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-5' }),
    0.01,
    inputTokens,
    100,
    0,
    0,
    1_777_777_700_000,
    1_777_777_800_000
  )
}

describe('scanner determinism measurements', () => {
  let dataRoot: string
  let openCodeDir: string
  let previousXdgDataHome: string | undefined
  let previousOpenCodeDb: string | undefined

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'orca-opencode-usage-repro-'))
    openCodeDir = join(dataRoot, 'opencode')
    mkdirSync(openCodeDir, { recursive: true })
    previousXdgDataHome = process.env.XDG_DATA_HOME
    previousOpenCodeDb = process.env.OPENCODE_DB
    process.env.XDG_DATA_HOME = dataRoot
    delete process.env.OPENCODE_DB
  })

  afterEach(() => {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome
    }
    if (previousOpenCodeDb === undefined) {
      delete process.env.OPENCODE_DB
    } else {
      process.env.OPENCODE_DB = previousOpenCodeDb
    }
    rmSync(dataRoot, { recursive: true, force: true })
  })

  function writeSessionTotalsDb(fileName: string, rows: [string, number][]): string {
    const path = join(openCodeDir, fileName)
    const db = new Database(path)
    createSessionTotalsSchema(db)
    for (const [sessionId, inputTokens] of rows) {
      insertSessionTotalsRow(db, sessionId, inputTokens)
    }
    db.close()
    return path
  }

  it('records metadata collisions and the resulting cached total', async () => {
    const canonicalPath = writeSessionTotalsDb('opencode.db', [['session-1', 1000]])
    writeSessionTotalsDb('opencode-backup.db', [['session-1', 400]])

    let previous = await scanOpenCodeUsageDatabases([], [])
    let sameMetadataCount = 0
    let staleTotalCount = 0
    const observations: {
      iteration: number
      before: object
      after: object
      beforeTimes: object
      afterTimes: object
      beforeChangeCounter: number
      afterChangeCounter: number
      total: number
    }[] = []

    for (let iteration = 1; iteration <= 200; iteration += 1) {
      const beforeChangeCounter = readSqliteChangeCounter(canonicalPath)
      const beforeTimes = readFileTimes(canonicalPath)
      const db = new Database(canonicalPath)
      insertSessionTotalsRow(db, `session-${iteration + 1}`, 200)
      db.close()

      const previousCanonical = previous.processedDatabases.find((database) =>
        database.path.endsWith('opencode.db')
      )
      const after = await getProcessedDatabaseInfo(canonicalPath)
      const afterTimes = readFileTimes(canonicalPath)
      const afterChangeCounter = readSqliteChangeCounter(canonicalPath)
      const sameMetadata =
        previousCanonical?.mtimeMs === after.mtimeMs && previousCanonical.size === after.size
      const result = await scanOpenCodeUsageDatabases([], previous.processedDatabases)
      const total = result.dailyAggregates.reduce(
        (sum, aggregate) => sum + aggregate.inputTokens,
        0
      )
      const expected = 1000 + iteration * 200
      if (sameMetadata) {
        sameMetadataCount += 1
        if (total !== expected) {
          staleTotalCount += 1
          observations.push({
            iteration,
            before: { mtimeMs: previousCanonical?.mtimeMs, size: previousCanonical?.size },
            after,
            beforeTimes,
            afterTimes,
            beforeChangeCounter,
            afterChangeCounter,
            total
          })
        }
      }
      previous = result
    }

    console.log(
      JSON.stringify({
        sameMetadataCount,
        staleTotalCount,
        firstStaleObservation: observations[0] ?? null
      })
    )
  })

  it('records the live WAL case while the writer remains open', async () => {
    const canonicalPath = join(openCodeDir, 'opencode.db')
    const writer = new Database(canonicalPath)
    createSessionTotalsSchema(writer)
    writer.pragma('journal_mode = WAL')
    insertSessionTotalsRow(writer, 'session-1', 1000)

    try {
      const first = await scanOpenCodeUsageDatabases([], [])
      const firstCanonical = first.processedDatabases.find((database) =>
        database.path.endsWith('opencode.db')
      )
      insertSessionTotalsRow(writer, 'session-2', 200)
      const second = await scanOpenCodeUsageDatabases([], first.processedDatabases)
      const total = second.dailyAggregates.reduce(
        (sum, aggregate) => sum + aggregate.inputTokens,
        0
      )
      console.log(
        JSON.stringify({
          firstTotal: first.dailyAggregates.reduce(
            (sum, aggregate) => sum + aggregate.inputTokens,
            0
          ),
          secondTotal: total,
          previousChangeCounter: firstCanonical?.databaseChangeCounter,
          currentChangeCounter: second.processedDatabases.find((database) =>
            database.path.endsWith('opencode.db')
          )?.databaseChangeCounter
        })
      )
    } finally {
      writer.close()
    }
  })
})
