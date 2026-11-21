import { afterEach, expect, it, vi } from 'vitest';
import { calculateNormals, Entity } from 'playcanvas';
import { AIRPORT, CITY, CITY_CREDITS, HANGAR, ROAD_CLASSES, UNIACADEMIA, WORKSHOP, airportData, cityData, cityDetails, cityLayout, cityStreetImages, createWorldPhysics, deliveryRampData, landmarkBoxes, roadHeightAt, nearestRoad, terrainData, terrainHeight } from './world-data';
import { buildWorld } from './world';
import type { FlightContext } from './types';

vi.mock('playcanvas',async importOriginal=>{
  const pc=await importOriginal<typeof import('playcanvas')>();
  const app={_entityIndex:{},systems:{}} as unknown as FlightContext['app'];
  class TestEntity extends pc.Entity {
    constructor(name='Entity'){super(name,app);}
    addComponent(type:string,data:unknown){if(type==='render')Object.defineProperty(this,'render',{value:data,writable:true,configurable:true});return null;}
  }
  class TestMesh {
    setPositions(){} setNormals(){} setColors32(){} setUvs(){} setIndices(){} update(){}
  }
  class TestTexture {setSource(){} }
  class TestMeshInstance {constructor(public mesh:unknown,public material:unknown){}}
  return {...pc,Entity:TestEntity,Mesh:TestMesh,Texture:TestTexture,MeshInstance:TestMeshInstance};
});
afterEach(()=>vi.unstubAllGlobals());

it('builds Juiz de Fora from real data: relief, road categories, river, parks, landmarks and runway',()=>{
  const city=cityData(),layout=cityLayout(),details=cityDetails(city);
  expect(layout.buildings).toEqual(city.boxes);expect(layout.blocks).toEqual(city.blocks);
  expect(city.boxes.length).toBeGreaterThan(300);expect(city.boxes.length).toBeLessThan(6000);
  expect(layout.roadLines.map(r=>r.category)).toEqual([...ROAD_CLASSES]);
  for(const road of layout.roadLines)expect(road.lines.length).toBeGreaterThan(0);
  expect(layout.river.lines.length).toBeGreaterThan(0);expect(layout.parkPolygons.length).toBeGreaterThan(10);
  expect(layout.stadiumPolygons.length).toBeGreaterThan(0);expect(layout.universityPolygons.length).toBeGreaterThan(0);
  expect(layout.runwayLine.a.x).toBe(layout.runwayLine.b.x);expect(layout.runwayLine.heading).toBe(0);
  expect(layout.helipad.y).toBe(city.helipad.y);expect(layout.workshop.x).toBe(WORKSHOP.x);
  expect(layout.landmarks.uniacademia).toMatchObject({x:UNIACADEMIA.x,z:UNIACADEMIA.z});
  expect(CITY_CREDITS).toContain('OpenStreetMap');
  expect(cityDetails(city)).toEqual(details);expect(cityData()).toBe(city);
  expect(Object.keys(details.meshes)).toEqual(['roads','ground','props','lamps']);
  for(const mesh of Object.values(details.meshes)) {
    expect(mesh.pos.every(Number.isFinite)).toBe(true);expect(mesh.normals).toHaveLength(mesh.pos.length);
    expect(mesh.idx.every(i=>i>=0&&i<mesh.pos.length/3)).toBe(true);
  }
  expect(details.meshes.roads.uv).toHaveLength(details.meshes.roads.pos.length/3*2);
});

it('keeps terrain between 2 m and the real hills, flat under the runway and shared with the mesh',()=>{
  const terrain=terrainData();let min=Infinity,max=-Infinity;
  for(let i=1;i<terrain.pos.length;i+=3){min=Math.min(min,terrain.pos[i]);max=Math.max(max,terrain.pos[i]);}
  expect(min).toBeGreaterThanOrEqual(2);expect(max).toBeGreaterThan(150);expect(max).toBeLessThan(400);
  for(const z of [10,200,AIRPORT.z,700])expect(terrainHeight(AIRPORT.x,z)).toBeCloseTo(AIRPORT.y-.05,6);
  // a mesh vertex must equal the physics height exactly
  const i=Math.floor(terrain.pos.length/3/2);expect(terrainHeight(terrain.pos[i*3],terrain.pos[i*3+2])).toBeCloseTo(terrain.pos[i*3+1],4);
  expect(CITY.x1-CITY.x0).toBeGreaterThan(4000);
});

