import { Quat, Vec3 } from 'playcanvas';
import { FIXED_STEP } from './model';

export interface HeliControls { forward:number; right:number; yaw:number; collective:number }
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
export class HeliDynamics {
  readonly position=new Vec3();
  readonly velocity=new Vec3();
  readonly rotation=new Quat();
  heading=0;pitch=0;roll=0;crashed=false;grounded=false;
  reset(x:number,y:number,z:number,heading:number) {
    this.position.set(x,y,z);this.velocity.set(0,0,0);this.heading=heading;
    this.pitch=this.roll=0;this.crashed=this.grounded=false;this.rotation.setFromEulerAngles(0,-heading,0);
  }
  step(input:HeliControls,groundAt:(x:number,z:number)=>number,clearance:number) {
    const dt=FIXED_STEP;
    const forward=clamp(input.forward,-1,1),right=clamp(input.right,-1,1),collective=clamp(input.collective,-1,1);
    this.heading=(this.heading+clamp(input.yaw,-1,1)*90*dt+360)%360;
    const h=this.heading*Math.PI/180, blend=1-Math.exp(-dt/.45);
    this.pitch+=(-forward*20-this.pitch)*blend;this.roll+=(right*20-this.roll)*blend;
    const tx=(Math.sin(h)*forward+Math.cos(h)*right)*80;
    const tz=(-Math.cos(h)*forward+Math.sin(h)*right)*80;
    const limit=Math.max(1,Math.hypot(tx,tz)/80);
    this.velocity.x+=(tx/limit-this.velocity.x)*blend;
    this.velocity.z+=(tz/limit-this.velocity.z)*blend;
    this.velocity.y+=(collective*15-this.velocity.y)*(1-Math.exp(-dt/1.2));
    this.position.addScaled(this.velocity,dt);
    this.position.x=clamp(this.position.x,-2980,2980);this.position.z=clamp(this.position.z,-2980,2980);
    this.position.y=Math.min(this.position.y,2500);
    const floor=groundAt(this.position.x,this.position.z)+clearance;
    this.grounded=false;
    if(this.position.y<=floor) {
      if(floor-this.position.y>.3||Math.abs(this.velocity.y)>=3||Math.abs(this.pitch)>18||Math.abs(this.roll)>18||Math.hypot(this.velocity.x,this.velocity.z)>20) this.crashed=true;
      else {this.position.y=floor;this.velocity.set(0,0,0);this.grounded=true;}
    }
    this.rotation.setFromEulerAngles(this.pitch,-this.heading,-this.roll);
  }
}
