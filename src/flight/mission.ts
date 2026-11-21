import { Color, Entity, KEY_SPACE, StandardMaterial } from 'playcanvas';
import { createMissionState, STAGE_ORDER, type DeliveryPoint, type FlightContext, type FlightModule, type Stage, type VehicleKind } from './types';
import { AIRPORT, CITY_Y, WORKSHOP, airportData, cityData, deliveryRampData, terrainHeight } from './world-data';

export const DAY_REAL_SECONDS = 30 * 60;
export const CLOCK_MINUTES_PER_SECOND = 1440 / DAY_REAL_SECONDS;
const restartHandlers = new WeakMap<FlightContext, Set<() => void>>();
const stageNames: Record<Stage,string> = {car:'carro',tuned:'tunado',heli:'helicóptero',a29:'A-29'};

export function onMissionRestart(ctx:FlightContext,handler:()=>void) {
  let handlers=restartHandlers.get(ctx);
  if(!handlers)restartHandlers.set(ctx,handlers=new Set());
  handlers.add(handler);
  return ()=>handlers!.delete(handler);
}

export function deliveryPoints():DeliveryPoint[] {
  const city=cityData(),access=airportData(city.helipad).access[0],ramps=deliveryRampData().ramps;
  const roof=(x:number,z:number)=>[...city.boxes].sort((a,b)=>Math.hypot((a.x0+a.x1)/2-x,(a.z0+a.z1)/2-z)-Math.hypot((b.x0+b.x1)/2-x,(b.z0+b.z1)/2-z))[0];
  const a=roof(350,-300),b=roof(-400,200);
  let peak={x:-2000,z:-1600,y:0};
  for(let x=-2400;x<=-1400;x+=100)for(let z=-2200;z<=-1000;z+=100) {
    const y=terrainHeight(x,z);if(y>peak.y)peak={x,y,z};
  }
  let beachZ=500;
  for(let z=500;z<=650;z+=5)if(terrainHeight(1050,z)>1&&terrainHeight(1050,z)<6){beachZ=z;break;}
  const points:DeliveryPoint[]=[];
  const add=(stage:Stage,name:string,x:number,y:number,z:number,radius:number,leadsToNext=false,airDrop=false)=>{
    points.push({id:`${stage}-${points.filter(p=>p.stage===stage).length+1}`,stage,name,x,y,z,radius,leadsToNext,airDrop,delivered:false});
  };
  add('car','Dona Buzina — Padaria do Pneu',38,CITY_Y,-450,11);
  add('car','Seu Mingau — Praça do Guarda-Chuva',-306,CITY_Y,-106,11);
  add('car','Nina Cupom — Correio do Atraso',382,CITY_Y,238,11);
  add('car','Beto Rosca — Oficina do Parafuso Perdido',WORKSHOP.x,WORKSHOP.y,WORKSHOP.z,11,true);
  add('tuned','Téo Troco — Salto do Recibo',ramps[0].x1-3,ramps[0].y1-.5,ramps[0].z1,13);
  add('tuned','Vó Faísca — Morro da Nota Fiscal',ramps[1].x1+3,ramps[1].y1,ramps[1].z1,15);
  add('tuned','Lola Farofa — Praia do Frete Grátis',1050,Math.max(0,terrainHeight(1050,beachZ)),beachZ,20);
  add('tuned','Ivo Elevador — Portaria do Quase Céu',access.x,access.y,access.z,12,true);
  add('heli','Lia Antena — Cobertura Sem Sinal',(a.x0+a.x1)/2,a.top,(a.z0+a.z1)/2,14);
  add('heli','Zeca Garoa — Varal das Nuvens',(b.x0+b.x1)/2,b.top,(b.z0+b.z1)/2,14);
  add('heli','Doutora Eco — Pico do Café Frio',peak.x,peak.y,peak.z,24);
  add('heli','Capitão Canhoto — Pista do Vento Entregador',AIRPORT.x-22,AIRPORT.y,410,12,true);
  add('a29','Cida Maré — Guarda-Sol Solitário',2100,0,1500,80,false,true);
  add('a29','Otto Pedregulho — Chalé do Cadê',-2400,Math.max(0,terrainHeight(-2400,300)),300,85,false,true);
  add('a29','Bia Horizonte — Mirante do Fim do Mapa',2200,Math.max(0,terrainHeight(2200,-1800)),-1800,85,false,true);
  add('a29','Dona Meia-Noite — Centro do Último Carimbo',0,CITY_Y,-110,85,false,true);
  return points;
}

export function startMission(ctx:FlightContext) {
  const mission=ctx.mission??=createMissionState();
  const deliveries=deliveryPoints();
  Object.assign(mission,createMissionState(),{status:'playing',deliveries,total:deliveries.length});
  for(const restart of restartHandlers.get(ctx)??[])restart();
}

export function canEnterVehicle(ctx:FlightContext,kind:VehicleKind) {
  if(kind==='foot'||!ctx.mission)return true;
  const mission=ctx.mission;
  if(STAGE_ORDER.indexOf(kind)<=STAGE_ORDER.indexOf(mission.stage))return true;
  mission.message=`Termine as entregas do ${stageNames[mission.stage]} primeiro`;
  mission.messageTimer=4;
  return false;
}

