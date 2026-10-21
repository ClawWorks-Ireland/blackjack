// Count drill: fake a 20 s hidden tab after ~4 cards; the scored time must exclude it.
const {chromium}=require('./lib/browser');
(async()=>{const b=await chromium.launch({headless:true});const p=await b.newPage();
await p.addInitScript(()=>{let hidden=false;Object.defineProperty(document,'hidden',{get:()=>hidden});Object.defineProperty(document,'visibilityState',{get:()=>hidden?'hidden':'visible'});window.__setHidden=(h)=>{hidden=h;document.dispatchEvent(new Event('visibilitychange'));};});
await p.goto(process.argv[2]); await p.evaluate(()=>localStorage.clear()); await p.reload();
await p.keyboard.press('w'); await p.click('#tab-count'); await p.selectOption('#cd-size','26'); await p.selectOption('#cd-speed','500');
await p.click('#cd-start'); await p.waitForTimeout(2100);
const before=await p.textContent('#cd-progress'); await p.evaluate(()=>window.__setHidden(true));
await p.waitForTimeout(500); const pausedMsg=(await p.textContent('#cd-progress'))+' | '+(await p.evaluate(()=>document.getElementById('cd-card').textContent.trim().slice(0,40)));
await p.waitForTimeout(20000); const duringHidden=await p.textContent('#cd-progress'); await p.evaluate(()=>window.__setHidden(false));
await p.waitForSelector('#cd-form:not([hidden])',{timeout:60000}); await p.fill('#cd-guess','0'); await p.press('#cd-guess','Enter'); await p.waitForTimeout(300);
const res=(await p.textContent('#cd-result')).replace(/\s+/g,' ').trim(); const secs=Number((res.match(/([\d.]+) s,/)||[])[1]);
console.log(JSON.stringify({before,pausedMsg,duringHidden,result:res,scoredSeconds:secs,pass: secs>=12.5 && secs<16}));await b.close();})();
