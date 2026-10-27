/* One server-resolved branch feeds paging, replies, regeneration and summaries. */
(function(){
'use strict';
const API=new URL('dwell-api/history/graph/',location.href).pathname;
const cache=new Map();
const key=(fid,tid)=>JSON.stringify([String(fid),String(tid||'')]);
const E=(tag,text)=>{const x=document.createElement(tag);if(text!=null)x.textContent=text;return x;};
const errors={history_graph_cycle:'这部分原始关系存在循环，已保留原文，请选择另一段查看',history_graph_ambiguous:'这段来源关系不明确，原文已保留，不能自动拼接为一条对话',history_upload_not_finished:'原话还在导入中，完成后即可查看和续聊',history_graph_revision_conflict:'分支已在另一端切换，请刷新后重试',history_graph_source_changed:'这条来源已变化，请刷新后再查看'};
async function api(fid,tid,action,body={},signal){
 const ac=new AbortController(),cancel=()=>ac.abort(),timer=setTimeout(cancel,35000);if(signal){if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});}
 try{const r=await fetch(API+action,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({friend_id:String(fid),thread_id:String(tid||''),...body}),signal:ac.signal});const v=await r.json();if(!r.ok||!v.ok)throw Error(errors[v.error]||v.error||'历史读取失败');return v;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
async function state(fid,tid,head,signal){
 if(String(fid).startsWith('group_'))return {enabled:false};
 const local=await rows(fid,tid);if(!local.some(m=>m.imp?.s==='claude'||m.history_parent)){cache.delete(key(fid,tid));return {enabled:false};}
 try{const s=await api(fid,tid,'state',head?{head}:{},signal);cache.set(key(fid,tid)+(head?'|'+head:''),s);return s;}
 catch(e){if(e.message==='memory_binding_changed'){cache.delete(key(fid,tid));return {enabled:false};}throw e;}
}
async function rows(fid,tid){return (await dbGetByIndex('chatMessages','byFriend',fid)).filter(m=>String(m.threadId||'')===String(tid||''));}
async function filter(fid,tid,input,head=null){
 let s=await state(fid,tid,head);if(!s.enabled)return input;
 if(window.IBCloud?.flushRecord){let changed=false;const ids=new Set(s.ids);for(const m of input){if(m.history_parent&&!ids.has(String(m.id))&&ids.has(m.history_parent)){await IBCloud.flushRecord('chatMessages',m);changed=true;}}if(changed)s=await state(fid,tid,head);}
 const byId=new Map(input.map(m=>[String(m.id),m]));
 const result=s.ids.map(id=>byId.get(id)).filter(Boolean);
 return result;
}
async function page(fid,tid,before,limit){
 const s=await state(fid,tid);if(!s.enabled)return null;
 const all=await rows(fid,tid),byId=new Map(all.map(m=>[String(m.id),m]));
 if(s.ids.some(id=>!byId.has(id))){await IBCloud.run();const retry=await rows(fid,tid);for(const m of retry)byId.set(String(m.id),m);}
 if(s.ids.some(id=>!byId.has(id)))throw Error('当前分支还有原话未同步齐，请稍后刷新');
 const end=before==null?s.ids.length:s.ids.indexOf(String(before));if(end<0)throw Error('查看的分支已变化，请重新打开');
 const start=Math.max(0,end-limit),ids=s.ids.slice(start,end);
 return {items:ids.map(id=>byId.get(id)),nextBefore:ids[0]||null,more:start>0,graph:s};
}
async function history(fid,tid,keep){
 if(window.IBCloud)await IBCloud.run();
 const s=await state(fid,tid);if(!s.enabled)return null;
 const all=await rows(fid,tid),byId=new Map(all.map(m=>[String(m.id),m]));
 if(s.ids.some(id=>!byId.has(id)))throw Error('本轮分支历史尚未同步齐，未发送混合历史');
 return s.ids.slice(-Math.max(1,keep)).map(id=>byId.get(id));
}
async function attach(message,source=null){
 if(!message?.friendId||message.imp||message.generation_error)return message;
 if(!source&&window.IBCloud)await IBCloud.run();
 const s=await state(message.friendId,message.threadId||'');if(!s.enabled)return message;
 const parent=source?.id||s.head;if(!parent)throw Error('请选择一段有效记录后继续聊天');
 message.history_parent=String(parent);return message;
}
function active(fid,tid){return cache.get(key(fid,tid))?.enabled===true;}
function cached(input,fid,tid,head=null){
 const s=(head?cache.get(key(fid,tid)+'|'+head):null)||cache.get(key(fid,tid));if(!s?.enabled)return input;
 const end=head?s.ids.indexOf(String(head)):-1;
 const ids=end>=0?s.ids.slice(0,end+1):s.ids,byId=new Map(input.map(m=>[String(m.id),m]));
 return ids.map(id=>byId.get(id)).filter(Boolean);
}
function summaryUsable(record,fid,tid){const s=cache.get(key(fid,tid));if(!s?.enabled)return true;const ids=new Set(s.ids);return Array.isArray(record?.graph_source_ids)&&record.graph_source_ids.length>0&&record.graph_source_ids.every(id=>ids.has(id)&&record.graph_source_versions?.[id]===s.source_versions?.[id]);}
function bindSources(record,fid,tid,ids){const s=cache.get(key(fid,tid));if(s?.enabled){record.graph_source_ids=(ids||s.ids).slice();record.graph_source_versions=Object.fromEntries(record.graph_source_ids.map(id=>[id,s.source_versions[id]]));}return record;}
function button(text,fn){const b=E('button',text);b.type='button';b.className='btn';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{b.disabled=false;}};return b;}
async function choose(fid,tid,head){
 if(typeof _sendKeys!=='undefined'&&_sendKeys.has(_keyOf(fid,tid||'')))throw Error('请等当前回复结束后再切换分支');
 const current=await state(fid,tid);await api(fid,tid,'select',{head,expected_revision:current.revision});cache.delete(key(fid,tid));
 const cfg=await dbGet('apiConfigs',fid),thread=tid?await dbGet('chatThreads',tid):null;
 await openConv(cfg,thread,{skipAutoSummary:true});
}
async function open(fid,tid=''){
 const old=document.getElementById('sheet-history-graph');old?.remove();const box=E('div');box.id='sheet-history-graph';box.className='sheet sheet-split';const area=E('div');area.className='sheet-scroll';const s=await state(fid,tid);
 area.append(E('h3','导入记录与分支'),E('p',s.enabled?'本频道保存 '+s.count+' 条消息；当前分支 '+s.ids.length+' 条。其他分支仍完整保存，切换只改变查看与续聊的上下文。':'本频道没有需要切换的导入分支。'));
 const local=await rows(fid,tid),byId=new Map(local.map(m=>[String(m.id),m]));
 for(const leaf of s.leaves||[]){const msg=byId.get(leaf.id),d=E('details');d.append(E('summary',(leaf.id===s.head?'当前 · ':'')+(msg?.content||leaf.id).replace(/\s+/g,' ').slice(0,90)+(leaf.issue?' · 前文关系不完整':'')));const pre=E('pre',msg?.content||'消息尚未同步');pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';d.append(pre,button('查看并从这条分支续聊',async()=>{await choose(fid,tid,leaf.id);closeSheets();}));area.append(d);}
 const all=E('details');all.append(E('summary','查看全部消息（含其他分支）'));const list=E('div'),more=button('再看 40 条',show);let shown=0;
 function show(){const end=Math.min(shown+40,local.length);for(;shown<end;shown++){const m=local[shown],d=E('details'),pre=E('pre',m.content||'');pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:35vh;overflow:auto';d.append(E('summary',(m.role==='user'?'我':'TA')+' · '+(m.content||'').replace(/\s+/g,' ').slice(0,80)),pre);list.append(d);}more.hidden=shown>=local.length;}
 all.append(list,more);all.ontoggle=()=>{if(all.open&&!shown)show();};area.append(all);
 const raw=E('details');raw.append(E('summary','查看原始节点（含无正文和不支持的内容）'));const rawList=E('div');let rawOffset=0,rawLoaded=false;const rawMore=button('查看更多原始节点',loadRaw);
 async function loadRaw(){const r=await api(fid,tid,'archives',{offset:rawOffset});for(const item of r.items){const d=E('details');d.append(E('summary','原始节点 #'+(Number(item.node_key)+1)+' · '+item.conversation));let loaded=false;d.ontoggle=async()=>{if(!d.open||loaded)return;loaded=true;try{const v=await api(fid,tid,'raw',item);const pre=E('pre',v.raw_json);pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:45vh;overflow:auto';d.append(pre);}catch(e){loaded=false;d.append(E('p',e.message));}};rawList.append(d);}rawOffset=r.next_offset;rawMore.hidden=rawOffset===null;}
 raw.append(rawList,rawMore);raw.ontoggle=()=>{if(raw.open&&!rawLoaded){rawLoaded=true;loadRaw().catch(e=>toast(e.message));}};area.append(raw);
 const footer=E('div');footer.className='sheet-btns';footer.append(button('搜索全部频道',()=>searchUI(fid)),button('关闭',()=>closeSheets()));box.append(area,footer);document.body.append(box);openSheet(box.id);
}
function bar(cfg,thread,graph){
 const old=document.getElementById('history-graph-chip');old?.remove();if(!graph?.enabled||_activeCfg?.id!==cfg.id||String(_activeThread?.id||'')!==String(thread?.id||''))return;
 const host=document.getElementById('cvd-threads')||convEl('cv-threads'),b=E('div','分支 · 保存 '+graph.count+' / 当前 '+graph.ids.length);b.id='history-graph-chip';b.className='th-chip';b.onclick=()=>open(cfg.id,thread?.id||'').catch(e=>toast(e.message));host.append(b);
}
async function searchUI(fid){
 const old=document.getElementById('sheet-history-search');old?.remove();const box=E('div');box.id='sheet-history-search';box.className='sheet sheet-split';const area=E('div');area.className='sheet-scroll';const input=E('input');input.placeholder='搜索这个记忆库的所有聊天原文';input.style.width='100%';const note=E('p'),results=E('div');let cursor=null,generation=0;
 async function run(again=false){const q=input.value.trim();if(!q)return;const gen=++generation;if(!again){cursor=0;results.replaceChildren();}let scanned=0,hits=0;do{const r=await api(fid,'','search',{query:q,cursor:cursor||0});if(gen!==generation)return;scanned+=r.scanned;for(const hit of r.hits){hits++;const d=E('details');d.append(E('summary',(hit.role==='user'?'我':'TA')+' · '+hit.quote.replace(/\s+/g,' ').slice(0,80)),E('pre',hit.quote),button('查看来源',()=>sourceUI(fid,hit)));results.append(d);}cursor=r.next_cursor;note.textContent='已检查 '+scanned+' 条，找到 '+hits+' 条'+(cursor===null?'；已查完当前库。':'…');}while(cursor!==null&&scanned<15000);more.hidden=cursor===null;}
 const more=button('继续搜索更早记录',()=>run(true));more.hidden=true;area.append(E('h3','搜索全部聊天'),E('p','范围为当前独立记忆库，包含主聊天、频道和其他分支；结果是原文片段，不代表其中的结论已经核实。'),input,button('搜索',()=>run(false)),note,results,more);input.onkeydown=e=>{if(e.key==='Enter')run(false).catch(x=>toast(x.message));};const footer=E('div');footer.className='sheet-btns';footer.append(button('关闭',()=>{generation++;closeSheets();}));box.append(area,footer);document.body.append(box);openSheet(box.id);
}
async function sourceUI(fid,hit){
 const m=(await api(fid,'','source',{id:hit.id,source_hash:hit.source_hash})).message;if(!m||m.friendId!==hit.friend_id||String(m.threadId||'')!==hit.thread_id)throw Error('来源还未同步或已经变化，请刷新后再查看');
 const box=E('div');box.id='sheet-history-source';document.getElementById(box.id)?.remove();box.className='sheet sheet-split';const area=E('div');area.className='sheet-scroll';const pre=E('pre',m.content||'');pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';area.append(E('h3','聊天原文'),E('p','聊天对象：'+hit.friend_id+'；频道：'+(hit.thread_id||'主聊天')),pre);
 const footer=E('div');footer.className='sheet-btns';footer.append(button('查看所在频道的分支',()=>open(hit.friend_id,hit.thread_id)),button('关闭',()=>closeSheets()));box.append(area,footer);document.body.append(box);openSheet(box.id);
}
async function openArchive(fid,batch_id){
 document.getElementById('sheet-history-archive')?.remove();const box=E('div');box.id='sheet-history-archive';box.className='sheet sheet-split';const area=E('div');area.className='sheet-scroll';area.append(E('h3','本批原始节点'),E('p','原文件中的节点均保留在这里；不支持的内容仍可查看原文。'));let offset=0;const list=E('div'),more=button('查看更多',load);
 async function load(){const r=await api(fid,'','archives',{batch_id,offset});for(const item of r.items){const d=E('details');d.append(E('summary',item.conversation+' · 原始节点 #'+(Number(item.node_key)+1)));let loaded=false;d.ontoggle=async()=>{if(!d.open||loaded)return;loaded=true;try{const v=await api(fid,'','raw',item),pre=E('pre',v.raw_json);pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:45vh;overflow:auto';d.append(pre);}catch(e){loaded=false;toast(e.message);}};list.append(d);}offset=r.next_offset;more.hidden=offset===null;}
 area.append(list,more);const footer=E('div');footer.className='sheet-btns';footer.append(button('关闭',()=>closeSheets()));box.append(area,footer);document.body.append(box);openSheet(box.id);await load();
}
window.IBGraph={api,state,filter,page,history,attach,active,cached,summaryUsable,bindSources,open,openArchive,choose,bar,searchUI,sourceUI,cache};
})();
