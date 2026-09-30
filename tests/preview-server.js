// Local-only fixture server for browser QA. No Supabase credentials or requests.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { Readable } from 'node:stream';
import { attachmentLimitError } from '../shared/limits.js';

const root = resolve(import.meta.dirname, '..');
const id = '11111111-1111-4111-8111-111111111111';
const category = { id, name:'검증용 분류', sort_order:0 };
let posts = Array.from({length:12}, (_, index) => ({
  id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,
  category_id:id,category:'검증용 분류',title:index<2 ? `검증용 공지 ${index+1}` : `별표 검증 메모 ${index+1}`,
  content:index<2 ? '공지가 두 개일 때도 각각 본문 요약을 표시합니다.\n테스트 데이터입니다.' : '첨부파일은 이미지와 별도로 최대 8개, 합계 25MB까지 저장합니다.',
  image_urls:[],attachments:index===0 ? [{path:`${id}/test.txt`,name:'검증용.txt',size:16}] : [],
  tags:[],author_id:id,author_name:'테스트',is_notice:index<2,is_pinned:true,is_confidential:false,view_count:0,
  created_at:new Date(Date.now()-index*60000).toISOString(),updated_at:new Date().toISOString()
}));
const objects = new Map([[`${id}/test.txt`,Buffer.from('local fixture\n')]]);
const logs = [];
const server = createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost:4173');
  const send = (value,status=200) => {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try {
    if (url.pathname==='/__qa/logs') return send(logs);
    if (url.pathname.startsWith('/api/')) {
      logs.push({method:req.method,path:url.pathname});
      if (url.pathname==='/api/bootstrap') return send({user:{id,email:'demo@example.test'},profile:{id,display_name:'테스트',role:'admin'},categories:[category],shortcuts:[],posts});
      if (url.pathname==='/api/files' || url.pathname==='/api/images') {
        const request = new Request(url,{method:req.method,headers:req.headers,body:Readable.toWeb(req),duplex:'half'});
        if (req.method==='DELETE') { const body=await request.json();for(const path of body.paths) objects.delete(path); return send({discarded:true}); }
        const form=await request.formData(); const file=form.get('file');
        const path=`${id}/${crypto.randomUUID()}-file`;
        objects.set(path,Buffer.from(await file.arrayBuffer()));
        const uploaded={path,name:file.name,size:file.size,expiresAt:Date.now()+3600000};
        return send(url.pathname==='/api/files' ? {attachment:uploaded} : uploaded,201);
      }
      if (url.pathname.startsWith('/api/files/')) {
        const path=decodeURIComponent(url.pathname.slice('/api/files/'.length));
        if(!objects.has(path)) return send({error:'missing'},404);
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="test.txt"'});return res.end(objects.get(path));
      }
      if (url.pathname.endsWith('/view')) return send({viewed:true,viewCount:1});
      if (url.pathname==='/api/posts' || url.pathname.startsWith('/api/posts/')) {
        const request=new Request(url,{method:req.method,headers:req.headers,body:Readable.toWeb(req),duplex:'half'});
        const body=await request.json();const error=attachmentLimitError(body.attachments||[]);
        if(error) return send({error},400);
        const post={...posts[0],...body,id:crypto.randomUUID(),is_notice:false,created_at:new Date().toISOString()};
        posts.unshift(post);return send({post},201);
      }
      return send({error:'unsupported fixture route'},404);
    }
    const path=resolve(root,`.${decodeURIComponent(url.pathname==='/' ? '/index.html' : url.pathname)}`);
    if(!path.startsWith(root+sep)) return send({error:'missing'},404);
    const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
    const bytes=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
  } catch {send({error:'fixture server error'},500);}
});
server.listen(4173,'127.0.0.1',()=>process.stdout.write('QA fixture server: http://127.0.0.1:4173\n'));
