import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { getProcessedDatabaseInfo, scanOpenCodeUsageDatabases } from './scanner'

const WORKTREE = '/workspace/repo'

function readSqliteChangeCounter(path: string): number {
  return readFileSync(path).readUInt32BE(24)
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

describe('scanner cache invalidation', () => {
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

  it('detects an in-place update when mtime and size are unchanged', async () => {
    const canonicalPath = writeSessionTotalsDb('opencode.db', [['session-1', 1000]])
    const fixedTime = new Date('2025-01-01T00:00:00.000Z')
    utimesSync(canonicalPath, fixedTime, fixedTime)

    const first = await scanOpenCodeUsageDatabases([], [])
    const firstCanonical = first.processedDatabases.find((database) =>
      database.path.endsWith('opencode.db')
    )
    expect(firstCanonical).toBeDefined()

    const db = new Database(canonicalPath)
    insertSessionTotalsRow(db, 'session-2', 200)
    db.close()
    utimesSync(canonicalPath, fixedTime, fixedTime)

    const current = await getProcessedDatabaseInfo(canonicalPath)
    expect(current.mtimeMs).toBe(firstCanonical?.mtimeMs)
    expect(current.size).toBe(firstCanonical?.size)
    expect(readSqliteChangeCounter(canonicalPath)).not.toBe(firstCanonical?.databaseChangeCounter)

    const second = await scanOpenCodeUsageDatabases([], first.processedDatabases)
    expect(second.dailyAggregates.reduce((sum, aggregate) => sum + aggregate.inputTokens, 0)).toBe(
      1200
    )
  })

  it('rescans while a live WAL contains uncheckpointed rows', async () => {
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
      expect(firstCanonical?.hasWalJournal).toBe(true)
      insertSessionTotalsRow(writer, 'session-2', 200)
      const second = await scanOpenCodeUsageDatabases([], first.processedDatabases)
      expect(
        second.dailyAggregates.reduce((sum, aggregate) => sum + aggregate.inputTokens, 0)
      ).toBe(1200)
      expect(
        second.processedDatabases.find((database) => database.path.endsWith('opencode.db'))
          ?.hasWalJournal
      ).toBe(true)
    } finally {
      writer.close()
    }
  })
})
