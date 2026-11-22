import { KEY_A, KEY_D, KEY_S, KEY_SPACE, KEY_SHIFT, KEY_W } from 'playcanvas';
import type { FlightContext, FlightModule, FlightState } from './types';
import type { createWorldPhysics } from './world-data';
import { TireDynamics, HATCH, COUPE } from './carphys/model';

// Arcade tire grip/braking preserve the delivery game's response; this is not a road-car validation.
export const CAR_ASSISTS={tractionControl:.9,nitroGrip:1.2,lateralAcceleration:18,steeringTime:.065,yawDamping:.7,yawResponse:10,gripResponse:12,brakeBoost:3.2,uprightRoll:0};

export type GroundPhysics = ReturnType<typeof createWorldPhysics>;
export interface CarInput { drive: number; steer: number; handbrake: boolean; nitro?: boolean }
// Optional HUD bridge; keep the shared FlightState declaration unchanged.
type NitroState = FlightState & { nitro?: number };
export const getCarNitro = (state:FlightState) => (state as NitroState).nitro ?? 1;
const radians = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export class CarDynamics {
  x = 0; y = 0; z = 0; heading = 0; speed = 0; pitch = 0; roll = 0;
  radius = 2.2;
  nitro=1;
  verticalSpeed=0;
  airborne=false;
  private rampSlope=0;
  readonly chassis:TireDynamics;
  constructor(readonly world: GroundPhysics,readonly tuned=false) { this.chassis=new TireDynamics(tuned?COUPE:HATCH,CAR_ASSISTS); }
  get movementSpeed() { return this.chassis.speed; }
  reset(x: number, y: number, z: number, heading: number) {
    Object.assign(this, { x,y,z,heading,speed:0,pitch:0,roll:0,nitro:1,verticalSpeed:0,airborne:false,rampSlope:0 });
    this.chassis.reset(heading);
  }
  step(input: CarInput, dt: number) {
    const drive=clamp(input.drive,-1,1), steer=clamp(input.steer,-1,1);
    const requestingNitro=this.tuned&&!!input.nitro&&drive>0;
    const boosting=requestingNitro&&this.nitro>0;
    this.nitro=clamp(this.nitro+(boosting?-.4:requestingNitro?0:.18)*dt,0,1);
    this.chassis.step({drive,steer,handbrake:input.handbrake,boost:boosting?1.65:1},dt,this.airborne,this.airborne?0:this.pitch*radians);
    this.speed=this.chassis.forwardSpeed;this.heading=((this.chassis.heading/radians)%360+360)%360;
    const h=this.heading*radians,dx=this.chassis.vx*dt,dz=this.chassis.vz*dt;
    const p=this.world.moveCapsule(this,dx,dz,this.radius,1.5,.55);
    if(Math.hypot(p.x-this.x-dx,p.z-this.z-dz)>.001) { this.chassis.stop();this.speed=0; }
    this.x=p.x;this.z=p.z;
    const floor=this.world.surfaceAt(this.x,this.z,this.y+.35),oldY=this.y;
    if(this.tuned) {
      if(!this.airborne&&oldY-floor>.18&&this.movementSpeed>8) {
        this.airborne=true;this.verticalSpeed=Math.max(2,this.movementSpeed*this.rampSlope);
      }
      if(this.airborne) {
        const nextY=this.y+this.verticalSpeed*dt-4.905*dt*dt;
        if(this.verticalSpeed>0&&this.world.obstacleAt(this.x,this.z,nextY,this.radius,1.5))this.verticalSpeed=0;
        else {this.y=nextY;this.verticalSpeed-=9.81*dt;}
        if(this.verticalSpeed<=0&&this.y<=floor){this.y=floor;this.verticalSpeed=0;this.airborne=false;}
      } else {
        this.y=floor;
        if(Math.hypot(dx,dz)>.001)this.rampSlope=clamp((floor-oldY)/Math.hypot(dx,dz),0,1);
      }
    } else this.y=floor;
    const front=this.world.surfaceAt(this.x+Math.sin(h)*2,this.z-Math.cos(h)*2,this.y+.8);
    const back=this.world.surfaceAt(this.x-Math.sin(h)*2,this.z+Math.cos(h)*2,this.y+.8);
    this.pitch=clamp(Math.atan2(front-back,4)/radians,-25,25);
    if(this.airborne)this.pitch=clamp(Math.atan2(this.verticalSpeed,Math.max(1,this.movementSpeed))/radians,-25,25);
    this.roll=CAR_ASSISTS.uprightRoll;
  }
}

export function publishGround(state: FlightState, body: {x:number;y:number;z:number;heading:number;speed:number;pitch:number;roll:number}, ground: number, verticalSpeed=0) {
  Object.assign(state, {x:body.x,y:body.y,z:body.z,heading:body.heading,speed:Math.abs(body.speed),pitch:body.pitch,roll:body.roll,
    verticalSpeed,altitude:body.y,heightAboveGround:Math.max(0,body.y-ground),throttle:0,stall:false,crashed:false});
}

export function createCarController(ctx: FlightContext, physics: GroundPhysics): FlightModule {
  const {state,app,plane}=ctx, body=new CarDynamics(physics,state.vehicle==='tuned');
  body.reset(state.x,state.y,state.z,state.heading);
  let accumulator=0, wheelAngle=0;
  return { update(dt) {
    if(!Number.isFinite(dt)||dt<=0)return;
    body.radius=Math.max(2.2,...(plane.hitbox??[]).map(p=>Math.hypot(p[0],p[2])));
    const k=app.keyboard;
    const drive=Number(!!k?.isPressed(KEY_W))-Number(!!k?.isPressed(KEY_S));
    const steer=Number(!!k?.isPressed(KEY_D))-Number(!!k?.isPressed(KEY_A));
    accumulator+=Math.min(dt,.25);
    while(accumulator>=1/120){body.step({drive,steer,handbrake:!!k?.isPressed(KEY_SPACE),nitro:!!k?.isPressed(KEY_SHIFT)},1/120);accumulator-=1/120;}
    wheelAngle=(wheelAngle+body.speed*Math.min(dt,.25)/.35/radians)%360;
    for(const wheel of plane.wheels??[])wheel.setLocalEulerAngles(wheelAngle,0,0);
    publishGround(state,body,physics.surfaceAt(body.x,body.z,body.y+.35),body.verticalSpeed);
    state.speed=Math.hypot(body.movementSpeed,body.verticalSpeed);
    (state as NitroState).nitro=body.nitro;
    state.throttle=Math.max(0,drive);
    plane.root.setPosition(body.x,body.y,body.z);plane.root.setLocalEulerAngles(body.pitch,-body.heading,0);
  },destroy(){delete (state as NitroState).nitro;}};
}
