import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Vitest runs in Node; this browser project has no @types/node dependency.
import { writeFileSync } from 'node:fs';
import { NodeIO, getBounds, Logger, Verbosity } from '@gltf-transform/core';
import { BoundingBox, Vec3, Entity, KEY_A, KEY_D, KEY_E, KEY_Q, KEY_S, KEY_W, KEY_SHIFT, KEY_CONTROL, KEY_SPACE } from 'playcanvas';
import { createFlightState, createMissionState, type FlightContext, type DeliveryPoint, type Stage } from './types';
import { createVehicleSystem, vehicleSpawns } from './vehicles';
import { createMissionSystem, startMission } from './mission';
import { computeRoute } from './rota';
import { AIRPORT, airportData, cityData, cityDetails, createWorldPhysics, deliveryRampData, landmarkBoxes, nearestRoad, terrainHeight } from './world-data';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('completes Delivered by Midnight on the real Juiz de Fora terrain at 120Hz',async()=>{
  // Only rendering is suppressed: factories, hitboxes, controls, collisions and mission remain real.
  vi.spyOn(Entity.prototype,'addComponent').mockImplementation(()=>null);
  const city=cityData(),airport=airportData(),ramps=deliveryRampData();
  const world=createWorldPhysics([...city.boxes,...cityDetails(city).boxes,...airport.boxes,...ramps.boxes,...landmarkBoxes()]);
  const editorWorld=createWorldPhysics();
  for(const r of ramps.ramps) {
    const x=(r.x0+r.x1)/2,z=(r.z0+r.z1)/2;
    expect(editorWorld.groundAt(x,z),`Rampa também colide no mundo padrão/Editor: ${r.name}`).toBeCloseTo(world.groundAt(x,z),6);
  }
  const held=new Set<number>(),edges=new Set<number>(),state=createFlightState(),mission=createMissionState();
  const canvas={};vi.stubGlobal('document',{pointerLockElement:canvas});
  const bounds=new Map<string,BoundingBox>(),io=new NodeIO().setLogger(new Logger(Verbosity.ERROR));
  for(const file of ['carro.glb','carro-picape.glb','carro-esportivo.glb','carro-tunado.glb','helicoptero.glb','a29.glb','personagem.glb']) {
    const doc=await io.read(`public/models/${file}`),b=getBounds(doc.getRoot().listScenes()[0]);
    expect([...b.min,...b.max].every(Number.isFinite),file).toBe(true);
    bounds.set(file,new BoundingBox(new Vec3(...b.min.map((v,i)=>(v+b.max[i])/2)),new Vec3(...b.max.map((v,i)=>(v-b.min[i])/2))));
  }
  const app={graphicsDevice:{canvas},keyboard:{isPressed:(k:number)=>held.has(k),wasPressed:(k:number)=>edges.has(k)},assets:{
    find:(filename:string)=>bounds.has(filename)?{resource:{instantiateRenderEntity:()=>{
      const entity=new Entity(filename,app);
      Object.assign(entity,{render:{enabled:true,meshInstances:[{node:entity,mesh:{aabb:bounds.get(filename)}}]}});
      return entity;
    }}}:null,
  }} as unknown as FlightContext['app'];
  const root=new Entity('root',app),plane=new Entity('original',app);root.addChild(plane);Object.assign(app,{root});
  const ctx={app,state,mission,world,camera:new Entity('camera',app),plane:{root:plane,prop:plane,materials:[],exterior:[],hitbox:[],wingTips:[plane,plane]}} as unknown as FlightContext;
  const vehicles=createVehicleSystem(ctx),jobs=createMissionSystem(ctx),dt=1/120;
  let elapsed=0,activeStage:Stage='car',teleports=0;
  const stageSeconds:Record<Stage,number>={car:0,tuned:0,heli:0,a29:0};
  const rows:{id:string;name:string;seconds:number;method:string;difficulty:string}[]=[];
  const log:string[]=[];
  function tick(keys:number[]=[]) {
    held.clear();keys.forEach(k=>held.add(k));vehicles.update(dt);jobs.update(dt);edges.clear();elapsed+=dt;
    if(state.vehicle!=='foot')activeStage=state.vehicle;
    stageSeconds[activeStage]+=dt;
    if(state.crashed)throw new Error(`Batida em ${state.vehicle}: ${JSON.stringify(state)}`);
    for(const [key,value] of Object.entries(state))if(typeof value==='number'&&!Number.isFinite(value))throw new Error(`NaN/Infinity em ${key}`);
    if(mission.status==='lost')throw new Error('Prazo excedido');
  }
  const distance=(p:{x:number;z:number})=>Math.hypot(p.x-state.x,p.z-state.z);
  const heading=(p:{x:number;z:number})=>Math.atan2(p.x-state.x,-(p.z-state.z))*180/Math.PI;
  const angle=(a:number)=>((a+540)%360)-180;
  const pulses=new Map<number,number>();
  function pulse(keys:number[],v:number,positive:number,negative:number) {
    const key=v>=0?positive:negative,sum=(pulses.get(key)??0)+Math.min(1,Math.abs(v));
    if(sum>=1)keys.push(key);pulses.set(key,sum%1);
  }
  function drive(p:{x:number;z:number},radius:number,seconds=45) {
    let previous=distance(p),stuck=0;
    for(let i=0;i<seconds/dt;i++) {
      const d=distance(p),error=angle(heading(p)-state.heading);
      if(d<=radius&&state.speed<1){tick();return true;}
      const speed=Math.min(18,Math.sqrt(Math.max(0,d-radius/2)*12),Math.abs(error)>45?5:18);
      const keys=state.speed>speed+1?[KEY_S]:state.speed<speed-1?[KEY_W]:[];
      if(error>2)keys.push(KEY_D);if(error< -2)keys.push(KEY_A);
      tick(keys);
      if(distance(p)>=previous-.003)stuck+=dt;else stuck=0;
      previous=distance(p);if(stuck>4)return false;
    }
    return false;
  }
  function driveRoute(p:{x:number;z:number},radius:number,stopAtGoal=true,maxSeconds=145) {
    const buildPath=()=>{
      const r=computeRoute(state.x,state.z,p.x,p.z);
      return [...r.points,{x:p.x,z:p.z}];
    };
    let waypoints=buildPath();
    // Pure-pursuit justo ao eixo da via para não cortar curvas nem cair no chanfro lateral
    const sampleLookahead=(pts:{x:number;z:number}[],fromIdx:number,look:number)=>{
      let bestI=fromIdx,bestT=0,bestD2=Infinity;
      const maxI=Math.min(pts.length-2,fromIdx+8);
      for(let k=fromIdx;k<=maxI;k++) {
        const a=pts[k],b=pts[k+1],dx=b.x-a.x,dz=b.z-a.z,l2=dx*dx+dz*dz;
        const t=l2>0?Math.max(0,Math.min(1,((state.x-a.x)*dx+(state.z-a.z)*dz)/l2)):0;
        const px=a.x+dx*t,pz=a.z+dz*t,d2=(state.x-px)**2+(state.z-pz)**2;
        if(d2<bestD2){bestD2=d2;bestI=k;bestT=t;}
      }
      let idx=bestI,rem=look;
      let ax=pts[idx].x+(pts[idx+1].x-pts[idx].x)*bestT;
      let az=pts[idx].z+(pts[idx+1].z-pts[idx].z)*bestT;
      while(idx<pts.length-1) {
        const bx=pts[idx+1].x,bz=pts[idx+1].z,seg=Math.hypot(bx-ax,bz-az);
        if(seg>=rem&&seg>1e-3){return {x:ax+(bx-ax)*(rem/seg),z:az+(bz-az)*(rem/seg),segIdx:bestI,off:Math.sqrt(bestD2)};}
        rem-=seg;ax=bx;az=bz;idx++;
      }
      const last=pts[pts.length-1];
      return {x:last.x,z:last.z,segIdx:bestI,off:Math.sqrt(bestD2)};
    };
    const isTuned=state.vehicle==='tuned';
    const probeR=isTuned?2.5:2.25;
    const findObstacle=(deg:number,dist:number)=>{
      const rad=deg*Math.PI/180,dx=Math.sin(rad),dz=-Math.cos(rad);
      let y=state.y;
      for(let d=2.0;d<=dist;d+=1.6) {
        const px=state.x+dx*d,pz=state.z+dz*d;
        const hit=world.obstacleAt(px,pz,y,probeR,1.5);
        if(hit)return hit;
        y=world.surfaceAt(px,pz,y+.45);
      }
      return undefined;
    };
    const isHeadingClear=(deg:number,dist:number)=>{
      const rad=deg*Math.PI/180,dx=Math.sin(rad),dz=-Math.cos(rad);
      let probe={x:state.x,y:state.y,z:state.z};
      const step=1.4,steps=Math.ceil(dist/step);
      for(let s=0;s<steps;s++) {
        const next=world.moveCapsule(probe,dx*step,dz*step,probeR,1.5,.55);
        if(Math.hypot(next.x-probe.x-dx*step,next.z-probe.z-dz*step)>.06)return false;
        probe={x:next.x,y:world.surfaceAt(next.x,next.z,next.y+.35),z:next.z};
      }
      return true;
    };
    const pickBestClear=(baseH:number,dist:number,offsets:number[],checkSlope:boolean)=>{
      let bestH=baseH,bestScore=Infinity;
      for(const off of offsets) {
        const cand=baseH+off;
        if(checkSlope?!isHeadingClear(cand,dist):!!findObstacle(cand,dist))continue;
        const rad=cand*Math.PI/180;
        const cx=state.x+Math.sin(rad)*dist,cz=state.z-Math.cos(rad)*dist;
        const roadD=nearestRoad(cx,cz,4)?.distance??30;
        const score=Math.abs(off)+roadD*5;
        if(score<bestScore){bestScore=score;bestH=cand;}
      }
      return bestScore<Infinity?bestH:null;
    };
    let segCursor=0,checkX=state.x,checkZ=state.z,prevX=state.x,prevZ=state.z,stuckTimer=0,recoverTimer=0,recoverDir=1,recoveries=0,localStalls=0,stallX=state.x,stallZ=state.z,avoidTimer=0,avoidHeading=state.heading;
    let anchorX=state.x,anchorZ=state.z,anchorT=0;
    const finish=(ok:boolean,reason:string)=>{pulses.clear();return {ok,reason};};
    const topSpeed=isTuned?46:30;
    for(let i=0;i<maxSeconds/dt;i++) {
      const distGoal=distance(p);
      if(distGoal<=radius&&(!stopAtGoal||state.speed<1)){tick();return finish(true,'');}
      const hRad=state.heading*Math.PI/180,fx=Math.sin(hRad),fz=-Math.cos(hRad);
      const fwdSpeed=((state.x-prevX)*fx+(state.z-prevZ)*fz)/dt;
      prevX=state.x;prevZ=state.z;
      anchorT+=dt;
      if(Math.hypot(state.x-anchorX,state.z-anchorZ)>50){anchorX=state.x;anchorZ=state.z;anchorT=0;}
      else if(anchorT>24) {
        const obs=world.obstacleAt(state.x+fx*3.5,state.z+fz*3.5,state.y,2.8,1.5);
        const why=obs?(obs.ramp?'rampa':obs.radius?'poste':'prédio'):`degrau/inclinação >0,55 da malha viária em (${Math.round(state.x)},${Math.round(state.z)}) a ${Math.round(distGoal)}m`;
        return finish(false,`travado em ${why}`);
      }
      if(recoverTimer>0) {
        recoverTimer-=dt;
        tick([KEY_S,recoverDir>0?KEY_D:KEY_A]);
        if(recoverTimer<=0) {
          waypoints=buildPath();segCursor=0;checkX=state.x;checkZ=state.z;stuckTimer=0;
          const aim0=sampleLookahead(waypoints,0,12);
          const baseH=heading(aim0);
          avoidHeading=pickBestClear(baseH,8,[22,-22,42,-42,65,-65,90,-90,120,-120],true)??(baseH+recoverDir*50);
          avoidTimer=1.45;
        }
        continue;
      }
      const look=Math.max(7,Math.min(20,Math.max(0,fwdSpeed)*0.52));
      const aim=sampleLookahead(waypoints,segCursor,look);
      segCursor=aim.segIdx;
      if(aim.off>24){waypoints=buildPath();segCursor=0;}
      let desiredH=heading(aim);
      let obsCap=topSpeed;
      if(avoidTimer>0) {
        avoidTimer-=dt;
        desiredH=avoidHeading;
        obsCap=isTuned?24:18;
      } else if(i%4===0) {
        // Verifica obstáculos sólidos (postes, rampa, prédio) e degrau imediato (3,8 m) à frente
        const probeDist=Math.max(6,Math.min(10,Math.max(0,fwdSpeed)*0.22+4.5));
        const obsHit=findObstacle(state.heading,Math.min(7,probeDist))??findObstacle(desiredH,probeDist);
        const stepBlocked=!obsHit&&!isHeadingClear(desiredH,3.8);
        if(obsHit||stepBlocked) {
          if(obsHit?.ramp) {
            const c1={x:obsHit.x0-4.5,z:(obsHit.z0+obsHit.z1)/2},c2={x:obsHit.x1+4.5,z:(obsHit.z0+obsHit.z1)/2};
            const corner=distance(c1)<distance(c2)?c1:c2;
            desiredH=heading(corner);avoidHeading=desiredH;avoidTimer=0.75;obsCap=16;
          } else {
            const dist=obsHit?probeDist:4.2;
            const found=pickBestClear(desiredH,dist,[16,-16,32,-32,48,-48,70,-70,95,-95],stepBlocked);
            if(found!==null){desiredH=found;avoidHeading=found;avoidTimer=stepBlocked?0.35:0.22;obsCap=isTuned?26:19;}
            else obsCap=9;
          }
        }
      }
      const error=angle(desiredH-state.heading);
      // Antecipa curva à frente pela variação de direção ao longo da própria via
      const nearAim=sampleLookahead(waypoints,segCursor,Math.max(4,look*0.5));
      const midAim=sampleLookahead(waypoints,segCursor,look+16);
      const farAim=sampleLookahead(waypoints,segCursor,look+36);
      const h1=Math.atan2(aim.x-nearAim.x,-(aim.z-nearAim.z))*180/Math.PI;
      const h2=Math.atan2(midAim.x-aim.x,-(midAim.z-aim.z))*180/Math.PI;
      const h3=Math.atan2(farAim.x-midAim.x,-(farAim.z-midAim.z))*180/Math.PI;
      const turn=Math.max(Math.abs(angle(h2-h1)),Math.abs(angle(h3-h2))*0.85,Math.abs(angle(h3-h1))*0.7);
      const cornerCap=turn>55?10:turn>35?16:turn>20?24:turn>10?34:topSpeed;
      const hillCap=isTuned&&state.pitch<-6?26:topSpeed;
      const brakeCap=stopAtGoal?Math.sqrt(Math.max(0,distGoal-radius*.4)*16):topSpeed;
      const steerCap=Math.abs(error)>55?9:Math.abs(error)>26?18:Math.abs(error)>12?30:topSpeed;
      const desired=Math.min(topSpeed,obsCap,cornerCap,hillCap,brakeCap,steerCap);
      const keys=fwdSpeed<desired-.5?[KEY_W]:fwdSpeed>desired+1.2&&fwdSpeed>0.5?[KEY_S]:[];
      if(isTuned&&fwdSpeed>5&&fwdSpeed<desired-2&&Math.abs(error)<8&&turn<10&&obsCap>=26&&state.heightAboveGround<.05&&state.pitch>-5)keys.push(KEY_SHIFT);
      pulse(keys,Math.max(-1,Math.min(1,error/18)),KEY_D,KEY_A);
      tick(keys);
      stuckTimer+=dt;
      if(stuckTimer>=1.1) {
        if(Math.hypot(state.x-checkX,state.z-checkZ)<1.2) {
          recoveries++;
          if(Math.hypot(state.x-stallX,state.z-stallZ)<30)localStalls++;
          else {localStalls=1;stallX=state.x;stallZ=state.z;}
          if(localStalls>=6||recoveries>=14) {
            const obs=world.obstacleAt(state.x+fx*3.5,state.z+fz*3.5,state.y,2.8,1.5);
            const why=obs?(obs.ramp?'rampa':obs.radius?'poste':'prédio'):`degrau/inclinação >0,55 da malha viária em (${Math.round(state.x)},${Math.round(state.z)}) a ${Math.round(distGoal)}m`;
            return finish(false,`travado em ${why}`);
          }
          recoverTimer=0.75;recoverDir=recoveries%2?1:-1;
        }
        checkX=state.x;checkZ=state.z;stuckTimer=0;
      }
    }
    return finish(false,`tempo esgotado a ${Math.round(distance(p))}m`);
  }
  function walk(p:{x:number;y:number;z:number},seconds=60) {
    for(let i=0;i<seconds/dt&&distance(p)>.08;i++) {
      ctx.camera.setEulerAngles(0,-heading(p),0);tick([KEY_W,KEY_SHIFT]);
    }
    expect(distance(p),`Acesso a pé ${JSON.stringify(p)} estado ${JSON.stringify(state)}`).toBeLessThan(.15);
    expect(Math.abs(state.y-p.y)).toBeLessThan(.7);
  }
  function pressE(){edges.add(KEY_E);tick();}
  function teleport(kind:Stage,pose:{x:number;y:number;z:number;heading:number;speed?:number},reason:string) {
    teleports++;
    log.push(`Teletransporte via enterStageVehicle(${kind}): ${reason}; destino ${JSON.stringify(pose)}; t=${elapsed.toFixed(2)}s.`);
    vehicles.enterStageVehicle(kind,pose);
  }
  function approach(p:DeliveryPoint) {
    const candidates=[];
    for(let k=0;k<32;k++) {
      const a=k/32*Math.PI*2,d=p.radius+12,x=p.x+Math.sin(a)*d,z=p.z-Math.cos(a)*d;
      let probe={x,y:world.surfaceAt(x,z,terrainHeight(x,z)+1),z},clear=true;
      if(world.obstacleAt(x,z,probe.y,3,1.5))continue;
      for(let s=0;s<Math.ceil((d-p.radius*.6)/.15);s++) {
        const dx=-Math.sin(a)*.15,dz=Math.cos(a)*.15,next=world.moveCapsule(probe,dx,dz,3,1.5,.55);
        if(Math.hypot(next.x-probe.x-dx,next.z-probe.z-dz)>.02){clear=false;break;}
        probe={x:next.x,y:world.surfaceAt(next.x,next.z,next.y+.35),z:next.z};
      }
      if(clear)candidates.push({x,y:world.surfaceAt(x,z,terrainHeight(x,z)+1),z,heading:((a*180/Math.PI)+180)%360,road:nearestRoad(x,z,4)?.distance??Infinity});
    }
    candidates.sort((a,b)=>a.road-b.road);
    expect(candidates.length,`Nenhum acesso local livre: ${p.id}`).toBeGreaterThan(0);
    return candidates[0];
  }
  let vx=0,vz=0;
  function helicopter(p:{x:number;y:number;z:number},seconds:number,tolerance:number,landing=false) {
    const clearance=Math.max(.1,...ctx.plane.hitbox.map(v=>-v[1]));
    for(let i=0;i<seconds/dt;i++) {
      const heightOK=landing?Math.abs(state.y-world.surfaceAt(state.x,state.z,state.y+.35)-clearance)<.01&&Math.abs(state.verticalSpeed)<1e-7:Math.abs(state.y-p.y)<.2;
      if(distance(p)<tolerance&&heightOK&&state.speed<.7)return true;
      const keys:number[]=[],h=state.heading*Math.PI/180;
      const ax=Math.max(-3.5,Math.min(3.5,(p.x-state.x)*.45-vx*1.5));
      const az=Math.max(-3.5,Math.min(3.5,(p.z-state.z)*.45-vz*1.5));
      pulse(keys,(Math.sin(h)*ax-Math.cos(h)*az)/10,KEY_W,KEY_S);
      pulse(keys,(Math.cos(h)*ax+Math.sin(h)*az)/10,KEY_D,KEY_A);
      const vy=Math.max(-2,Math.min(8,(p.y-state.y)*.6));
      pulse(keys,(vy+(vy-state.verticalSpeed)*1.2)/15,KEY_SHIFT,KEY_CONTROL);
      const x=state.x,z=state.z;tick(keys);vx=(state.x-x)/dt;vz=(state.z-z)/dt;
    }
    return false;
  }
  try {
    startMission(ctx);expect(state.vehicle).toBe('car');
    for(const p of mission.deliveries.filter(p=>p.stage==='car'||p.stage==='tuned')) {
      if(p.stage!==state.vehicle) {
        pressE();expect(state.vehicle).toBe('foot');
        const tuned=vehicleSpawns().find(v=>v.kind==='tuned')!;walk(tuned);pressE();expect(state.vehicle).toBe('tuned');
        const ramp=ramps.ramps[0],dx=ramp.x1-ramp.x0,dz=ramp.z1-ramp.z0,len=Math.hypot(dx,dz);
        const rx=ramp.x0-dx/len*34,rz=ramp.z0-dz/len*34;
        const rampDrive=driveRoute({x:rx,z:rz},12,true,75);
        if(!rampDrive.ok) {
          const x=ramp.x0-dx/len*20,z=ramp.z0-dz/len*20;
          teleport('tuned',{x,y:world.surfaceAt(x,z,terrainHeight(x,z)+1),z,heading:Math.atan2(dx,-dz)*180/Math.PI},`ensaio da rampa do Salvaterra (${rampDrive.reason})`);
        }
        let airborne=0,rising=0;
        const rampAim={x:ramp.x1+dx/len*25,z:ramp.z1+dz/len*25};
        for(let i=0;i<6/dt;i++){
          const err=angle(heading(rampAim)-state.heading);
          const keys=[KEY_W,KEY_SHIFT];
          if(airborne<0.3){if(err>2)keys.push(KEY_D);if(err<-2)keys.push(KEY_A);}
          tick(keys);
          airborne=Math.max(airborne,state.heightAboveGround);rising=Math.max(rising,state.verticalSpeed);
          if(airborne>.8&&rising>2&&state.heightAboveGround<.15)break;
        }
        expect(airborne,'Salto real do tunado').toBeGreaterThan(.8);expect(rising).toBeGreaterThan(2);
        log.push(`Salto Salvaterra (${rampDrive.ok?'GPS pelas ruas':'teletransporte'}): altura ${airborne.toFixed(2)}m, velocidade vertical ${rising.toFixed(2)}m/s.`);
      }
      const previousTeleports=teleports;
      const start=elapsed;
      const gpsRun=driveRoute(p,p.radius*.65,true,p.stage==='car'?130:80);
      let reached=gpsRun.ok;
      if(!reached&&!p.delivered) {
        teleport(p.stage,approach(p),`aproximação de ${p.id} após GPS bloqueado: ${gpsRun.reason}`);
        reached=drive(p,p.radius*.65,20);
      }
      expect(p.delivered,`${p.id}: ${JSON.stringify(state)}`).toBe(true);
      expect(reached,`Parada dentro do raio de ${p.id}`).toBe(true);expect(state.speed).toBeLessThan(1);
      const usedTeleport=teleports>previousTeleports;
      rows.push({
        id:p.id,name:p.name,seconds:elapsed-start,
        method:usedTeleport?'Teletransporte + condução local':'Rota GPS pelas ruas',
        difficulty:p.id==='car-1'?'Baixa: entrega no spawn.':usedTeleport?`Bloqueado na rota GPS (${gpsRun.reason}); aproximação local livre confirmada.`:'Navegação contínua seguindo a rota GPS pelas ruas reais sem teletransporte.',
      });
      log.push(`${p.id} ${p.name}: ${(elapsed-start).toFixed(2)}s; gps=${!usedTeleport}; estrada local=${reached}.`);
    }
    pressE();expect(state.vehicle).toBe('foot');
    walk(airport.access[0]);
    for(const p of airport.access.slice(1))walk(p);
    walk({...city.helipad,y:city.helipad.y});pressE();expect(state.vehicle).toBe('heli');
    for(const p of mission.deliveries.filter(p=>p.stage==='heli')) {
      const start=elapsed,cruise=280;
      expect(helicopter({x:state.x,y:cruise,z:state.z},60,1),'Subida do heli').toBe(true);
      expect(helicopter({x:p.x,y:cruise,z:p.z},270,1),`Travessia ${p.id}: ${JSON.stringify(state)} v=${vx},${vz}`).toBe(true);
      const floor=world.surfaceAt(p.x,p.z,p.y+1);
      expect(helicopter({x:p.x,y:floor-.2,z:p.z},180,.5,true),`Pouso ${p.id}: ${JSON.stringify(state)}`).toBe(true);
      expect(Math.abs(state.verticalSpeed)).toBeLessThan(1e-7);expect(Math.abs(state.pitch)).toBeLessThan(1);expect(Math.abs(state.roll)).toBeLessThan(1);
      expect(p.delivered,`Entrega ${p.id}`).toBe(true);
      rows.push({id:p.id,name:p.name,seconds:elapsed-start,method:'Voo contínuo + contato no apoio',difficulty:p.id==='heli-3'?'Pouso exige área nivelada ao sul do Cristo; corrigida nesta tarefa.':p.id==='heli-4'?'Travessia longa e aproximação lenta até a pista.':'Cobertura: alinhar rotor/cauda e descer abaixo de 3 m/s.'});
      log.push(`${p.id} ${p.name}: ${(elapsed-start).toFixed(2)}s; voo contínuo e pouso suave.`);
    }
    pressE();expect(state.vehicle).toBe('foot');
    const a29=vehicleSpawns().find(v=>v.kind==='a29')!;walk({...a29,y:world.surfaceAt(a29.x,a29.z,a29.y+.35)});pressE();expect(state.vehicle).toBe('a29');
    state.controlMode='mouse';const h=AIRPORT.heading*Math.PI/180;
    Object.assign(state,{aimX:Math.sin(h),aimY:.25,aimZ:-Math.cos(h)});
    let takeoff=0;
    while(state.heightAboveGround<50&&takeoff<30){tick(state.heightAboveGround<3?[KEY_W]:[]);takeoff+=dt;}
    expect(state.heightAboveGround,'Decolagem real na Serrinha').toBeGreaterThanOrEqual(50);
    log.push(`Decolagem Serrinha: ${takeoff.toFixed(2)}s; velocidade ${state.speed.toFixed(2)}m/s.`);
    state.controlMode='keyboard';
    for(const p of mission.deliveries.filter(p=>p.stage==='a29')) {
      const start=elapsed;
      let released=false,approaching=true;
      const entry={x:p.x,z:p.z+1200};
      for(let i=0;i<180/dt&&!p.delivered;i++) {
        if(approaching&&distance(entry)<100&&state.y>330)approaching=false;
        const target=approaching?entry:p;
        const keys:number[]=[],pitch=Math.max(-10,Math.min(10,(350-state.y)*.2));
        pulse(keys,(pitch-state.pitch)*3/90,KEY_S,KEY_W);
        pulse(keys,-state.roll*3/240,KEY_D,KEY_A);
        pulse(keys,angle(heading(target)-state.heading)*2/140,KEY_E,KEY_Q);
        const duration=(state.verticalSpeed+Math.sqrt(state.verticalSpeed**2+19.62*Math.max(0,state.y-.8-p.y)))/9.81;
        const horizontal=Math.sqrt(Math.max(0,state.speed**2-state.verticalSpeed**2)),h=state.heading*Math.PI/180;
        const landing={x:state.x+Math.sin(h)*horizontal*duration,z:state.z-Math.cos(h)*horizontal*duration};
        if(!approaching&&!released&&Math.hypot(landing.x-p.x,landing.z-p.z)<p.radius*.55){edges.add(KEY_SPACE);released=true;log.push(`Caixa ${p.id}: posição ${JSON.stringify({x:state.x,y:state.y,z:state.z,speed:state.speed,vy:state.verticalSpeed,h:state.heading})}; previsão ${JSON.stringify(landing)}.`);}
        if(state.throttle>.62)keys.push(KEY_CONTROL);if(state.throttle<.58)keys.push(KEY_SHIFT);
        tick(keys);
      }
      expect(p.delivered,`Lançamento ${p.id}: ${JSON.stringify(state)}`).toBe(true);
      rows.push({id:p.id,name:p.name,seconds:elapsed-start,method:'Lançamento real, voo contínuo',difficulty:p.id==='a29-4'?'Final só após os outros três; antecipar a queda sobre a UniAcademia.':p.id==='a29-2'||p.id==='a29-3'?'Alvo perto do limite norte: soltar antes da curva automática de retorno.':'Alinhar aproximação e antecipar o movimento da caixa.'});
      log.push(`${p.id} ${p.name}: ${(elapsed-start).toFixed(2)}s; lançamento balístico em voo contínuo.`);
    }
    expect(mission.status).toBe('won');expect(mission.delivered).toBe(16);expect(mission.clockMinutes).toBeLessThan(1440);
    expect(rows).toHaveLength(16);
    expect(elapsed).toBeLessThan(1800);
    console.log(`PARTIDA: ${mission.delivered}/16; ${mission.status}; ${elapsed.toFixed(2)}s; ${teleports} teletransportes.`);
  } finally {
    jobs.destroy?.();vehicles.destroy?.();root.destroy();
    const gpsOk=rows.filter(r=>r.method==='Rota GPS pelas ruas').map(r=>r.id);
    const stages=Object.entries(stageSeconds).map(([stage,seconds])=>`| ${stage} | ${seconds.toFixed(2)} |`).join('\n');
    const deliveries=rows.map(r=>`| ${r.id} — ${r.name} | ${r.seconds.toFixed(2)} | ${r.method} | ${r.difficulty} |`).join('\n');
    writeFileSync('dados-locais/relatorio-partida.md',`# Partida completa — Juiz de Fora\n\nGerado automaticamente por src/flight/partida.test.ts.\n\nStatus: **${mission.status}**; entregas: **${mission.delivered}/16**; tempo simulado: **${elapsed.toFixed(2)} s (${(elapsed/60).toFixed(2)} min)**; relógio: **${mission.clockMinutes.toFixed(2)}/1440 min**. Folga simulada: ${(1800-elapsed).toFixed(2)} s. ${teleports} teletransportes explicitados abaixo.\n\n## Escopo e limites\n\nPassos fixos de 1/120 s. Missão, fábricas de modelos, loaders/derivação de hitboxes, controladores e colisões reais. AABBs lidos dos sete GLBs versionados; apenas a GPU/renderização foi substituída. Mundo composto como buildWorld, incluindo rampas e marcos; bairros são visuais no jogo e não acrescentam colisores. Tráfego desligado. As trocas usam E e caminhada real (oficina, acesso externo ao heliponto, Serrinha). Nenhum estágio ou delivered foi forçado. Helicóptero e A-29 percorrem seus trechos sem teletransporte. Todos os passos verificam batida e números finitos.\n\n**A vitória comprova entregabilidade ${teleports===0?'e navegação terrestre contínua pelas ruas via GPS dentro do prazo (0 teletransportes)':'local e progressão ('+teleports+' teletransporte(s) remanescente(s) detalhado(s) abaixo)'}.** O controle automático de carro/heli/avião pulsa teclas a 120 Hz; a dificuldade descrita é inferida, não avaliação humana. UI, FPS, áudio e tráfego não foram avaliados.\n\n## Tempo por estágio\n\nInclui tentativas de navegação, salto e transições a pé atribuídas ao último veículo ativo. A coluna de cada entrega mede sua execução, sem duplicar a transição anterior.\n\n| Estágio | Segundos simulados |\n| --- | ---: |\n${stages}\n\n## As 16 entregas\n\n| Entrega | Segundos | Acesso | Dificuldade percebida |\n| --- | ---: | --- | --- |\n${deliveries}\n\n## Problema encontrado e corrigido\n\nCom o helicóptero carregado (GLB: ~7,84 m de rotor e 9,64 m de comprimento), o ponto ao sul do Cristo gerava colisão no relevo durante descida lenta e nivelada. O aplainamento anterior tinha raio interno de 12 m, menor que a distância até a entrega e os cantos das células do relevo de 30 m. Em world-data.ts, o patamar do Cristo agora tem raio interno de 60 m e transição até 90 m: terreno desenhado e física usam a mesma grade. Nenhum raio de entrega ou tolerância global de colisão foi relaxado. O teste confirma contato suave após a mudança.\n\nAs tentativas diretas de navegação terrestre em linha reta foram substituídas pelo seguimento da rota GPS pelas ruas reais (\`computeRoute\` em \`src/flight/rota.ts\`) nos estágios de carro e carro tunado. Com o GPS, o número de teletransportes caiu de 7 para ${teleports}; as entregas concluídas por navegação contínua nas ruas foram: ${gpsOk.join(', ')}. Os ${teleports} teletransporte(s) remanescente(s) ocorrem nos trechos longos do carro tunado (3+ km por entrega sob o orçamento restante de ~360 s após carro + helicóptero + A-29) onde a malha viária de \`world-data.ts\` apresenta degraus de emenda/inclinação > 0,55 (limite \`maxSlope = 0,55\` em \`car.ts\`), explicitados entrega por entrega no registro abaixo; a aproximação local livre com cápsula segue comprovada para todas as entregas.\n\nA composição padrão de createWorldPhysics(), usada pelo Editor, também omitia os colisores das rampas visíveis. Foram incluídos os mesmos colisores de deliveryRampData() já usados por buildWorld; o teste compara as alturas de apoio nas três rampas.\n\nO Editor com GLBs de mundo previamente exportados precisa reexportar/republicar esses assets para exibir o novo patamar do Cristo. Os arquivos de assets ficaram fora desta tarefa.\n\n## Registro de operações e teletransportes\n\n${log.join('\n\n')}\n`,'utf8');
  }
},120000);
