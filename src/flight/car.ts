import { KEY_A, KEY_D, KEY_S, KEY_SPACE, KEY_W } from 'playcanvas';
import type { FlightContext, FlightModule, FlightState } from './types';
import type { createWorldPhysics } from './world-data';

export type GroundPhysics = ReturnType<typeof createWorldPhysics>;
export interface CarInput { drive: number; steer: number; handbrake: boolean }
const radians = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export class CarDynamics {
  x = 0; y = 0; z = 0; heading = 0; speed = 0; pitch = 0; roll = 0;
  radius = 2.2;
  private vx = 0;
  private vz = 0;
  constructor(readonly world: GroundPhysics) {}
  get movementSpeed() { return Math.hypot(this.vx,this.vz); }
  reset(x: number, y: number, z: number, heading: number) {
    Object.assign(this, { x,y,z,heading,speed:0,pitch:0,roll:0,vx:0,vz:0 });
  }
  step(input: CarInput, dt: number) {
    const drive=clamp(input.drive,-1,1), steer=clamp(input.steer,-1,1);
    const braking=drive*this.speed<0;
    this.speed += (drive*(braking?32:18)-this.speed*.12)*dt;
    const friction=(input.handbrake?38:drive===0?2:0)*dt;
    this.speed=Math.sign(this.speed)*Math.max(0,Math.abs(this.speed)-friction);
    this.speed=clamp(this.speed,-12,45);
    this.heading=(this.heading+steer*this.speed*1.6*dt+360)%360;
    const h=this.heading*radians;
    const grip=1-Math.exp(-dt*(input.handbrake?3:14));
    this.vx+=(Math.sin(h)*this.speed-this.vx)*grip;
    this.vz+=(-Math.cos(h)*this.speed-this.vz)*grip;
    const dx=this.vx*dt,dz=this.vz*dt;
    const p=this.world.moveCapsule(this,dx,dz,this.radius,1.5,.55);
    if(Math.hypot(p.x-this.x-dx,p.z-this.z-dz)>.001) { this.speed*=.25; this.vx=0;this.vz=0; }
    this.x=p.x;this.z=p.z;
    this.y=this.world.surfaceAt(this.x,this.z,this.y+.35);
    const front=this.world.surfaceAt(this.x+Math.sin(h)*2,this.z-Math.cos(h)*2,this.y+.8);
    const back=this.world.surfaceAt(this.x-Math.sin(h)*2,this.z+Math.cos(h)*2,this.y+.8);
    this.pitch=clamp(Math.atan2(front-back,4)/radians,-25,25);
    this.roll=0;
  }
}

export function publishGround(state: FlightState, body: {x:number;y:number;z:number;heading:number;speed:number;pitch:number;roll:number}, ground: number, verticalSpeed=0) {
  Object.assign(state, {x:body.x,y:body.y,z:body.z,heading:body.heading,speed:Math.abs(body.speed),pitch:body.pitch,roll:body.roll,
    verticalSpeed,altitude:body.y,heightAboveGround:Math.max(0,body.y-ground),throttle:0,stall:false,crashed:false});
}

export function createCarController(ctx: FlightContext, physics: GroundPhysics): FlightModule {
  const {state,app,plane}=ctx, body=new CarDynamics(physics);
  body.reset(state.x,state.y,state.z,state.heading);
  let accumulator=0, wheelAngle=0;
  return { update(dt) {
    if(!Number.isFinite(dt)||dt<=0)return;
    body.radius=Math.max(2.2,...(plane.hitbox??[]).map(p=>Math.hypot(p[0],p[2])));
    const k=app.keyboard;
    const drive=Number(!!k?.isPressed(KEY_W))-Number(!!k?.isPressed(KEY_S));
    let steer=Number(!!k?.isPressed(KEY_D))-Number(!!k?.isPressed(KEY_A));
    if(state.controlMode==='mouse'&&Math.hypot(state.aimX,state.aimZ)>.01) {
      const target=Math.atan2(state.aimX,-state.aimZ)/radians;
      steer=clamp((((target-body.heading+540)%360)-180)/35+steer,-1,1);
    }
    accumulator+=Math.min(dt,.25);
    while(accumulator>=1/120){body.step({drive,steer,handbrake:!!k?.isPressed(KEY_SPACE)},1/120);accumulator-=1/120;}
    wheelAngle=(wheelAngle+body.speed*Math.min(dt,.25)/.35/radians)%360;
    for(const wheel of plane.wheels??[])wheel.setLocalEulerAngles(wheelAngle,0,0);
    publishGround(state,body,physics.surfaceAt(body.x,body.z,body.y+.35));
    state.speed=body.movementSpeed;
    state.throttle=Math.max(0,drive);
    plane.root.setPosition(body.x,body.y,body.z);plane.root.setLocalEulerAngles(body.pitch,-body.heading,0);
  }};
}
