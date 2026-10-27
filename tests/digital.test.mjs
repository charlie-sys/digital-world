import test from 'node:test';
import assert from 'node:assert/strict';
import {appearance,motion,mood,residentPoint,placePoint,pathPoint,personSvg,assignFormation} from '../public/digital.js';

test('digital identities stay stable and SVG output escapes resident names',()=>{
 assert.deepEqual(appearance('one'),appearance('one'));assert.notDeepEqual(appearance('one'),appearance('two'));
 const svg=personSvg({id:'one',name:'<script>alert(1)</script>'});assert.ok(!svg.includes('<script>'));assert.ok(svg.includes('&lt;script&gt;'));assert.ok(svg.includes('person-left-leg'));
});
test('movement follows a continuous route and stops at the confirmed destination',()=>{
 const r={id:'one',location:'farm',activity:{from_location:'square',to_location:'farm',started_ms:1000,ends_ms:7500,action:'move'}};
 assert.deepEqual(residentPoint(r,1000),placePoint('square','one'));assert.deepEqual(residentPoint(r,7500),placePoint('farm','one'));
 assert.notDeepEqual(residentPoint(r,4000),placePoint('square','one'));assert.notDeepEqual(residentPoint(r,4000),placePoint('farm','one'));
 const a=residentPoint(r,4000),b=residentPoint(r,4001);assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])<1);assert.deepEqual(pathPoint([[0,0],[10,0]],.5),[5,0]);
});
test('animation states distinguish real thinking, walking, working, idle and suspension',()=>{
 const r={id:'one',energy:80,hunger:20,location:'farm',mode:'rules',activity:{action:'work',from_location:'farm',to_location:'farm',started_ms:1000,ends_ms:2000}};
 assert.equal(motion(r,false,1500).key,'work');assert.equal(motion(r,false,3000).key,'idle');assert.equal(motion(r,true,1500).key,'thinking');assert.equal(motion({...r,suspended:1},true,1500).key,'paused');assert.equal(mood({...r,hunger:90}),'饥饿');
});
test('residents at the same place occupy separate stable visual slots',()=>{
 const source=[{id:'two',location:'market'},{id:'one',location:'market'}],arranged=assignFormation(source),a=residentPoint(arranged[0]),b=residentPoint(arranged[1]);assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])>=40);assert.deepEqual(assignFormation(source)[0].formation,assignFormation([...source].reverse())[1].formation);
});