interface Drop {x:number;y:number;z:number;vx:number;vy:number;vz:number;entity?:Entity}
export function createMissionSystem(ctx:FlightContext):FlightModule {
  const mission=ctx.mission??=createMissionState();
  if(!mission.deliveries.length){mission.deliveries=deliveryPoints();mission.total=mission.deliveries.length;}
  const drops:Drop[]=[];
  let material:StandardMaterial|undefined;
  const clear=()=>{for(const drop of drops)drop.entity?.destroy();drops.length=0;};
  const unsubscribe=onMissionRestart(ctx,clear);
  function message(text:string){mission.message=text;mission.messageTimer=4;}
  function pending(stage:Stage|null=mission.carrying) {
    const points=mission.deliveries.filter(p=>p.stage===stage&&!p.delivered);
    return points.length>1?points.filter(p=>!p.leadsToNext&&p.id!=='a29-4'):points;
  }
  function deliver(point:DeliveryPoint) {
    if(point.delivered)return;
    point.delivered=true;mission.delivered++;
    const points=100+Math.floor((1440-mission.clockMinutes)/12);
    mission.score+=points;message(`Entregue a ${point.name.split(' — ')[0]}! +${points}`);
    if(mission.delivered===mission.total){mission.status='won';mission.carrying=null;mission.nextDeliveryId=null;clear();return;}
    if(!mission.deliveries.some(p=>p.stage===mission.stage&&!p.delivered)) {
      mission.stage=STAGE_ORDER[STAGE_ORDER.indexOf(mission.stage)+1];
      message(`${stageNames[mission.stage]} liberado! Próxima marcha do expediente.`);
    }
  }
  function loadAndTarget() {
    const kind=ctx.state.vehicle;
    mission.carrying=kind!=='foot'&&STAGE_ORDER.indexOf(kind)<=STAGE_ORDER.indexOf(mission.stage)
      &&mission.deliveries.some(p=>p.stage===kind&&!p.delivered)?kind:null;
    const nearest=pending().sort((a,b)=>Math.hypot(a.x-ctx.state.x,a.y-ctx.state.y,a.z-ctx.state.z)-Math.hypot(b.x-ctx.state.x,b.y-ctx.state.y,b.z-ctx.state.z))[0];
    mission.nextDeliveryId=nearest?.id??null;
  }
  function release() {
    if(drops.length>=8){message('Espere as caixas pousarem!');return;}
    const state=ctx.state,h=state.heading*Math.PI/180;
    const horizontal=Math.sqrt(Math.max(0,state.speed**2-state.verticalSpeed**2));
    const drop:Drop={x:state.x,y:state.y-.8,z:state.z,vx:Math.sin(h)*horizontal,vy:state.verticalSpeed,vz:-Math.cos(h)*horizontal};
    if(ctx.app.graphicsDevice&&ctx.app.systems?.render) {
      if(!material){material=new StandardMaterial();material.diffuse=new Color(.65,.36,.12);material.update();}
      drop.entity=new Entity('Encomenda da meia-noite',ctx.app);
      drop.entity.addComponent('render',{type:'box',material,castShadows:false});drop.entity.setLocalScale(.9,.9,.9);
      (ctx.plane.root.parent??ctx.app.root).addChild(drop.entity);drop.entity.setPosition(drop.x,drop.y,drop.z);
    }
    drops.push(drop);message('Caixa a caminho!');
  }
  return {update(dt) {
    if(!Number.isFinite(dt)||dt<=0||mission.status!=='playing')return;
    mission.messageTimer=Math.max(0,mission.messageTimer-dt);if(!mission.messageTimer)mission.message=null;
    mission.clockMinutes=Math.min(1440,mission.clockMinutes+dt*CLOCK_MINUTES_PER_SECOND);
    if(mission.clockMinutes>=1440){mission.status='lost';mission.carrying=null;mission.nextDeliveryId=null;message('Meia-noite! O frete virou abóbora.');clear();return;}
    loadAndTarget();
    const state=ctx.state;
    if(!state.crashed) {
      if(mission.carrying==='a29') {if(ctx.app.keyboard?.wasPressed(KEY_SPACE))release();}
      else for(const p of pending()) {
        const distance=Math.hypot(p.x-state.x,p.z-state.z);
        const height=state.y-p.y;
        const canDeliver=mission.carrying==='heli'?height>=-.5&&height<10&&state.heightAboveGround<10&&Math.abs(state.verticalSpeed)<3&&state.speed<8:Math.abs(height)<3&&state.speed<8;
        if(distance<=p.radius&&canDeliver){deliver(p);break;}
      }
    }
    let remaining=dt;
    while(drops.length&&remaining>0&&mission.status==='playing') {
      const step=Math.min(remaining,1/60);remaining-=step;
      for(let i=drops.length-1;i>=0;i--) {
        const d=drops[i];d.x+=d.vx*step;d.z+=d.vz*step;d.y+=d.vy*step-4.905*step*step;d.vy-=9.81*step;
        d.entity?.setPosition(d.x,d.y,d.z);
        if(d.y<=ctx.world.groundAt(d.x,d.z)+.45) {
          d.entity?.destroy();drops.splice(i,1);
          const target=pending('a29').find(p=>Math.hypot(p.x-d.x,p.z-d.z)<=p.radius);
          if(target)deliver(target);else message('Endereço errado. A gaivota agradece!');
          if(mission.status!=='playing')break;
        }
      }
    }
    if(mission.status==='playing')loadAndTarget();
  },destroy(){unsubscribe();clear();material?.destroy();}};
}
