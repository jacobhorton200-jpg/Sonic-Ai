/*
  Browser adapter contract for Sonic Cognition v3.
  This is intentionally separated from the cognition model so heap addresses can
  be changed without changing learned behavior.

  The adapter only reads game state and writes expiring planner mailboxes.
  It never writes Sonic position, velocity, rings, lives, HP, object routines,
  boss HP, checkpoints, or level completion.
*/
(function(root){
  "use strict";

  const DEFAULT_MAILBOX = {
    command:   0xffc4, // 0 none, 4 cognition navigation
    ttl:       0xffc6,
    targetX:   0xffd0,
    targetY:   0xffd2,
    targetKind:0xffd4,

    // Proposed v3 extension. Reserve these words in _Variables.asm.
    desiredSpeed:0xffda,
    jumpHold:    0xffdc,
    waitFrames:  0xffde,
    commitFrames:0xffe0,
    navFlags:    0xffe2, // bit0 left, bit1 right, bit2 jump, bit3 backtrack
  };

  class SonicCognitionAdapter {
    constructor({agent, memory, base=0, mailbox=DEFAULT_MAILBOX, sampleEvery=6}) {
      this.agent=agent;
      this.memory=memory;
      this.base=base;
      this.mailbox={...DEFAULT_MAILBOX,...mailbox};
      this.sampleEvery=sampleEvery;
      this.tick=0;
      this.lastIntent=null;
    }

    signed16(v){return v&0x8000?v-0x10000:v;}
    rb(heap,a){return heap[a^1]||0;}
    rw(heap,a){return ((heap[a]<<8)|heap[a+1])&0xffff;}
    ww(heap,a,v){v&=0xffff;heap[a]=(v>>8)&255;heap[a+1]=v&255;}

    objects(heap){
      const out=[];
      for(let a=0xd800;a<0xf000;a+=64){
        const id=this.rb(heap,a); if(!id)continue;
        out.push({
          id,
          x:this.rw(heap,a+8), y:this.rw(heap,a+12),
          render:this.rb(heap,a+1), collision:this.rb(heap,a+0x20),
          routine:this.rb(heap,a+0x24), subtype:this.rb(heap,a+0x28)
        });
      }
      return out;
    }

    observation(heap, extras={}){
      const rb=a=>this.rb(heap,a), rw=a=>this.rw(heap,a);
      return {
        active:!!extras.active,
        mode:rb(0xf600), locked:!!rb(0xf7aa), stage:rw(0xfe10),
        physics:extras.physics||"normal",
        x:rw(0xd008), y:rw(0xd00c),
        vx:this.signed16(rw(0xd010)), vy:this.signed16(rw(0xd012)),
        inertia:this.signed16(rw(0xd014)), angle:rb(0xd026), status:rb(0xd022), routine:rb(0xd024),
        rings:rw(0xfe20), lives:rb(0xfe12), checkpoint:rb(0xfe30), emeralds:rb(0xfe57),
        shield:rb(0xfe2c), invincible:rb(0xfe2d), shoes:rb(0xfe2e),
        grounded:!(rb(0xd022)&2),
        mechanic:rw(0xff86),
        objects:this.objects(heap),
        sensors:extras.sensors||{},
        onPlatform:!!extras.onPlatform,
        platformId:extras.platformId||0,
      };
    }

    clear(heap){
      for(const k of ["command","ttl","desiredSpeed","jumpHold","waitFrames","commitFrames","navFlags"])
        this.ww(heap,this.mailbox[k],0);
      this.lastIntent=null;
    }

    writeIntent(heap,intent){
      if(!intent){this.clear(heap);return;}
      let flags=0;
      if(intent.direction<0)flags|=1;
      if(intent.direction>0)flags|=2;
      if(intent.jump)flags|=4;
      if(intent.allowBacktrack)flags|=8;
      this.ww(heap,this.mailbox.command,4);
      this.ww(heap,this.mailbox.ttl,24);
      this.ww(heap,this.mailbox.targetX,intent.targetX||0);
      this.ww(heap,this.mailbox.targetY,intent.targetY||0);
      this.ww(heap,this.mailbox.targetKind,{resource:1,explore:2,recover:3}[intent.goalType]||0);
      this.ww(heap,this.mailbox.desiredSpeed,intent.desiredSpeed||0);
      this.ww(heap,this.mailbox.jumpHold,intent.jumpHold||0);
      this.ww(heap,this.mailbox.waitFrames,intent.waitFrames||0);
      this.ww(heap,this.mailbox.commitFrames,intent.commitmentFrames||0);
      this.ww(heap,this.mailbox.navFlags,flags);
      this.lastIntent=intent;
    }

    step(heap,extras={}){
      if((this.tick++%this.sampleEvery)!==0)return this.lastIntent;
      const obs=this.observation(heap,extras);
      const intent=this.agent.observe(obs);
      this.writeIntent(heap,intent);
      return intent;
    }

    takeover(heap){
      this.agent.resetEpisode?.();
      this.clear(heap);
    }
  }

  if(typeof module==="object"&&module.exports)module.exports={SonicCognitionAdapter,DEFAULT_MAILBOX};
  else root.SonicCognitionAdapter=SonicCognitionAdapter;
})(typeof window==="object"?window:globalThis);
