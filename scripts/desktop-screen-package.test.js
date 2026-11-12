const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname,'../platforms/desktop');
test('desktop package exports a self-contained screen process and client',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
  assert.equal(pkg.exports['./screen']?.default,'./runtime/screen/desktop/electron/screen-capture-process.js');
  for(const file of ['screen/desktop/electron/screen-capture-process','screen/client/screen-capture-client','screen/client/types']) {
    for(const extension of ['js','d.ts']) assert.ok(fs.existsSync(path.join(root,'runtime',file+'.'+extension)),file);
  }
  const entry=fs.readFileSync(path.join(root,pkg.main),'utf8');
  assert.match(entry,/ScreenCaptureProcess/);
  const screen=require(path.join(root,pkg.exports['./screen'].default));
  assert.equal(typeof screen.ScreenCaptureProcess.launch,'function');
  assert.equal(screen.SCREEN_CAPTURE_PROTOCOL_VERSION,1);
});

test('desktop public declarations accept AudioCapture as the screen audio source',t=>{
  const os=require('node:os');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'sdk-screen-types-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
  const usage=path.join(temporary,'usage.ts');
  const entry=JSON.stringify(path.join(root,pkg.main).replaceAll(path.sep,'/'));
  fs.writeFileSync(usage,`import {AudioCapture,ScreenCaptureProcess} from ${entry};
import type {ScreenCaptureStartConfig,ScreenCaptureResult,RecordingOutput} from ${entry};
const audioCapture=new AudioCapture();
const config:ScreenCaptureStartConfig={captureId:'one',source:{type:'display_at',point:{x:0,y:0}},output:{type:'file',label:'test'},captureCursor:true,includeAudio:true,audioCapture};
const launched=ScreenCaptureProcess.launch({root:'recordings'});
function metadata(result:ScreenCaptureResult<RecordingOutput>){if(result.ok)return result.value.audio?.codec;}
void config;void launched;void metadata;
`);
  const program=ts.createProgram([usage],{noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.Node16,moduleResolution:ts.ModuleResolutionKind.Node16});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
});
