import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'

let logFilePath = ''

const MAX_LOG_SIZE = 3 * 1024 * 1024
const TAIL_SIZE = 1 * 1024 * 1024

function rotateLog(): void {
  try {
    const stats = statSync(logFilePath)
    if (stats.size <= MAX_LOG_SIZE) return
    const content = readFileSync(logFilePath)
    const tail = content.subarray(content.length - TAIL_SIZE)
    writeFileSync(logFilePath + '.bak', tail)
    renameSync(logFilePath + '.bak', logFilePath)
  } catch {}
}

function writeLog(level: string, message: string): void {
  if (!logFilePath) return
  try {
    const dir = dirname(logFilePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    rotateLog()
    appendFileSync(logFilePath, `[${new Date().toISOString()}] [${level}] ${message}\n`)
  } catch {}
}

export function setLogFilePath(path: string): void {
  logFilePath = path
}

export const logger = {
  info: (message: string) => writeLog('INFO', message),
  error: (message: string) => writeLog('ERROR', message),
  warn: (message: string) => writeLog('WARN', message),
}
