/** Real local stream-json child fixtures; no CLI login, network or model is accessed. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { OfficialCliClient, officialCliArgv } from '../src/official-cli.js'

const peer = String.raw`
const readline=require('node:readline');
const mode=process.argv[1], sessionId=process.argv[2];
const send=m=>{const b=Buffer.from(JSON.stringify(m)+'\n');process.stdout.write(b.subarray(0,9));process.stdout.write(b.subarray(9));};
const assistant=text=>send({type:'assistant',session_id:sessionId,message:{role:'assistant',content:[{type:'text',text}]}});
const result=(extra={})=>send({type:'result',session_id:sessionId,subtype:'success',is_error:false,result:'本轮回复',...extra});
const control=(id,response)=>send({type:'control_response',response:{subtype:'success',request_id:id,response}});
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request'&&m.request.subtype==='initialize') {
  if(m.request.hasPrompt!==true)process.exitCode=8;
  if(mode==='malformed'){process.stdout.write('not-json\n');return;}
  if(mode==='stderr-limit'){process.stderr.write('x'.repeat(7000));return;}
  if(mode==='auth'){send({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'Authentication required'}});return;}
  if(mode==='replay')assistant('OLD REPLAY MUST NOT LEAK');
  control(m.request_id,{commands:[],models:[{id:'fixture-model'}],currentModelId:mode==='init-wrong-model'?'not-selected':mode==='init-missing-model'?undefined:'fixture-model',account:{token:'SECRET_MUST_NOT_LEAK',uid:'PRIVATE_USER'}});
 } else if(m.type==='user') {
  if(m.session_id!==sessionId||m.message?.role!=='user'||!Array.isArray(m.message.content)||m.parent_tool_use_id!==null)process.exitCode=9;
  send({type:'system',subtype:'init',session_id:sessionId,model:mode==='wrong-model'?'not-selected':'fixture-model'});
  if(mode==='timeout')return;
  if(mode==='permission'||mode==='unsupported-control'){
   send({type:'control_request',request_id:'perm_fixture',request:{subtype:mode==='permission'?'can_use_tool':'unavailable_capability',tool_name:'Write',input:{}}});return;
  }
  assistant(mode==='output-limit'?'x'.repeat(1000):'本轮回复');
  if(mode==='cancel'||mode==='cancel-wrong')return;
  if(mode==='wrong-session')result({session_id:'another-session'});
  else if(mode==='remote-error')result({subtype:'error_during_execution',is_error:true,result:undefined,errors:['private upstream detail']});
  else result();
 } else if(m.type==='control_request'&&m.request.subtype==='interrupt'){
  control(m.request_id,{session_id:mode==='cancel-wrong'?'not-owned':sessionId,interrupted:true});
  result({result:'',terminal_reason:'aborted_streaming'});
 } else if(m.type==='control_response'&&m.response.request_id==='perm_fixture'){
  if(mode==='permission'&&m.response.response?.allowed!==false)process.exitCode=11;
  if(mode==='unsupported-control'&&m.response.subtype!=='error')process.exitCode=12;
  assistant('本轮回复');result();
 }
});
input.on('close',()=>{if(mode==='exit-error')process.exitCode=7;});
`

function fixture(mode='normal',extra={}) {
 const facts={spawned:0,terminated:0,confirmed:false,allowExit:true,userFrames:0,frames:[],spec:undefined}
 const client=new OfficialCliClient({spawn(spec){
  facts.spawned++;facts.spec=spec
  const child=spawn(process.execPath,['-e',peer,mode,spec.argv.at(-1)],{stdio:['pipe','pipe','pipe'],windowsHide:true})
  const write=child.stdin.write.bind(child.stdin)
  child.stdin.write=(data,...args)=>{const m=JSON.parse(String(data));facts.frames.push(m);if(m.type==='user')facts.userFrames++;return write(data,...args)}
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}))})
  return {pid:child.pid,stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,done,
   terminate(){facts.terminated++;throw Error('termination forbidden')},
   async waitForExit(){await done;if(!facts.allowExit)return false;facts.confirmed=true;return true}}
 },argv:['fixture-node','fixture-cli','--model','fixture-model'],cwd:process.cwd(),timeoutMs:4000,shutdownMs:1000,...extra})
 return {client,facts}
}

test('official argv uses print stream-json, read-only tools and no configuration/MCP injection',()=>{
 assert.deepEqual(officialCliArgv({nodePath:'node',cliPath:'cli',model:'selected'}),
  ['node','cli','--print','--input-format','stream-json','--output-format','stream-json','--verbose',
   '--setting-sources','','--permission-mode','dontAsk','--tools','Read,Glob,Grep','--strict-mcp-config','--model','selected'])
})

test('new UUID is durable before user frame; output and managed EOF exit are verified',async()=>{
 const {client,facts}=fixture();let saved,chunk=''
 const value=await client.run({prompt:'fixture',onSession:async id=>{assert.equal(facts.userFrames,0);saved=id},onChunk:text=>{assert(saved);chunk+=text}})
 assert.match(saved,/^[a-f0-9-]{36}$/);assert.equal(value.sessionId,saved);assert.equal(value.text,'本轮回复');assert.equal(chunk,'本轮回复')
 assert.equal(value.model,'fixture-model');assert.equal(value.cleanExit,true);assert(facts.spec.argv.includes('--session-id'))
 assert(facts.confirmed);assert.equal(facts.terminated,0);assert.equal(facts.spec.signal,undefined);assert.deepEqual(facts.spec.env,{})
 assert.equal(JSON.stringify({value,snapshot:client.snapshot()}).includes('SECRET_MUST_NOT_LEAK'),false)
})

test('resume uses the exact persisted id and excludes old replay',async()=>{
 const {client,facts}=fixture('replay')
 const value=await client.run({prompt:'next turn',sessionId:'persisted-session'})
 assert.equal(facts.spec.argv.at(-2),'--resume');assert.equal(facts.spec.argv.at(-1),'persisted-session')
 assert.equal(value.text,'本轮回复');assert.equal(value.sessionId,'persisted-session')
})

test('failed session persistence sends no user frame and cleanly closes the child',async()=>{
 const {client,facts}=fixture()
 await assert.rejects(client.run({prompt:'must not send',onSession:()=>{throw Error('storage failure')}}),e=>e.code==='SESSION_PERSISTENCE_FAILED'&&e.cleanup==='clean')
 assert.equal(facts.userFrames,0);assert(facts.confirmed);assert.equal(facts.terminated,0)
})

test('interrupt control is acknowledged and aborted success result is classified cancelled',async()=>{
 const {client,facts}=fixture('cancel')
 await assert.rejects(client.run({prompt:'wait',onChunk:()=>client.cancel()}),e=>e.code==='CANCELLED'&&e.confirmedCancelled&&e.cleanup==='clean'&&e.partialText==='本轮回复')
 const interrupt=facts.frames.find(x=>x.request?.subtype==='interrupt')
 assert.equal(interrupt.request.session_id,facts.spec.argv.at(-1));assert(facts.confirmed);assert.equal(facts.terminated,0)
})

test('AbortSignal invokes protocol interrupt without a provider termination signal',async()=>{
 const {client,facts}=fixture('cancel');const controller=new AbortController()
 await assert.rejects(client.run({prompt:'wait',signal:controller.signal,onChunk:()=>controller.abort()}),e=>e.code==='CANCELLED'&&e.confirmedCancelled)
 assert.equal(facts.spec.signal,undefined);assert.equal(facts.terminated,0)
})

for(const [mode,code]of [['auth','AUTH_REQUIRED'],['malformed','PROTOCOL_ERROR'],['stderr-limit','PROTOCOL_LIMIT'],
 ['output-limit','OUTPUT_LIMIT'],['wrong-session','PROTOCOL_ERROR'],['wrong-model','MODEL_MISMATCH'],['remote-error','REMOTE_ERROR'],['exit-error','PROCESS_EXITED'],['timeout','TIMEOUT'],['cancel-wrong','PROTOCOL_ERROR']]) {
 test(mode+' fails explicitly with EOF and no process termination',async()=>{
  const {client,facts}=fixture(mode,{maxProtocolBytes:5000,maxOutputBytes:100,timeoutMs:mode==='timeout'?100:4000})
  await assert.rejects(client.run({prompt:'bounded',...(mode==='cancel-wrong'?{onChunk:()=>client.cancel()}:{})}),e=>e.code===code&&e.cleanup==='clean')
  assert(facts.confirmed);assert.equal(facts.terminated,0)
 })
}

for(const mode of ['permission','unsupported-control'])test(mode+' never grants an unowned capability',async()=>{
 const {client,facts}=fixture(mode);const value=await client.run({prompt:'restriction'})
 assert.equal(value.text,'本轮回复');assert.equal(value.exit.exitCode,0);assert.equal(facts.terminated,0)
})

test('unknown range retains its handle and rejects replacement until reconciled',async()=>{
 const {client,facts}=fixture();facts.allowExit=false
 await assert.rejects(client.run({prompt:'ownership'}),e=>e.cleanup==='unknown')
 assert.equal(client.snapshot().state,'unknown');assert.equal(client.snapshot().retainedHandle,true)
 await assert.rejects(client.run({prompt:'must not duplicate'}),e=>e.code==='EXIT_UNKNOWN')
 assert.equal(facts.spawned,1);facts.allowExit=true;assert.equal(await client.reconcileExit(),true);assert.equal(client.snapshot().state,'idle')
})

test('concurrent requests and credential injection are rejected before replacement spawn',async()=>{
 assert.throws(()=>fixture('normal',{env:{CODEBUDDY_AUTH_TOKEN:'not-a-real-token'}}),/injected credentials/)
 const {client,facts}=fixture('cancel');const first=client.run({prompt:'wait',onChunk:()=>client.cancel()})
 await assert.rejects(client.run({prompt:'concurrent'}),e=>e.code==='BUSY')
 await assert.rejects(first,e=>e.code==='CANCELLED');assert.equal(facts.spawned,1)
})

for(const [mode,code]of [['init-wrong-model','MODEL_MISMATCH'],['init-missing-model','MODEL_UNCONFIRMED']]) {
 test(mode+' blocks before session persistence or any user frame',async()=>{
  const {client,facts}=fixture(mode);let saved=false
  await assert.rejects(client.run({prompt:'must not send',onSession:()=>{saved=true}}),e=>e.code===code&&e.cleanup==='clean')
  assert.equal(facts.userFrames,0);assert.equal(saved,false);assert(facts.confirmed);assert.equal(facts.terminated,0)
 })
}
