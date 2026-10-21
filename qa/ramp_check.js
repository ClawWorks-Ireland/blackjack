const {chromium}=require('./lib/browser'); const http=require('http'),fs=require('fs'),path=require('path');
const { pagePath } = require('./lib/layout');
const dir=process.argv[2];
const srv=http.createServer((q,r)=>{const f=path.join(dir,decodeURIComponent(q.url.split('?')[0])==='/'?'index.html':decodeURIComponent(q.url.split('?')[0]));fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);r.end();return;}r.writeHead(200,{'content-type':f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});r.end(d);});}).listen(0,'127.0.0.1',async()=>{
 const b=await chromium.launch({headless:true}); const p=await b.newPage({viewport:{width:1280,height:900}});
 const url=`http://127.0.0.1:${srv.address().port}${pagePath(dir)}`; await p.goto(url);
 await p.keyboard.press('k'); const out=[];
 for (const [bet, label] of [[25,'after a $25 hand'],[200,'after following an 8-unit count bet ($200)']]) {
   await p.evaluate(v=>localStorage.setItem('blackjack.lastBet',String(v)),bet); await p.reload(); 
   if(!(await p.isVisible('#suggest-text'))) await p.keyboard.press('k');
   out.push(label+': '+(await p.textContent('#suggest-text')));
 }
 console.log(out.join('\n')); await b.close(); srv.close();
});
