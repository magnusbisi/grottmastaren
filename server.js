// Grottmästaren – server för nätverksspel (upp till fyra spelare).
// Kräver bara Node.js (inga extra paket). Starta med "Starta natverksspel.bat" eller: node server.js
//
// Servern
//  - delar ut spelet (index.html) till alla i hemmanätet
//  - skickar meddelanden mellan spelarna och värden via WebSocket
//  - startar en osynlig värd (Edge eller Chrome) som kör hela simuleringen,
//    så att surfplattorna bara behöver rita
//  - loggar allt till mappen logs/
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os'),{spawn}=require('child_process');
const PORT=+(process.env.PORT||8077),DIR=__dirname,LOGDIR=path.join(DIR,'logs');
const VISIBLE_HOST=process.argv.includes('--visa-vard')||process.argv.includes('--show-host');
const NO_HOST=process.argv.includes('--ingen-vard')||process.argv.includes('--no-host');
try{fs.mkdirSync(LOGDIR,{recursive:true});}catch(e){}
const stamp=new Date().toISOString().replace(/[:T]/g,'-').slice(0,16);
const LOGFILE=path.join(LOGDIR,`server-${stamp}.log`);
function log(line,quiet){const t=new Date().toLocaleTimeString('sv-SE');const s=`[${t}] ${line}`;if(!quiet)console.log(s);try{fs.appendFileSync(LOGFILE,s+'\n');}catch(e){}}

/* ---------- filer ---------- */
const server=http.createServer((req,res)=>{
  const u=req.url.split('?')[0];
  if(u==='/'||u==='/index.html'){fs.readFile(path.join(DIR,'index.html'),(err,data)=>{if(err){res.writeHead(500);res.end('index.html saknas');return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(data);});return;}
  if(u==='/status'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({host:!!host,players:[...clients.values()].filter(c=>c.role==='player').map(c=>({id:c.id,name:c.name})),up:process.uptime()|0}));return;}
  res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Finns inte');
});

/* ---------- WebSocket (RFC 6455) utan extra paket ---------- */
const clients=new Map();let nextId=1,host=null;
const stats={inB:0,outB:0,inM:0,outM:0};
function frame(str){const p=Buffer.from(str,'utf8'),n=p.length;let h;
  if(n<126){h=Buffer.alloc(2);h[1]=n;}else if(n<65536){h=Buffer.alloc(4);h[1]=126;h.writeUInt16BE(n,2);}else{h=Buffer.alloc(10);h[1]=127;h.writeUInt32BE(Math.floor(n/2**32),2);h.writeUInt32BE(n>>>0,6);}
  h[0]=0x81;return Buffer.concat([h,p]);}
function sendRaw(c,buf){if(!c||c.dead)return;try{if(c.sock.writableLength>8*1024*1024){return;}c.sock.write(buf);stats.outB+=buf.length;stats.outM++;}catch(e){}}
function send(c,obj){sendRaw(c,frame(typeof obj==='string'?obj:JSON.stringify(obj)));}
server.on('upgrade',(req,sock)=>{
  if(req.url.split('?')[0]!=='/ws'){sock.destroy();return;}
  const key=req.headers['sec-websocket-key'];if(!key){sock.destroy();return;}
  const acc=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');
  sock.setNoDelay(true);
  const c={id:nextId++,sock,buf:Buffer.alloc(0),role:null,name:'',ip:(req.socket.remoteAddress||'').replace('::ffff:',''),frag:null,dead:false};clients.set(c.id,c);
  sock.on('data',d=>{c.buf=Buffer.concat([c.buf,d]);stats.inB+=d.length;parse(c);});
  const bye=()=>{if(c.dead)return;c.dead=true;clients.delete(c.id);onClose(c);};
  sock.on('close',bye);sock.on('error',bye);
});
function parse(c){
  for(;;){const b=c.buf;if(b.length<2)return;const fin=b[0]&0x80,op=b[0]&0x0f,masked=b[1]&0x80;let len=b[1]&0x7f,off=2;
    if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4;}else if(len===127){if(b.length<10)return;len=b.readUInt32BE(2)*2**32+b.readUInt32BE(6);off=10;}
    if(len>32*1024*1024){c.sock.destroy();return;}
    const mo=off;if(masked)off+=4;if(b.length<off+len)return;
    let p=b.subarray(off,off+len);if(masked){const m=b.subarray(mo,mo+4);p=Buffer.from(p);for(let i=0;i<p.length;i++)p[i]^=m[i&3];}
    c.buf=b.subarray(off+len);
    if(op===8){try{c.sock.end(Buffer.from([0x88,0]));}catch(e){}return;}
    if(op===9){sendRaw(c,Buffer.concat([Buffer.from([0x8a,p.length]),p]));continue;}
    if(op===10)continue;
    if(op===1||op===2){if(fin)onText(c,p.toString('utf8'));else c.frag=[p];continue;}
    if(op===0){if(!c.frag)continue;c.frag.push(p);if(fin){const all=Buffer.concat(c.frag);c.frag=null;onText(c,all.toString('utf8'));}continue;}
  }
}

