/* IB V1: scoped Sup context + reversible dialogue projection. Provider credentials stay in IB. */
(function () {
  'use strict';
  const API = new URL('dwell-api/', location.href).pathname;
  const outboxKey = 'ib-dwell-mutations-v1';
  let draining = false;
  // Native IB memories have their own visibility rules. Public visibility alone
  // must not grant an independent Dwell object another object's prior memories.
  const nativeScopes = new Map();
  function rememberNativeScope(fid, status) {
    const bindings=status.native_bindings;
    const verified=!!bindings&&typeof bindings==='object'&&!Array.isArray(bindings)
      &&Object.values(bindings).every(p=>typeof p==='string'&&p.length>0);
    nativeScopes.set(String(fid),{verified,principal:status.bound_library||status.principal||null,
      bindings:verified?new Map(Object.entries(bindings)):new Map()});
  }
  function nativeMemoryVisible(memory, fid) {
    if(!fid)return true; // Group chats keep their existing explicit sharing rules.
    fid=String(fid);
    const creator=typeof memory?.createdBy==='string'?memory.createdBy:'';
    const own=creator===fid;
    const explicit=String(memory?.visibility||'').toLowerCase()==='only'
      &&Array.isArray(memory.visibleTo)&&memory.visibleTo.includes(fid);
    const scope=nativeScopes.get(fid);
    if(!scope?.verified)return own||explicit;
    const source=scope.bindings.get(creator);
    if(scope.principal&&scope.principal!=='changchuan')
      return own||source===scope.principal||explicit;
    // Legacy/unbound chats must also reject memories from another registered library.
    if(source&&source!==(scope.principal||'changchuan'))return explicit;
    return true;
  }
  function nativeMemoryScope(fid) {
    const scope=nativeScopes.get(String(fid));
    return {principal:scope?.principal||null,verified:!!scope?.verified,
      mode:scope?.verified?(scope.principal&&scope.principal!=='changchuan'?'library':'legacy'):'own_until_verified',
      signature:scope?.verified?JSON.stringify([scope.principal,[...scope.bindings.entries()].sort((a,b)=>a[0].localeCompare(b[0]))]):null};
  }
  const scope = (cfg, thread) => Object.freeze({friend_id: String(cfg.id), thread_id: thread ? String(thread.id) : ''});
  const message = m => ({id:String(m.id), role:m.role, content:String(m.content || ''), timestamp:m.timestamp});
  const changed = () => {const e=Error('聊天记录或附件在准备期间已变化，请重新发送');e.name='DwellContextChanged';throw e;};
  const canonical = value => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.keys(value).sort().map(k=>[k,canonical(value[k])]):value;
  const inputStamp = m => JSON.stringify([String(m.id),m.role,String(m.content||''),m.timestamp,
    ...['images','files','voice','audio','sticker','quote','callFold','mark','generation_error','link','mapRun','topicBack','history_parent'].map(k=>canonical(m[k]??null))]);
  async function verifyInput(proof,signal) {
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    const identity=proof.identity;
    if(typeof dbGet==='function'){
      const current=await dbGet(identity.thread_id?'chatThreads':'apiConfigs',identity.thread_id||identity.friend_id);
      if(current&&Number(current.sealTimestamp||0)!==proof.seal)changed();
    }
    let all=(await dbGetAll('chatMessages')).filter(m=>!m.generation_error&&String(m.friendId)===identity.friend_id
      &&String(m.threadId||'')===identity.thread_id&&['user','assistant'].includes(m.role));
    if(window.IBGraph){all=await IBGraph.filter(identity.friend_id,identity.thread_id,all,proof.historical?proof.anchor:null);const graph=await IBGraph.state(identity.friend_id,identity.thread_id,proof.historical?proof.anchor:null);if(graph.enabled){if(proof.graphSignature&&proof.graphSignature!==graph.signature)changed();proof.graphSignature=graph.signature;proof.graphState=graph;}}
    if(!window.IBGraph?.active(identity.friend_id,identity.thread_id))all.sort((a,b)=>a.timestamp-b.timestamp||String(a.id).localeCompare(String(b.id)));
    const end=proof.anchor?all.findIndex(m=>String(m.id)===proof.anchor):all.length-1;
    if(proof.anchor&&end<0)changed();
    const prefix=all.slice(0,end+1).filter(m=>m.timestamp>proof.seal),byId=new Map(prefix.map(m=>[String(m.id),m]));
    for(const old of proof.frozen){const now=byId.get(old.id);if(!now||inputStamp(now)!==old.stamp)changed();}
    const bounded=prefix.slice(-500),ids=bounded.map(m=>String(m.id));
    if(proof.topology&&JSON.stringify(ids)!==JSON.stringify(proof.topology))changed();
    const prepared=bounded.map(inputStamp);
    if(proof.prepared&&JSON.stringify(prepared)!==JSON.stringify(proof.prepared))changed();
    proof.topology=ids;
    proof.prepared=prepared;
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    return bounded;
  }
  async function request(route, body, signal) {
    const ac = new AbortController();
    const cancel = () => ac.abort();
    if (signal) { if(signal.aborted)ac.abort(); else signal.addEventListener('abort',cancel,{once:true}); }
    const timer = setTimeout(cancel, 35000);
    try {
      const r = await fetch(API + route, {method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal:ac.signal, cache:'no-store'});
      const v = await r.json();
      if(!r.ok || !v.ok){
        const e=Error(v.error || '记忆连接失败');
        if(route==='prepare' && (v.error==='stale_turn' || v.error==='聊天记录已在另一端更新，请同步后再发送')){
          e.name='DwellContextChanged';e.message='聊天记录或记忆来源已更新，请同步后重新发送';
        }
        throw e;
      }
      if(route==='status'&&body?.friend_id)rememberNativeScope(body.friend_id,v);
      return v;
    } finally {clearTimeout(timer); if(signal)signal.removeEventListener('abort',cancel);}
  }
  function visible(text) {
    // Hold partial tag prefixes so technical metadata never flashes in the bubble/TTS.
    const pos = String(text).indexOf('<dwell-state');
    if(pos >= 0)return text.slice(0,pos).trimEnd();
    const tail=String(text).lastIndexOf('<');
    if(tail>=0 && '<dwell-state'.startsWith(String(text).slice(tail)))return text.slice(0,tail);
    return String(text);
  }
  function decode(text, turn) {
    const pattern = /<dwell-state nonce="([a-f0-9]{32})">([\s\S]*?)<\/dwell-state>\s*$/;
    const match = String(text).match(pattern);
    let candidate = null;
    let reason=String(text).includes('<dwell-state')?'invalid_tag_format':'omitted';
    if(match && turn){
      if(match[1]!==turn.nonce)reason='nonce_mismatch';
      else try {candidate=JSON.parse(match[2]);reason='parsed';}catch(e){reason='invalid_json';}
    }
    const clean=visible(text).trimEnd();
    return {text:turn?.core_memory?.enabled&&typeof _parseMemOps==='function'?_parseMemOps(clean).clean:clean, candidate,reason};
  }
  async function prepare(cfg, thread, frozen, signal, historical=false) {
    const identity = scope(cfg,thread);
    nativeScopes.delete(identity.friend_id);
    const seal=Number((thread?thread.sealTimestamp:cfg.sealTimestamp)||0);
    const localInput={identity,seal,historical,anchor:frozen.length?String(frozen[frozen.length-1].id):null,
      frozen:frozen.filter(m=>!m.generation_error&&['user','assistant'].includes(m.role)&&m.timestamp>seal)
        .map(m=>({id:String(m.id),stamp:inputStamp(m)})),topology:null};
    const base={...identity,created_at:Date.now(),trigger_message_id:frozen[frozen.length-1]?.id||null,historical,seal_timestamp:seal};
    try {
      const status = await request('status',identity,signal);
      if(!status.enabled){window.IBCore?.forget(identity.friend_id);return {identity,_localInput:localInput,receipt:{...base,stage:'unbound',context_included:false,memory_refs:[]}};}
      const core=window.IBCore?await IBCore.before(cfg,thread,frozen,signal,historical):null;
      await drain();
      if(signal && signal.aborted)throw new DOMException('Aborted','AbortError');
      const bounded = (await verifyInput(localInput,signal)).map(message);
      const turn = await request('prepare',{...identity,messages:bounded,historical,seal_timestamp:seal,...(core?.enabled?{memory_budget:Math.max(256,Math.min(65536,core.budget-(core.estimated_tokens||0))),raw_recall:true,suspend_memory:!!core.pending_statements}:{})},signal);
      if(turn.seal_timestamp!==undefined && Number(turn.seal_timestamp)!==seal){
        const changed=Error('封档线已在另一端更新，请同步后再发送');changed.name='DwellContextChanged';throw changed;
      }
      if(core?.enabled){
        turn.core_memory=core;
        if(core.pending_statements){turn.memory_context='';turn.reference_context='';turn.memory_refs=[];turn.reference_refs=[];turn.history_recall={context:'',refs:[],scanned:0,partial:false,omitted:0};turn.context=turn.structure_context||'';}
        turn.context=[turn.context,core.context].filter(Boolean).join('\n\n');
      }
      if(localInput.graphState?.enabled){const g=localInput.graphState;turn.graph_view={head:g.head,revision:g.revision,signature:g.signature,hidden:g.hidden,issues:g.issues,source_count:g.ids.length};if(Object.keys(g.issues||{}).length)turn.context=['【导入来源关系说明】这段记录有缺失前文或未知的父子关系；仅参考已提供片段，不补造原话、日期或分支关系。',turn.context].filter(Boolean).join('\n\n');}
      turn.identity=identity;
      turn._localInput=localInput;
      const cited=new Set((turn.input_state?.nodes||[]).flatMap(n=>n.sources||[]));
      const fullSources=new Map(bounded.map(m=>[m.id,m]));
      turn.sourceMessages=(turn.source_messages||bounded.filter(m=>cited.has(m.id)||bounded.slice(-12).includes(m))).map(m=>{const full=fullSources.get(m.id);return full&&full.role===m.role&&full.content.startsWith(m.content)?{...m,content:full.content}:m;});
      if(turn.warning)toast(turn.warning);
      if(turn.pending_sync)toast('Sup 原话还有 '+turn.pending_sync+' 条待同步，会自动重试');
      turn.receipt={...base,
        graph_view:turn.graph_view||null,history_recall:turn.history_recall||null,core_memory:turn.core_memory||null,principal:turn.principal,revision:turn.revision,memory_refs:turn.memory_refs,pending_sync:turn.pending_sync,
        seal_timestamp:turn.seal_timestamp??seal,memory_suspended:!!turn.memory_suspended,pending_source_changes:turn.pending_source_changes||0,
        context_included:!!turn.context,warning:turn.warning,stage:'prepared',
        context:turn.context||'',memory_context:turn.memory_context||'',reference_context:turn.reference_context||'',reference_refs:turn.reference_refs||[],reference_omitted:turn.reference_omitted||0,
        structure_context:turn.structure_context||'',input_state:turn.input_state||null,source_messages:turn.sourceMessages,source_messages_full:turn.sourceMessages.every(m=>fullSources.get(m.id)?.content===m.content),call_type:historical?'regenerate':'reply'};
      window.IBDwell.lastReceipt=turn.receipt;
      return turn;
    } catch(e) {
      if(e.name==='DwellContextChanged')throw e;
      if(window.IBCore?.managed(identity.friend_id)){e.name='DwellContextChanged';e.message='自动记忆暂未准备完成：'+e.message+'；本轮未发送，请重试';throw e;}
      if(signal && signal.aborted)throw e;
      toast('本轮未接上 Dwell 记忆：'+e.message+'；继续发送原始历史');
      return {identity,_localInput:localInput,receipt:{...base,stage:'unavailable',error:e.message,context_included:false,memory_refs:[]}};
    }
  }
  async function complete(turn, candidate, am, protocol) {
    if(!turn)return;
    const current=turn.receipt,regeneration=protocol?.regeneration;
    if(regeneration&&am&&window.IBCloud){
      try{await IBCloud.flushRecord('chatMessages',am,regeneration.deletedRecords||[]);if(window.IBGraph&&turn.graph_view){const g=await IBGraph.state(turn.identity.friend_id,turn.identity.thread_id);await IBGraph.api(turn.identity.friend_id,turn.identity.thread_id,'select',{head:am.id,expected_revision:g.revision});}}
      catch(e){if(current){current.stage='failed';current.error=e.message;}toast('重生成已保存在本机，同步未完成：'+e.message);await saveReceipt(am,current);return;}
    }
    if(!turn.turn_id){if(am)await saveReceipt(am,current);return;}
    if(current && current.turn_id===turn.turn_id && protocol)current.protocol={
      finish_reason:['stop','end_turn','length','max_tokens'].includes(protocol.finish_reason)?protocol.finish_reason:'other',
      truncated:!!protocol.truncated,parse_status:protocol.parse_status};
    try {
      if(am&&!regeneration&&(turn.historical||current?.call_type==='regenerate')&&window.IBCloud){
        if(typeof IBCloud.flushRecord!=='function')throw Error('同步组件已更新，请刷新 IB 页面');
        await IBCloud.flushRecord('chatMessages',am);
      }
      const removed=(regeneration?.removed||[]).filter(m=>['user','assistant'].includes(m.role)).map(m=>({...message(m),content:''}));
      for(let i=0;i<removed.length;i+=500)await request('mutate',{...turn.identity,messages:removed.slice(i,i+500),delete:true});
      const effectiveCandidate=turn.core_memory?.enabled&&candidate?.state?{...candidate,memory:null}:candidate;
      const result=await request('complete',{...turn.identity,turn_id:turn.turn_id,candidate:effectiveCandidate,
      messages:am?[message(am)]:[]});
      const receipt=turn.receipt;
      if(receipt && receipt.turn_id===turn.turn_id){receipt.stage='completed';receipt.state_applied=result.applied===true;receipt.intent_guard=result.intent_guard;receipt.candidate_rejection=result.candidate_rejection;receipt.output_state=result.state||null;receipt.applied_revision=result.revision;}}
    catch(e) {
      const receipt=turn.receipt;
      if(receipt && receipt.turn_id===turn.turn_id){receipt.stage='failed';receipt.error=e.message;}
      console.info('[IB Dwell] projection update deferred; details saved with reply');
    }
    if(am)await saveReceipt(am,current);
    window.IBCore?.finish(turn);
  }
  async function saveReceipt(am,receipt) {
    if(!receipt)return;
    const stored=await dbGet('chatMessages',am.id);
    if(!stored||stored.content!==am.content||stored.friendId!==am.friendId||String(stored.threadId||'')!==String(am.threadId||''))return;
    stored.dwell=JSON.parse(JSON.stringify(receipt));am.dwell=stored.dwell;
    await dbPut('chatMessages',stored);
    if(typeof _msgs!=='undefined'){const live=_msgs.find(x=>x.id===am.id);if(live)live.dwell=stored.dwell;}
    window.IBDwell?.refreshStateCard?.(stored);
  }
  async function dispatched(turn,signal) {
    if(turn?._localInput)await verifyInput(turn._localInput,signal);
    const receipt=turn&&turn.receipt;
    if(turn?.core_memory?.enabled){
      const latest=await IBCore.request(turn.identity.friend_id,'context',{query:turn.core_memory.query||'',budget:Math.max(256,Math.floor(turn.core_memory.budget/2))},signal);
      if(latest.signature!==turn.core_memory.signature){const e=Error('记忆已在另一频道更新，请重新发送');e.name='DwellContextChanged';throw e;}
    }
    if(turn?.history_recall?.refs?.length){try{await window.IBGraph.api(turn.identity.friend_id,turn.identity.thread_id,'validate',{refs:turn.history_recall.refs.map(({id,source_hash})=>({id,source_hash}))},signal);}catch(e){e.name='DwellContextChanged';throw e;}}
    if(receipt?.native_memory_scope?.verified){
      await request('status',turn.identity,signal);
      if(receipt.native_memory_scope.signature!==nativeMemoryScope(turn.identity.friend_id).signature){
        const error=Error('记忆库绑定在准备期间已变化，请重新发送');error.name='DwellContextChanged';throw error;
      }
    }
    if(turn && receipt && JSON.stringify(turn.identity)===JSON.stringify({friend_id:receipt.friend_id,thread_id:receipt.thread_id})){
      if(turn.turn_id){receipt.turn_id=turn.turn_id;receipt.stage='dispatched';}
    }
  }
  function followup(base,type,included=true){return {...JSON.parse(JSON.stringify(base||{})),context_plan:undefined,graph_view:included?(base?.graph_view||null):null,history_recall:included?(base?.history_recall||null):null,call_id:crypto.randomUUID(),created_at:Date.now(),call_type:type,stage:'dispatched',context_included:included&&!!base?.context_included,core_memory:included?(base?.core_memory||null):null,context:included?(base?.context||''):'',memory_refs:included?(base?.memory_refs||[]):[],reference_refs:included?(base?.reference_refs||[]):[],reference_context:included?(base?.reference_context||''):'',native_memory_refs:included?(base?.native_memory_refs||[]):[],native_memory_context:included?(base?.native_memory_context||''):'',input_state:included?(base?.input_state||null):null,output_state:null,state_applied:false,turn_id:null,warning:undefined,error:undefined,protocol:undefined,intent_guard:undefined,candidate_rejection:undefined};}
  async function recordCall(am,r){const stored=await dbGet('chatMessages',am.id);if(!stored||stored.content!==am.content||stored.friendId!==am.friendId||String(stored.threadId||'')!==String(am.threadId||''))return;r.stage=r.stage==='stopped'?'stopped':'completed';stored.dwell_calls=[...(stored.dwell_calls||[]),JSON.parse(JSON.stringify(r))];am.dwell_calls=stored.dwell_calls;await dbPut('chatMessages',stored);}
  function enqueue(m, deleted) {
    if(!m || m.branch_copy || m.generation_error || !m.friendId || !['user','assistant'].includes(m.role))return;
    try {
      const q=JSON.parse(localStorage.getItem(outboxKey)||'[]');
      const identity={friend_id:String(m.friendId),thread_id:String(m.threadId||'')};
      const key=JSON.stringify([identity,m.id]);
      const i=q.findIndex(x=>x.key===key);
      const item={key,body:{...identity,messages:[message(m)],delete:!!deleted}};
      if(i>=0)q[i]=item;else q.push(item);
      localStorage.setItem(outboxKey,JSON.stringify(q));
      setTimeout(drain,500);
    }catch(e){toast('记忆同步队列保存失败，请保留本页数据');}
  }
  async function drain() {
    if(draining)return;draining=true;
    try {
      for(let n=0;n<20;n++) {
        const q=JSON.parse(localStorage.getItem(outboxKey)||'[]');if(!q.length)break;
        const item=q[0];
        const st=await request('status',item.body);
        // Unbound messages are never copied to Sup or assigned a resident.
        if(st.enabled)await request('mutate',item.body);
        const latest=JSON.parse(localStorage.getItem(outboxKey)||'[]');
        const i=latest.findIndex(x=>x.key===item.key && JSON.stringify(x)===JSON.stringify(item));
        if(i>=0)latest.splice(i,1);
        localStorage.setItem(outboxKey,JSON.stringify(latest));
      }
    }catch(e){}finally{draining=false;}
  }
  function regenerationCommitted(reply,removed) {
    enqueue(reply,false);
    for(const m of removed)enqueue(m,true);
  }
  function hooks() {
    const put=dbPut, putAll=dbPutAll, del=dbDelete, delMany=dbDeleteMany;
    dbPut=async function(s,v){const old=s==='chatMessages'?await dbGet(s,v.id):null;
      const r=await put(s,v);if(old && JSON.stringify(message(old))!==JSON.stringify(message(v)))enqueue(v,false);return r;};
    dbPutAll=async function(s,arr){const old=s==='chatMessages'?await dbGetAll(s):[];
      const r=await putAll(s,arr);if(s==='chatMessages'){const map=new Map(old.map(x=>[x.id,x]));
        arr.forEach(v=>{if(map.has(v.id)&&JSON.stringify(message(map.get(v.id)))!==JSON.stringify(message(v)))enqueue(v,false);});}return r;};
    dbDelete=async function(s,id){const old=s==='chatMessages'?await dbGet(s,id):null;const r=await del(s,id);if(old)enqueue(old,true);return r;};
    dbDeleteMany=async function(s,ids){const old=s==='chatMessages'?await dbGetAll(s):[];const r=await delMany(s,ids);
      if(s==='chatMessages'){const set=new Set(ids);old.filter(m=>set.has(m.id)).forEach(m=>enqueue(m,true));}return r;};
  }
  function boot() {
    hooks();window.addEventListener('online',drain);
  }
  window.IBDwell={prepare,complete,regenerationCommitted,dispatched,visible,decode,followup,recordCall,nativeMemoryVisible,nativeMemoryScope,lastReceipt:null};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
