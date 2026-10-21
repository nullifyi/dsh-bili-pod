import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {withFileLock} from '../lib/file-state.mjs'

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pod-file-lock-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  return path.join(dir,'state.json')
}
test('Windows transient EPERM during exclusive lock open retries without running transaction twice',{skip:process.platform!=='win32'},t=>{
  const file=fixture(t),original=fs.openSync;let attempts=0,calls=0
  fs.openSync=function(p,...args){if(p===file+'.lock' && ++attempts<=2)throw Object.assign(Error('delete-pending transient'),{code:'EPERM'});return original.call(this,p,...args)}
  try {assert.equal(withFileLock(file,()=>{calls++;return 'committed'}),'committed')}
  finally{fs.openSync=original}
  assert.equal(attempts,3);assert.equal(calls,1);assert.equal(fs.existsSync(file+'.lock'),false)
})
test('permanent Windows EPERM fails closed by the existing five-second bound and preserves original error',{skip:process.platform!=='win32'},t=>{
  const file=fixture(t),original=fs.openSync,now=Date.now,error=Object.assign(Error('permission permanently denied'),{code:'EPERM'});let attempts=0,calls=0,elapsed=0
  fs.openSync=function(p,...args){if(p===file+'.lock'){attempts++;throw error}return original.call(this,p,...args)}
  Date.now=()=>{elapsed+=1000;return elapsed}
  try{assert.throws(()=>withFileLock(file,()=>calls++),e=>e===error)}finally{fs.openSync=original;Date.now=now}
  assert.equal(attempts,5);assert.equal(calls,0)
})
test('non-contention permission failures are not retried or masked',t=>{
  const file=fixture(t),original=fs.openSync,error=Object.assign(Error('access denied'),{code:'EACCES'});let attempts=0,calls=0
  fs.openSync=function(p,...args){if(p===file+'.lock'){attempts++;throw error}return original.call(this,p,...args)}
  try{assert.throws(()=>withFileLock(file,()=>calls++),e=>e===error)}finally{fs.openSync=original}
  assert.equal(attempts,1);assert.equal(calls,0)
})
test('PID write error after acquiring a lock is not retried and releases the owned lock',t=>{
  const file=fixture(t),original=fs.writeFileSync,error=Object.assign(Error('PID write denied'),{code:'EPERM'});let writes=0,calls=0
  fs.writeFileSync=function(p,...args){if(typeof p==='number'){writes++;throw error}return original.call(this,p,...args)}
  try{assert.throws(()=>withFileLock(file,()=>calls++),e=>e===error)}finally{fs.writeFileSync=original}
  assert.equal(writes,1);assert.equal(calls,0);assert.equal(fs.existsSync(file+'.lock'),false)
})
