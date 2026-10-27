/* Native model picker, independent chat creation, and connection-scoped capacity. */
(function(){
 'use strict';
 const API=new URL('dwell-api/',location.href).pathname,requests=new Map(),lists=new Map();
 let panelToken=0;
 const clone=v=>structuredClone(v);
 const el=id=>document.getElementById(id);
 const text=(tag,value,cls)=>{const n=document.createElement(tag);n.textContent=value||'';if(cls)n.className=cls;return n;};
 const error=t=>{throw Error(t);};
 const connection=c=>({provider:String(c.provider||'custom'),endpoint:String(c.endpoint||'').trim(),model:String(c.model||'').trim(),apiKey:String(c.apiKey??c.key??'').trim()});
 const signature=c=>JSON.stringify([String(c.provider||'custom'),String(c.endpoint||'').trim().replace(/\/+$/,''),String(c.model||'').trim()]);
 const route=c=>{let host='';try{host=new URL(c.endpoint).host;}catch{}return{requested_model:String(c.model||PROVIDERS[c.provider]?.model||''),provider:c.provider,host};};
 const equalConnection=(a,b)=>JSON.stringify(connection(a))===JSON.stringify(connection(b));
 const validCapacity=n=>Number.isInteger(Number(n))&&Number(n)>=4096&&Number(n)<=4000000;
 function manualCapacity(cfg,pa={}){
  const n=pa.modelContextWindows?pa.modelContextWindows[signature(cfg)]:(cfg.ibContextBound?0:pa.contextWindow);
  return validCapacity(n)?Number(n):0;
 }
 function capacityPatch(oldCfg,newCfg,pa={},entered){
  const map={...(pa.modelContextWindows||{})};
  if(!pa.modelContextWindows&&oldCfg&&!oldCfg.ibContextBound&&validCapacity(pa.contextWindow))map[signature(oldCfg)]=Number(pa.contextWindow);
  const key=signature(newCfg);
  if(entered!==undefined){if(validCapacity(entered))map[key]=Number(entered);else delete map[key];}
  return{modelContextWindows:map,contextWindow:map[key]||0};
 }
 function capacityFor(cfg,pa,entered){
  const patch=capacityPatch(null,cfg,pa,entered);
  return window.IBContext.capacity(cfg,{...pa,...patch});
 }
 async function api(route,body){
  const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),20000);
  try{const res=await fetch(API+route,{method:'POST',credentials:'same-origin',cache:'no-store',signal:ac.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   const v=await res.json();if(!res.ok||!v.ok)error(v.error||'记忆接入未确认');return v;
  }finally{clearTimeout(tm);}
 }
 function same(s){return _activeCfg?.id===s.cfg.id&&String(_activeThread?.id||'')===s.threadId;}
 function busy(fid){
  if(requests.get(fid))return true;
  if([..._sendKeys].some(k=>k.startsWith(fid+'|')))return true;
  if(typeof _wsLoopStateM!=='undefined'&&[..._wsLoopStateM.values()].some(s=>s.cfg?.id===fid||s.rootAm?.friendId===fid))return true;
  if(typeof _contBusyM!=='undefined'&&[..._contBusyM].some(id=>(typeof _msgs!=='undefined'?_msgs:[]).some(m=>m.id===id&&m.friendId===fid)))return true;
  return false;
 }
 const attachments=()=>!!((typeof _pendImgs!=='undefined'&&_pendImgs.length)||(typeof _pendFiles!=='undefined'&&_pendFiles.length)||window._ibPendStk||
  (typeof _quote!=='undefined'&&_quote)||(typeof _pendLink!=='undefined'&&_pendLink)||(typeof _vtBusy!=='undefined'&&_vtBusy));
 const draftId=s=>'ib_chat_draft_v1_'+JSON.stringify([s.cfg.id,s.threadId]);
 const draftTasks=new Map();let restoringDraft=false;
 function draftTask(s,fn){const id=draftId(s),task=(draftTasks.get(id)||Promise.resolve()).catch(()=>{}).then(()=>fn(id));draftTasks.set(id,task);task.finally(()=>{if(draftTasks.get(id)===task)draftTasks.delete(id);}).catch(()=>{});return task;}
 function storeDraft(s,content,create=false){return draftTask(s,async id=>{const old=await dbGet('apiSettings',id);if(!old&&!create)return;
  if(content)await dbPut('apiSettings',_ibFormEdit('apiSettings',old||{id,kind:'ib-chat-draft-v1'},{content}));else if(old)await dbDelete('apiSettings',id);
 });}
 function draftSent(cfg,threadId,content){return draftTask({cfg,threadId:String(threadId||'')},async id=>{const old=await dbGet('apiSettings',id);if(old&&String(old.content||'').trim()===String(content||'').trim())await dbDelete('apiSettings',id);});}
 async function capture(){
  const active=_activeCfg;if(!active||active._group)error('请先打开单人聊天');
  const s={cfg:clone(active),threadId:String(_activeThread?.id||'')};
  const current=await dbGet('apiConfigs',active.id);if(!current||!same(s))error('聊天已切换或配置已删除');
  s.cfg=clone(current);s.prefs=await dbGet('apiSettings','mobilePrefs')||{id:'mobilePrefs',perAi:{}};
  s.pa=clone(s.prefs.perAi?.[current.id]||{});return s;
 }
 async function saveCapacity(s,cfg,entered){
  const patch=capacityPatch(s.cfg,cfg,s.pa,entered),perAi={...(s.prefs.perAi||{})};
  perAi[cfg.id]={...s.pa,...patch};
  await dbPut('apiSettings',_ibFormEdit('apiSettings',s.prefs,{perAi}));
  const latest=await dbGet('apiSettings','mobilePrefs');
  if(JSON.stringify(latest?.perAi?.[cfg.id]?.modelContextWindows?.[signature(cfg)])!==JSON.stringify(patch.modelContextWindows[signature(cfg)]))error('上下文容量存在同步冲突，当前选择保留');
 }
 async function checkCapacity(s,cfg,entered){
  if(entered!==undefined&&entered!==0&&!validCapacity(entered))error('上下文容量请填 4096～4000000，或留空');
  const ss=await getSummarySettingsM(),pa={...s.pa,...capacityPatch(s.cfg,cfg,s.pa,entered)};
  if(ss.enabled&&ss.mode==='rolling'&&!window.IBContext.capacity(cfg,pa).tokens)error('滚动模式需要新模型的上下文容量，请填写后再切换');
 }
 async function switchTo(s,selected,entered){
  const choice=connection(selected);if(!choice.model||!choice.endpoint)error('请填写模型和接口地址');
  if(!same(s))error('聊天已切换，当前选择保留');if(busy(s.cfg.id))error('等这个聊天对象的回复或工具续答结束后再切换');
  const latest=await dbGet('apiConfigs',s.cfg.id);if(!latest)error('这个聊天对象已删除');
  await checkCapacity(s,choice,entered);
  if(!same(s)||busy(s.cfg.id))error('聊天状态已变化，请稍后重试');
  await saveCapacity(s,{...s.cfg,...choice},entered);
  if(!same(s)||busy(s.cfg.id))error('聊天状态已变化，模型没有切换');
  const value=_ibFormEdit('apiConfigs',s.cfg,{...choice,ibContextBound:true});await dbPut('apiConfigs',value);
  await window.IBCloud.run();
  const saved=await dbGet('apiConfigs',s.cfg.id);if(!saved||!equalConnection(saved,choice))error('另一端同时改了接口，当前选择保留；请查看同步冲突');
  if(same(s)){_activeCfg=clone(saved);label(saved);}
  await loadCfgs();
  const pending=!!await dbGet('ibCloudOutbox',JSON.stringify(['apiConfigs',saved.id]));
  return{cfg:saved,pending};
 }
 function defaults(choice,name,systemPrompt){return{
  ...connection(choice),ibContextBound:true,nickname:name,systemPrompt,relationship:'',temperature:1,autoMem:false,autoMemMode:'hybrid',autoMemBudget:1200,
  amRecordOnly:false,streaming:true,thinkingEnabled:false,vision:!!PROVIDERS[choice.provider]?.vision,webSearch:false,promptCache:true,
  cacheTtl1h:false,fallbackMode:'off',fallbackModels:'',memWrite:false,beyond:{on:false,vis:'all',post:true,cmt:true,img:false,view:'ask'}
 };}
 async function targetDeleted(job){const id=JSON.stringify(['apiConfigs',job.cfg.id]);return !!((await dbGet('ibCloudOutbox',id))?.deleted||(await dbGet('ibCloudMeta',id))?.deleted);}
 async function cancelDeletedJob(job){const latest=await dbGet('apiSettings',job.id);if(latest?.state==='pending'){
  await dbPut('apiSettings',_ibFormEdit('apiSettings',latest,{state:'cancelled',reason:'target_deleted',finished_at:Date.now()}));
 }job.state='cancelled';}
 async function requireTarget(job){
  if(await targetDeleted(job)){await cancelDeletedJob(job);const e=Error('上次创建的聊天已删除，可重新创建；不会恢复已删除的聊天');e.code='IB_TARGET_DELETED';throw e;}
  const stored=await dbGet('apiConfigs',job.cfg.id);if(!stored)error('上次创建的聊天暂未读到，请同步后重试');return stored;
 }
 async function pendingJob(s){const jobs=(await dbGetAll('apiSettings')).filter(j=>j.kind==='ib-model-create-job-v1'&&j.state==='pending'&&j.source_id===s.cfg.id&&j.source_thread===s.threadId).sort((a,b)=>b.created-a.created);
  for(const job of jobs){if(await targetDeleted(job)){await cancelDeletedJob(job);continue;}return job;}return null;
 }
 const creates=new Set();
 async function create(s,choice,options,job=null){
  if(!same(s))error('聊天已切换，没有开始创建');
  if(attachments())error('输入框还有附件或引用，请先处理后再新建聊天；当前草稿保留');
  if(busy(s.cfg.id))error('等这个聊天对象的回复或工具续答结束后再新建');
  const key=JSON.stringify([s.cfg.id,s.threadId]);if(creates.has(key))error('正在创建同一个聊天');creates.add(key);
  try{
   let draft=el('cv-ta')?.value||'';
   if(!job){
    if(!choice.model||!choice.endpoint)error('请填写模型和接口地址');
    const name=String(options.name||choice.model).trim();if(!name||name.length>64)error('聊天名称请填 1～64 字');
    if(!(await dbGet('apiConfigs',s.cfg.id)))error('原聊天已删除');
    const configs=await dbGetAll('apiConfigs');if(configs.filter(c=>!c.archived).length>=API_MAX)error('最多 '+API_MAX+' 个聊天配置，请先归档一些');
    const child={id:'friend_'+crypto.randomUUID(),created:Date.now(),...defaults(choice,name,options.persona?s.cfg.systemPrompt||'':'')};
    await checkCapacity({...s,pa:{}},child,options.capacity);
    let memoryPrincipal=null;if(options.memory){const st=await api('status',{friend_id:s.cfg.id,thread_id:s.threadId});if(!st.enabled||!st.principal)error('原聊天尚未接入记忆库，请选暂不接入');memoryPrincipal=st.principal;}
    if(!same(s)||attachments()||busy(s.cfg.id))error('原聊天状态已变化，没有创建');
    const id=crypto.randomUUID();job={id:'ib_model_create_job_v1_'+id,kind:'ib-model-create-job-v1',request_id:id,state:'pending',source_id:s.cfg.id,source_thread:s.threadId,
     cfg:child,memory:!!options.memory,memory_principal:memoryPrincipal,capacity:options.capacity||0,created:Date.now()};
    await dbPut('apiSettings',job);
   }
   if(same(s))draft=el('cv-ta')?.value||'';
   await storeDraft(s,draft,true);
   let stored=await dbGet('apiConfigs',job.cfg.id);
   if(!stored){
    if(job.config_saved||await targetDeleted(job))await requireTarget(job);
    const prefs=await dbGet('apiSettings','mobilePrefs')||{id:'mobilePrefs',perAi:{}};
    const perAi={...(prefs.perAi||{})};perAi[job.cfg.id]={hbOff:true,...capacityPatch(null,job.cfg,{},job.capacity)};
    await dbPut('apiSettings',_ibFormEdit('apiSettings',prefs,{perAi}));
    await dbPut('apiConfigs',clone(job.cfg));stored=await dbGet('apiConfigs',job.cfg.id);
    if(!stored||!equalConnection(stored,job.cfg))error('新聊天尚未保存，原请求已保留');
    job.config_saved=true;await dbPut('apiSettings',job);
   }
   await window.IBCloud.run();
   stored=await requireTarget(job);
   if(job.memory){
    if(!job.memory_principal)error('旧创建任务未记录记忆库，请在新对象的 Dwell 面板明确接入');
    let status=await api('status',{friend_id:job.cfg.id,thread_id:''});
    if(!status.enabled){await api('bind',{friend_id:job.cfg.id,thread_id:'',enabled:true,library_id:job.memory_principal});status=await api('status',{friend_id:job.cfg.id,thread_id:''});}
    if(!status.enabled||status.principal!==job.memory_principal)error('聊天已创建，记忆接入待确认；再次提交会确认同一个聊天');
   }
   job.state='done';await dbPut('apiSettings',job);
   try{await loadCfgs();}catch{}
   const mayNavigate=same(s)&&!attachments()&&!busy(s.cfg.id)&&(el('cv-ta')?.value||'')===draft;
   return{cfg:stored,mayNavigate,draft,job,pending:!!await dbGet('ibCloudOutbox',JSON.stringify(['apiConfigs',stored.id]))};
  }catch(e){if(e.code==='IB_TARGET_DELETED')throw e;if(job?.config_saved)throw Error('聊天已创建，后续步骤待确认：'+e.message+'。再次提交不会重复创建');throw e;}
  finally{creates.delete(key);}
 }
 async function listModels(cfg,signal){
  await loadMP();
  const c=connection(cfg),cacheKey=JSON.stringify([Object.values(c),window._ibApiProxyModeM?window._ibApiProxyModeM(cfg):'direct']);if(lists.has(cacheKey))return clone(lists.get(cacheKey));
  const reqs=c.provider==='custom'?_modelListReqCustom(c.endpoint,c.apiKey):[_modelListReq(c.provider,c.endpoint,c.apiKey)].filter(Boolean);
  let last='该接口没有模型列表';const started=Date.now();
  for(const req of reqs){
   if(signal?.aborted)throw new DOMException('Aborted','AbortError');if(Date.now()-started>25000)break;
   const ac=new AbortController(),abort=()=>ac.abort();signal?.addEventListener('abort',abort,{once:true});
   const tm=setTimeout(abort,reqs.length>1?7000:20000);
   try{const res=await (window._ibApiRouteFetchM?window._ibApiRouteFetchM(cfg,req.url,{method:'GET',headers:req.headers,signal:ac.signal}):fetch(req.url,{headers:req.headers,signal:ac.signal}));if(!res.ok){last='模型列表返回 HTTP '+res.status;continue;}
    const list=_modelListParse(req.kind,await res.json());if(list.length){lists.set(cacheKey,clone(list));return list;}
   }catch(e){if(signal?.aborted)throw e;last=e.name==='AbortError'?'模型列表超时':'模型列表无法读取，仍可手填模型 ID';}
   finally{clearTimeout(tm);signal?.removeEventListener('abort',abort);}
  }error(last+'，仍可手填模型 ID');
 }
 function label(cfg){
  setConvSub(cfg);
 }
 function receipt(cfg,attempts){return{...route(cfg),returned_model:attempts?.at(-1)?.returned_model||'',created_at:Date.now()};}
 function group(host,name,input){const g=text('div','','f-group');g.append(text('label',name));if(input.tagName==='SELECT'){const wrap=text('div','','sel');wrap.append(input);g.append(wrap);}else g.append(input);host.append(g);return g;}
 async function open(isCreate=false){
  const token=++panelToken;let s;try{s=await capture();}catch(e){toast(e.message);return;}
  if(token!==panelToken||!same(s))return;
  el('sheet-model-picker')?.remove();const box=text('div','','sheet');box.id='sheet-model-picker';box.setAttribute('role','dialog');
  const title=isCreate?'用其他模型新建聊天':'切换此聊天对象的模型';box.setAttribute('aria-label',title);box.append(text('h3',title));
  const body=text('div','','dw-sheet-body'),footer=text('div','','sheet-btns'),advanced=text('details','','dw-evidence');advanced.append(text('summary','更多：上下文容量和保存预设'));box.append(body,footer);
  body.append(text('p',isCreate?'新聊天有独立记录，沿用接口无需重填 Key。':'主聊天及其频道共用此设置；其他独立聊天不受影响。','hint'));
  const preset=text('select'),model=text('input'),cap=text('input'),name=text('input'),persona=text('input'),memory=text('select');
  preset.id='ib-model-preset';model.id='ib-model-id';model.value=s.cfg.model||'';model.autocomplete='off';model.spellcheck=false;
  cap.id='ib-model-capacity';cap.type='number';cap.min='4096';cap.max='4000000';cap.placeholder='未知模型可手填；已知模型可留空';
  group(body,'接口／常用预设',preset);group(body,'模型 ID（可手填）',model);group(advanced,'上下文容量（token）',cap);
  const fetchButton=text('button','拉取所选接口模型列表','btn'),query=text('input'),results=text('select');
  const resultWrap=text('div','','sel');resultWrap.hidden=true;resultWrap.append(results);
  query.id='ib-model-search';query.placeholder='搜索模型';query.hidden=true;results.hidden=true;results.id='ib-model-results';body.append(fetchButton,query,resultWrap);
  let choice=connection(s.cfg),picked=null,sourceCfg=null,configs=[],models=[],controller=null,fetchVersion=0,job=null,submitted=false,memoryEdited=false;
  const activePanel=()=>token===panelToken&&box.isConnected&&same(s);
  memory.onchange=()=>{memoryEdited=true;};
  memory.onpointerdown=()=>{memoryEdited=true;};memory.onkeydown=e=>{if(e.key!=='Tab')memoryEdited=true;};
  const status=text('p','','hint');status.id='ib-model-notice';body.append(status);
  const renderCapacity=()=>{const c={...choice,model:model.value.trim()};cap.value=String(manualCapacity(c,isCreate?{}:{...s.pa,...capacityPatch(s.cfg,c,s.pa)})||'');};renderCapacity();
  const addName=text('input');addName.id='ib-model-preset-name';addName.maxLength=64;addName.placeholder='预设名称';
  const presetActions=text('div','','sheet-btns'),savePreset=text('button','另存预设','btn'),updatePreset=text('button','更新所选预设','btn');
  updatePreset.disabled=true;group(advanced,'存为常用（选填）',addName);presetActions.append(savePreset,updatePreset);advanced.append(presetActions);
  const reloadPresets=async()=>{
   const [saved,pool]=await Promise.all([dbGetAll('apiConfigs'),IBApiPresets.list().catch(()=>{status.textContent='常用预设读取失败，仍可选择已保存接口。';return[];})]);if(!box.isConnected)return;
   configs=saved.filter(c=>c.id!==s.cfg.id&&!c.archived&&!c._group&&connection(c).endpoint&&connection(c).model);
   preset.replaceChildren();const current=text('option','沿用当前接口');current.value='';preset.append(current);
   if(configs.length){const group=text('optgroup');group.label='已保存接口';for(const c of configs){const r=route(c),o=text('option',(c.nickname||c.name||c.model)+' · '+(r.host||PROVIDERS[c.provider]?.name||c.provider)+' · '+c.model);o.value='cfg:'+c.id;group.append(o);}preset.append(group);}
   if(pool.length){const group=text('optgroup');group.label='常用预设';for(const p of pool){const o=text('option',p.name+' · '+p.model);o.value=p.id;group.append(o);}preset.append(group);}
   if(picked&&pool.some(p=>p.id===picked.id))preset.value=picked.id;
   else if(sourceCfg&&configs.some(c=>c.id===sourceCfg.id))preset.value='cfg:'+sourceCfg.id;
   return pool;
  };
  let pool=[];
  const cancelFetch=()=>{controller?.abort();fetchVersion++;fetchButton.disabled=false;fetchButton.textContent='拉取所选接口模型列表';};
  preset.onchange=()=>{cancelFetch();picked=pool.find(p=>p.id===preset.value)||null;sourceCfg=configs.find(c=>'cfg:'+c.id===preset.value)||null;choice=connection(picked||sourceCfg||s.cfg);model.value=choice.model;renderCapacity();models=[];query.hidden=results.hidden=resultWrap.hidden=true;updatePreset.disabled=!picked;addName.value=picked?.name||'';if(isCreate&&!name.dataset.edited)name.value=model.value;};
  model.oninput=()=>{renderCapacity();if(isCreate&&!name.dataset.edited)name.value=model.value;};
  const draw=()=>{results.replaceChildren(text('option','选择一个模型'));for(const m of models.filter(m=>(m.id+' '+m.name).toLowerCase().includes(query.value.toLowerCase()))){const o=text('option',m.id+(m.name&&m.name!==m.id?' · '+m.name:''));o.value=m.id;results.append(o);}};
  query.oninput=draw;results.onchange=()=>{if(results.value&&models.some(m=>m.id===results.value)){model.value=results.value;model.oninput();}};
  fetchButton.onclick=async()=>{cancelFetch();const version=fetchVersion;controller=new AbortController();fetchButton.disabled=true;fetchButton.textContent='拉取中…';
   try{const list=await listModels({...choice,id:s.cfg.id},controller.signal);if(version!==fetchVersion||!box.isConnected)return;models=list;query.value='';query.hidden=results.hidden=resultWrap.hidden=false;draw();status.textContent='模型列表仅供选择，是否有权限以实际调用为准。';}
   catch(e){if(version===fetchVersion&&box.isConnected)status.textContent=e.message;}
   finally{if(version===fetchVersion){fetchButton.disabled=false;fetchButton.textContent='拉取所选接口模型列表';}}
  };
  const storePreset=async update=>{if(update&&!picked)return;try{const result=await IBApiPresets.save({...choice,model:model.value.trim(),key:choice.apiKey},addName.value,update?picked:null);picked=result;sourceCfg=null;pool=await reloadPresets();updatePreset.disabled=false;status.textContent='预设已存入本机，同步状态可在同步面板查看。';}catch(e){status.textContent=e.message;}};
  savePreset.onclick=()=>storePreset(false);updatePreset.onclick=()=>storePreset(true);
  name.id='ib-model-chat-name';name.value=model.value;name.maxLength=64;name.oninput=()=>name.dataset.edited='1';persona.type='checkbox';persona.checked=true;
  if(isCreate){group(body,'聊天名称',name);group(body,'沿用当前人设',persona).className+=' ib-model-inline';memory.id='ib-model-memory';
   const off=text('option','暂不接入 Dwell 记忆');off.value='off';const on=text('option','共用当前对象的记忆库');on.value='on';on.disabled=true;memory.append(off,on);group(body,'Dwell 记忆',memory);status.textContent='正在确认当前记忆接入…';
   api('status',{friend_id:s.cfg.id,thread_id:s.threadId}).then(async st=>{if(!activePanel()||job||submitted)return;on.disabled=!st.enabled;const pref=await dbGet('apiSettings','ib_model_memory_choice_'+s.cfg.id);if(!activePanel()||job||submitted||memoryEdited)return;memory.value=st.enabled&&pref?.enabled!==false?'on':'off';status.textContent=st.enabled?'可共用当前对象的长期记忆，新聊天主线独立。':'原聊天未接入记忆库，新聊天默认不接入。';}).catch(()=>{if(activePanel()&&!job&&!submitted&&!memoryEdited)status.textContent='暂无法确认记忆接入，可选择暂不接入后创建。';});
  }
  body.append(advanced);
  const close=text('button','取消','btn'),submit=text('button',isCreate?'创建聊天':'切换，继续聊天','btn primary');close.onclick=()=>{if(submitted)return;cancelFetch();closeSheets();panelToken++;};footer.append(close,submit);
  submit.id='ib-model-submit';submit.disabled=busy(s.cfg.id);
  if(submit.disabled)status.textContent='这个聊天对象正在生成或工具续答，结束后重开面板即可切换。';
  submit.onclick=async()=>{if(submitted)return;submitted=true;submit.disabled=close.disabled=true;cancelFetch();
   try{const c={...choice,model:model.value.trim()},entered=cap.value.trim()?Number(cap.value):0,options={name:name.value,persona:persona.checked,memory:memory.value==='on',capacity:entered};
    if(isCreate)job=job||await pendingJob(s);
    if(sourceCfg&&!job){const latest=await dbGet('apiConfigs',sourceCfg.id);if(!latest||latest.archived||!equalConnection(latest,sourceCfg))error('所选接口已修改、归档或删除，请重新打开选择；当前聊天没有切换');}
    if(isCreate){job=job||await pendingJob(s);const result=await create(s,c,options,job);
     job=result.job;
     await dbPut('apiSettings',{id:'ib_model_memory_choice_'+s.cfg.id,enabled:result.job.memory}).catch(()=>{});
     if(result.mayNavigate&&activePanel()&&!attachments()&&!busy(s.cfg.id)&&(el('cv-ta')?.value||'')===result.draft){closeSheets();el('cv-ta').value='';await openConv(result.cfg,null,{skipAutoSummary:true});}
     toast(result.pending?'聊天已创建，本机记录待同步':'聊天已创建');
    }else{const result=await switchTo(s,c,entered);if(box.isConnected)closeSheets();toast(result.pending?'本机已切换，待同步':'模型已切换');}
   }catch(e){if(e.code==='IB_TARGET_DELETED'){job=null;for(const n of [preset,model,cap,name,persona,memory])n.disabled=false;preset.value='';preset.onchange();submit.textContent='创建聊天';}else if(isCreate)job=job||await pendingJob(s);status.textContent=e.message;if(e.message.includes('上下文容量'))advanced.open=true;if(job){submit.textContent='确认上次创建';for(const n of [preset,model,cap,name,persona,memory])n.disabled=true;}}
   finally{submitted=false;submit.disabled=close.disabled=false;}
  };
  document.body.append(box);closeSheets();openSheet(box.id);
  try{pool=await reloadPresets();if(isCreate){job=await pendingJob(s);if(job){status.textContent='上次创建尚待确认；提交会恢复同一个聊天。';submit.textContent='确认上次创建';for(const n of [preset,model,cap,name,persona,memory])n.disabled=true;model.value=job.cfg.model;name.value=job.cfg.nickname;memory.value=job.memory?'on':'off';}}}catch(e){status.textContent='接口选项读取失败，仍可沿用当前接口并手填模型 ID。';}
 }
 const originalCall=callAI;callAI=async function(cfg){const frozen=clone(cfg),args=[frozen,...Array.from(arguments).slice(1)];requests.set(cfg.id,(requests.get(cfg.id)||0)+1);try{return await originalCall.apply(this,args);}finally{requests.set(cfg.id,requests.get(cfg.id)-1);}};
 if(typeof callAIC==='function'){const originalRecovery=callAIC;callAIC=async function(cfg){const frozen=clone(cfg),args=[frozen,...Array.from(arguments).slice(1)];requests.set(cfg.id,(requests.get(cfg.id)||0)+1);try{return await originalRecovery.apply(this,args);}finally{requests.set(cfg.id,requests.get(cfg.id)-1);}};}
 const originalOpen=openConv;openConv=async function(cfg,thread,options){const result=await originalOpen(cfg,thread,options);const s={cfg,threadId:String(thread?.id||'')};if(same(s)&&!attachments()&&!el('cv-ta')?.value){await draftTasks.get(draftId(s));const draft=await dbGet('apiSettings',draftId(s));if(draft&&same(s)&&!attachments()&&!el('cv-ta')?.value){el('cv-ta').value=draft.content||'';restoringDraft=true;try{el('cv-ta').dispatchEvent(new Event('input',{bubbles:true}));}finally{restoringDraft=false;}await draftSent(cfg,s.threadId,draft.content);}}return result;};
 document.addEventListener('input',event=>{if(event.target?.id!=='cv-ta'||restoringDraft||!_activeCfg||_activeCfg._group)return;const s={cfg:{id:_activeCfg.id},threadId:String(_activeThread?.id||'')};storeDraft(s,event.target.value||'').catch(()=>toast('草稿备份更新失败，请先保留输入内容'));});
 document.addEventListener('input',event=>{if(!['aset-model','aset-endpoint'].includes(event.target?.id))return;updateAsetCapacity();});
 document.addEventListener('change',event=>{if(event.target?.id==='aset-provider')updateAsetCapacity();});
 function updateAsetCapacity(){if(!window.IBModels||!el('aset-ctxwin'))return;const cfg={provider:el('aset-provider').value,endpoint:el('aset-endpoint').value,model:el('aset-model').value};const pa=_editMPBase?.perAi?.[_editCfgId]||{};
  el('aset-ctxwin').value=String(manualCapacity(cfg,{...pa,...capacityPatch(_editCfgBase,cfg,pa)})||0);}
 window.IBModels={connection,signature,manualCapacity,capacityPatch,capacityFor,listModels,capture,switchTo,create,pendingJob,open,label,receipt,busy,route,updateAsetCapacity,draftSent};
 const style=text('style');style.textContent='#sheet-model-picker .dw-sheet-body{overflow:auto;max-height:65dvh}#sheet-model-picker input:not([type=checkbox]),#sheet-model-picker select{width:100%;min-width:0}#sheet-model-picker input[type=checkbox]{width:20px;height:20px}#sheet-model-picker .sheet-btns{flex-wrap:wrap}#sheet-model-picker .ib-model-inline{display:flex;align-items:center;justify-content:space-between}#sheet-model-picker .ib-model-inline label{margin:0}#sheet-model-picker details{margin-top:14px}#sheet-model-picker details[open]>summary{margin-bottom:12px}';document.head.append(style);
})();
