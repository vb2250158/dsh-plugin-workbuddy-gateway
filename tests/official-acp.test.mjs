/** Real offline child-process fixtures for the official ACP protocol and ownership lifecycle. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { OfficialAcpClient, officialAcpArgv } from '../src/official-acp.js'

// Runs only a local NDJSON peer. No network, credential file or model is read.
const peer = String.raw`
const readline = require('node:readline');
const mode = process.argv[1];
let session = 'fixture-session', promptId;
function send(value) { const text=JSON.stringify({jsonrpc:'2.0',...value})+'\n'; process.stdout.write(text.slice(0,7));process.stdout.write(text.slice(7)); }
function chunk(text) { send({method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}}); }
const input=readline.createInterface({input:process.stdin});
input.on('line', line=> {
 const m=JSON.parse(line);
 if(m.method==='initialize') {
   if(mode==='malformed') {process.stdout.write('not-json\n');return;}
   if(mode==='stderr-overflow') {process.stderr.write('x'.repeat(7000));return;}
   send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 } else if(m.method==='session/new') {
   if(mode==='auth') {send({id:m.id,error:{code:-32000,message:'Authentication required'}});return;}
   send({id:m.id,result:{sessionId:session}});
 } else if(m.method==='session/load') {
   session=m.params.sessionId;chunk('OLD HISTORY MUST NOT LEAK');send({id:m.id,result:{}});
 } else if(m.method==='session/prompt') {
   promptId=m.id;
   if(mode==='permission') {send({id:'approval-1',method:'session/request_permission',params:{sessionId:session,options:[{optionId:'allow',kind:'allow_once'},{optionId:'deny',kind:'reject_once'}]}});return;}
   if(mode==='cancel') {chunk('partial reply');return;}
   if(mode==='timeout') return;
   if(mode==='fs') {send({id:'fs-1',method:'fs/read_text_file',params:{path:'/not-readable'}});return;}
   chunk(mode==='output-overflow'?'x'.repeat(1000):'本轮回复');send({id:m.id,result:{stopReason:mode==='incomplete'?'max_tokens':'end_turn'}});
 } else if(m.method==='session/cancel') {
   if(mode==='cancel') send({id:promptId,result:{stopReason:'cancelled'}});
 } else if(m.id==='approval-1') {
   if(m.result?.outcome?.optionId!=='deny') process.exitCode=9;
   chunk('permission denied');send({id:promptId,result:{stopReason:'end_turn'}});
 } else if(m.id==='fs-1') {
   if(m.error?.code!==-32601) process.exitCode=8;
   chunk('filesystem unavailable');send({id:promptId,result:{stopReason:'end_turn'}});
 }
});
input.on('close',()=> { if(mode==='exit-error') process.exitCode=7; });
`

function fixture(mode='normal', extra={}) {
  const facts={spawned:0,terminated:0,confirmed:false,allowExit:true,child:undefined,spec:undefined}
  const client=new OfficialAcpClient({
    spawn(spec) {
      facts.spawned++;facts.spec=spec
      const child=spawn(process.execPath,['-e',peer,mode],{stdio:['pipe','pipe','pipe'],windowsHide:true})
      facts.child=child
      const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}))})
      return {pid:child.pid,stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,done,
        terminate(){facts.terminated++;throw Error('termination forbidden')},
        async waitForExit(){await done;if(!facts.allowExit)return false;facts.confirmed=true;return true}}
    },
    argv:['fixture-node','fixture-acp'],cwd:process.cwd(),timeoutMs:4000,shutdownMs:1000,...extra,
  })
  return {client,facts}
}

test('restricted argv advertises only read tools and no settings or MCP configuration',()=>{
  assert.deepEqual(officialAcpArgv({nodePath:'node',cliPath:'cli',model:'selected'}),
    ['node','cli','--acp','--setting-sources','','--permission-mode','dontAsk','--tools','Read,Glob,Grep','--strict-mcp-config','--model','selected'])
})

test('new session persists mapping before prompt; chunks and managed exit are confirmed',async()=>{
  const {client,facts}=fixture();let persisted=false;const chunks=[]
  const result=await client.run({prompt:'local fixture',onSession:async id=>{assert.equal(id,'fixture-session');persisted=true},onChunk:text=>{assert(persisted);chunks.push(text)}})
  assert.equal(result.text,'本轮回复');assert.equal(result.stopReason,'end_turn');assert.equal(result.cleanExit,true)
  assert.deepEqual(chunks,['本轮回复']);assert(facts.confirmed);assert.equal(facts.terminated,0);assert.equal(facts.spec.signal,undefined)
  assert.deepEqual(facts.spec.env,{});assert.equal(client.snapshot().state,'idle')
})

test('load reuses exact official session and excludes historical replay from current reply',async()=>{
  const {client}=fixture();const result=await client.run({prompt:'next',sessionId:'previous-session'})
  assert.equal(result.sessionId,'previous-session');assert.equal(result.text,'本轮回复')
})

test('persistence failure sends no model prompt and closes normally',async()=>{
  const {client,facts}=fixture()
  await assert.rejects(client.run({prompt:'no request',onSession:()=>{throw Error('storage failed')}}),e=>e.code==='SESSION_PERSISTENCE_FAILED'&&e.cleanup==='clean')
  assert(facts.confirmed);assert.equal(facts.terminated,0)
})

test('normal cancellation uses session/cancel and waits for the managed range',async()=>{
  const {client,facts}=fixture('cancel')
  const run=client.run({prompt:'wait',onSession:()=>{setImmediate(()=>client.cancel())}})
  await assert.rejects(run,e=>e.code==='CANCELLED'&&e.cleanup==='clean'&&e.confirmedCancelled===true)
  assert(facts.confirmed);assert.equal(facts.terminated,0)
})

for(const [mode,code]of [['auth','AUTH_REQUIRED'],['malformed','PROTOCOL_ERROR'],['stderr-overflow','PROTOCOL_LIMIT'],['output-overflow','OUTPUT_LIMIT'],['incomplete','INCOMPLETE'],['exit-error','PROCESS_EXITED'],['timeout','TIMEOUT']]) {
  test(mode+' is an explicit failure with normal EOF cleanup',async()=>{
    const {client,facts}=fixture(mode,{maxProtocolBytes:5000,maxOutputBytes:100,timeoutMs:mode==='timeout'?100:4000})
    await assert.rejects(client.run({prompt:'bounded'}),e=>e.code===code&&e.cleanup==='clean')
    assert(facts.confirmed);assert.equal(facts.terminated,0)
  })
}

for(const mode of ['permission','fs']) test(mode+' requests are rejected rather than executed',async()=>{
  const {client,facts}=fixture(mode);const result=await client.run({prompt:'read restrictions'})
  assert.match(result.text,/denied|unavailable/);assert.equal(result.exit.exitCode,0);assert.equal(facts.terminated,0)
})

test('unknown managed range retains ownership and refuses replacement until reconciled',async()=>{
  const {client,facts}=fixture();facts.allowExit=false
  await assert.rejects(client.run({prompt:'ownership'}),e=>e.cleanup==='unknown')
  assert.equal(client.snapshot().retainedHandle,true);assert.equal(client.snapshot().state,'unknown')
  await assert.rejects(client.run({prompt:'must not duplicate'}),e=>e.code==='EXIT_UNKNOWN')
  assert.equal(facts.spawned,1);facts.allowExit=true
  assert.equal(await client.reconcileExit(),true);assert.equal(client.snapshot().state,'idle')
  assert.equal(facts.terminated,0)
})

test('concurrent runs and injected credentials are refused before another spawn',async()=>{
  assert.throws(()=>fixture('normal',{env:{CODEBUDDY_AUTH_TOKEN:'not-a-real-token'}}),/injected credentials/)
  const {client,facts}=fixture('cancel')
  const started=client.run({prompt:'wait',onSession:()=>setImmediate(()=>client.cancel())})
  await assert.rejects(client.run({prompt:'duplicate'}),e=>e.code==='BUSY')
  await assert.rejects(started,e=>e.code==='CANCELLED');assert.equal(facts.spawned,1)
})

test('confirmed cancellation retains the already delivered partial assistant text',async()=>{
  const {client,facts}=fixture('cancel')
  await assert.rejects(client.run({prompt:'partial',onChunk:()=>client.cancel()}),
    e=>e.code==='CANCELLED'&&e.confirmedCancelled===true&&e.partialText==='partial reply')
  assert(facts.confirmed);assert.equal(facts.terminated,0)
})

test('an AbortSignal requests protocol cancellation without a spawn termination signal',async()=>{
  const {client,facts}=fixture('cancel');const controller=new AbortController()
  await assert.rejects(client.run({prompt:'signal',signal:controller.signal,onChunk:()=>controller.abort()}),
    e=>e.code==='CANCELLED'&&e.confirmedCancelled===true&&e.cleanup==='clean')
  assert.equal(facts.spec.signal,undefined);assert.equal(facts.terminated,0)
})
