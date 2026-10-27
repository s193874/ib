/* Account-shared endpoint presets. Picking fills the existing form only. */
(function(){
 'use strict';
 const PREFIX='ib_api_preset_v1_',IMPORT='ib_api_preset_import_v1_',KIND='api-endpoint-preset-v1';
 let pool=[],loaded=false,busy=false,form=0,selected=null,importing=null;
 const field=id=>document.getElementById(id);
 const escape=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 const tuple=p=>[String(p.name||'').trim(),String(p.provider||'custom'),String(p.model||'').trim(),String(p.endpoint||'').trim(),String(p.key||'').trim()];
 const normalized=p=>{const [name,provider,model,endpoint,key]=tuple(p);return{name,provider,model,endpoint,key};};
 const current=()=>({provider:field('aset-provider')?.value||'custom',model:field('aset-model')?.value.trim()||'',endpoint:field('aset-endpoint')?.value.trim()||'',key:field('aset-key')?.value.trim()||''});
 const matches=(p,c)=>p.provider===c.provider&&p.model===c.model&&p.endpoint===c.endpoint&&p.key===c.key;
 const host=u=>{try{return new URL(u).host;}catch{return String(u||'').replace(/^https?:\/\//,'').split('/')[0];}};
 const providerName=p=>typeof PROVIDERS!=='undefined'&&PROVIDERS[p]?PROVIDERS[p].name:p;
 async function fingerprint(p){const bytes=new TextEncoder().encode(JSON.stringify(tuple(p)));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
 function row(){
  let r=field('aset-preset-row');if(r)return r;
  const parent=field('aset-key')?.closest('.f-group');if(!parent)return null;
  r=document.createElement('div');r.id='aset-preset-row';r.className='f-group';r.style.marginTop='12px';
  if(!field('ib-apipreset-css')){const style=document.createElement('style');style.id='ib-apipreset-css';style.textContent='#aset-preset-list .pwl-row{padding:10px 4px}#aset-preset-list .pwl-t{font-size:.86rem}#aset-preset-list .pwl-s{font-size:.72rem;color:var(--tx3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#aset-preset-list .pwl-row.on .pwl-s{color:var(--acc);opacity:.8}';document.head.appendChild(style);}
  r.innerHTML='<label>接口预设 <span class="lb-note">（所有配置共用）</span></label><div id="aset-preset-list"></div>'+
   '<div style="display:flex;gap:8px;align-items:center;margin-top:8px"><input id="aset-preset-name" maxlength="64" placeholder="给当前这套接口起个名" autocomplete="off" style="flex:1;min-width:0"><button class="btn" type="button" id="aset-preset-add" style="flex:none">存为预设</button></div>'+
   '<p class="hint" id="aset-preset-hint" style="margin:6px 0 0"></p>';
  parent.insertAdjacentElement('afterend',r);
  r.querySelector('#aset-preset-add').addEventListener('click',add);
  r.querySelector('#aset-preset-list').addEventListener('click',event=>{
   const remove=event.target.closest('[data-preset-delete]');if(remove){del(remove.dataset.presetDelete);return;}
   const item=event.target.closest('[data-preset-id]');if(item)pick(item.dataset.presetId);
  });return r;
 }
 function paint(){
  const r=row();if(!r)return;
  const c=current();r.querySelector('#aset-preset-list').innerHTML=pool.map(p=>
   '<div class="pwl-row'+(matches(p,c)?' on':'')+'" data-preset-id="'+escape(p.id)+'"><div style="flex:1;min-width:0"><div class="pwl-t">'+escape(p.name)+'</div><div class="pwl-s">'+
   escape([providerName(p.provider),p.model,host(p.endpoint)].filter(Boolean).join(' · '))+'</div></div><button class="pwl-x" type="button" title="移除共享预设" data-preset-delete="'+escape(p.id)+'"><svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button></div>').join('');
  r.querySelector('#aset-preset-add').disabled=busy||!loaded;
  r.querySelector('#aset-preset-add').textContent=selected&&field('aset-preset-name')?.value.trim()===selected.name?'更新所选预设':'另存预设';
  r.querySelector('#aset-preset-hint').textContent=!loaded?'正在读取共享预设…':
   (pool.length?'共 '+pool.length+' 套，新增配置也可直接选。':'把服务商、模型、地址和密钥填好，即可存为共享预设。')+
   '点选只填接口字段，按下方「保存」才生效；人设和聊天记录不随预设改变。';
 }
 async function refresh(){
  const records=await dbGetAll('apiSettings');pool=records.filter(p=>p.kind===KIND&&p.id.startsWith(PREFIX)).sort((a,b)=>(a.created||0)-(b.created||0)||String(a.id).localeCompare(String(b.id)));
  loaded=true;paint();
 }
 async function migrate(){
  const prefs=await dbGet('apiSettings','mobilePrefs');if(!prefs?.perAi)return;
  const seen=new Set(),batch=[];
  for(const settings of Object.values(prefs.perAi))for(const old of Array.isArray(settings?.presets)?settings.presets:[]){
   if(!old||typeof old!=='object'||!old.model)continue;
   const preset=normalized(old);if(!preset.name)preset.name=preset.model;
   const hash=await fingerprint(preset),id=PREFIX+hash,marker=IMPORT+hash;
   if(seen.has(hash)||await dbGet('apiSettings',marker))continue;seen.add(hash);
   if(!await dbGet('apiSettings',id))batch.push({id,kind:KIND,...preset,created:0,updated:0});
   batch.push({id:marker,kind:'api-preset-import-v1',preset_id:id,completed:true});
  }
  if(batch.length)await dbPutAll('apiSettings',batch);
 }
 async function opened(){
  const token=++form;selected=null;loaded=false;paint();if(field('aset-preset-name'))field('aset-preset-name').value='';
  try{await migrate();if(token!==form)return;await refresh();}
  catch{if(token===form){loaded=false;const r=row();if(r)r.querySelector('#aset-preset-hint').textContent='共享预设读取失败，请稍后重开；当前接口表单保留。';}}
 }
 function pick(id){
  const p=pool.find(p=>p.id===id);if(!p||busy||!loaded)return;
  selected=structuredClone(p);const provider=field('aset-provider');
  if(provider&&provider.value!==p.provider){provider.value=p.provider;if(typeof _lastProv!=='undefined')_lastProv=p.provider;}
  for(const [id,value] of [['aset-model',p.model],['aset-endpoint',p.endpoint],['aset-key',p.key]]){const el=field(id);if(el)el.value=value||'';}
  if(field('aset-preset-name'))field('aset-preset-name').value=p.name;
  if(typeof _modelListReset==='function')_modelListReset();if(window.IBModels)IBModels.updateAsetCapacity();paint();toast('已填入预设「'+p.name+'」，按下方保存后生效');
 }
 async function add(){
  if(busy||!loaded)return;
  const c=current(),input=field('aset-preset-name'),name=(input?.value||'').trim()||c.model.slice(0,64),token=form;
  if(!c.model){toast('模型填好再存');return;}if(c.provider==='custom'&&!c.endpoint){toast('自定义服务商要填接口地址');return;}
  if(name.length>64){toast('预设名称最多 64 字');return;}
  const sameName=pool.filter(p=>p.name===name);let base=selected?.name===name?selected:null;
  if(!base&&sameName.length){toast('有多个同名预设，先点选要更新的那套，或换个名字');return;}
  busy=true;paint();
  try{
   const existing=base?await dbGet('apiSettings',base.id):null;
   if(base&&!existing){toast('这套预设已在另一端移除，请换名另存；当前表单保留');await refresh();return;}
   const patch={name,...c};
   const value=base?_ibFormEdit('apiSettings',base,patch):{id:PREFIX+crypto.randomUUID(),kind:KIND,created:Date.now(),...patch};
   const expected=normalized(value),changed=base?Object.keys(expected).filter(key=>expected[key]!==normalized(base)[key]):Object.keys(expected);
   await dbPut('apiSettings',value);
   const saved=await dbGet('apiSettings',value.id);
   await refresh();
   if(!saved||changed.some(key=>normalized(saved)[key]!==expected[key])){toast('另一端同时修改了预设；当前表单保留，冲突版本可在同步面板查看');return;}
   // The interface form still shows its captured values. Preserve that baseline
   // so a later save cannot revert another device's independently merged field.
   if(token===form){selected={...structuredClone(saved),...expected};if(input)input.value='';}
   toast((base?'已更新共享预设「':'已存为共享预设「')+name+'」');
  }catch{toast('预设保存失败，当前表单保留');}
  finally{busy=false;paint();}
 }
 async function del(id){
  const preset=pool.find(p=>p.id===id);if(!preset||busy)return;
  let confirmed=false;try{confirmed=await confirmDlg('移除共享预设「'+preset.name+'」？已保存的 API 配置不会随它改变。','移除');}catch{return;}
  if(!confirmed)return;busy=true;paint();
  try{await dbDelete('apiSettings',id);if(selected?.id===id)selected=null;await refresh();toast('已移除共享预设');}
  catch{toast('移除失败，原预设保留');}finally{busy=false;paint();}
 }
 const original=openAset;openAset=function(){original.apply(this,arguments);return opened();};
 document.addEventListener('change',event=>{if(event.target?.id==='aset-provider')paint();});
 document.addEventListener('input',event=>{if(['aset-model','aset-endpoint','aset-key','aset-preset-name'].includes(event.target?.id))paint();});
 window.IBApiPresets={refresh};
 Object.assign(window.IBApiPresets,{
  importLegacy(){if(!importing)importing=migrate().then(refresh).finally(()=>{importing=null;});return importing;},
  async list(){await this.importLegacy();return pool.map(p=>structuredClone(p));},
  async save(connection,name,base=null){
   name=String(name||'').trim();if(!name||name.length>64||!connection.model)throw Error('请填写预设名称和模型');
   if(base&&!await dbGet('apiSettings',base.id))throw Error('所选预设已移除，请另存');
   const patch={name,...normalized({...connection,name})};
   const value=base?_ibFormEdit('apiSettings',base,patch):{id:PREFIX+crypto.randomUUID(),kind:KIND,created:Date.now(),...patch};
   const expected=normalized(value);await dbPut('apiSettings',value);const saved=await dbGet('apiSettings',value.id);await refresh();
   if(!saved||JSON.stringify(normalized(saved))!==JSON.stringify(expected))throw Error('预设存在同步冲突，当前选择保留');
   return structuredClone(saved);
  }
 });
})();
