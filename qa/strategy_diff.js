// Compare <snap>/strategy.js recommend() with an independent 6D S17 DAS LS chart.
'use strict';
const path = require('path');
const dir = path.resolve(process.argv[2]);
const S = require(path.join(dir, 'strategy.js'));
const R = ['2','3','4','5','6','7','8','9','10','A'];
const val = (r) => (r === 'A' ? 11 : Number(r));
function total(cs){let t=0,a=0;for(const c of cs){t+=val(c);if(c==='A')a++;}while(t>21&&a){t-=10;a--;}return{t,soft:a>0};}
function ref(cs, up, o){ // independent chart (Wizard of Odds, 4-8 decks, S17, DAS, LS)
  const {t,soft}=total(cs); const pair=cs.length===2&&cs[0]===cs[1];
  if(o.canSurrender&&!soft&&!(pair&&cs[0]==='8')&&((t===16&&up>=9)||(t===15&&up===10)))return'surrender';
  if(pair&&o.canSplit){const v=val(cs[0]);
    if(v===11||v===8)return'split'; if(v===10)return'stand';
    if(v===9)return[7,10,11].includes(up)?'stand':'split';
    if(v===7&&up<=7)return'split'; if(v===6&&up<=6)return'split';
    if(v===4&&(up===5||up===6))return'split'; if((v===2||v===3)&&up<=7)return'split';}
  const D=(ok)=>ok&&o.canDouble?'double':null;
  if(soft){ if(t>=19)return'stand';
    if(t===18)return up>=3&&up<=6?(D(true)||'stand'):up<=8?'stand':'hit';
    if(t===17)return D(up>=3&&up<=6)||'hit'; if(t>=15)return D(up>=4&&up<=6)||'hit';
    return D(t>=13&&up>=5&&up<=6)||'hit';} // soft 12 (A,A unsplit) never doubles
  if(t>=17)return'stand'; if(t>=13)return up<=6?'stand':'hit'; if(t===12)return up>=4&&up<=6?'stand':'hit';
  if(t===11)return D(up<=10)||'hit'; if(t===10)return D(up<=9)||'hit'; if(t===9)return D(up>=3&&up<=6)||'hit'; return'hit';}
const diffs=[];
for(const a of R)for(const b of R)for(const u of R){
  if(R.indexOf(b)<R.indexOf(a))continue;
  const up=val(u); const o={canDouble:true,canSplit:true,canSurrender:true};
  const got=S.recommend([{rank:a,suit:'♠'},{rank:b,suit:'♥'}],{rank:u,suit:'♣'},o).action;
  const want=ref([a,b],up,o);
  if(got!==want)diffs.push(`${a},${b} vs ${u}: game=${got} ref=${want}`);
  // unsplittable pair (e.g. 4 hands already)
  if(a===b){const o2={canDouble:true,canSplit:false,canSurrender:false};
    const g2=S.recommend([{rank:a,suit:'♠'},{rank:b,suit:'♥'}],{rank:u,suit:'♣'},o2).action, w2=ref([a,b],up,o2);
    if(g2!==w2)diffs.push(`${a},${a} (cannot split) vs ${u}: game=${g2} ref=${w2}`);}
}
console.log(diffs.length?diffs.join('\n'):'no differences');
