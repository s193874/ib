/* Branches use the original channel sheet and account sync; no model call. */
(function(){
 'use strict';
 const busy=new Set(),API=new URL('dwell-api/',location.href).pathname;
 const errors={branch_source_changed:'原路线已经变化，请重新打开消息面板',branch_source_unavailable:'原消息或角色尚未同步，或已被删除',branch_history_too_large:'这段历史超过本次分叉容量，原记录保留；没有截断创建',branch_request_changed:'这次创建的内容已改变，请先确认上次创建结果',branch_already_deleted:'上次创建的分支已经删除，不会重新创建'};
 const same=(cfg,thread)=>_activeCfg?.id===cfg.id&&String(_activeThread?.id||'')===String(thread?.id||'');
 const draft=()=>!!(document.getElementById('cv-ta')?.value||'').trim()||
  (typeof _pendImgs!=='undefined'&&_pendImgs.length)||(typeof _pendFiles!=='undefined'&&_pendFiles.length)||!!window._ibPendStk;
 const can=m=>!!(m&&!m.generation_error&&!m.mark&&!m.callFold&&['user','assistant'].includes(m.role)&&
  _activeCfg&&!_activeCfg._group&&m.friendId===_activeCfg.id&&String(m.threadId||'')===String(_activeThread?.id||'')&&
  m.timestamp>Number((_activeThread||_activeCfg).sealTimestamp||0));
 async function capture(cfg,thread,selected){
  if(!window.IBContext||!window.IBCloud)throw Error('页面版本尚未准备好，请刷新后再试');
  if(!can(selected))throw Error('只能从当前单人频道的未封档消息分叉');
  if(_sendKeys.has(_keyOf(cfg.id,thread?.id||'')))throw Error('等当前回复结束后再分叉');
  if(draft())throw Error('输入框还有草稿或待发附件，先处理后再分叉');
  const snapshot=JSON.parse(JSON.stringify(selected)),sourceHash=await IBContext.hash(IBContext.stamp(snapshot));
  const jobs=(await dbGetAll('apiSettings')).filter(j=>j.kind==='ib-branch-job-v1'&&j.state==='pending'&&
   j.body.friend_id===cfg.id&&j.body.thread_id===String(thread?.id||'')&&j.body.target_id===selected.id);
  if(!same(cfg,thread))throw Error('已切换对话，没有开始分叉');
  return{cfg:JSON.parse(JSON.stringify(cfg)),thread:thread?JSON.parse(JSON.stringify(thread)):null,
   selected:snapshot,sourceHash,job:jobs.sort((a,b)=>b.created-a.created)[0]||null};
 }
 async function create(fork,name,memoryEnabled){
  const {cfg,thread,selected}=fork,key=_keyOf(cfg.id,thread?.id||'');
  if(busy.has(key))throw Error('这个分叉正在创建');
  if(!same(cfg,thread))throw Error('已切换对话，没有创建分叉');
  if(draft())throw Error('输入框还有草稿或待发附件，先处理后再分叉');
  if(_sendKeys.has(key))throw Error('等当前回复结束后再分叉');
  busy.add(key);
  try{
   let job=fork.job;
   if(!job&&(!String(name).trim()||String(name).trim().length>24))throw Error('请输入 1～24 字的频道名称');
   if(!job){
    await IBCloud.run();
    if(!same(cfg,thread)||draft())throw Error('对话或草稿已变化，没有创建分叉');
    const rows=(await dbGetAll('chatMessages')).filter(m=>m.friendId===cfg.id&&String(m.threadId||'')===String(thread?.id||'')&&
     ['user','assistant'].includes(m.role)&&!m.generation_error&&!m.mark&&!m.callFold&&m.timestamp>Number((thread||cfg).sealTimestamp||0))
     .sort((a,b)=>a.timestamp-b.timestamp||(String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0));
    const at=rows.findIndex(m=>m.id===selected.id);
    if(at<0||await IBContext.hash(IBContext.stamp(rows[at]))!==fork.sourceHash)throw Error(errors.branch_source_changed);
    const proofs=await Promise.all(rows.slice(0,at+1).map(async m=>[String(m.id),await IBContext.hash(IBContext.stamp(m))]));
    const requestId=crypto.randomUUID();
    job={id:'ib-branch-job-'+requestId,kind:'ib-branch-job-v1',state:'pending',created:Date.now(),body:{
     friend_id:String(cfg.id),thread_id:String(thread?.id||''),request_id:requestId,target_id:String(selected.id),
     prefix_hash:await IBContext.hash(proofs),seal_timestamp:Number((thread||cfg).sealTimestamp||0),name:String(name).trim(),memory_enabled:!!memoryEnabled}};
    await dbPut('apiSettings',job);fork.job=job;
   }
   const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),35000);let value;
   try{
    const response=await fetch(API+'branch/create',{method:'POST',credentials:'same-origin',cache:'no-store',signal:ac.signal,
     headers:{'Content-Type':'application/json'},body:JSON.stringify(job.body)});
    value=await response.json();
    if(!response.ok||!value.ok){
     if(response.status>=400&&response.status<500){job.state='failed';job.error=value.error;await dbPut('apiSettings',job);fork.job=null;}
     throw Error(errors[value.error]||value.error||'分叉创建未完成');
    }
   }finally{clearTimeout(timer);}
   if(value.thread?.id!=='thread_branch_'+job.body.request_id)throw Error('分叉返回的身份不匹配，原请求已保留');
   for(let attempt=0;attempt<2;attempt++){
    await IBCloud.run();
    const stored=await dbGet('chatThreads',value.thread.id),copies=(await dbGetAll('chatMessages')).filter(m=>m.friendId===cfg.id&&m.threadId===value.thread.id);
    if(stored&&copies.length===value.copied_count){
     job.state='done';job.thread_id=stored.id;await dbPut('apiSettings',job);fork.job=null;
     return{thread:stored,copied_count:value.copied_count,mayNavigate:same(cfg,thread)&&!draft()};
    }
   }
   throw Error('分叉已保存到云端，本机还没同步齐；再点保存会确认同一条，不重复创建');
  }catch(error){
   if(error.name==='AbortError')throw Error('暂未确认分叉是否创建；原请求已保留，再点保存不会重复创建');
   throw error;
  }finally{busy.delete(key);}
 }
 function description(t){const b=t?.branch;return b?'分自「'+b.source_name+'」，截至 '+new Date(b.target_timestamp).toLocaleString()+'，保留 '+b.copied_count+' 条历史快照。两条路线之后独立；Sup 长期记忆仍共用原库。':'';}
 window.IBBranch={can,capture,create,description};
})();
