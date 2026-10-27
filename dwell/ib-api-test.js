/* Connection diagnostics: explicit user action, no chat or memory writes. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let active = null, generation = 0;
  function scrub(value, cfg = {}) {
    let s = String(value || '');
    const key = String(cfg.apiKey || '');
    if (key) for (const secret of [key, encodeURIComponent(key)]) {
      s = s.split(secret).join('[密钥已隐藏]');
      if (secret.length >= 8) s = s.replace(new RegExp(secret.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\s"\'<>]*', 'g'), '[密钥已隐藏]');
    }
    return s.replace(/https?:\/\/[^\s"<>]+/gi, raw => {
      try { const u = new URL(raw); return u.origin + u.pathname; } catch { return '[地址已隐藏]'; }
    }).replace(/(Bearer\s+)[^\s"',}]+/gi, '$1[已隐藏]')
      .replace(/((?:api[_-]?key|token|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, '$1[已隐藏]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '[密钥已隐藏]').slice(0, 900);
  }
  function endpoint(cfg) {
    try { const u = new URL(cfg.endpoint); return scrub(u.origin + u.pathname, cfg); }
    catch { return '未填写或地址无效'; }
  }
  function diagnose(err, cfg, cancelled = false, timedOut = false) {
    const source = err?.cause || err;
    let detail = scrub(source?.message || source, cfg);
    let code = 'request', title = '请求失败', hint = '请核对接口地址、模型名和服务商返回的说明。';
    const status = Number(detail.match(/\bHTTP\s+(\d{3})\b/i)?.[1] || 0);
    if (cancelled) { code = 'cancelled'; title = '已停止测试'; hint = '没有更改配置或聊天记录。'; }
    else if (timedOut || err?.name === 'AbortError') { code = 'timeout'; title = '等待超过 45 秒，已停止'; hint = '接口可能较慢或暂时无响应；不能仅凭超时判断配置错误。'; }
    else if (status === 401) { code = 'auth'; title = 'HTTP 401 · 身份验证失败'; hint = '检查密钥是否有效、是否属于这个服务商，以及是否有多余字符。'; }
    else if (status === 403) { code = 'permission'; title = 'HTTP 403 · 服务商拒绝访问'; hint = '可能是模型权限、账户额度或访问限制；以服务商说明为准。'; }
    else if (status === 404) { code = 'not_found'; title = 'HTTP 404 · 地址或模型不存在'; hint = '核对完整接口路径和模型 ID；网页首页地址不一定是 API 地址。'; }
    else if (status === 429) { code = 'quota'; title = 'HTTP 429 · 额度或频率受限'; hint = '检查余额、配额或请求频率；这个状态不等于密钥填错。'; }
    else if (status >= 500) { code = 'upstream'; title = 'HTTP ' + status + ' · 服务商或中转异常'; hint = '稍后重试，并查看服务商的运行状态。'; }
    else if (/Failed to fetch|Load failed|NetworkError|网络连接失败|跨域|没连上/i.test(detail)) {
      code = 'network'; title = '网络请求失败 · 无法读取接口响应';
      detail = '原始异常：' + scrub(source?.name || 'Error', cfg) + ': ' + detail + '\nHTTP 状态码：浏览器未提供（不代表服务器没有返回）';
      hint = '具体原因尚未确定：网页脚本拿不到网络层或被跨域拦截的响应详情。需要检查浏览器网络记录中的失败请求（含 OPTIONS 预检），或单独检查接口连通性与跨域响应；不能据此判断密钥错误。';
    } else if (/JSON|Unexpected token|Unexpected end/i.test(detail)) {
      code = 'format'; title = '响应格式不符合预期'; hint = '接口可能返回了网页、错误页或另一种 API 格式，请核对地址与服务商类型。';
    }
    return {ok:false, code, status, title, hint, detail, err:title + '。' + hint + (detail ? '\n服务商 / 浏览器信息：' + detail : '')};
  }
  function validate(cfg) {
    if (!cfg.apiKey?.trim()) return '请先填写 API Key。';
    if (!cfg.model?.trim()) return '请先填写模型名。';
    let u; try { u = new URL(cfg.endpoint); } catch { return '接口地址无效，请填写完整的 https:// 地址。'; }
    if (!['http:', 'https:'].includes(u.protocol)) return '接口地址必须使用 HTTP 或 HTTPS。';
    if (u.username || u.password) return '请移除地址里的用户名或密码，把 API Key 填到密钥栏。';
    if (location.protocol === 'https:' && u.protocol === 'http:') return '当前 IB 使用 HTTPS，浏览器会限制 HTTP 接口。请使用服务商提供的 HTTPS 地址。';
    return '';
  }
  async function run(input, options = {}) {
    const cfg = {...input};
    const prov = PROVIDERS[cfg.provider] || PROVIDERS.custom;
    cfg.endpoint = String(cfg.endpoint || prov.endpoint || '').trim();
    cfg.model = String(cfg.model || prov.model || '').trim();
    const invalid = validate(cfg);
    if (invalid) return {ok:false,code:'validation',title:'尚未发送测试',hint:invalid,detail:'',err:invalid};
    const ac = new AbortController(), started = Date.now(); let timedOut = false;
    const cancel = () => ac.abort();
    if (options.signal?.aborted) ac.abort();
    options.signal?.addEventListener('abort', cancel, {once:true});
    const timer = setTimeout(() => {timedOut = true; ac.abort();}, 45000);
    try {
      if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await callAI({...cfg, thinkingEnabled:false, promptCache:false, webSearch:false, fallbackMode:'off'},
        [{role:'user',content:'连接测试，请只回复 OK。'}], '', () => {}, ac.signal,
        {maxTokens:256,_noThink:true,_effOff:true,_noWS:true,_noFb:true});
      if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const text = String(result?.t || '').trim();
      if (!text) return {ok:false,code:'empty',title:'请求已返回，但没有收到回复正文',hint:'可能是模型只返回了思考、输出额度不足或响应格式不兼容；暂不能算回复测试成功。',detail:'',err:'请求已返回，但没有收到回复正文',ms:Date.now()-started};
      return {ok:true,code:'ok',title:'连接成功，已收到回复',hint:'基础对话测试通过；完整聊天的历史、记忆、图片和工具未包含在这次测试中。',detail:'回复：' + scrub(text,cfg).slice(0,240),ms:Date.now()-started};
    } catch (err) { return {...diagnose(err,cfg,!!options.signal?.aborted,timedOut),ms:Date.now()-started}; }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort',cancel); }
  }
  function current() {
    const provider = $('aset-provider').value;
    return {provider, nickname:$('aset-nick').value.trim(),
      endpoint:provider === 'custom' ? _epTidyM($('aset-endpoint').value) : $('aset-endpoint').value.trim(),
      model:$('aset-model').value.trim(),apiKey:$('aset-key').value.trim(),streaming:$('aset-stream').classList.contains('on'),apiRoute:$('aset-route').value};
  }
  function reset() {
    generation++; active?.abort(); active = null;
    $('aset-test').disabled = false; $('aset-test-stop').hidden = true;
    $('aset-test-result').hidden = true; $('aset-test-result').textContent = '';
  }
  async function start() {
    if (active) return;
    const cfg = current(), ac = new AbortController(), mine = ++generation;
    active = ac; $('aset-test').disabled = true; $('aset-test-stop').hidden = false;
    const box = $('aset-test-result'); box.hidden = false;
    box.textContent = '正在测试当前填写的配置（无需先保存）…\n' + endpoint(cfg) + '\n' + scrub(cfg.model,cfg) + ' · ' + (cfg.streaming?'流式':'非流式');
    try {
      const r = await run(cfg,{signal:ac.signal});
      if (mine !== generation) return;
      box.dataset.state = r.ok ? 'ok' : 'bad';
      box.textContent = r.title + (r.ms != null ? '（' + (r.ms/1000).toFixed(1) + ' 秒）' : '') + '\n' + r.hint +
        '\n\n本次接口：' + endpoint(cfg) + '\n模型：' + scrub(cfg.model,cfg) + ' · ' + (cfg.streaming?'流式':'非流式') +
        (r.detail ? '\n\n' + r.detail : '');
    } finally { if (mine === generation) {active = null;$('aset-test').disabled = false;$('aset-test-stop').hidden = true;} }
  }
  $('aset-test').addEventListener('click', start);
  $('aset-test-stop').addEventListener('click', () => active?.abort());
  for (const id of ['aset-provider','aset-endpoint','aset-model','aset-key']) $(id).addEventListener('input', reset);
  $('aset-stream').addEventListener('click', reset);
  $('aset-route').addEventListener('change', reset);
  window.IBApiTest = {run,diagnose,scrub,reset,start};
})();
