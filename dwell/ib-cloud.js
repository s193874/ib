/* Authenticated cloud history; IndexedDB remains the durable offline cache. */
(function () {
  'use strict';
  const STORES=['posts','categories','about','music','apiSettings','chatMessages','letters','apiConfigs','groups','blogComments','memories','chatThreads','chatSummaries','uploadedFiles','blogAnnotations','projects','projectFiles','autoMemory','calEvents','calNotes','calLedger','feed','ibPreferences','ibMedia','ibMediaJobs'];
  const META='ibCloudMeta', QUEUE='ibCloudOutbox', CONFLICTS='ibCloudConflicts';
  const ROLE=new Set(('id nickname relationship provider endpoint model systemPrompt temperature autoMem autoMemMode autoMemBudget amRecordOnly streaming thinkingEnabled vision webSearch promptCache cacheTtl1h fallbackMode fallbackModels memWrite beyond avatar created archived sortOrder sealTimestamp').split(' '));
  const SECRET=/(?:^(?:key|authorization|cookie|headers|password|secret|token)$|api.?key|access.?token|refresh.?token|imageGenKey|sttKey|igKey)/i;
  const API=new URL('dwell-api/',location.href).pathname;
  const originals={put:dbPut,putAll:dbPutAll,del:dbDelete,delMany:dbDeleteMany};
  const reads={get:dbGet,all:dbGetAll}, snapshots=new WeakMap();
  const setting=s=>['apiSettings','apiConfigs'].includes(s);
  function track(s,v){if(setting(s)&&v&&typeof v==='object'){snapshots.set(v,structuredClone(v));for(const x of Object.values(v))if(x&&typeof x==='object')snapshots.set(x,structuredClone(x));}return v;}
  dbGet=async(s,id)=>track(s,await reads.get(s,id));
  dbGetAll=async s=>(await reads.all(s)).map(v=>track(s,v));
  function editRecord(s,base,patch){const value=Object.assign(structuredClone(base||{}),patch);if(setting(s))snapshots.set(value,structuredClone(base||{}));return value;}
  function editBase(v){if(snapshots.has(v))return snapshots.get(v);const out={...v};let found=false;for(const [k,x] of Object.entries(v))if(x&&typeof x==='object'&&snapshots.has(x)){out[k]=snapshots.get(x);found=true;}return found?out:null;}
  function rebase(v,next){if(!v||typeof v!=='object'||!Object.isExtensible(v))return;for(const k of Object.keys(v))if(!Object.hasOwn(next,k))delete v[k];for(const [k,x] of Object.entries(next)){if(x&&typeof x==='object'&&!Array.isArray(x)&&v[k]&&typeof v[k]==='object'&&!Array.isArray(v[k]))rebase(v[k],x);else v[k]=x;}}
  const clear=dbClear;
  let running=null, timer, button, overlay, status='正在连接', owner=null, changed=false, refreshPending=false;
  let mediaRunning=null;
  const key=(s,id)=>JSON.stringify([s,id]);
  const uuid=()=>crypto.randomUUID();
  function clean(v) {
    if(Array.isArray(v))return v.map(clean);
    if(v && typeof v==='object')return Object.fromEntries(Object.keys(v).sort().filter(k=>!['__proto__','constructor','prototype'].includes(k)).map(k=>[k,clean(v[k])]));
    return v;
  }
  function sanitize(s,v) {
    let out=clean(v);
    return out;
  }
  const recordId=(s,v)=>s==='categories'?v.name:v.id;
  const serialize=(s,v)=>JSON.stringify(sanitize(s,v));
  function transaction(stores,fn) {
    return new Promise((resolve,reject)=>{
      const tx=db.transaction([...new Set(stores)],'readwrite');let result;
      tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(tx.error||Error('本地同步队列保存失败'));
      try{fn(tx,x=>{result=x;});}catch(e){tx.abort();reject(e);}
    });
  }
  function schedule(ms=500){clearTimeout(timer);timer=setTimeout(()=>run(),ms);}
  async function write(s,values,deleted) {
    if(s==='chatMessages'&&!deleted&&window.IBGraph){const parents=new Map();for(const item of values){if(item?.role!=='user'||item.imp||item.branch_copy||item.history_parent||await reads.get(s,item.id))continue;const scope=JSON.stringify([item.friendId,String(item.threadId||'')]);await IBGraph.attach(item,parents.get(scope));if(item.history_parent)parents.set(scope,item);}}
    const saved=[];
    await transaction([s,META,QUEUE,CONFLICTS],tx=>{
      const target=tx.objectStore(s), meta=tx.objectStore(META), q=tx.objectStore(QUEUE);
      for(const item of values) {
        const id=deleted?item:recordId(s,item), k=key(s,id);
        if(typeof id!=='string'||!id)throw Error('同步记录缺少 ID');
        const req=meta.get(k);
        req.onsuccess=()=>{
          const m=req.result, base=!deleted&&setting(s)?editBase(item):null;
          const rr=target.get(id);rr.onsuccess=()=>{
          let value=item;
          if(base&&rr.result){const merged=mergeSettings(base,item,rr.result);
            if(!merged.ok){const op=uuid();tx.objectStore(CONFLICTS).put({id:op,op,store:s,recordId:id,text:serialize(s,item),deleted:false,time:Date.now(),remoteVersion:m?.version||0});saved.push([item,rr.result]);changed=true;return;}
            value=merged.value;}
          if(deleted)target.delete(id);else{target.put(value);if(setting(s)){saved.push([item,value]);if(JSON.stringify(value)!==JSON.stringify(item))changed=true;}}
          const text=deleted?'null':serialize(s,value);
          const qr=q.get(k);qr.onsuccess=()=>{
            if(!qr.result && m && m.text===text && !!m.deleted===deleted)return;
            q.put({id:k,store:s,recordId:id,op:uuid(),base:m?m.version:0,deleted,text});
          };
          };
        };
      }
    });
    if(s==='memories'&&typeof _ibMemInvalidateM==='function')_ibMemInvalidateM();
    for(const [item,value] of saved){rebase(item,value);track(s,item);}
    schedule();
  }
  // Atomic record + outbox writes. IBDwell's outer hooks keep their original behavior.
  dbPut=(s,v)=>STORES.includes(s)?write(s,[v],false):originals.put(s,v);
  dbPutAll=(s,v)=>STORES.includes(s)?write(s,v,false):originals.putAll(s,v);
  dbDelete=(s,id)=>STORES.includes(s)?write(s,[id],true):originals.del(s,id);
  dbDeleteMany=(s,ids)=>STORES.includes(s)?write(s,ids,true):originals.delMany(s,ids);
  dbClear=async s=>STORES.includes(s)?dbDeleteMany(s,(await dbGetAll(s)).map(v=>recordId(s,v))):clear(s);
  async function request(route,body) {
    const ac=new AbortController(), timeout=setTimeout(()=>ac.abort(),20000);
    try{
      const r=await fetch(API+'sync/'+route,{method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,client_version:3}),signal:ac.signal});
      const v=await r.json();if(!r.ok||!v.ok){const e=Error(v.error||'同步暂不可用');e.status=r.status;throw e;}return v;
    }finally{clearTimeout(timeout);}
  }
  async function bootstrap() {
    // Import old local history once; missing local records never mean cloud deletion.
    for(const s of STORES) {
      const rows=await dbGetAll(s);
      for(let i=0;i<rows.length;i+=100)await transaction([s,META,QUEUE],tx=>{
        const meta=tx.objectStore(META), q=tx.objectStore(QUEUE), target=tx.objectStore(s);
        for(const record of rows.slice(i,i+100)) {
          const id=recordId(s,record), k=key(s,id), mr=meta.get(k);
          mr.onsuccess=()=>{
            const known=mr.result;
            if(known && (known.deleted || known.text===serialize(s,record)))return;
            const qr=q.get(k);qr.onsuccess=()=>{
              if(qr.result){const old=qr.result;if(!old.deleted){const rr=target.get(id);rr.onsuccess=()=>{if(rr.result&&serialize(s,rr.result)!==old.text)q.put({...old,op:uuid(),text:serialize(s,rr.result),error:undefined});};}else if(old.error&&old.error.includes('客户端'))q.put({...old,op:uuid(),error:undefined});return;}
              // Re-read in this transaction: do not upload a snapshot deleted during startup.
              const rr=target.get(id);rr.onsuccess=()=>{if(rr.result)q.put({id:k,store:s,recordId:id,
                op:uuid(),base:known?known.version:0,deleted:false,text:serialize(s,rr.result)});};
            };
          };
        }
      });
    }
  }
  async function upload(item) {
    const body={store:item.store,id:item.recordId,base:item.base,op:item.op,deleted:item.deleted};
    if(!item.deleted) {
      if(new TextEncoder().encode(item.text).length<=700000)body.value=JSON.parse(item.text);
      else {
        const pieces=[];for(let p=0;p<item.text.length;) {
          let end=Math.min(p+196608,item.text.length);
          if(end<item.text.length && /[\uD800-\uDBFF]/.test(item.text[end-1]))end--;
          pieces.push(item.text.slice(p,end));p=end;
        }
        for(let i=0;i<pieces.length;i++)await request('stage',{op:item.op,index:i,total:pieces.length,text:pieces[i]});
        body.staged=true;
      }
    }
    return request('push',body);
  }
  async function read(record) {
    if(record.deleted)return null;
    let text='',offset=0;
    for(let n=0;n<2048;n++) {
      const r=await request('read',{...record,offset});if(r.changed)return undefined;
      text+=r.text;if(r.done)return JSON.parse(text);
      if(r.next<=offset)throw Error('同步读取未完成');offset=r.next;
    }
    throw Error('同步记录过大');
  }
  function localRole(remote,old) {
    return remote;
  }
  function mergeSettings(base,local,remote,root=true) {
    if(root && base && local && remote && (Object.hasOwn(base,'provider') || base.kind==='api-endpoint-preset-v1')) {
      const fields=['provider','endpoint','model',base.kind==='api-endpoint-preset-v1'?'key':'apiKey'];
      const signature=v=>JSON.stringify(fields.map(k=>v[k]??'')), b=signature(base), l=signature(local), r=signature(remote);
      if(l!==b && r!==b && l!==r)return {ok:false};
    }
    const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    if(same(local,base))return {ok:true,value:remote};
    if(same(remote,base)||same(local,remote))return {ok:true,value:local};
    const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
    if(!object(base)||!object(local)||!object(remote))return {ok:false};
    const out={};for(const k of new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])) {
      const merged=mergeSettings(base[k],local[k],remote[k],false);if(!merged.ok)return merged;
      if(merged.value!==undefined)out[k]=merged.value;
    }
    return {ok:true,value:out};
  }
  const preferenceKey=k=>/^ib[_-]/.test(k)&&!/^ib(?:[_-](?:cloud|dwell|hb|presence|lockbusy|poll|sending|session|auth|cache|cold|win_|memback_))/.test(k);
  const storageOps=typeof Storage!=='undefined'?{set:Storage.prototype.setItem,remove:Storage.prototype.removeItem,clear:Storage.prototype.clear}:null;
  let mediaOps=null,extraFailures=[],extrasBootstrapped=false;
  async function encodeMedia(value) {
    if(typeof Blob!=='undefined'&&value instanceof Blob) {
      if(value.size>192*1024*1024)throw Error('单个媒体超过 192 MB，原文件仍保留在本机');
      const bytes=new Uint8Array(await value.arrayBuffer());let binary='';
      for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
      return {__ib_blob_v1:true,type:value.type,data:btoa(binary)};
    }
    if(Array.isArray(value))return Promise.all(value.map(encodeMedia));
    if(value&&typeof value==='object'){const out={};for(const [k,v] of Object.entries(value))out[k]=await encodeMedia(v);return out;}
    return value;
  }
  function decodeMedia(value) {
    if(value&&value.__ib_blob_v1===true&&typeof value.data==='string') {
      const binary=atob(value.data),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      return new Blob([bytes],{type:value.type||''});
    }
    if(Array.isArray(value))return value.map(decodeMedia);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,decodeMedia(v)]));
    return value;
  }
  function installExtras() {
    if(storageOps&&!installExtras.storage) {
      installExtras.storage=true;
      Storage.prototype.setItem=function(k,v){storageOps.set.call(this,k,v);if(this===localStorage&&preferenceKey(String(k))&&db)dbPut('ibPreferences',{id:String(k),value:String(v)}).catch(()=>toast('设置同步队列保存失败，设置仍在本机'));};
      Storage.prototype.removeItem=function(k){storageOps.remove.call(this,k);if(this===localStorage&&preferenceKey(String(k))&&db)dbDelete('ibPreferences',String(k)).catch(()=>toast('设置删除尚未同步'));};
      Storage.prototype.clear=function(){const keys=this===localStorage?Object.keys(this).filter(preferenceKey):[];storageOps.clear.call(this);if(db&&keys.length)dbDeleteMany('ibPreferences',keys).catch(()=>toast('设置删除尚未同步'));};
    }
    if(window._ibVid&&!mediaOps) {
      mediaOps={};
      for(const [store,obj] of [['ibMedia',window._ibVid.media],['ibMediaJobs',window._ibVid.jobs]]) {
        const original={put:obj.put.bind(obj),del:obj.del.bind(obj),all:obj.all.bind(obj)};mediaOps[store]=original;
        obj.put=async rec=>{const result=await original.put(rec);try{await registerCapture(store,rec.id);}catch(e){toast('媒体尚未同步：'+e.message+'，重新进入后会重试');}schedule(0);return result;};
        obj.del=async id=>{await deleteMedia(store,[id]);const result=await original.del(id);schedule(0);return result;};
        if(obj.clear){const clearMedia=obj.clear.bind(obj);obj.clear=async()=>{const rows=await original.all();await deleteMedia(store,rows.map(x=>x.id));await clearMedia();schedule(0);};}
      }
    }
  }
  const captureKey=(s,id)=>'media-capture:'+JSON.stringify([s,id]);
  async function deleteMedia(store,ids){await transaction([store,META,QUEUE],tx=>{const meta=tx.objectStore(META);for(const id of ids){const k=key(store,id);meta.delete(captureKey(store,id));tx.objectStore(store).delete(id);const r=meta.get(k);r.onsuccess=()=>tx.objectStore(QUEUE).put({id:k,store,recordId:id,op:uuid(),base:r.result?.version||0,deleted:true,text:'null'});}});}
  async function registerCapture(store,id){await originals.put(META,{id:captureKey(store,id),store,recordId:id,op:uuid()});}
  async function captureMedia(){
    for(const task of (await dbGetAll(META)).filter(x=>x.id.startsWith('media-capture:'))){
      try{
        const raw=(await mediaOps[task.store].all()).find(x=>x.id===task.recordId);
        const value=raw?await encodeMedia(raw):null;
        await transaction([task.store,META,QUEUE],tx=>{
          const meta=tx.objectStore(META),get=meta.get(task.id);
          get.onsuccess=()=>{if(get.result?.op!==task.op)return;
            const k=key(task.store,task.recordId),mr=meta.get(k);mr.onsuccess=()=>{
              const text=value?serialize(task.store,value):'null';
              if(value)tx.objectStore(task.store).put(value);else tx.objectStore(task.store).delete(task.recordId);
              if(!mr.result||mr.result.text!==text||!!mr.result.deleted!==!value)tx.objectStore(QUEUE).put({id:k,store:task.store,recordId:task.recordId,op:uuid(),base:mr.result?.version||0,deleted:!value,text});
              meta.delete(task.id);
            };
          };
        });
      }catch(e){await transaction([META],tx=>{const st=tx.objectStore(META),r=st.get(task.id);r.onsuccess=()=>{if(r.result?.op===task.op)st.put({...r.result,error:e.message});};});}
    }
  }
  async function bootstrapExtras() {
    installExtras();
    if(storageOps)for(const k of Object.keys(localStorage).filter(preferenceKey))if(!(await dbGet('ibPreferences',k)))await originals.put('ibPreferences',{id:k,value:localStorage.getItem(k)});
    extraFailures=[];
    if(mediaOps)for(const [store,original] of Object.entries(mediaOps))for(const value of await original.all())if(!(await dbGet(META,captureKey(store,value.id)))){const k=key(store,value.id),m=await dbGet(META,k),q=await dbGet(QUEUE,k);if(q?.deleted||m?.deleted&&!q){await original.del(value.id);continue;}await registerCapture(store,value.id);}
    await originals.put(META,{id:'extra-failures',items:extraFailures});
  }
  async function sideEffect(record) {
    if(record.store==='memories'&&typeof _ibMemInvalidateM==='function')_ibMemInvalidateM();
    if(record.store==='apiSettings'&&record.id==='mobilePrefs'&&window.IBApiPresets){await window.IBApiPresets.importLegacy();}
    if(record.store==='apiSettings'&&record.id.startsWith('ib_api_preset_v1_')&&window.IBApiPresets){await window.IBApiPresets.refresh();return;}
    if(!['ibPreferences','ibMedia','ibMediaJobs'].includes(record.store))return;
    const meta=await dbGet(META,key(record.store,record.id));if(meta?.version!==record.version||await dbGet(QUEUE,key(record.store,record.id))||await dbGet(META,captureKey(record.store,record.id)))return;
    const value=record.deleted?null:await dbGet(record.store,record.id);
    if(record.store==='ibPreferences'&&storageOps&&preferenceKey(record.id)) {
      if(record.deleted)storageOps.remove.call(localStorage,record.id);else if(value)storageOps.set.call(localStorage,record.id,value.value);
    }
    if(mediaOps?.[record.store]){const original=mediaOps[record.store];if(record.deleted)await original.del(record.id);else if(value)await original.put(decodeMedia(value));}
  }
  async function acknowledge(item,result) {
    const r=result.record, value=result.conflict?await read(r):null;
    if(result.conflict && value===undefined)return; // Retry if the winner changed while reading.
    await transaction([item.store,META,QUEUE,CONFLICTS],tx=>{
      const q=tx.objectStore(QUEUE), m=tx.objectStore(META), target=tx.objectStore(item.store);
      const qr=q.get(item.id);qr.onsuccess=()=>{
        const current=qr.result;if(!current)return;
        if(result.conflict) {
          const mr=m.get(item.id);mr.onsuccess=()=>{
            if(['apiSettings','apiConfigs'].includes(item.store)&&!current.deleted&&!r.deleted&&mr.result&&!mr.result.deleted) {
              const merged=mergeSettings(JSON.parse(mr.result.text),JSON.parse(current.text),value);
              if(merged.ok){const text=serialize(item.store,merged.value);target.put(merged.value);changed=true;
                m.put({id:item.id,version:r.version,deleted:false,text:serialize(item.store,value)});
                q.put({...current,op:uuid(),base:r.version,text});return;}
            }
            tx.objectStore(CONFLICTS).put({...current,id:current.op,time:Date.now(),remoteVersion:r.version});
            q.delete(item.id);
            if(r.deleted)target.delete(r.id);else target.put(value);
            m.put({id:item.id,version:r.version,deleted:r.deleted,text:r.deleted?'null':serialize(item.store,value)});
            changed=true;status='冲突副本已保留';
          };
        } else {
          const mr=m.get(item.id);mr.onsuccess=()=>{
            if(!mr.result||mr.result.version<=r.version)m.put({id:item.id,version:r.version,deleted:r.deleted,text:item.text});
            if(current.op===item.op)q.delete(item.id);
            else if(current.base<r.version){current.base=r.version;q.put(current);} // Edits during an in-flight upload stay queued.
          };
        }
      };
    });
    if(result.conflict)await sideEffect(r);
  }
  function importHistoryChanged(old,value) {
    const seen=new Set();
    for(const m of [old,value]){
      if(!m||m.imp?.v!==19||!m.friendId)continue;
      const suffix=m.friendId+'|'+String(m.threadId||'');if(seen.has(suffix))continue;seen.add(suffix);
      for(const k of ['ib_win_'+suffix,'ib_win_'+suffix+'#k','ib_cold_'+suffix])localStorage.removeItem(k);
    }
    if(seen.size){try{if(typeof _coldGcM==='function')_coldGcM();}catch{}}
  }
  async function apply(record,value) {
    const k=key(record.store,record.id);let applied=false,previous;
    await transaction([record.store,META,QUEUE],tx=>{
      const target=tx.objectStore(record.store), meta=tx.objectStore(META), q=tx.objectStore(QUEUE);
      const qr=q.get(k);qr.onsuccess=()=>{
        if(qr.result)return; // Pending edits must go through server CAS, never a silent overwrite.
        const capture=meta.get(captureKey(record.store,record.id));capture.onsuccess=()=>{
        if(capture.result)return;
        const mr=meta.get(k);mr.onsuccess=()=>{
          if(mr.result && mr.result.version>=record.version)return;
          const rr=target.get(record.id);rr.onsuccess=()=>{
            previous=rr.result;applied=true;
            if(record.deleted)target.delete(record.id);
            else target.put(record.store==='apiConfigs'?localRole(value,rr.result):value);
            meta.put({id:k,version:record.version,deleted:record.deleted,text:record.deleted?'null':serialize(record.store,value)});
            changed=true;
          };
        };
        };
      };
    });
    if(applied&&record.store==='chatMessages')importHistoryChanged(previous,record.deleted?null:value);
    await sideEffect(record);
  }
  async function pull() {
    let cursor=(await dbGet(META,'cursor'))?.version||0;
    for(let page=0;page<100;page++) {
      const r=await request('pull',{cursor});
      for(const record of r.records) {
        if(record.store==='ibMedia'){await originals.put(META,{id:'media-download:'+record.id,record});continue;}
        const value=await read(record);if(value!==undefined)await apply(record,value);
      }
      cursor=r.cursor;await originals.put(META,{id:'cursor',version:cursor});
      if(!r.more)return;
    }
    schedule(100);
  }
  async function refresh() {
    if(!refreshPending && !changed)return;refreshPending=true;changed=false;
    // Never reset the composer, selection, or a reply being streamed.
    if(typeof _sendKeys!=='undefined'&&_sendKeys.size)return;
    const seq=_convSeq, cfg=_activeCfg, thread=_activeThread;
    if(typeof _mpFromDb!=='undefined')_mpFromDb=false;
    if(typeof _about!=='undefined')_about=null;
    if(typeof _ms!=='undefined')_ms=null;
    if(typeof _mbgs!=='undefined'){_mbgs=null;if(window._pfBgDrop)window._pfBgDrop();}
    if(typeof _outFromDb!=='undefined')_outFromDb=false;
    if(typeof _ibtFromDb!=='undefined')_ibtFromDb=false;
    if(typeof _vtFromDb!=='undefined')_vtFromDb=false;
    if(typeof _csFromDb!=='undefined')_csFromDb=false;
    if(typeof loadMP==='function')await loadMP();
    if(window._ibPrefSyncImport)await window._ibPrefSyncImport(true);
    if(typeof loadBgs==='function'&&typeof _uiApplyBg==='function'){const b=await loadBgs();if(!b._volatile)_uiApplyBg(b);}
    if(typeof applyTheme==='function'&&typeof _mp!=='undefined'&&['internal','infernal'].includes(_mp?.themeMode))applyTheme(_mp.themeMode==='infernal');
    await loadCfgs();
    if(window.IBModels&&cfg&&!cfg._group){const latest=await dbGet('apiConfigs',cfg.id);if(latest&&_activeCfg?.id===cfg.id)IBModels.label(latest);}
    if(currentPage==='chat'&&!document.body.classList.contains('on-conv'))await renderFriends();
    if(currentPage==='api'&&typeof renderApiList==='function')await renderApiList();
    if(cfg && document.body.classList.contains('on-conv')) {
      const latest=cfg._group?await dbGet('groups',cfg.id):await dbGet('apiConfigs',cfg.id);
      const latestThread=thread?await dbGet('chatThreads',thread.id):null;
      if(seq!==_convSeq)return;
      if(!latest || (thread&&!latestThread)) {
        convEl('conv').classList.remove('open');document.body.classList.remove('on-conv');_activeCfg=null;
        await renderFriends();toast('此角色或频道已在另一端删除');
      } else {
        const box=convEl('cv-msgs'), near=box.scrollHeight-box.scrollTop-box.clientHeight<180, top=box.scrollTop;
        if(typeof _cvHist!=='undefined'&&_cvHist){refreshPending=false;return;}
        const pg=await dbPageByFriend(cfg.id,null,Math.max(PAGE,_msgs.length),thread?thread.id:null);
        if(seq!==_convSeq)return;
        _activeCfg=cfg._group?groupAsCfg(latest):latest;_activeThread=latestThread;
        _msgs=pg.items;_before=pg.nextBefore;_more=pg.more;
        await loadThreadsBar(_activeCfg);drawConv();if(!near){pinBottom._stop=true;box.scrollTop=top;}
        convEl('cv-name').textContent=cfgName(_activeCfg)+(latestThread?' · '+latestThread.name:'');
      }
    }
    refreshPending=false;
  }
  async function cycle() {
    if(!db)return;
    try {
      installExtras();status='正在同步';paint();
      const account=await request('status',{});owner=account.owner;
      const bound=await dbGet(META,'owner');if(bound&&bound.owner!==owner)throw Error('本机缓存属于其他账户，请先导出保留');
      await originals.put(META,{id:'owner',owner});
      if(!extrasBootstrapped){await bootstrapExtras();extrasBootstrapped=true;}
      if(!(await dbGet(META,'bootstrapped-v4'))) {
        await bootstrap();await originals.put(META,{id:'bootstrapped-v4',done:true});
      }
      for(let n=0;n<1000;n++) {
        const queue=(await dbGetAll(QUEUE)).filter(x=>!x.error&&x.store!=='ibMedia');if(!queue.length)break;
        const item=queue[0];
        try{await acknowledge(item,await upload(item));}
        catch(e){
          if(!(e.status>=400&&e.status<500&&![401,403].includes(e.status)))throw e;
          await transaction([QUEUE],tx=>{const q=tx.objectStore(QUEUE), r=q.get(item.id);r.onsuccess=()=>{if(r.result?.op===item.op)q.put({...r.result,error:e.message});};});
        }
      }
      await pull();await refresh();
      startMedia();
      const tasks=(await dbGetAll(META)).filter(x=>/^media-(download|capture):/.test(x.id));
      const pending=await dbCount(QUEUE)+tasks.length, conflicts=await dbCount(CONFLICTS);
      const blocked=(await dbGetAll(QUEUE)).filter(x=>x.error).length+tasks.filter(x=>x.error).length;
      const extra=(await dbGet(META,'extra-failures'))?.items?.length||0;
      status=(blocked+extra)?(blocked+extra)+' 条同步失败，原记录仍在本机':pending?pending+' 条待同步':conflicts?'已同步 · '+conflicts+' 份冲突副本':'已同步';
    }catch(e){status=e.name==='AbortError'?'网络较慢，稍后重试':String(e.message||'同步暂不可用');}
    paint();
  }
  function run() {
    if(running)return running;
    running=cycle().finally(()=>{running=null;});return running;
  }
  const regenerationStamp=m=>JSON.stringify(clean(Object.fromEntries(
    ['id','friendId','threadId','role','timestamp','content','thinking','images','files','voice','audio','sticker','quote','callTone','callFold','mark','gift','callEnd','senderId','generation_error','link','mapRun','topicBack','history_parent'].map(k=>[k,m?.[k]??null]))));
  async function commitRegeneration(reply,plan,signal) {
    const cancelled=()=>new DOMException('已停止生成','AbortError');
    if(signal?.aborted)throw cancelled();
    // Pull other devices before the atomic local edit, then compare the entire chosen suffix.
    await run();
    if(signal?.aborted)throw cancelled();
    if(plan.graph_ids&&window.IBGraph){const graph=await IBGraph.state(reply.friendId,reply.threadId||'');if(graph.signature!==plan.graph_signature)throw Error('分支在生成期间已变化，新结果未覆盖');}
    let failure=null,result,stopTransaction;
    try{
      result=await transaction(['chatMessages','chatSummaries',META,QUEUE],(tx,done)=>{
        // An abort before commit must roll back both the replacement and every tombstone.
        stopTransaction=()=>{failure=cancelled();try{tx.abort();}catch{}};
        signal?.addEventListener('abort',stopTransaction,{once:true});
        if(signal?.aborted){stopTransaction();return;}
        const messages=tx.objectStore('chatMessages'),summaries=tx.objectStore('chatSummaries'),meta=tx.objectStore(META),queue=tx.objectStore(QUEUE);
        const enqueueRecord=(store,id,value,deleted)=>{
          const k=key(store,id),mr=meta.get(k);
          mr.onsuccess=()=>queue.put({id:k,store,recordId:id,op:uuid(),base:mr.result?.version||0,deleted,text:deleted?'null':serialize(store,value)});
        };
        const abort=error=>{failure=error;tx.abort();};
        const request=messages.index('byFriend').getAll(reply.friendId);
        request.onsuccess=()=>{try{
          let all=request.result.filter(m=>String(m.threadId||'')===String(reply.threadId||'')).sort((a,b)=>a.timestamp-b.timestamp||String(a.id).localeCompare(String(b.id)));
          if(plan.graph_ids){const map=new Map(all.map(m=>[String(m.id),m]));all=plan.graph_ids.map(id=>map.get(id)).filter(Boolean);}
          const start=all.findIndex(m=>m.id===plan.anchorId);
          const current=start<0?[]:all.slice(start);
          if(start<0||JSON.stringify(current.map(regenerationStamp))!==JSON.stringify(plan.boundary.map(regenerationStamp)))throw Error('选中位置或后续消息已变化，新结果未覆盖、未删除');
          if(reply.role!=='assistant'||plan.boundary[0].friendId!==reply.friendId||String(plan.boundary[0].threadId||'')!==String(reply.threadId||''))throw Error('重生成范围不属于这个频道');
          if(plan.insert&&all.some(m=>m.id===reply.id))throw Error('回复已在另一端保存，新结果未覆盖');
          const removed=all.slice(start+1).filter(m=>m.id!==reply.id);
          const changedIds=new Set([reply.id,...removed.map(m=>m.id)]),deletedRecords=removed.map(m=>({store:'chatMessages',id:m.id}));
          messages.put(reply);enqueueRecord('chatMessages',reply.id,reply,false);
          for(const m of removed){messages.delete(m.id);enqueueRecord('chatMessages',m.id,null,true);}
          const sr=summaries.getAll();sr.onsuccess=()=>{try{
            const cutoff=Math.min(reply.timestamp,...removed.map(m=>m.timestamp));
            for(const summary of sr.result){
              const legacy=summary.id==='sum_'+(reply.threadId||reply.friendId)&&Number(summary.coveredUpTo||0)>=cutoff;
              const rolling=summary.friendId===reply.friendId&&String(summary.threadId||'')===String(reply.threadId||'')
                &&summary.kind==='rolling-segment-v1'&&(summary.source_ids||summary.sources?.map(s=>s.id)||[]).some(id=>changedIds.has(id));
              const suffix=reply.threadId||reply.friendId;
              const derived=(summary.id==='chap_'+suffix||summary.id==='sumh_'+suffix)&&(summary.items||[]).some(x=>!Number(x.to)||Number(x.to)>=cutoff);
              if(legacy||rolling||derived){summaries.delete(summary.id);enqueueRecord('chatSummaries',summary.id,null,true);deletedRecords.push({store:'chatSummaries',id:summary.id});}
            }
            done({removed,deletedRecords});
          }catch(e){abort(e);}};
        }catch(e){abort(e);}};
      });
    }catch(e){throw failure||e;}
    finally{if(stopTransaction)signal?.removeEventListener('abort',stopTransaction);}
    schedule();
    try{const suffix=reply.friendId+'|'+String(reply.threadId||'');for(const k of ['ib_win_'+suffix,'ib_win_'+suffix+'#k','ib_cold_'+suffix]){if(storageOps)storageOps.remove.call(localStorage,k);else localStorage.removeItem(k);}if(typeof _coldGcM==='function')_coldGcM();if(window._ibSentPendM)delete window._ibSentPendM[String(reply.friendId)];}catch{}
    if(window.IBDwell?.regenerationCommitted)IBDwell.regenerationCommitted(reply,result.removed);
    return result;
  }
  async function flushRecord(store,value,deletedRecords=[]) {
    const id=recordId(store,value), k=key(store,id), expected=serialize(store,value);
    // A previous cycle may already be pulling. Another cycle uploads this edit.
    // Large truncations can require more than one bounded queue batch.
    for(let attempt=0;attempt<Math.ceil(deletedRecords.length/1000)+2;attempt++){
      await run();
      const local=await dbGet(store,id), meta=await dbGet(META,k), queued=await dbGet(QUEUE,k);
      if(!local||serialize(store,local)!==expected)throw Error('回复已在另一端更新，请查看云同步中的冲突副本');
      if(queued?.error)throw Error('回复同步失败：'+queued.error);
      const deletions=await Promise.all(deletedRecords.map(async r=>{
        const dk=key(r.store,r.id),[record,dm,dq]=await Promise.all([dbGet(r.store,r.id),dbGet(META,dk),dbGet(QUEUE,dk)]);
        if(record)throw Error('后续消息在同步期间发生冲突，请查看云同步面板');
        if(dq?.error)throw Error('后续消息删除同步失败：'+dq.error);
        return !!dm?.deleted&&!dq;
      }));
      if(meta&&!meta.deleted&&meta.text===expected&&!queued&&deletions.every(Boolean))return {version:meta.version};
    }
    throw Error('回复或后续消息删除尚未同步到云端，本机修改已保存');
  }
  async function mediaCycle() {
    try{
      if(mediaOps)await captureMedia();
      for(let n=0;n<1000;n++) {
        const item=(await dbGetAll(QUEUE)).find(x=>!x.error&&x.store==='ibMedia');if(!item)break;
        try{await acknowledge(item,await upload(item));}
        catch(e){if(!(e.status>=400&&e.status<500&&![401,403].includes(e.status)))throw e;
          await transaction([QUEUE],tx=>{const q=tx.objectStore(QUEUE),r=q.get(item.id);r.onsuccess=()=>{if(r.result?.op===item.op)q.put({...r.result,error:e.message});};});}
      }
      for(const pending of (await dbGetAll(META)).filter(x=>x.id.startsWith('media-download:'))) {
        const r=pending.record,value=await read(r);if(value===undefined)continue;await apply(r,value);
        await transaction([META],tx=>{const st=tx.objectStore(META),get=st.get(pending.id);get.onsuccess=()=>{if(get.result?.record?.version===r.version)st.delete(pending.id);};});
      }
      await refresh();
      const tasks=(await dbGetAll(META)).filter(x=>/^media-(download|capture):/.test(x.id));
      const pending=await dbCount(QUEUE)+tasks.length;
      const blocked=(await dbGetAll(QUEUE)).filter(x=>x.error).length+tasks.filter(x=>x.error).length+((await dbGet(META,'extra-failures'))?.items?.length||0);
      const conflicts=await dbCount(CONFLICTS);
      status=blocked?blocked+' 条同步失败，原记录仍在本机':pending?pending+' 条待同步':conflicts?'已同步 · '+conflicts+' 份冲突副本':'已同步';paint();
    }catch(e){status='媒体同步未完成：'+(e.name==='AbortError'?'网络较慢，将自动重试':e.message);paint();}
  }
  function startMedia() {
    if(!mediaRunning)mediaRunning=mediaCycle().finally(()=>{mediaRunning=null;});
    return mediaRunning;
  }
  function paint(){if(button)button.textContent=owner?'云同步':'登录 / 同步';if(overlay)overlay.querySelector('[data-status]').textContent=status;}
  async function panel() {
    if(overlay)overlay.remove();overlay=document.createElement('div');overlay.className='sheet';overlay.id='sheet-ib-cloud';
    overlay.setAttribute('role','dialog');overlay.setAttribute('aria-label','多端记录同步');
    overlay.innerHTML='<h3>多端记录同步</h3>'+
      '<p data-status role="status"></p><p>手机和电脑登录同一个原 Dwell 账户，聊天、角色、频道、附件和 IB 记忆会自动同步。原来的 Sup 记忆仍按角色绑定。</p>'+
      '<p class="hint">登录、打开页面和进入聊天时自动同步。IB 的全部数据区、设置、API 配置和媒体都参与同步；服务端加密保存。单个媒体上限 192 MB，超限或失败会保留本机原文件并显示原因。</p>'+
      '<button class="mi-btn" data-now>重试未完成的同步</button><details class="dw-evidence"><summary>登录原 Dwell 账户</summary><form>'+
      '<div class="f-group"><label>用户名</label><input type="text" name="username" aria-label="Dwell 用户名" autocomplete="username" required></div>'+
      '<div class="f-group"><label>密码</label><input name="password" aria-label="Dwell 密码" type="password" autocomplete="current-password" required></div>'+
      '<button class="mi-btn">登录并同步</button></form></details><div data-conflicts></div><div class="sheet-btns"><button class="btn" data-close>关闭</button></div>';
    document.body.appendChild(overlay);closeSheets();openSheet(overlay.id);paint();
    overlay.querySelector('[data-close]').onclick=()=>{closeSheets();overlay.remove();overlay=null;};
    overlay.querySelector('[data-now]').onclick=async()=>{
      for(const item of await dbGetAll(QUEUE))if(item.error){delete item.error;await originals.put(QUEUE,item);}
      await run();await drawConflicts();
    };
    overlay.querySelector('form').onsubmit=async e=>{
      e.preventDefault();const f=e.target;
      try{const r=await fetch('/api/account/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:f.username.value,password:f.password.value})});
        const v=await r.json();f.password.value='';if(!r.ok||!v.ok)throw Error(v.error||'登录失败');await run();await drawConflicts();
      }catch(err){f.password.value='';status=err.message;paint();}
    };
    await drawConflicts();
  }
  async function drawConflicts() {
    if(!overlay||!db)return;const box=overlay.querySelector('[data-conflicts]');box.replaceChildren();
    const rows=await dbGetAll(CONFLICTS);
    for(const item of (await dbGet(META,'extra-failures'))?.items||[])box.append(Object.assign(document.createElement('p'),{textContent:item.store+' · '+item.id+'：'+item.error}));
    for(const item of (await dbGetAll(QUEUE)).filter(x=>x.error)){
      const p=document.createElement('p');p.textContent=item.store+' · '+item.recordId+'：'+item.error;box.append(p);
    }
    for(const item of (await dbGetAll(META)).filter(x=>x.id.startsWith('media-capture:')&&x.error))box.append(Object.assign(document.createElement('p'),{textContent:'媒体 '+item.recordId+'：'+item.error}));
    if(rows.length){const p=document.createElement('p');p.textContent='同时修改的本机版本已保留。可先查看，再决定是否用它覆盖当前云端版本。';box.append(p);}
    for(const row of rows) {
      const details=document.createElement('details'), title=document.createElement('summary'), text=document.createElement('pre'), b=document.createElement('button');
      title.textContent=row.store+' · '+row.recordId+' · '+new Date(row.time).toLocaleString();
      const masked=v=>Array.isArray(v)?v.map(masked):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,SECRET.test(k)?'（已隐藏）':masked(x)])):v;
      const value=JSON.parse(row.text), secretPreference=row.store==='ibPreferences'&&/(tok|key|secret|password|auth)/i.test(row.recordId);
      text.textContent=row.deleted?'本机操作：删除':JSON.stringify(secretPreference?{...value,value:'（已隐藏）'}:masked(value),null,2);text.className='dw-evidence-text';
      b.textContent='采用这份本机版本';b.onclick=async()=>{
        if(!await confirmDlg('采用这份版本并同步到所有设备？','采用'))return;
        if(row.deleted)await dbDelete(row.store,row.recordId);else {
          let value=JSON.parse(row.text);if(row.store==='apiConfigs')value=localRole(value,await dbGet(row.store,row.recordId));await dbPut(row.store,value);
        }
        await run();await drawConflicts();
      };
      details.append(title,text,b);box.append(details);
    }
  }
  function boot() {
    button=document.createElement('button');button.className='btn wide';button.id='ib-cloud-open';button.onclick=panel;
    button.style.marginBottom='10px';
    const card=document.querySelector('#sec-data-io .card');if(card)card.prepend(button);
    paint();
    const ready=()=>{if(!db){setTimeout(ready,200);return;}schedule(0);};ready();
    window.addEventListener('online',()=>schedule(0));window.addEventListener('focus',()=>schedule(0));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0);});
    setInterval(()=>{if(!document.hidden)run();},5000);
  }
  window.IBCloud={run,flushRecord,commitRegeneration,panel,sanitize,editRecord,waitMedia:()=>mediaRunning||Promise.resolve(),get status(){return status;}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
