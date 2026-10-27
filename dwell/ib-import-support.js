/* Import previews are local. Nothing here selects a branch or writes chat data automatically. */
(function(){
'use strict';
const rootID=/^00000000-0000-(?:4000|0000)-(?:8000|0000)-000000000000$/;
function tree(cv,raw){
 const nodes=raw.map((m,i)=>({id:typeof m?.uuid==='string'?m.uuid:'',parent:m?.parent_message_uuid||m?.parent_uuid||m?.parent_id||null,index:i}));
 const byId=new Map(),children=new Map();let error='';
 for(const n of nodes){if(n.id&&byId.has(n.id))error='原文件有重复消息 ID，无法可靠选择路线';if(n.id)byId.set(n.id,n);}
 for(const n of nodes)if(n.parent){const a=children.get(n.parent)||[];a.push(n);children.set(n.parent,a);}
 const linked=nodes.some(n=>n.parent),roots=nodes.filter(n=>!n.parent||!byId.has(n.parent));
 const fork=[...children.values()].some(a=>a.length>1);
 const conflict=linked&&(fork||roots.length>1||roots.some(n=>n.parent&&!rootID.test(n.parent)));
 const leaves=nodes.filter(n=>!n.id||!children.has(n.id));
 if(linked){const done=new Set();for(const n of nodes){const seen=new Set();let p=n;while(p&&!done.has(p.index)){if(seen.has(p.index)){error='原文件的父子关系有循环，无法可靠选择路线';break}seen.add(p.index);p=byId.get(p.parent)}for(const i of seen)done.add(i);}}
 if(conflict&&nodes.some(n=>!n.id))error='存在分支但部分消息缺少 ID，无法可靠选择路线';
 cv.historyGraphRaw=raw;cv.historyTree={nodes,byId,leaves,roots,linked,error};cv.historyRawCount=nodes.length;
 cv.historyHasBranches=!!error||conflict;cv.historyBranchConflict=false;cv.historyGraphError=error;
 const counts=new Map();for(const n of nodes)if(n.id)counts.set(n.id,(counts.get(n.id)||0)+1);for(const m of cv.msgs)if(counts.get(m.historySource?.message_id)>1)m.historySource.identity_conflict=true;
 cv.historyAllMsgs=cv.msgs.slice();cv.historyAllRejected=(cv.historyRejected||[]).slice();
 return cv;
}
function route(cv,leafIndex){
 const t=cv.historyTree;if(!t||t.error)throw Error(t?.error||'缺少原始路线');
 const leaf=t.leaves.find(n=>n.index===Number(leafIndex));if(!leaf)throw Error('请选择文件中已有的路线');
 const nodes=[],seen=new Set();let n=leaf,missing=null;
 while(n){if(seen.has(n.index))throw Error('路线存在循环');seen.add(n.index);nodes.push(n);if(n.parent&&!t.byId.has(n.parent)&&!rootID.test(n.parent))missing=n.parent;n=t.byId.get(n.parent);}
 nodes.reverse();const rank=new Map(nodes.map((n,i)=>[n.index,i]));
 const msgs=cv.historyAllMsgs.filter(m=>rank.has(m.historySource.message_index)).sort((a,b)=>rank.get(a.historySource.message_index)-rank.get(b.historySource.message_index));
 const rejected=cv.historyAllRejected.filter(r=>rank.has(r.message_index));
 return {nodes,msgs,rejected,missing,excluded:t.nodes.length-nodes.length,leafIndex:leaf.index};
}
function select(cv,leafIndex,allowMissing){
 // Selection affects a later view only; every source node remains in the import.
 return {...cv,msgs:cv.historyAllMsgs.slice(),historyRejected:cv.historyAllRejected.slice(),historyBranchConflict:false,historyViewLeaf:Number(leafIndex),historyBranchExcluded:0};
}
function ui(host,cv,onChoose){
 const el=(tag,text)=>{const x=document.createElement(tag);if(text!=null)x.textContent=text;return x;};
 const box=el('details');box.className='ci-branch';box.append(el('summary','完整保存 · '+cv.historyRawCount+' 个原始节点'));
 box.append(el('p','所有分支和已有片段都会保存；导入后可切换查看，续聊只读取当前分支。这里无需选择导入路线。'));
 if(cv.historyGraphError)box.append(el('p',cv.historyGraphError+'；原文仍保存，关系不明的部分不会自动串进模型上下文。'));
 if(cv.historyTree?.roots?.length>1)box.append(el('p','原文件包含多个独立片段，保留原有关系。'));
 const preview=el('div');let shown=0;const more=el('button','查看更多原话');more.type='button';more.className='ov2-btn';
 const add=()=>{const end=Math.min(shown+30,cv.msgs.length);for(;shown<end;shown++){const m=cv.msgs[shown],d=el('details'),pre=el('pre',m.text);pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:35vh;overflow:auto';d.append(el('summary',(m.role==='user'?'我':'TA')+' · '+m.text.slice(0,90).replace(/\s+/g,' ')),pre);preview.insertBefore(d,more);}more.hidden=shown>=cv.msgs.length;};preview.append(more);more.onclick=add;add();box.append(preview);host.append(box);
}
function rejectionUI(host,cv){
 if(!cv.historyRejected?.length&&!cv.historyBranchExcluded)return;
 const d=document.createElement('details'),s=document.createElement('summary');s.textContent='原始节点保留，聊天气泡未呈现：无正文 / 不支持 '+(cv.historyRejected?.length||0)+' 条'+(cv.historyBranchExcluded?'；路线外 '+cv.historyBranchExcluded+' 条':'');d.append(s);
 const pre=document.createElement('pre');pre.style.cssText='white-space:pre-wrap;max-height:30vh;overflow:auto';pre.textContent=(cv.historyRejected||[]).map(r=>'原消息 #'+(r.message_index+1)+'：'+r.reason).join('\n');d.append(pre);host.append(d);
}
function parseRoom(root){
 if(root.format!=='ib-room-v1'||!Array.isArray(root.conversations))throw Error('Room 转换文件格式不完整');
 const ids=new Set();return root.conversations.map(c=>{
  if(typeof c.id!=='string'||!c.id||!Array.isArray(c.messages))throw Error('Room 会话缺少原始标识');
  const msgs=c.messages.map(m=>{const key=JSON.stringify([c.id,m.id]);if(ids.has(key))throw Error('Room 来源 ID 重复');ids.add(key);
   if(typeof m.id!=='string'||!m.id||!['user','assistant'].includes(m.role)||typeof m.content!=='string'||!m.content.trim()||m.content.length>120000||!Number.isSafeInteger(m.timestamp)||m.timestamp<=0)throw Error('Room 消息字段无效或超过长度上限');
   return {role:m.role,text:m.content,ts:m.timestamp,mid:m.id,roomSource:{...m.source,source_file:root.source_file,source_sha256:root.source_sha256,original_time:m.timestamp}};});
  return {id:c.id,title:String(c.title||'Room 聊天记录'),msgs,named:true,t0:0};
 });
}
window.IBImportSupport={tree,route,select,ui,rejectionUI,parseRoom};
})();
