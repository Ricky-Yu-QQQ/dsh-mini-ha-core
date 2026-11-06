import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {HAClient} from '../client.js';

test('native HTTP adapter uses GET/POST/DELETE on fixed managed config route only',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nomi-config-http-'));
 const credential=path.join(root,'credentials.json');await fs.writeFile(credential,JSON.stringify({access_token:'test-token'}));
 const methods=[],saved=new Map();
 const server=http.createServer(async(req,res)=>{
   assert.equal(req.headers.authorization,'Bearer test-token');methods.push(req.method);
   let body='';for await(const chunk of req)body+=chunk;
   if(req.method==='POST'){saved.set(req.url,JSON.parse(body));res.end('{"result":"ok"}');}
   else if(req.method==='DELETE'){saved.delete(req.url);res.end('{"result":"ok"}');}
   else if(saved.has(req.url))res.end(JSON.stringify(saved.get(req.url)));
   else {res.writeHead(404);res.end('{}');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const client=new HAClient({url:`http://127.0.0.1:${server.address().port}`,credentials_path:credential});
 t.after(async()=>{await client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
 await assert.rejects(client.automationConfig('nomi_test'),/HA_HTTP_404/);
 await client.automationConfig('nomi_test',{id:'nomi_test',initial_state:false});
 assert.equal((await client.automationConfig('nomi_test')).initial_state,false);
 await client.deleteAutomation('nomi_test');await assert.rejects(client.automationConfig('nomi_test'),/HA_HTTP_404/);
 assert.deepEqual(methods,['GET','POST','GET','DELETE','GET']);
 assert.throws(()=>client.automationConfig('other_id'),/INVALID_ID/);
 await assert.rejects(client.request('/api/config/automation/config/nomi_test',{}),/ROUTE_DENIED/);
});
