// Headless: run the count drill (52 cards, 0.5 s) at a visible tab, record every card, answer with my own Hi-Lo sum.
const {chromium}=require('./lib/browser');
(async()=>{const b=await chromium.launch({headless:true});const p=await b.newPage({viewport:{width:1280,height:900}});
await p.goto(process.argv[2]); await p.evaluate(()=>localStorage.clear()); await p.reload();
await p.keyboard.press('w'); await p.click('#tab-count'); await p.selectOption('#cd-size','52'); await p.selectOption('#cd-speed','500');
await p.evaluate(()=>{window.__seen={};const el=document.getElementById('cd-card'),pr=document.getElementById('cd-progress');const g=()=>{const c=el.querySelector('.card');const n=(pr.textContent.match(/Card (\d+)/)||[])[1];if(c&&n)window.__seen[n]=c.getAttribute('aria-label');};const mo=new MutationObserver(g);mo.observe(el,{childList:true,subtree:true});mo.observe(pr,{childList:true,subtree:true,characterData:true});});
const t0=Date.now(); await p.click('#cd-start');
await p.waitForSelector('#cd-form:not([hidden])',{timeout:60000});
const ms=Date.now()-t0;
const {n,sum}=await p.evaluate(()=>{const v=l=>{const r=l.split(' of ')[0].toUpperCase();if(['A','K','Q','J','10'].includes(r))return -1;return Number(r)<=6?1:0;};const ls=Object.values(window.__seen);return{n:ls.length,sum:ls.reduce((s,l)=>s+v(l),0)};});
await p.fill('#cd-guess',String(sum)); await p.press('#cd-guess','Enter'); await p.waitForTimeout(300);
console.log(JSON.stringify({cardsSeen:n,myCount:sum,wallMs:ms,result:(await p.textContent('#cd-result')).replace(/\s+/g,' ').trim()}));
await b.close();})();
