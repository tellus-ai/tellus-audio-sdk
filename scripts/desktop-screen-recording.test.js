// 실제 자식 프로세스 경계에서 소스 연결·프로토콜 직렬화·정리를 검증한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const childProcess = require('node:child_process');
const nativeSpawn = childProcess.spawn;
const fixtureScripts = new Map();
const fixtureChildren = new Map();
// 실행 파일 경계만 Node fixture로 바꿔 Windows에서도 같은 실제 stdin/stdout 계약을 검증한다.
childProcess.spawn = (file, args, options) => {
  const child = fixtureScripts.has(file) ? nativeSpawn(process.execPath, [fixtureScripts.get(file), ...args], options) : nativeSpawn(file, args, options);
  if (fixtureScripts.has(file)) fixtureChildren.set(file, child);
  return child;
};
const { ScreenCaptureProcess } = require('../platforms/desktop/runtime/screen/desktop/electron/screen-capture-process.js');

async function fixture(t, old = false) {
  // old=true는 구버전 hello, old='no-keepalive'는 녹화 오디오만 알리고 pause keepalive는 알리지 않는 hello다.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), old === 'no-keepalive' ? 'screen-nokeep-' : old ? 'screen-old-' : 'screen-audio-'));
  const executable = path.join(root, 'host');
  const script = path.join(root, 'host.js');
  fixtureScripts.set(executable, script);
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const root = process.argv[3];
const send = value => console.log(JSON.stringify(value));
const audio = {codec:'aac_lc',sampleRate:48000,channels:1,samples:960,gaps:0,paddingSamples:64,queueHighWaterSamples:960};
const output = {file:root+'/result.mp4',mediaDurationUs:20000,firstFrame:null,pauses:[],stats:{},interruption:null,audio};
let snapshot, previousTerminal, lateAfterStart;
let nextSession = 0;
send({hello:{protocolVersion:1,...(root.includes('screen-old-')?{}:{audioRecording:true,...(root.includes('screen-nokeep-')?{}:{audioRecordingPauseKeepalive:true})}),monotonicNow:process.hrtime.bigint().toString(),capabilities:{platform:'macos',consent:'system_permission',selection:'programmatic',sourceKinds:['display']}}});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  fs.appendFileSync(root+'/commands.jsonl',line+'\\n');
  const {id,command:c}=JSON.parse(line);
  let result={status:'ok'};
  if(c.type==='start') {
    if(c.config.captureId==='exit') return process.exit(2);
    if(c.config.captureId==='exit-inherited'){require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:['ignore',process.stdout,process.stderr]});setTimeout(()=>process.exit(2),10);return;}
    if(c.config.captureId==='b') send({event:{type:'state',snapshot:{sessionId:'old',captureId:'a',state:{phase:'finished',output},source:null,profile:null}}});
    if(c.config.output.label==='fail') result={status:'error',error:{code:'encoder_failed',detail:'test failure'}};
    else if (!snapshot || ['finished','failed'].includes(snapshot.state.phase)) snapshot={sessionId:'session-'+(++nextSession),captureId:c.config.captureId,state:{phase:'armed'},source:null,profile:null};
    if(c.config.output.label==='late-terminal'&&previousTerminal) send({event:{type:'state',snapshot:previousTerminal}});
    if(c.config.output.label==='late-after-start') lateAfterStart=previousTerminal;
    if(result.status==='ok') {result.snapshot=snapshot;send({event:{type:'state',snapshot}});}
    if(c.config.output.label==='early-interrupt') {snapshot={...snapshot,state:{phase:'finished',output}};send({event:{type:'state',snapshot}});}
  } else if(c.type==='finalize'&&snapshot.state.phase!=='sealed'&&snapshot.state.phase!=='finished') result={status:'error',error:{code:'invalid_state',detail:'must seal first'}};
  else if(c.type==='stop'||c.type==='finalize') {if(snapshot.captureId==='unsafe') audio.samples=Number.MAX_SAFE_INTEGER+1;result.output=output;snapshot={...snapshot,state:{phase:'finished',output}};previousTerminal=snapshot;if(snapshot.captureId==='restart-on-event')send({event:{type:'state',snapshot}});}
  else if(c.type==='open_gate'&&snapshot.captureId==='interrupt') {snapshot.state={phase:'finished',output};send({event:{type:'state',snapshot}});result.snapshot=snapshot;}
  else if(c.type==='seal') {snapshot.state={phase:'sealed'};result.snapshot=snapshot;}
  else if(c.type==='shutdown') {send({response:{id,result}});return process.exit(0);}
  else {if(c.type==='open_gate'&&lateAfterStart){send({event:{type:'state',snapshot:lateAfterStart}});lateAfterStart=null;}result.snapshot=snapshot;}
  setTimeout(()=>send({response:{id,result}}),10);
});
`);
  const launched = await ScreenCaptureProcess.launch({ root, executablePath: executable, timeoutMs: 5000 });
  assert.equal(launched.ok, true, JSON.stringify(launched));
  t.after(async () => { await launched.value.shutdown(); fixtureScripts.delete(executable); fixtureChildren.delete(executable); fs.rmSync(root, { recursive: true, force: true }); });
  return { recorder: launched.value, child: fixtureChildren.get(executable), commands: () => fs.readFileSync(path.join(root, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}
function source() {
  const created = [], stopped = [], options = [];
  return { created, stopped, options, createRecordingAudioSource(o) { options.push(o); const token = `token-${created.length}`;created.push(token);return {port:12345,token}; }, stopRecordingAudioSource(token) { stopped.push(token); } };
}
function config(audioCapture, captureId='a', label='ok') {
  return {captureId,source:{type:'display_at',point:{x:0,y:0}},output:{type:'file',label},captureCursor:true,includeAudio:true,audioCapture};
}

test('recording binds once, shares concurrent identical start, serializes endpoint and leaves capture running', async t => {
  const f = await fixture(t), capture = source();
  const [a,b] = await Promise.all([f.recorder.start(config(capture)), f.recorder.start(config(capture))]);
  assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(capture.created.length,1);
  assert.equal((await f.recorder.start(config(source()))).ok,false);
  const starts = f.commands().filter(x=>x.command.type==='start');
  assert.equal(starts.length,1);
  assert.deepEqual(starts[0].command.config.audioInput,{port:12345,token:'token-0'});
  assert.equal('audioCapture' in starts[0].command.config,false);
  assert.equal((await f.recorder.stop()).ok,true);
  assert.deepEqual(capture.stopped,['token-0']);
  assert.equal((await f.recorder.stop()).ok,true);
  assert.deepEqual(capture.stopped,['token-0']);
  assert.equal((await f.recorder.start(config(capture,'b'))).ok,true);
  assert.equal(capture.created.length,2);
  assert.deepEqual(capture.stopped,['token-0']);
  await f.recorder.shutdown();assert.deepEqual(capture.stopped,['token-0','token-1']);
});
test('failed start and process exit detach the exact source token', async t => {
  const f=await fixture(t),capture=source();
  assert.equal((await f.recorder.start(config(capture,'fail','fail'))).ok,false);
  assert.deepEqual(capture.stopped,['token-0']);
  assert.equal((await f.recorder.start(config(capture,'exit'))).ok,false);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(capture.stopped,['token-0','token-1']);
});
test('old binary, missing source methods, and fragments reject audio before attach', async t => {
  const f=await fixture(t,true),capture=source();
  assert.equal(f.recorder.recordingAudioSupported,false);
  assert.equal((await f.recorder.start(config(capture))).ok,false);
  assert.equal(capture.created.length,0);
  const g=await fixture(t);
  const missing={createRecordingAudioSource(){throw new Error('must not attach');}};
  assert.equal((await g.recorder.start(config(missing))).ok,false);
  assert.equal((await g.recorder.start({...config(capture),output:{type:'fragments'}})).ok,false);
  assert.equal((await g.recorder.start({...config(capture),includeAudio:false})).ok,false);
  assert.equal(capture.created.length,0);
});
test('terminal interruption detaches and video-only start remains compatible',async t=>{
  const f=await fixture(t),capture=source();
  assert.equal((await f.recorder.start(config(capture,'interrupt'))).ok,true);
  await f.recorder.openGate();await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(capture.stopped,['token-0']);
  const c=config(undefined,'video');delete c.includeAudio;delete c.audioCapture;
  assert.equal((await f.recorder.start(c)).ok,true);
  const last=f.commands().filter(x=>x.command.type==='start').at(-1).command.config;
  assert.equal(last.audioInput,undefined);
});

test('unsafe native audio counters fail explicitly and detach the source', async t=>{
  const f=await fixture(t),capture=source();
  assert.equal((await f.recorder.start(config(capture,'unsafe'))).ok,true);
  const result=await f.recorder.stop();
  assert.equal(result.ok,false);
  assert.match(result.error.detail,/unsafe recording audio metadata/);
  assert.deepEqual(capture.stopped,['token-0']);
});

test('sequential idempotent start retains the original endpoint without creating a new source',async t=>{
  const f=await fixture(t),capture=source();
  assert.equal((await f.recorder.start(config(capture))).ok,true);
  assert.equal((await f.recorder.start(config(capture))).ok,true);
  const requests=f.commands().filter(x=>x.command.type==='start');
  assert.equal(capture.created.length,1);
  assert.deepEqual(requests[1].command.config.audioInput,{port:12345,token:'token-0'});
});

test('finishing an old stop cannot detach a recording started by its terminal event',async t=>{
  const f=await fixture(t),capture=source();
  assert.equal((await f.recorder.start(config(capture,'restart-on-event'))).ok,true);
  let restarted;
  f.recorder.onEvent(event=>{
    if(event.type==='state'&&event.snapshot.captureId==='restart-on-event'&&event.snapshot.state.phase==='finished') restarted=f.recorder.start(config(capture,'restart-on-event'));
  });
  assert.equal((await f.recorder.stop()).ok,true);
  assert.equal((await restarted).ok,true);
  assert.equal(capture.created.length,2);
  assert.deepEqual(capture.stopped,['token-0']);
});

test('process exit detaches audio before inherited output handles close',async t=>{
  const f=await fixture(t),capture=source();
  const exited=new Promise(resolve=>f.child.once('exit',resolve));
  const started=f.recorder.start(config(capture,'exit-inherited'));
  await exited;await new Promise(setImmediate);
  assert.deepEqual([...capture.stopped],['token-0']);
  assert.equal((await started).ok,false);
});


test('terminal captureId restarts with a fresh token and permits changed audio settings',async t=>{
  const f=await fixture(t),capture=source();
  const first=await f.recorder.start(config(capture,'same'));
  assert.equal(first.ok,true);
  assert.equal((await f.recorder.stop()).ok,true);
  const second=await f.recorder.start(config(capture,'same'));
  assert.equal(second.ok,true);
  assert.notEqual(second.value.sessionId,first.value.sessionId);
  assert.deepEqual(capture.created,['token-0','token-1']);
  assert.deepEqual(f.commands().filter(x=>x.command.type==='start').at(-1).command.config.audioInput,{port:12345,token:'token-1'});
  await f.recorder.stop();
  const other=source();
  assert.equal((await f.recorder.start(config(other,'same'))).ok,true);
  await f.recorder.stop();
  const video=config(undefined,'same');delete video.includeAudio;delete video.audioCapture;
  assert.equal((await f.recorder.start(video)).ok,true);
});

test('rejected finalize preserves the active source and session until a successful stop',async t=>{
  const f=await fixture(t),capture=source();
  assert.equal((await f.recorder.start(config(capture))).ok,true);
  const rejected=await f.recorder.finalize();
  assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'invalid_state');
  assert.deepEqual(capture.stopped,[]);
  assert.equal((await f.recorder.start(config(capture,'other'))).ok,false);
  assert.equal((await f.recorder.openGate()).ok,true);
  assert.equal((await f.recorder.stop()).ok,true);
  assert.deepEqual(capture.stopped,['token-0']);
});

test('request queue rejection preserves the active recording source',async t=>{
  const f=await fixture(t),capture=source();
  assert.equal((await f.recorder.start(config(capture))).ok,true);
  const requests=Array.from({length:64},()=>f.recorder.openGate());
  const rejected=await f.recorder.stop();
  assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'request_queue_full');
  assert.deepEqual(capture.stopped,[]);
  assert.equal((await f.recorder.start(config(capture,'other'))).ok,false);
  assert.equal((await Promise.all(requests)).every(result=>result.ok),true);
  assert.equal((await f.recorder.stop()).ok,true);
  assert.deepEqual(capture.stopped,['token-0']);
});

for (const label of ['late-terminal','late-after-start']) {
  test(`previous session terminal event cannot detach same captureId restart (${label})`,async t=>{
    const f=await fixture(t),capture=source();
    assert.equal((await f.recorder.start(config(capture,'same'))).ok,true);
    assert.equal((await f.recorder.stop()).ok,true);
    const restarted=await f.recorder.start(config(capture,'same',label));
    assert.equal(restarted.ok,true);
    assert.deepEqual(capture.created,['token-0','token-1']);
    assert.deepEqual(capture.stopped,['token-0']);
    assert.equal((await f.recorder.openGate()).ok,true);
    assert.deepEqual(capture.stopped,['token-0']);
    assert.equal((await f.recorder.start(config(capture,'other'))).ok,false);
    await f.recorder.stop();assert.deepEqual(capture.stopped,['token-0','token-1']);
  });
}

test('terminal interruption before the start response still detaches its source',async t=>{
  const f=await fixture(t),capture=source();
  const started=await f.recorder.start(config(capture,'early','early-interrupt'));
  assert.equal(started.ok,true);
  assert.equal(started.value.state.phase,'armed');
  assert.deepEqual(capture.stopped,['token-0']);
  assert.equal((await f.recorder.start(config(capture,'next'))).ok,true);
  assert.deepEqual(capture.stopped,['token-0']);
});

test('screen process exposes pause keepalive support from the hello', async t => {
  assert.equal((await fixture(t)).recorder.recordingAudioPauseKeepaliveSupported, true);
  const noKeepalive = (await fixture(t, 'no-keepalive')).recorder;
  assert.equal(noKeepalive.recordingAudioSupported, true);
  assert.equal(noKeepalive.recordingAudioPauseKeepaliveSupported, false);
  assert.equal((await fixture(t, true)).recorder.recordingAudioPauseKeepaliveSupported, false);
});

test('start validates audioPauseMode and forwards it to the audio source without sending it to the host', async t => {
  const nk = await fixture(t, 'no-keepalive'), capture = source();
  const unsupported = await nk.recorder.start({ ...config(capture), audioPauseMode: 'keepalive' });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.detail, 'audioPauseMode keepalive requires recording audio pause keepalive support');
  const f = await fixture(t), other = source();
  const unknown = await f.recorder.start({ ...config(other), audioPauseMode: 'freeze' });
  assert.equal(unknown.error.detail, 'audioPauseMode must be abort or keepalive');
  assert.equal(other.created.length, 0);
  assert.equal((await f.recorder.start(config(other, 'a'))).ok, true);
  assert.deepEqual(other.options, [{ pauseMode: 'abort' }]);
  await f.recorder.stop();
  assert.equal((await f.recorder.start({ ...config(other, 'b'), audioPauseMode: 'keepalive' })).ok, true);
  assert.deepEqual(other.options, [{ pauseMode: 'abort' }, { pauseMode: 'keepalive' }]);
  assert.equal('audioPauseMode' in f.commands().filter(x => x.command.type === 'start')[1].command.config, false);
});
