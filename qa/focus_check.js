const {chromium}=require('./lib/browser'); const http=require('http'),fs=require('fs'),path=require('path');
const { pagePath } = require('./lib/layout');
const dir=path.resolve(process.argv[2]);
const T={'.js':'text/javascript','.css':'text/css','.html':'text/html'};
const srv=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(dir,u==='/'?'index.html':u);fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);r.end();return;}r.writeHead(200,{'content-type':T[path.extname(f)]||'text/plain'});r.end(d);});}).listen(0,'127.0.0.1',async()=>{
 const b=await chromium.launch({headless:true}); const p=await b.newPage({viewport:{width:1280,height:900}});
 await p.goto(`http://127.0.0.1:${srv.address().port}${pagePath(dir)}`);
 const st=()=>p.evaluate(()=>({deal:!document.getElementById('deal').disabled,msg:document.getElementById('message').textContent.trim(),val:document.getElementById('bet').value,vm:document.getElementById('bet').validationMessage}));
 const out={};
 for (const v of ['50','0','-5','2.5','5000','']) { await p.fill('#bet',v); await p.waitForTimeout(100); out[v||'(empty)']=await st(); }

 await p.fill('#bet','10'); out['back to 10']=await st();
 // focus after rounds, 20 rounds standing
 const foc=[]; const en=(s)=>p.$eval(s,e=>!e.disabled&&!e.closest('[hidden]')).catch(()=>false);
 for(let i=0;i<40;i++){ for(let k=0;k<50&&!(await en('#deal'))&&!(await en('#rebet-1'));k++) await p.waitForTimeout(100);
   if(await en('#rebet-1')) await p.click('#rebet-1'); else { await p.fill('#bet','10'); await p.click('#deal'); }
   await p.waitForTimeout(1500);
   if(await en('#no-insure')){await p.click('#no-insure'); await p.waitForTimeout(1200);}
   let g=0; const acted0=await en('#stand'); while(await en('#stand') && g++<6){ await p.click('#stand'); await p.waitForTimeout(1200); }
   await p.waitForTimeout(900);
   foc.push(await p.evaluate((ACTED)=>({f:document.activeElement&&(document.activeElement.id||document.activeElement.tagName), msg:document.getElementById('message').textContent.trim().slice(0,40), acted:ACTED, rebetShown:!document.getElementById('rebet-1').closest('[hidden]')&&!document.getElementById('rebet-1').disabled}), acted0));
 }
 out.focusAfterRound=foc.filter(x=>x.f!=='rebet-1'&&x.f!=='deal'); out.noActionRounds=foc.filter(x=>!x.acted).length; out.badWithAction=out.focusAfterRound.filter(x=>x.acted).length; out.focusRounds=foc.length;
 console.log(JSON.stringify(out,null,1)); await b.close(); srv.close();
});
