/* Sonic AI Failure Log v1
   Bounded diagnostic recorder for Cognition v3. Records decisions/failures,
   never gameplay state changes. Safe to persist in localStorage. */
(function(root){'use strict';
const VERSION=1, MAX_EVENTS=1200, MAX_RUNS=40;
const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
class SonicAIFailureLog{
 constructor(saved){this.events=[];this.runs=[];this.seq=0;this.run=null;if(saved?.version===VERSION){this.events=Array.isArray(saved.events)?saved.events.slice(-MAX_EVENTS):[];this.runs=Array.isArray(saved.runs)?saved.runs.slice(-MAX_RUNS):[];this.seq=Number(saved.seq)||this.events.length;}}
 export(){return{version:VERSION,seq:this.seq,events:this.events.slice(-MAX_EVENTS),runs:this.runs.slice(-MAX_RUNS)};}
 begin(s){if(this.run)return;this.run={id:`run-${Date.now()}-${this.seq}`,stage:s.stage,physics:s.physics||'normal',started:Date.now(),events:0,deaths:0,damage:0,stalls:0,successes:0,maxX:s.x||0,maxRings:s.rings||0};}
 finish(reason='ended'){if(!this.run)return;this.run.ended=Date.now();this.run.reason=reason;this.runs.push(this.run);if(this.runs.length>MAX_RUNS)this.runs.shift();this.run=null;}
 snapshot(s){return{x:s.x|0,y:s.y|0,vx:s.vx|0,vy:s.vy|0,inertia:s.inertia|0,angle:s.angle|0,rings:s.rings|0,lives:s.lives|0,routine:s.routine|0,status:s.status|0,mechanic:s.mechanic|0,checkpoint:s.checkpoint|0,stage:s.stage,physics:s.physics||'normal',grounded:!!s.grounded};}
 add(type,s,data={}){this.begin(s);const e={id:++this.seq,tick:data.tick||0,time:Date.now(),runId:this.run?.id,type,state:this.snapshot(s),goal:clone(data.goal)||null,intent:clone(data.intent)||null,attemptKey:data.attemptKey||null,profile:data.profile||null,reason:data.reason||'',context:clone(data.context)||null};this.events.push(e);if(this.events.length>MAX_EVENTS)this.events.shift();if(this.run){this.run.events++;this.run.maxX=Math.max(this.run.maxX,s.x||0);this.run.maxRings=Math.max(this.run.maxRings,s.rings||0);if(type==='death')this.run.deaths++;if(type==='damage')this.run.damage++;if(type==='stall'||type==='failed_frontier'||type==='failed_resource')this.run.stalls++;if(type==='success'||type==='discovery')this.run.successes++;}return e;}
 summary(){const failures=this.events.filter(e=>['death','damage','stall','failed_frontier','failed_resource'].includes(e.type));const by={};for(const e of failures){const k=[e.state.stage,e.type,e.profile||'none',e.reason||'unspecified'].join('|');const x=by[k]||(by[k]={stage:e.state.stage,type:e.type,profile:e.profile||'none',reason:e.reason||'unspecified',count:0,lastX:0,lastY:0,rings:0});x.count++;x.lastX=e.state.x;x.lastY=e.state.y;x.rings=e.state.rings;}return Object.values(by).sort((a,b)=>b.count-a.count);}
 recent(n=50){return this.events.slice(-Math.max(1,Math.min(500,n)));}
 clear(){this.events=[];this.runs=[];this.seq=0;this.run=null;}
 download(filename='sonic-ai-failure-log.json'){const blob=new Blob([JSON.stringify(this.export(),null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
}
if(typeof module==='object'&&module.exports)module.exports=SonicAIFailureLog;else root.SonicAIFailureLog=SonicAIFailureLog;
})(typeof window==='object'?window:globalThis);
