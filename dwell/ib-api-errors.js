/* Provider diagnostics: retain status and request id without credentials or prompts. */
(() => {
  'use strict';
  const key='ib_api_failures_v1';
  function scrub(value,cfg={}) {
    let s=String(value||'');
    if(cfg.apiKey)for(const secret of [String(cfg.apiKey),encodeURIComponent(cfg.apiKey)])s=s.split(secret).join('[密钥已隐藏]');
    return s.replace(/https?:\/\/[^\s"<>]+/gi,raw=>{try{const u=new URL(raw);return u.origin+u.pathname;}catch{return '[地址已隐藏]';}})
      .replace(/(Bearer\s+)[^\s"',}]+/gi,'$1[已隐藏]')
      .replace(/((?:api[_-]?key|token|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi,'$1[已隐藏]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g,'[密钥已隐藏]').slice(0,1600);
  }
  function error(res,raw,cfg={},transport='HTTP') {
    let data=raw;if(typeof data==='string')try{data=JSON.parse(data);}catch{}
    const e=data?.error||data;
    const code=scrub(typeof e==='object'?(e.type||e.code||data?.type||''):'',cfg);
    const detail=scrub(typeof e==='object'?(e.message||e.detail||'服务商未提供错误说明'):e,cfg);
    const requestId=scrub(res?.headers?.get('request-id')||res?.headers?.get('x-request-id')||data?.request_id||'',cfg);
    const status=Number(res?.status||0);
    const policy=/content_filter|content_policy|safety|refusal|moderation/i.test(code);
    let title=policy?'服务商明确返回内容限制':status>=500||/^(overloaded_error|server_error|temporarily_unavailable)$/.test(code)?'服务商或中转暂时异常':status===429?'服务商额度或频率受限':status===401?'服务商身份验证失败':status===403?'服务商拒绝访问，原因以返回说明为准':'接口请求未成功，不能仅凭提示判断内容违规';
    const info={status,transport,code,request_id:requestId,detail};
    const err=new Error(title+'（'+transport+(status?' '+status:'')+(code?' · '+code:'')+'）'+(detail?'：'+detail:'')+(requestId?'\n请求编号：'+requestId:''));
    err.apiDiagnostic=info;return err;
  }
  function record(err,cfg) {
    if(err?.name==='AbortError')return;
    try{const list=JSON.parse(localStorage.getItem(key)||'[]');list.unshift({at:Date.now(),fid:String(cfg.id||''),message:scrub(err?.message||err,cfg),...(err.apiDiagnostic||{})});localStorage.setItem(key,JSON.stringify(list.slice(0,30)));}catch{}
  }
  function show(cfg) {
    let list=[];try{list=JSON.parse(localStorage.getItem(key)||'[]').filter(x=>x.fid===String(cfg?.id||''));}catch{}
    const box=document.getElementById('aset-test-result');if(!box)return;
    box.hidden=false;box.textContent=list.length?list.map(x=>new Date(x.at).toLocaleString()+'\n'+x.message).join('\n\n'):'此设备尚未保存这项配置的失败记录。更新前的短提示无法反推出上游原因。';
  }
  const anchor=document.getElementById('aset-test');
  if(anchor){const b=document.createElement('button');b.className='mi-btn';b.type='button';b.textContent='最近的聊天失败原因';anchor.after(b);
    // openAset receives the exact configuration being edited, independent of active chat.
    const original=openAset;let selected=null;openAset=function(cfg){selected=cfg;return original.apply(this,arguments);};b.onclick=()=>show(selected);
  }
  window.IBApiErrors={error,record,scrub,show};
})();
