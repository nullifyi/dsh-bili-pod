// Shared contract for trusted local mod settings. No UI-specific coercion.
const KINDS = new Set(['text','textarea','number','list','switch','select','multiselect'])
const blocked = new Set(['__proto__','prototype','constructor'])
export const optionValue = o => String(typeof o === 'object' && o !== null ? o.value : o)
export function normalizeField(spec={}) {
  if(!Array.isArray(spec.path)||!spec.path.length||spec.path.some(k=>!String(k)||String(k).includes('.')||blocked.has(String(k))))throw Error('设置路径不合法')
  const kind=KINDS.has(spec.kind)?spec.kind:'text'
  const options=(Array.isArray(spec.options)?spec.options:[]).map(o=>typeof o==='object'&&o!==null?{value:String(o.value??''),label:String(o.label??o.value??'')}:String(o))
  if(spec.optionsRoute && !/^\/[^?#]*$/.test(spec.optionsRoute))throw Error('选项路由必须是模块内绝对路径')
  return {path:spec.path.map(String),label:String(spec.label??spec.path.join('.')),hint:String(spec.hint??''),kind,options,...Object.fromEntries(['min','max','step','default','placeholder','group','optionsRoute'].filter(k=>spec[k]!==undefined).map(k=>[k,spec[k]]))}
}
export function fieldValue(field,value) {
  if(value===undefined)return undefined
  const fail=()=>{throw Error(field.label+'：设置值不合法')}
  if(field.kind==='switch'){if(typeof value!=='boolean')fail();return value}
  if(field.kind==='number'){
    if((typeof value!=='string'&&typeof value!=='number')||String(value).trim()==='')fail()
    const n=Number(value),step=Number(field.step)
    if(!Number.isFinite(n)||(field.min!==undefined&&n<field.min)||(field.max!==undefined&&n>field.max))fail()
    if(step>0&&Math.abs((n-(Number(field.min)||0))/step-Math.round((n-(Number(field.min)||0))/step))>1e-8)fail()
    return n
  }
  if(field.kind==='list'||field.kind==='multiselect'){
    if(field.kind==='list'&&typeof value==='string')value=value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)
    if(!Array.isArray(value)||value.some(v=>typeof v!=='string'))fail()
    const list=[...new Set(value)]
    if(field.kind==='multiselect'&&list.some(v=>!field.options.map(optionValue).includes(v)))fail()
    return list
  }
  if(typeof value!=='string')fail()
  if(field.kind==='select'&&!field.optionsRoute&&!field.options.map(optionValue).includes(value))fail()
  return value
}
