#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'
import { DSH_HOME, HOME, workDir } from '../lib/paths.mjs'
import { personaPaths, readPersonaDocument, writePersonaDocument, validatePersona } from '../../lib/persona.mjs'

const args = process.argv.slice(2)
const sub = args[0] ?? 'info'
const paths = personaPaths({ dshHome: DSH_HOME, home: HOME, workDir })
try {
  if (sub === 'show') {
    const document = readPersonaDocument(paths)
    if (!document.exists) throw new Error(`人设源文件不存在：${paths.file}；未改读旧路径。`)
    process.stdout.write(document.text)
  } else if (sub === 'info') {
    const { text, ...info } = readPersonaDocument(paths)
    console.log(JSON.stringify({ ok: true, ...info, instructionsPath: paths.instructionsFile, loadMode: config().persona.loadMode, editPath: paths.file }, null, 2))
  } else if (sub === 'save' || sub === 'import-legacy') {
    let text
    if (sub === 'import-legacy') {
      if (fs.existsSync(paths.file)) throw new Error(`当前源文件已存在，未覆盖：${paths.file}`)
      text = fs.readFileSync(paths.legacyFile, 'utf8').replace(/^\uFEFF/, '')
    } else {
      const i = args.indexOf('--file')
      if (i < 0 || !args[i + 1]) throw new Error('用法：persona save --file <修改后的完整人设文件>')
      text = fs.readFileSync(path.resolve(args[i + 1]), 'utf8').replace(/^\uFEFF/, '')
    }
    validatePersona(text)
    if (!text.trim()) throw new Error('完整修改稿为空，未覆盖现有人设。需要清空时请在设置页操作。')
    const { text: savedText, ...info } = writePersonaDocument(text, { config: config(), paths })
    console.log(JSON.stringify({ ok: true, ...info, instructionsPath: paths.instructionsFile }, null, 2))
  } else throw new Error('用法：persona info | show | save --file <完整修改稿> | import-legacy')
} catch (error) {
  console.error(`✗ ${error.message}`)
  process.exitCode = 1
}
