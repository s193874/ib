/* Typed library documents; never imported as user utterances. */
(function(){
'use strict';
const kinds={claude_summary:'Claude 旧总结',project_memory:'项目旧总结',memory_file:'记忆文件',project_prompt:'项目提示词',project_description:'项目说明',project_document:'项目文档'};
const states={pending:'待核对',active:'已启用',paused:'已暂停',rejected:'已忽略'};
const E=(tag,text)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;return e};
const API=new URL('dwell-api/',location.href).pathname;let generation=0;
function parse(root,name=''){
 const roots=Array.isArray(root)?root:[root],items=[],skipped=[];let recognized=false;
 function add(kind,key,title,content,metadata){if(typeof content!=='string'||!content.trim()){skipped.push({title,reason:'没有文本内容'});return;}if(content.length>200000){skipped.push({title,reason:'超过单份资料 20 万字符上限，需拆分'});return;}items.push({kind,source_key:key,title:String(title).slice(0,240),content,metadata:{...metadata,source_file:name}});}
 for(const r of roots){if(!r||typeof r!=='object')continue;
  if(Object.hasOwn(r,'conversations_memory')||Object.hasOwn(r,'memory_files')){
   recognized=true;const a=String(r.account_uuid||'unknown-account');
   add('claude_summary','claude:'+a+':summary','Claude 对话旧总结',r.conversations_memory,{account_id:r.account_uuid||null});
   for(const [id,content] of Object.entries(r.project_memories||{}))add('project_memory','claude:'+a+':project:'+id,'项目旧总结 · '+id,content,{project_id:id});
   for(const [i,f] of (Array.isArray(r.memory_files)?r.memory_files:[]).entries())add('memory_file','claude:'+a+':file:'+String(f.path||i),'记忆文件 · '+String(f.path||i),f.content,{path:f.path||null,original_updated_at:f.updated_at||null});
  }else if(Array.isArray(r.docs)&&Object.hasOwn(r,'prompt_template')){
   recognized=true;const id=String(r.uuid||''),title=String(r.name||'未命名项目');if(!id){skipped.push({title,reason:'项目缺少原始 ID，无法可靠去重'});continue;}
   const meta={project_id:id,project_name:title,original_created_at:r.created_at||null,original_updated_at:r.updated_at||null};
   add('project_description','claude:project:'+id+':description',title+' · 项目说明',r.description,meta);
   add('project_prompt','claude:project:'+id+':prompt',title+' · 项目提示词',r.prompt_template,meta);
   for(const [i,d] of r.docs.entries())add('project_document','claude:project:'+id+':doc:'+String(d.uuid||d.filename||i),title+' · '+String(d.filename||'文档'),d.content,{...meta,document_id:d.uuid||null,filename:d.filename||null,original_created_at:d.created_at||null});
  }
 }
 return recognized?{items,skipped}:null;
}
async function request(fid,action,body={}){
 const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),28000);
 try{const r=await fetch(API+'references/'+action,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({friend_id:fid,...body}),signal:ac.signal});const v=await r.json();if(!r.ok||v.ok!==true)throw Error(({reference_revision_conflict:'这份资料已在另一处修改，请重新打开核对',memory_binding_changed:'请先接入 Dwell 记忆库',reference_missing:'这份资料不存在于当前记忆库'}[v.error])||v.error||'资料请求失败');return v;}finally{clearTimeout(timer);}
}
function button(label,fn){const b=E('button',label);b.type='button';b.className='btn';b.onclick=async()=>{if(b.disabled)return;b.disabled=true;try{await fn()}catch(e){toast(e.message);const n=document.getElementById('ref-notice');if(n)n.textContent=e.message}finally{b.disabled=false}};return b;}
async function open(parsed=null,file='',fid=''){
 const gen=++generation;let box=document.getElementById('sheet-import-references');if(box)box.remove();box=E('div');box.id='sheet-import-references';box.className='sheet sheet-split';
 const area=E('div');area.className='sheet-scroll';area.append(E('h3','Dwell 导入资料 · 核对后使用'),E('p','旧总结和项目材料按资料保存，不会变成聊天原话，也不等同于已证实的用户事实。待核对资料不会发送给模型。'));
 const target=E('select');target.id='ref-target';await loadCfgs();for(const cfg of _cfgs.filter(c=>!c._group&&!c.archived)){const o=E('option',cfgName(cfg));o.value=cfg.id;target.append(o);}target.value=fid||_activeCfg?.id||target.options[0]?.value||'';
 const notice=E('p');notice.id='ref-notice';const library=E('p'),list=E('div'),incoming=E('div');area.append(target,library,notice,incoming,list);
 const fileInput=E('input');fileInput.type='file';fileInput.accept='.zip,.json';fileInput.hidden=true;fileInput.onchange=async()=>{try{const f=fileInput.files[0];if(!f)return;const r=await _ibChatImp.read(f);const v=parse(r.root??JSON.parse(r.text),f.name);if(!v)throw Error('请选择 Claude memories 或 projects 导出包');await open(v,f.name,target.value)}catch(e){notice.textContent=e.message}};
 const footer=E('div');footer.className='sheet-btns';footer.append(button('选择记忆 / 项目文件',()=>fileInput.click()),button('刷新列表',()=>refresh()),button('关闭',()=>{generation++;closeSheets()}));box.append(area,fileInput,footer);document.body.append(box);openSheet(box.id);
 let offset=0,loadSeq=0;
 async function refresh(append=false){const selected=target.value,seq=++loadSeq;if(!selected){notice.textContent='请先添加聊天对象';return;}if(!append){list.replaceChildren();offset=0;}
  const r=await request(selected,'list',{offset});if(gen!==generation||selected!==target.value||seq!==loadSeq)return;library.textContent='当前独立记忆库：'+r.principal_id;
  if(!r.items.length&&!append)list.append(E('p','还没有导入资料。'));
  for(const row of r.items){const d=E('details');d.append(E('summary',row.title+' · '+kinds[row.kind]+' · '+states[row.state]));const content=E('div');d.append(content);let loaded=false;
   d.ontoggle=async()=>{if(!d.open||loaded)return;loaded=true;try{const v=await request(selected,'detail',{id:row.id});if(gen!==generation||selected!==target.value||!d.isConnected)return;const item=v.item;const original=E('pre',item.original_text);original.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:35vh;overflow:auto';const source=E('details');source.append(E('summary','查看导出原文与来源'),original,E('pre',JSON.stringify(item.metadata,null,2)));content.append(source);
    const draft=E('textarea');draft.rows=8;draft.style.width='100%';draft.value=item.reviewed_content||(item.original_text.length<=3000?item.original_text:'');draft.placeholder='核对原文后，填写要让模型参考的内容（最多 3000 字）';const counter=E('p');const count=()=>counter.textContent='供模型参考：'+draft.value.length+' / 3000 字；可以保留不确定性，不必把旧总结全部认可。';draft.oninput=count;count();
    const pin=E('input');pin.type='checkbox';pin.checked=item.pinned;const label=E('label');label.append(pin,document.createTextNode(' 优先带入（仍受本轮上下文预算限制）'));const actions=E('div');actions.className='sheet-btns';
    const save=async(state)=>{if(draft.value.length>3000||(state==='active'&&!draft.value.trim()))throw Error('请填写 1–3000 字的核对内容');await request(selected,'review',{id:item.id,expected_revision:item.revision,state,content:draft.value,pinned:pin.checked});await refresh();};
    actions.append(button('核对并启用',()=>save('active')),button('暂停使用',()=>save('paused')),button('忽略这份资料',()=>save('rejected')));content.append(E('p','启用后按相关性选取，每轮最多 3 份，使用剩余记忆预算；导出里的提示词也只作为参考材料，不会覆盖系统设置。'),draft,counter,label,actions);
   }catch(e){loaded=false;content.textContent=e.message}};list.append(d);}
  if(r.next_offset!==null&&r.next_offset!==undefined){const more=button('查看更多资料',async()=>{more.remove();offset=r.next_offset;await refresh(true)});list.append(more);}
 }
 target.onchange=()=>refresh().catch(e=>notice.textContent=e.message);
 if(parsed&&window.IBCore&&parsed.items.some(x=>IBCore.ordinary(x))){incoming.append(button('普通记忆：导入并自动维护',()=>IBCore.importDialog(parsed,file,target.value)));}
 if(parsed){incoming.append(E('h3',file),E('p','可保存 '+parsed.items.length+' 份资料；跳过 '+parsed.skipped.length+' 项。尚未上传。'));
  for(const item of parsed.items){const d=E('details'),pre=E('pre',item.content);pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:35vh;overflow:auto';d.append(E('summary',item.title+' · '+kinds[item.kind]+' · '+item.content.length+' 字'),pre);incoming.append(d);}
  for(const x of parsed.skipped)incoming.append(E('p',x.title+'：'+x.reason));
  incoming.append(button('保存到当前 Dwell 库，待核对',async()=>{const selected=target.value;if(!selected)throw Error('请选择聊天对象');const check=await request(selected,'list',{offset:0});if(!await confirmDlg('把 '+parsed.items.length+' 份资料保存到独立记忆库 '+check.principal_id+'？保存后仍需逐份核对启用，不会直接用于聊天。','保存待核对资料'))return;target.disabled=true;let n=0,skip=0;try{for(const item of parsed.items){const r=await request(selected,'import',{items:[item],expected_principal:check.principal_id});n+=r.imported;skip+=r.skipped;notice.textContent='已保存 '+n+' 份，重复跳过 '+skip+' 份。'}incoming.replaceChildren(E('p','保存完成：新增 '+n+'，重复跳过 '+skip+'；在下方展开资料进行核对。'));await refresh();}finally{target.disabled=false;}}));
 }
 try{await refresh()}catch(e){notice.textContent=e.message}
}
function boot(){const anchor=document.getElementById('btn-chatimp');if(anchor&&!document.getElementById('btn-reference-import')){const b=button('Dwell 导入资料（旧总结 / 项目）',()=>open());b.id='btn-reference-import';b.classList.add('wide');anchor.after(b);}}
window.IBReferences={parse,open,request};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
