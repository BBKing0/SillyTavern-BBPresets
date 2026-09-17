import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const allowed=/^\/(?:tests\/(?:preview\.html|preview\.js)|index\.js|style\.css|(?:core|runtime|ui)\/[a-z-]+\.js)$/;
const server=http.createServer(async(req,res)=>{const path=new URL(req.url,'http://127.0.0.1').pathname;if(!allowed.test(path)){res.writeHead(404);res.end();return;}try{const data=await readFile(fileURLToPath(new URL(path.slice(1),root)));res.writeHead(200,{'Content-Type':path.endsWith('.html')?'text/html; charset=utf-8':path.endsWith('.css')?'text/css':'text/javascript','Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(404);res.end();}});
server.listen(8766,'127.0.0.1',()=>console.log('BBPresets simulated host: http://127.0.0.1:8766/tests/preview.html'));
