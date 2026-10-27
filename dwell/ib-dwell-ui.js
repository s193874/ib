/* Dwell views reuse IB's message info and bottom-sheet components. */
(function () {
  'use strict';
  const API=new URL('dwell-api/',location.href).pathname;
  const statusNames={prepared:'已准备，尚未调用模型',dispatched:'已调用模型',completed:'回复已保存',stopped:'已停止，保留部分回复',failed:'回复已保存，主线更新失败',unbound:'此角色未接入 Dwell',unavailable:'本轮记忆读取失败'};
  const nodeNames={active:'当前',suspended:'挂起',pending_settle:'待收束',settled:'已收束'};
  const text=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;};
  function row(host,label,value) {const e=text('div','','mi-row');e.append(text('span',label),text('b',value));host.append(e);}
  function fold(host,title,body) {
    const d=text('details','','dw-evidence'),s=text('summary',title);d.append(s);
    if(typeof body==='string')d.append(text('pre',body,'dw-evidence-text'));else d.append(body);
    host.append(d);return d;
  }
  function receiptDetails(host,m) {
    const r=m.dwell, g=text('div','','mi-grid');host.append(g);
    if(r?.context_plan){const p=r.context_plan;row(g,'滚动上下文（首次生成）','原文 '+p.raw_message_count+' 条 · 摘要 '+(p.segments||[]).length+' 段');row(g,'输入估算',p.estimated_tokens+' / '+p.input_limit+' token');row(g,'容量依据',p.capacity_source+' · '+p.context_capacity+'；输出预留 '+p.output_reserve);if(p.omitted_segments)row(g,'未带入的旧摘要',p.omitted_segments+' 段，原记录保留');if(p.locally_verified_unsynced)row(g,'仅本机核验的新原话',p.locally_verified_unsynced+' 条尚无完整云端记录');if(p.segments?.length)fold(host,'本次实际带入的阶段摘要',p.segments.map(s=>new Date(s.from).toLocaleString()+' — '+new Date(s.to).toLocaleString()+'\n'+s.summary).join('\n\n'));}
    if(!r){row(g,'Dwell','这条消息未保存首次生成的注入记录');}
    if(r){
    row(g,'Dwell',statusNames[r.stage]||'状态未知');
    if(Array.isArray(r.native_memory_refs)){
      row(g,'IB 原生记忆',r.native_memory_refs.length+' 条');
      if(r.native_memory_context)fold(host,'本次实际带入的 IB 原生记忆',r.native_memory_context);
    }
    row(g,'Dwell 实际带入',r.context_included?'长期记忆 '+(r.memory_refs||[]).length+' 条 · '+(r.context||'').length+' 字符':'没有带入 Dwell 上下文');
    if(r.reference_refs?.length)row(g,'Dwell 导入资料',r.reference_refs.length+' 份（用户核对后的参考资料）');
    if(r.core_memory?.enabled){const c=r.core_memory;row(g,'自动维护核心记忆','版本 '+c.revision+' · '+(c.pending_statements?'使用待整理的最新原话':(c.refs||[]).length+' 条'));if(c.omitted)row(g,'核心记忆预算',c.omitted+' 条未带入，原记录保留');if(c.context)fold(host,'本轮实际带入的核心记忆',c.context);}
    if(r.reference_omitted)row(g,'资料预算',r.reference_omitted+' 份未完整放入，已省略');
    if(r.context_included&&r.reference_context)fold(host,'本次实际带入的导入资料',r.reference_context);
    if(r.principal)row(g,'记忆库标识',r.principal);
    if(r.historical)row(g,'生成方式','历史重生成 · 使用重生成时的当前有效记忆');
    if(r.warning||r.error)host.append(text('p',r.error||r.warning,'hint'));
    if(r.memory_suspended)row(g,'长期记忆','来源更新或人工修正待确认，本轮暂停注入');
    if(r.context_included) {
      fold(host,'查看这条回复实际收到的 Dwell 内容',r.context||'');
      const versions=text('div');
      for(const ref of r.memory_refs||[])row(versions,ref.topic_key||'有效理解','v'+ref.version_no+' · '+ref.thought_id);
      if((r.memory_refs||[]).length)fold(host,'记忆版本和来源',versions);
      if(r.input_state?.nodes?.length)fold(host,'生成时的主线',stateView(r.input_state,r));
    }
    if(r.stage==='completed'||r.stage==='failed')row(g,'回复后的主线更新',r.state_applied?'已应用':'未应用');
    if(r.output_state)fold(host,'这条回复实际保存的主线',stateView(r.output_state,r));
    if(r.candidate_rejection)host.append(text('p','候选未采纳：'+r.candidate_rejection,'hint'));
    if(r.intent_guard)row(g,'主线修正依据',r.intent_guard==='explicit_return'?'用户明确返回指令':'用户明确换题指令');
    if(r.protocol)row(g,'生成结束状态',r.protocol.truncated?'输出被截断':r.protocol.parse_status==='ignored_followup'?'续答结构标签已隐藏，未更新主线':r.protocol.parse_status==='parsed'?'结构候选已解析':r.protocol.parse_status==='omitted'?'未返回结构候选':r.protocol.parse_status||r.protocol.finish_reason);
    }
    for(const call of m.dwell_calls||[]){const area=text('div');const labels={tool_followup:'工具续答',workspace_followup:'工作区续答',continue:'继续生成'};fold(host,(labels[call.call_type]||'模型调用')+' · '+new Date(call.created_at).toLocaleString(),area);receipt(area,{dwell:call});}
    if(m.regeneration_versions?.length) {
      const versions=text('div');
      for(const old of m.regeneration_versions.slice().reverse()) {
        const body=text('div');body.append(text('p',old.content||'','dw-evidence-text'));
        if(old.dwell)receipt(body,old);
        fold(versions,'重生成前的回复 · '+new Date(old.saved_at).toLocaleString(),body);
      }
      fold(host,'此前回复版本（'+m.regeneration_versions.length+'）',versions);
    }
  }
  function readableContext(content) {
    const cats={identity:'身份',relationship:'相处约定',preference:'偏好',correction:'纠正',background:'背景',recent:'近期状态',event:'共同经历'};
    return String(content).split('\n').map(line=>{
      try{const entry=JSON.parse(line);if(typeof entry['记忆']==='string')return (cats[entry['类别']]||'记忆')+'：'+entry['记忆'];if(typeof entry['原话']==='string')return '你的原话：'+entry['原话'];}catch{}
      return line.replace(/（Thought [a-zA-Z0-9_-]+(?: v\d+)?）/g,'')
        .replace(/^来源摘录 Raw [a-zA-Z0-9_-]+ \[(user|assistant)\]/,(_,role)=>role==='user'?'你的原话':'回复原文')
        .replace(/^本轮未带入 Thought [a-zA-Z0-9_-]+ v\d+：/,'本轮有记忆未带入：');
    }).join('\n');
  }
  function receipt(host,m) {
    const r=m.dwell;
    if(!r){host.append(text('p','这条旧回复没有保存记忆记录。','hint'));return;}
    const sections=[['长期记忆',r.memory_context],['自动维护的记忆',r.core_memory?.context],['原有记忆',r.native_memory_context],['参考资料',r.reference_context],['找回的聊天原话',r.history_recall?.context]];
    let shown=false;
    for(const [title,content] of sections)if(content){const d=fold(host,title,readableContext(content));d.open=true;shown=true;}
    if(r.input_state?.nodes?.length){fold(host,'当时的频道主线',stateView(r.input_state,r)).open=true;shown=true;}
    if(!shown&&r.context){fold(host,'本轮带入的内容',r.context).open=true;shown=true;}
    if(!shown)host.append(text('p','本轮没有额外带入记忆。','hint'));
    const full=text('div');fold(full,'实际发送的完整 Dwell 内容',r.context||'（无）');
    if(r.native_memory_context)fold(full,'完整 IB 记忆内容',r.native_memory_context);
    const diagnostic=text('div');receiptDetails(diagnostic,m);fold(full,'技术详情',diagnostic);
    fold(host,'完整原始记录',full);
  }
  function stateView(state,identity) {
    const host=text('div');
    if(!state?.nodes?.length){host.append(text('p','当前没有已建立的频道主线。','hint'));return host;}
    const titles=new Map(state.nodes.map(n=>[n.id,n.title]));
    for(const n of state.nodes) {
      const body=text('div');row(body,n.id===state.focus?'当前焦点':'状态',nodeNames[n.status]||n.status);
      if(n.parent)row(body,'所属主线',titles.get(n.parent)||n.parent);
      if(n.return_to)body.append(text('p','返回点：'+n.return_to));
      if(n.sources?.length&&identity){const sources=text('div');fold(body,identity.source_messages?'当时的来源原话':'来源原话',sources);
        if(identity.source_messages){for(const m of identity.source_messages.filter(m=>n.sources.includes(m.id))){sources.append(text('p',(m.role==='user'?'你：':'AI：')+(m.content||''),'dw-evidence-text'));if(!identity.source_messages_full&&m.content?.length>=360){const more=text('button','查看现存的完整原话','mi-btn');more.onclick=async()=>{const full=await dbGet('chatMessages',m.id);if(full&&String(full.friendId)===identity.friend_id&&String(full.threadId||'')===identity.thread_id){more.replaceWith(text('p','当前保存的原话：\n'+full.content,'dw-evidence-text'));}else more.textContent='原话已不在当前聊天中';};sources.append(more);}}}
        else for(const id of n.sources)dbGet('chatMessages',id).then(m=>{if(!m||String(m.friendId)!==identity.friend_id||String(m.threadId||'')!==identity.thread_id)return;sources.append(text('p',(m.role==='user'?'你：':'AI：')+(m.content||''),'dw-evidence-text'));}).catch(()=>{});}
      const d=fold(host,n.title,body);if(n.id===state.focus)d.open=true;
    }
    return host;
  }
  function stateDiff(r) {
    if(!r?.state_applied||!r.output_state)return [];
    const before=new Map((r.input_state?.nodes||[]).map(n=>[n.id,n])),after=new Map((r.output_state.nodes||[]).map(n=>[n.id,n]));
    const fields=n=>JSON.stringify([n.title,n.status,n.parent||null,n.return_to||'']);
    const changes=[];
    for(const [id,n] of after){const old=before.get(id);if(!old||fields(old)!==fields(n))changes.push({kind:old?'更新':'新增',node:n,old});}
    for(const [id,n] of before)if(!after.has(id))changes.push({kind:'移出当前主线',node:n});
    if(r.input_state?.focus!==r.output_state.focus&&!changes.some(x=>x.node.id===r.output_state.focus)){
      const n=after.get(r.output_state.focus);if(n)changes.push({kind:'回到',node:n});
    }
    return changes;
  }
  function stateChanges(r) {
    return stateDiff(r).map(({kind,node:n})=>kind+' · '+n.title+(n.return_to?'\n'+n.return_to:'')).join('\n\n');
  }
  function stateCard(m,host) {
    host.querySelectorAll('.dw-state-card').forEach(e=>e.remove());
    const r=m.dwell;if(m.role!=='assistant'||r?.stage!=='completed'||!r.turn_id)return;
    const changes=stateDiff(r);if(!changes.length)return;
    const titles=[...new Set(changes.map(x=>x.node.title))].join('、');
    const card=wsOpCard({type:'mem_write'},{ok:true,label:'已更新频道主线 ·「'+titles+'」',response:stateChanges(r)});
    card.classList.add('dw-state-card');host.append(card);
    card.addEventListener('pointerdown',e=>e.stopPropagation());
  }
  function refreshStateCard(m) {
    for(const host of document.querySelectorAll('.m.ai[data-id]'))if(host.dataset.id===m.id)stateCard(m,host);
  }
  async function stateHistory(host,identity) {
    const area=text('div');area.append(text('p','历次保存的主线快照，仅供回看，不会重新注入模型；原话被编辑、删除或切换分支后，旧快照也可能失效。','hint'));
    const details=fold(host,'查看主线更新历史',area),more=text('button','读取更新历史','mi-btn');area.append(more);
    let before=null,loaded=false;
    more.onclick=async()=>{more.disabled=true;try{
      const result=await request('state/history',{...identity,...(before?{before}:{})});
      for(const item of result.items){const content=stateView(item.state);fold(area,'版本 '+item.revision+' · '+new Date(item.created*1000).toLocaleString(),content);}
      loaded=true;before=result.next_before;if(before){more.textContent='读取更早的更新';more.disabled=false;}else{more.remove();if(!result.items.length)area.append(text('p','没有更早的更新记录。','hint'));}
    }catch(e){area.append(text('p',e.message,'hint'));more.disabled=false;}};
    details.addEventListener('toggle',()=>{if(details.open&&!loaded&&!more.disabled)more.click();});
  }
  function receiptEntry(host,m) {
    const slot=text('div'),r=m.dwell,parts=[];
    if(r?.memory_context||r?.core_memory?.context||r?.native_memory_context)parts.push('记忆');
    if(r?.input_state?.nodes?.length)parts.push('频道主线');
    if(r?.reference_context)parts.push('参考资料');
    if(r?.history_recall?.context)parts.push('聊天原话');
    const item=fold(host,new Date(m.timestamp).toLocaleString()+' · '+(parts.join('、')||'本轮记录'),slot);
    let loaded=false;item.addEventListener('toggle',()=>{if(item.open&&!loaded){loaded=true;receipt(slot,m);fold(slot,'对应的完整回复',String(m.content||'')||'（无正文）');}});
  }
  function messageInfo(m,host) {
    if(m.role==='user')return;
    const area=text('section','','dw-message-info');
    const d=fold(area,'Dwell 记忆注入',text('div'));receipt(d.lastChild,m);
    if(m.branch_copy&&m.branch_original_metadata?.dwell){
      const original=fold(area,'原路线这条回复的 Dwell 记录（历史参考）',text('div'));
      receipt(original.lastChild,{dwell:m.branch_original_metadata.dwell,dwell_calls:m.branch_original_metadata.dwell_calls||[]});
    }
    const acts=host.querySelector('.mi-acts');if(acts)acts.before(area);else host.append(area);
  }
  async function request(route,body) {
    const r=await fetch(API+route,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const v=await r.json();if(!r.ok||!v.ok)throw Error(v.error||'读取失败');return v;
  }
  function topicView(items) {
    const host=text('div');
    for(const item of items||[]) {
      host.append(text('p',item.content||'','dw-evidence-text'));row(host,'理解版本','v'+item.version_no);
      for(const s of item.sources||[])fold(host,(s.origin==='memory_panel_edit'?'面板修正原文':'来源原话')+' · '+(s.role==='user'?'用户':'AI'),s.text||'');
    }
    if(!host.childNodes.length)host.append(text('p','没有可读取的当前有效理解。','hint'));
    return host;
  }
  function managedTopic(item,identity) {
    const host=text('div'),headline=text('p',item.content||'','dw-evidence-text'),info=text('p','','hint');
    host.append(headline,info);
    const controls=text('div','','mi-acts'),edit=text('button','修正理解','mi-btn'),pause=text('button','','mi-btn'),history=text('button','查看版本','mi-btn');
    controls.append(edit,pause,history);host.append(controls);
    const editor=text('div','','f-group');editor.hidden=true;
    const content=text('textarea');content.className='dw-evidence-text';content.rows=7;content.maxLength=8000;content.setAttribute('aria-label','修正后的理解');
    const reason=text('textarea');reason.rows=2;reason.maxLength=2000;reason.setAttribute('aria-label','修正说明（选填）');reason.placeholder='补充说明（选填）';
    editor.append(text('p','保存会给原 Sup 理解新增一个用户修正版，并设为当前有效理解。原版本及来源保留；其他读取这条理解的入口也会读到新版。','hint'),text('label','修正后的理解'),content,text('label','补充说明（选填）'),reason);
    const sources=text('div');editor.append(fold(editor,'关联本频道原话（选填，最多 10 条）',sources));
    const save=text('button','保存为当前有效理解','mi-btn'),cancel=text('button','取消编辑','mi-btn'),actions=text('div','','mi-acts');actions.append(save,cancel);editor.append(actions);host.append(editor);
    const notice=text('p','','hint'),versions=text('div');versions.hidden=true;host.append(notice,versions);
    let detail=null,editing=false,lastSignature='',requestId='',selected=[],editToken='';
    const describe=()=>{info.textContent=(item.fixed?'常驻 · ':'')+(item.effective_version_no?'当前有效 v'+item.effective_version_no:'当前无有效版本')+' · 最新 v'+item.latest_version_no+(item.paused?' · 已暂停在 IB 使用':'')+(!item.effective_valid?' · 当前来源待复核':'');pause.textContent=item.paused?'恢复在 IB 使用':'暂停在 IB 使用';};describe();
    edit.disabled=pause.disabled=history.disabled=true;
    async function load(){
      const v=await request('memory/detail',{...identity,thought_id:item.thought_id});if(!host.isConnected)return;
      detail=v;item={...item,...v.item};describe();
      edit.disabled=item.status!=='active';pause.disabled=false;history.disabled=false;
      if(!editing)headline.textContent=item.content||'';
      versions.replaceChildren();
      for(const version of v.versions||[]){
        const area=topicView([{...version,thought_id:item.thought_id,topic_key:item.topic_key}]);
        area.prepend(text('p',(version.writer_role==='user'?'用户直接修正':'既有记录')+' · '+new Date(version.occurred_at).toLocaleString()+(version.change_note?' · '+version.change_note:''),'hint'));
        fold(versions,'v'+version.version_no+' · '+version.version_state,area);
      }
      if(v.next_offset!==null&&v.next_offset!==undefined){
        const more=text('button','读取更早版本','mi-btn');more.onclick=async()=>{more.disabled=true;try{const older=await request('memory/detail',{...identity,thought_id:item.thought_id,offset:v.next_offset});for(const version of older.versions||[])fold(versions,'v'+version.version_no+' · '+version.version_state,topicView([version]));v.next_offset=older.next_offset;if(v.next_offset===null)more.remove();else more.disabled=false;}catch(e){more.disabled=false;notice.textContent=e.message;}};versions.append(more);
      }
      for(const p of v.policy_history||[])row(versions,'IB 使用状态',new Date(p.created*1000).toLocaleString()+' · '+(p.paused?'暂停':'恢复'));
      if(v.pending_manual){notice.textContent='有人工修正尚未确认，本轮长期记忆会暂缓注入；可重试确认。';
        const retry=text('button','重试确认','mi-btn');retry.onclick=async()=>{retry.disabled=true;try{await request('memory/retry',{...identity,thought_id:item.thought_id});retry.remove();await load();}catch(e){retry.disabled=false;notice.textContent=e.message;}};host.append(retry);}
    }
    edit.onclick=async()=>{
      editing=true;editToken=item.edit_token;editor.hidden=false;content.value=item.content||'';reason.value='';selected=[];sources.replaceChildren();
      const all=await dbGetAll('chatMessages');if(!host.isConnected)return;
      const rows=all.filter(m=>m.friendId===identity.friend_id&&String(m.threadId||'')===identity.thread_id&&m.role==='user'&&!m.generation_error&&!m.branch_copy).sort((a,b)=>a.timestamp-b.timestamp).slice(-20);
      for(const m of rows){const label=text('label'),check=text('input');check.type='checkbox';check.onchange=()=>{if(check.checked&&selected.length>=10){check.checked=false;return;}selected=check.checked?[...selected,m.id]:selected.filter(id=>id!==m.id);};label.append(check,document.createTextNode(' '+String(m.content||'')));sources.append(label,text('br'));}
      if(!rows.length)sources.append(text('p','本频道暂无可选原话；你的修正文字本身会保留为来源。','hint'));
    };
    cancel.onclick=()=>{editing=false;editor.hidden=true;notice.textContent='';};
    pause.onclick=async()=>{pause.disabled=true;notice.textContent='暂停／恢复作用于所有接入此记忆库的 IB 角色，保留原 Sup 内容。';try{await request('memory/policy',{...identity,thought_id:item.thought_id,expected_revision:item.revision,paused:!item.paused});await load();}catch(e){if(e.message==='memory_policy_conflict'){await load();notice.textContent='另一端已经改过使用状态，已读取最新状态；编辑草稿保留。';}else notice.textContent=e.message;}finally{pause.disabled=false;}};
    history.onclick=()=>{versions.hidden=!versions.hidden;history.textContent=versions.hidden?'查看版本':'收起版本';};
    save.onclick=async()=>{
      if(!content.value.trim()){notice.textContent='请填写修正后的理解';return;}
      const payload={...identity,thought_id:item.thought_id,expected_token:editToken,content:content.value,reason:reason.value,source_ids:selected};
      const signature=JSON.stringify(payload);if(signature!==lastSignature){requestId=crypto.randomUUID();lastSignature=signature;}
      save.disabled=true;content.disabled=reason.disabled=true;
      try{const result=await request('memory/revise',{...payload,request_id:requestId});editing=false;editor.hidden=true;notice.textContent='已保存用户修正版 v'+result.version_no;await load();}
      catch(e){
        notice.textContent=e.message==='memory_binding_changed'?'该角色已断开记忆接入，本次未保存；请重新接入后操作。':e.message==='memory_revision_conflict'?'另一端已经修改这条理解，你的草稿已保留。读取最新版本后可对照调整再保存。':e.message==='manual_source_changed'?'所选原话已变化或尚未同步，请更新选择后再保存。':'保存尚未确认，草稿保留：'+e.message;
        if(e.message==='memory_revision_conflict'){
          const refresh=text('button','读取最新版本作对照','mi-btn');refresh.onclick=async()=>{refresh.disabled=true;try{await load();editToken=item.edit_token;headline.textContent='最新有效理解：\n'+item.content;refresh.remove();notice.textContent='草稿保留，请对照最新内容调整后再保存。';}catch(error){refresh.disabled=false;notice.textContent=error.message;}};editor.append(refresh);
        }
      }finally{save.disabled=false;content.disabled=reason.disabled=false;}
    };
    const d=fold(document.createElement('div'),item.topic_key+(item.fixed?' · 常驻':''),host);
    let loaded=false;d.addEventListener('toggle',async()=>{if(!d.open||loaded)return;loaded=true;try{await load();}catch(e){loaded=false;notice.textContent=e.message;}});
    return d;
  }
  async function panel() {
    const cfg=_activeCfg?{..._activeCfg}:null,thread=_activeThread?{..._activeThread}:null;
    let box=document.getElementById('sheet-dwell');if(box)box.remove();
    box=text('div','','sheet');box.id='sheet-dwell';box.setAttribute('role','dialog');box.setAttribute('aria-label','Dwell 记忆与主线');
    box.append(text('h3','Dwell 记忆与主线'));
    const who=text('p',cfg?(cfgName(cfg)+(thread?' · '+thread.name:' · 主聊天')):'请先打开一个角色的聊天','hint');box.append(who);
    const tabs=text('div','','dw-sheet-tabs'),body=text('div','','dw-sheet-body'),footer=text('div','','sheet-btns');
    const close=text('button','关闭','btn');close.onclick=closeSheets;footer.append(close);box.append(tabs,body,footer);document.body.append(box);
    closeSheets();openSheet(box.id);
    if(!cfg||cfg._group){body.append(text('p','第一版 Dwell 接入单人聊天。','hint'));return;}
    const identity={friend_id:String(cfg.id),thread_id:thread?String(thread.id):''};
    let selected='memory',generation=0;
    async function draw(view) {
      selected=view;const gen=++generation;body.replaceChildren(text('p','正在读取…','hint'));
      for(const b of tabs.children){b.setAttribute('aria-selected',String(b.dataset.view===view));b.classList.toggle('on',b.dataset.view===view);}
      try {
        const st=await request('status',identity);if(gen!==generation||!box.isConnected)return;
        const registry=await request('libraries',identity);if(gen!==generation||!box.isConnected)return;
        const libraries=registry.libraries||[],bound=libraries.find(l=>l.principal_id===(st.principal||st.bound_library));
        body.replaceChildren();row(body,'接入状态',st.enabled?'已连接 · '+(bound?.name||'记忆库不可用'):'尚未接入');
        const libraryControls=text('div'),select=text('select');select.setAttribute('aria-label','记忆库');
        for(const lib of libraries){const option=text('option',lib.name);option.value=lib.principal_id;select.append(option);}
        if(bound)select.value=bound.principal_id;
        select.disabled=!!st.bound_library;
        libraryControls.append(select);
        if(!st.enabled){
          const bind=text('button',st.bound_library?'恢复此对象记忆':'接入所选记忆库','mi-btn');
          bind.onclick=async()=>{bind.disabled=true;try{await request('bind',{...identity,enabled:true,library_id:select.value});await draw(selected);}catch(e){libraryControls.append(text('p',e.message,'hint'));bind.disabled=false;}};
          libraryControls.append(bind);
        }
        const name=text('input');name.placeholder='新记忆库名称';name.maxLength=64;name.setAttribute('aria-label','新记忆库名称');
        const create=text('button','新建空记忆库','mi-btn');let createId=null,createName=null;
        create.onclick=async()=>{const value=name.value.trim();if(!value){name.focus();return;}create.disabled=true;
          try{if(!createId||createName!==value){createId=crypto.randomUUID();createName=value;}
            const made=await request('library/create',{...identity,name:value,request_id:createId});
            if(gen!==generation||!box.isConnected)return;
            const option=text('option',made.name);option.value=made.principal_id;
            if(!Array.from(select.options).some(o=>o.value===made.principal_id))select.append(option);
            if(!st.bound_library)select.value=made.principal_id;
            libraryControls.append(text('p','已新建空库「'+made.name+'」。'+(st.bound_library?'请在新对象的 Dwell 面板接入。':'点击接入所选记忆库即可使用。'),'hint'));
            name.value='';createId=null;
          }catch(e){libraryControls.append(text('p',e.message,'hint'));}finally{create.disabled=false;}
        };
        libraryControls.append(name,create,text('p','记忆库跟随对象，频道默认继承；切换模型不改变归属。已有归属的对象请用新对象接入另一套库。','hint'));
        fold(body,'记忆库与对象绑定',libraryControls).open=!st.enabled;
        if(st.pending_source_changes)body.append(text('p','还有 '+st.pending_source_changes+' 项原话更新或人工修正待确认；完成前暂缓长期记忆注入，聊天可以继续。','hint'));
        if(!st.enabled)return;
        const controls=text('div');
        const unbind=text('button','断开此角色记忆','mi-btn');unbind.onclick=async()=>{if(!await confirmDlg('断开此角色的 Sup 记忆接入？长期记忆和聊天记录保留。','断开'))return;unbind.disabled=true;try{await request('bind',{...identity,enabled:false});await draw(view);}catch(e){unbind.disabled=false;controls.append(text('p',e.message,'hint'));}};controls.append(unbind);
        if(view==='state'){const reset=text('button','清空本频道线索','mi-btn');reset.onclick=async()=>{if(!await confirmDlg('清空本频道可重建的主线线索？聊天原话和 Sup 长期记忆保留。','清空线索'))return;reset.disabled=true;try{await request('reset',identity);await draw(view);}catch(e){reset.disabled=false;controls.append(text('p',e.message,'hint'));}};controls.append(reset);}
        fold(body,'接入管理',controls);
        if(view==='memory') {
          const lib=await request('library',identity);if(gen!==generation||!box.isConnected)return;
          row(body,'可读取的话题',lib.topics.length+' 个');row(body,'常驻理解',lib.fixed.length+' 条');
          const cs=window.IBCore?await IBCore.request(identity.friend_id,'status').catch(()=>null):null;
          if(cs?.enabled)body.append(text('p','已开启自动维护核心记忆，记忆额度随模型上下文容量分配。旧话题与资料保留为参考；本轮核心记忆版本和实际内容可在消息信息中查看。','hint'));
          else body.append(text('p','每轮从未暂停的有效理解中读取常驻项和最多 '+lib.topic_limit+' 个相关话题；长期记忆文本上限 '+lib.text_budget+' 字符。实际带入内容在对应回复的右键／长按消息面板查看。','hint'));
          if(window.IBCore){const manage=text('button','自动维护记忆 · 导入普通 Claude 记忆','mi-btn');manage.onclick=()=>IBCore.open(identity.friend_id);body.append(manage);} 
          body.append(text('p','记忆由模型自动整理和维护，不需要逐条审核。想看时再打开；需要纠正时，直接在聊天里告诉它。','hint'));
          if(window.IBReferences){const refs=text('button','旧版导入资料','mi-btn');refs.onclick=()=>IBReferences.open(null,'',identity.friend_id);body.append(refs);}
          const managed=await request('memory/list',{...identity,offset:0});if(gen!==generation||!box.isConnected)return;
          body.append(text('p','可直接修正、查看版本或暂停在 IB 使用。暂停影响全部绑定此记忆库的 IB 角色；恢复仍须通过来源有效性检查。','hint'));
          for(const item of managed.items||[])body.append(managedTopic(item,identity));
          if(managed.next_offset!==null&&managed.next_offset!==undefined){const more=text('button','读取更多理解','mi-btn');more.onclick=async()=>{more.disabled=true;try{const v=await request('memory/list',{...identity,offset:managed.next_offset});if(gen!==generation||!box.isConnected)return;for(const item of v.items||[])more.before(managedTopic(item,identity));managed.next_offset=v.next_offset;if(v.next_offset===null)more.remove();else more.disabled=false;}catch(e){more.disabled=false;body.append(text('p',e.message,'hint'));}};body.append(more);}
        }else if(view==='state') {
          row(body,'本频道版本',String(st.revision));body.append(stateView(st.state,identity));
          body.append(text('p','上方为最新主线列表；模型可能合并或移出旧条目。历次保存的状态可在下方回看。','hint'));await stateHistory(body,identity);
          row(body,'待同步到 Sup 的原话',st.pending_sync+' 条');
        }else {
          const all=await dbGetAll('chatMessages');if(gen!==generation||!box.isConnected)return;
          const messages=all.filter(m=>m.friendId===cfg.id&&String(m.threadId||'')===identity.thread_id&&m.role==='assistant').sort((a,b)=>b.timestamp-a.timestamp);
          if(!messages.length)body.append(text('p','本频道尚无 AI 回复。','hint'));
          body.append(text('p','按回复时间查看当时带入的记忆，展开即可阅读完整内容。','hint'));
          let offset=0;const more=text('button','读取更早的注入记录','mi-btn');
          const add=()=>{for(const m of messages.slice(offset,offset+40))receiptEntry(body,m);offset+=40;if(offset<messages.length)body.append(more);else more.remove();};more.onclick=()=>{more.remove();add();};add();
        }
      }catch(e){if(gen===generation){body.replaceChildren(text('p',e.message,'hint'));const login=text('button','登录原 Dwell 账户','mi-btn');login.onclick=()=>{closeSheets();window.IBCloud?.panel();};body.append(login);}}
    }
    for(const [view,label] of [['memory','长期记忆'],['state','本频道主线'],['receipts','注入记录']]) {
      const b=text('button',label,'mi-btn');b.dataset.view=view;b.setAttribute('role','tab');b.onclick=()=>draw(view);tabs.append(b);
    }
    tabs.setAttribute('role','tablist');await draw(selected);
  }
  Object.assign(window.IBDwell,{panel,messageInfo,stateCard,refreshStateCard,receiptEntry,stateChanges,stateDiff});
})();
