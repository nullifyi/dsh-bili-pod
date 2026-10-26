import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
for(const scenario of ['retry','timeout','rotation','cross-host'])test('native scheduler integration: '+scenario,()=>{const r=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/scheduler-sync.mjs',import.meta.url)),scenario],{encoding:'utf8',windowsHide:true,timeout:12000});assert.equal(r.status,0,r.stdout+r.stderr)})
