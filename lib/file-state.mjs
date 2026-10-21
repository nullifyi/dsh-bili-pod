// Small synchronous transactions for local JSON state shared by CLI children.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function withFileLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lock = file + '.lock'
  const until = Date.now() + 5000
  let fd
  while (fd === undefined) {
    try { fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)) }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      // Do not reap a dead PID here: the owner may have released and a new
      // process acquired the same path between the read and unlink. A stale
      // lock fails closed and requires an operator to check it after a crash.
      if (Date.now() >= until) throw new Error(`State lock timeout: ${file}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  try { return fn() } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e }
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(tmp, file) }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
}
