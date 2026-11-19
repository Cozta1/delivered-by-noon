import { KEY_A, KEY_D, KEY_S, KEY_SHIFT, KEY_SPACE, KEY_W, Vec3 } from 'playcanvas';
import type { FlightContext, FlightModule } from './types';
import { publishGround, type GroundPhysics } from './car';

export interface FootInput { forward:number; right:number; run:boolean; jump:boolean; heading:number }
export class FootDynamics {
  x=0;y=0;z=0;heading=0;speed=0;pitch=0;roll=0;verticalSpeed=0;
  private jumpHeld=false;
  constructor(readonly world: GroundPhysics) {}
  reset(x:number,y:number,z:number,heading:number) { Object.assign(this,{x,y,z,heading,speed:0,verticalSpeed:0,jumpHeld:false}); }
  step(input: FootInput,dt:number) {
    const floor=this.world.surfaceAt(this.x,this.z,this.y+.35);
    const grounded=this.y<=floor+.02&&this.verticalSpeed<=0;
    if(input.jump&&!this.jumpHeld&&grounded)this.verticalSpeed=5.5;
    this.jumpHeld=input.jump;
    const length=Math.max(1,Math.hypot(input.forward,input.right));
    const speed=input.run?8:4, h=input.heading*Math.PI/180;
    const dx=(Math.sin(h)*input.forward+Math.cos(h)*input.right)/length*speed*dt;
    const dz=(-Math.cos(h)*input.forward+Math.sin(h)*input.right)/length*speed*dt;
    const p=this.world.moveCapsule(this,dx,dz,.35,1.8,.8);
    this.speed=Math.hypot(p.x-this.x,p.z-this.z)/dt;
    if(this.speed>.01)this.heading=(Math.atan2(p.x-this.x,-(p.z-this.z))*180/Math.PI+360)%360;
    this.x=p.x;this.z=p.z;this.y=Math.max(this.y,p.y);
    const oldY=this.y;
    this.verticalSpeed-=9.81*dt;
    const nextY=this.y+this.verticalSpeed*dt;
    const support=this.world.surfaceAt(this.x,this.z,Math.max(oldY,nextY)+.1);
    const ceiling=this.world.obstacleAt(this.x,this.z,nextY,.35,1.8);
    if(this.verticalSpeed>0&&ceiling){this.verticalSpeed=0;this.y=oldY;}
    else if(nextY<=support){this.y=support;this.verticalSpeed=0;}
    else this.y=nextY;
  }
}

export function createFootController(ctx:FlightContext,physics:GroundPhysics):FlightModule {
  const {state,app,plane,camera}=ctx, body=new FootDynamics(physics),forward=new Vec3();
  body.reset(state.x,state.y,state.z,state.heading);
  let accumulator=0;
  return {update(dt){
    if(!Number.isFinite(dt)||dt<=0)return;
    camera.getRotation().transformVector(Vec3.FORWARD,forward);
    const heading=Math.atan2(forward.x,-forward.z)*180/Math.PI;
    const k=app.keyboard,input:FootInput={forward:Number(!!k?.isPressed(KEY_W))-Number(!!k?.isPressed(KEY_S)),
      right:Number(!!k?.isPressed(KEY_D))-Number(!!k?.isPressed(KEY_A)),run:!!k?.isPressed(KEY_SHIFT),jump:!!k?.isPressed(KEY_SPACE),heading};
    accumulator+=Math.min(dt,.25);
    while(accumulator>=1/120){body.step(input,1/120);accumulator-=1/120;}
    publishGround(state,body,physics.surfaceAt(body.x,body.z,body.y+.1),body.verticalSpeed);
    plane.root.setPosition(body.x,body.y,body.z);plane.root.setLocalEulerAngles(0,-body.heading,0);
  }};
}