it('places buildings off the roads and keeps the lots of the university and workshop free',()=>{
  const city=cityData(),world=createWorldPhysics([...city.boxes]);
  for(const b of city.boxes.slice(0,200)){
    const x=(b.x0+b.x1)/2,z=(b.z0+b.z1)/2;expect(world.obstacleAt(x,z,b.bottom!+1,.35,1.8)).toBeDefined();
  }
  for(const b of city.boxes) {
    expect(Math.hypot((b.x0+b.x1)/2-UNIACADEMIA.x,(b.z0+b.z1)/2-UNIACADEMIA.z)).toBeGreaterThan(UNIACADEMIA.radius);
    expect(Math.hypot((b.x0+b.x1)/2-WORKSHOP.x,(b.z0+b.z1)/2-WORKSHOP.z)).toBeGreaterThan(14);
  }
  const road=nearestRoad(UNIACADEMIA.x,UNIACADEMIA.z,4)!;expect(road.distance).toBeGreaterThan(40);
  expect(landmarkBoxes()).toHaveLength(3);
});

it('uses circular collisions for poles/signals instead of invisible square corners',()=>{
  const details=cityDetails(),poles=details.boxes.filter(b=>b.radius!==undefined&&b.top-b.bottom!>6);
  expect(poles.length).toBeGreaterThan(300);expect(poles.length).toBeLessThan(3000);
  const pole=poles[0],r=pole.radius!,x=pole.x!,z=pole.z!,world=createWorldPhysics([pole]);
  expect(world.obstacleAt(x,z,pole.bottom!,.35,1.8)).toBe(pole);
  expect(world.obstacleAt(x+r*.9,z+r*.9,pole.bottom!,0,1.8)).toBeUndefined();
  expect(world.surfaceAt(x+r*.9,z+r*.9)).toBeLessThan(pole.top);
});

it('keeps the workshop, helipad access and hangar doorway open',()=>{
  const world=createWorldPhysics(),access=airportData().access[0];
  expect(world.obstacleAt(WORKSHOP.x,WORKSHOP.z,WORKSHOP.y,2.7,1.5)).toBeUndefined();
  expect(world.obstacleAt(access.x,access.z,access.y+.15,.35,1.8)).toBeUndefined();
  expect(world.obstacleAt((HANGAR.x0+HANGAR.x1)/2,HANGAR.z1-1,AIRPORT.y,2.7,1.5)).toBeUndefined();
  const images=cityStreetImages();expect(images.road.rectangles.some(r=>r.color==='#e9bd43')).toBe(true);
});

it('exposes the actual batched emissive street material without creating dynamic lights',()=>{
  vi.stubGlobal('document',{createElement:()=>({width:0,height:0,getContext:()=>({fillStyle:'',fillRect(){},createLinearGradient:()=>({addColorStop(){}})})})});
  const root=new Entity('world');
  const app={root,graphicsDevice:{}} as unknown as FlightContext['app'];
  const world=buildWorld(app,root),lamp=root.findByName('Lampadas dos postes') as Entity;
  expect(world.streetLightMaterial?.name).toBe('Lampadas dos postes');
  expect(world.streetLightMaterial?.emissiveIntensity).toBe(1.8);
  expect((lamp.render!.meshInstances[0] as unknown as {material:unknown}).material).toBe(world.streetLightMaterial);
  expect(root.findComponents('light')).toHaveLength(0);
  expect(root.children.filter(c=>c.name.startsWith('Cidade - '))).toHaveLength(3);
});

it('lays roads at the shared physics height and aligns the three tuned ramps with axes and relief',()=>{
  const world=createWorldPhysics(),road=nearestRoad(0,-1300,3)!;
  expect(roadHeightAt(road.x,road.z)).toBeGreaterThanOrEqual(terrainHeight(road.x,road.z));
  expect(world.groundAt(road.x,road.z)).toBeCloseTo(roadHeightAt(road.x,road.z),8);
  for(const w of cityDetails().meshes.roads.pos.slice(0,300).filter((_,i)=>i%3===0)) expect(Number.isFinite(w)).toBe(true);
  const ramps=deliveryRampData();expect(ramps.ramps).toHaveLength(3);expect(ramps.boxes.every(b=>b.ramp&&b.top>b.bottom!)).toBe(true);
  for(const r of ramps.ramps){expect(r.x0===r.x1||r.z0===r.z1).toBe(true);expect(r.y1).toBeGreaterThan(r.y0+3.9);}
});