/* ---------- meddelanden ---------- */
function onText(c,txt){stats.inM++;let d;try{d=JSON.parse(txt);}catch(e){return;}
  if(d.t==='hello'){
    if(d.role==='host'){if(host&&!host.dead){send(c,{t:'note',text:'Det finns redan en värd.'});log(`En andra värd försökte ansluta från ${c.ip} och nekades.`);c.sock.end();return;}
      c.role='host';host=c;log(`Värden anslöt (${c.ip}).`);send(c,{t:'welcome',id:c.id});
      for(const o of clients.values())if(o.role==='player'&&o.name)send(host,{t:'join',from:o.id,name:o.name});return;}
    c.role='player';c.name=String(d.name||'').slice(0,20);log(`En spelare öppnade spelet (${c.ip}).`);send(c,{t:'welcome',id:c.id});if(!host)send(c,{t:'nohost'});return;}
  if(c.role==='host'){
    if(d.t==='to'){const s=frame(JSON.stringify(d.data));if(d.to==='all'){for(const o of clients.values())if(o.role==='player')sendRaw(o,s);}else{const o=clients.get(d.to);if(o)sendRaw(o,s);}return;}
    if(d.t==='log'){log('[spel] '+d.line);return;}
    if(d.t==='kick'){const o=clients.get(d.id);if(o){send(o,{t:'full'});log(`Spelare ${o.name||o.id} nekades: spelet är fullt.`);}return;}
    return;}
  if(c.role==='player'){
    if(d.t==='join'){c.name=String(d.name||'').slice(0,20);log(`${c.name} vill vara med (${c.ip}).`);}
    if(!host||host.dead){send(c,{t:'nohost'});return;}
    d.from=c.id;send(host,d);}
}
function onClose(c){
  if(c===host){host=null;log('Värden kopplades bort.');for(const o of clients.values())if(o.role==='player')send(o,{t:'note',text:'Värden stängdes. Vänta, den startar om.',kind:'b'});if(!NO_HOST)setTimeout(startHost,3000);return;}
  if(c.role==='player'){log(`${c.name||'En spelare'} kopplades bort.`);if(host)send(host,{t:'leave',from:c.id});}
}
setInterval(()=>{if(stats.inM||stats.outM)log(`Trafik senaste minuten: in ${(stats.inB/1024).toFixed(0)} kB (${stats.inM} medd.), ut ${(stats.outB/1024).toFixed(0)} kB (${stats.outM} medd.). Anslutna: ${[...clients.values()].filter(c=>c.role==='player').length} spelare${host?' + värd':''}.`,true);stats.inB=stats.outB=stats.inM=stats.outM=0;},60000);

/* ---------- värden: en osynlig webbläsare kör simuleringen ---------- */
let hostProc=null;
function findBrowser(){
  const pf=[process.env['PROGRAMFILES(X86)'],process.env.PROGRAMFILES,process.env.LOCALAPPDATA].filter(Boolean);
  const c=[];for(const b of pf)c.push(path.join(b,'Microsoft','Edge','Application','msedge.exe'),path.join(b,'Google','Chrome','Application','chrome.exe'));
  c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/microsoft-edge');
  return c.find(p=>{try{return fs.existsSync(p);}catch(e){return false;}});
}
function startHost(){
  if(NO_HOST||(host&&!host.dead))return;
  if(hostProc&&hostProc.exitCode==null){return;}
  const exe=findBrowser(),url=`http://localhost:${PORT}/?host`;
  if(!exe){log(`Hittade ingen Edge eller Chrome. Öppna ${url} i en webbläsare på den här datorn och låt fliken vara öppen.`);return;}
  const prof=path.join(DIR,'.vardprofil');
  const args=VISIBLE_HOST?[`--user-data-dir=${prof}`,'--new-window',`--app=${url}`,'--autoplay-policy=no-user-gesture-required']:['--headless=new','--disable-gpu','--mute-audio',`--user-data-dir=${prof}`,'--disable-background-timer-throttling','--disable-renderer-backgrounding',url];
  hostProc=spawn(exe,args,{stdio:'ignore',detached:false});hostProc.on('exit',code=>{log(`Värdens webbläsare avslutades (${code}).`,true);});
  log(`Startar värden${VISIBLE_HOST?' i ett eget fönster':' i bakgrunden'} (${path.basename(exe)}).`);
}
process.on('exit',()=>{try{if(hostProc)hostProc.kill();}catch(e){}});
process.on('SIGINT',()=>process.exit());

server.listen(PORT,'0.0.0.0',()=>{
  const ips=[];for(const list of Object.values(os.networkInterfaces()))for(const a of list||[])if(a.family==='IPv4'&&!a.internal&&!a.address.startsWith('169.254'))ips.push(a.address);
  console.log('\n  GROTTMÄSTAREN – NÄTVERKSSPEL\n');
  console.log('  Öppna adressen i Safari eller Chrome på varje surfplatta och dator:');
  for(const ip of ips)console.log(`     http://${ip}:${PORT}`);
  console.log(`\n  På den här datorn: http://localhost:${PORT}`);
  console.log('  Välj Nätverk i spelet, skriv ditt namn och tryck Gå med.');
  console.log(`  Loggen sparas i ${LOGFILE}`);
  console.log('  Stäng det här fönstret för att stänga av servern.\n');
  log(`Servern startade på port ${PORT}. Adresser: ${ips.join(', ')||'localhost'}`,true);
  setTimeout(startHost,800);
});
server.on('error',e=>{if(e.code==='EADDRINUSE'){console.log(`\n  Port ${PORT} används redan. Är servern redan igång i ett annat fönster?\n`);}else console.log(e);process.exit(1);});
