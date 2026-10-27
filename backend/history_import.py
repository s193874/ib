"""Durable Claude-history import and bounded, user-started organization jobs."""
import datetime as dt
import hashlib
import json
import math
import re
import time
import uuid
import cloud_sync
import library_scope
import history_graph
from continuity import digest

def init(c):
    c.executescript("""
    CREATE TABLE IF NOT EXISTS hi_batches(
      id TEXT PRIMARY KEY,owner INTEGER,fid TEXT,principal TEXT,label TEXT,file_hash TEXT,
      mode TEXT,state TEXT,created REAL,manifest TEXT);
    CREATE TABLE IF NOT EXISTS hi_records(
      mid TEXT PRIMARY KEY,owner INTEGER,fid TEXT,tid TEXT,principal TEXT,source_key TEXT,
      scope TEXT,body TEXT,fingerprint TEXT,first_batch TEXT,raw_id TEXT,active INTEGER DEFAULT 1,
      UNIQUE(owner,fid,source_key));
    CREATE TABLE IF NOT EXISTS hi_items(
      batch TEXT,item_key TEXT,mid TEXT,action TEXT,error TEXT,request_hash TEXT,PRIMARY KEY(batch,item_key));
    CREATE TABLE IF NOT EXISTS hi_chunks(
      id TEXT PRIMARY KEY,batch TEXT,owner INTEGER,fid TEXT,principal TEXT,state TEXT,
      body TEXT,proof TEXT,result TEXT,lease TEXT,leased REAL,error TEXT,model TEXT);
    CREATE TABLE IF NOT EXISTS hi_candidates(
      id TEXT PRIMARY KEY,chunk TEXT,batch TEXT,owner INTEGER,fid TEXT,principal TEXT,
      state TEXT,body TEXT,proposal TEXT,receipt TEXT,error TEXT);
    CREATE TABLE IF NOT EXISTS hi_source_updates(batch TEXT,mid TEXT,state TEXT,body TEXT,PRIMARY KEY(batch,mid));
    CREATE TABLE IF NOT EXISTS hi_undo_proofs(mid TEXT PRIMARY KEY,stamp TEXT);
    CREATE INDEX IF NOT EXISTS hi_chunk_batch ON hi_chunks(batch,state);
    CREATE INDEX IF NOT EXISTS hi_candidate_batch ON hi_candidates(batch,state);
    CREATE INDEX IF NOT EXISTS hi_batch_owner ON hi_batches(owner,fid,created);
    """)
def enc(v,identity):return cloud_sync.seal(cloud_sync.packed(v),['history',*identity])
def dec(v,identity):return json.loads(cloud_sync.open_text(v,['history',*identity]))
def text(v,limit=200,empty=False):
    if not isinstance(v,str) or len(v)>limit or (not empty and not v.strip()):raise ValueError('history_invalid_text')
    return v
def ident(v):
    if not isinstance(v,str) or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,150}',v):raise ValueError('history_invalid_id')
    return v
def batch(c,owner,fid,bid):
    b=c.execute('SELECT * FROM hi_batches WHERE id=? AND owner=? AND fid=?',(bid,owner,fid)).fetchone()
    if not b:raise ValueError('history_batch_missing')
    if b['principal']!=library_scope.current():raise ValueError('memory_binding_changed')
    return b
def cloud(c,owner,store,mid):
    r=c.execute('SELECT * FROM cloud_records WHERE owner=? AND store=? AND id=?',(owner,store,mid)).fetchone()
    return (json.loads(cloud_sync.record_text(c,r,owner,store,mid)) if r and not r['deleted'] else None,r)
def push(c,owner,store,value,mid,invalidate,deleted=False):
    old,row=cloud(c,owner,store,mid)
    result=cloud_sync.handle(c,owner,'sync/push',{'client_version':3,'store':store,'id':mid,
        'base':row['version'] if row else 0,'op':str(uuid.uuid4()),'deleted':deleted,'value':value},invalidate)
    if result.get('conflict'):raise ValueError('history_cloud_conflict')
    return result
def undo_stamp(m):return digest({k:m.get(k) for k in ('id','friendId','threadId','role','timestamp','content','thinking','images','files','voice','audio','sticker','quote','link','mapRun','topicBack','imp')})
def is_import_id(mid):
    return isinstance(mid,str) and re.fullmatch(r'msg_(?:hi_|[0-9]{13,14}_hi_)[a-f0-9]{48}',mid) is not None

def invalidate_summaries(c,owner,old,new,invalidate):
    """An inserted/changed imported source invalidates later derived coverage on every device."""
    affected={}
    for m in (old,new):
        if not m or not is_import_id(m.get('id')) or not m.get('friendId'):continue
        key=(m['friendId'],str(m.get('threadId') or ''))
        stamp=m.get('timestamp')
        if type(stamp) not in (int,float):continue
        affected[key]=min(affected.get(key,stamp),stamp)
    if not affected or (old and new and undo_stamp(old)==undo_stamp(new)):return
    def number(v):
        try:
            n=float(v or 0)
            return n if math.isfinite(n) else 0
        except (TypeError,ValueError):return 0
    rows=c.execute("SELECT * FROM cloud_records WHERE owner=? AND store='chatSummaries' AND deleted=0",(owner,)).fetchall()
    for row in rows:
        summary=json.loads(cloud_sync.record_text(c,row,owner,'chatSummaries',row['id']))
        stale=False
        for (fid,tid),stamp in affected.items():
            suffix=tid or fid
            if stamp<=number(summary.get('sealTimestamp')):continue
            legacy=row['id']=='sum_'+suffix and number(summary.get('coveredUpTo'))>=stamp
            rolling=summary.get('kind')=='rolling-segment-v1' and summary.get('friendId')==fid and str(summary.get('threadId') or '')==tid and number(summary.get('to'))>=stamp
            chapters=row['id'] in ('chap_'+suffix,'sumh_'+suffix) and any(number(x.get('to'))>=stamp for x in summary.get('items',[]) if isinstance(x,dict))
            if legacy or rolling or chapters:stale=True;break
        if stale:push(c,owner,'chatSummaries',None,row['id'],invalidate,True)

def record_body(r):return dec(r['body'],['record',r['mid']])
def normalized(m,file_hash):
    if not isinstance(m,dict) or set(m)-{'conversation_id','message_id','conversation_index','message_index','parent_id','title','role','content','original_time','sort_time','thinking','attachments','unsupported','branch_known','identity_conflict'}:
        raise ValueError('history_invalid_message')
    if m.get('role') not in ('user','assistant'):raise ValueError('history_unsupported_role')
    content=text(m.get('content'),262144)
    if len(content.encode())>262144:raise ValueError('history_message_too_large')
    ci=m.get('conversation_index');mi=m.get('message_index')
    if type(ci) is not int or type(mi) is not int or min(ci,mi)<0:raise ValueError('history_invalid_order')
    cv=m.get('conversation_id');mid=m.get('message_id');parent=m.get('parent_id')
    for v in [cv,mid,parent]:
        if v is not None:text(v,200)
    original=m.get('original_time')
    if original is not None and (type(original) not in (int,float) or not math.isfinite(original) or not 0<original<32503680000000):raise ValueError('history_invalid_time')
    order=m.get('sort_time')
    if type(order) not in (int,float) or not math.isfinite(order) or not 0<order<32503680000000:raise ValueError('history_invalid_sort_time')
    attachments=m.get('attachments') or []
    if not isinstance(attachments,list) or len(cloud_sync.packed(attachments))>50000:raise ValueError('history_invalid_attachments')
    # Fallback identity is explicitly file-scoped, never presented as an original UUID.
    cvkey=['id',cv] if cv else ['file',file_hash,ci]
    msgkey=['id',mid] if mid and not m.get('identity_conflict') else ['file',file_hash,ci,mi]
    out={**m,'content':content,'original_time':original,'time_known':original is not None,'attachments':attachments,
         'title':str(m.get('title') or '导入的 Claude 对话')[:120]}
    out['source_key']=digest([cvkey,msgkey])
    out['conversation_key']=digest(cvkey)
    out['identity_kind']='original' if cv and mid and not m.get('identity_conflict') else 'file_scoped_surrogate'
    out['fingerprint']=digest([m.get('role'),content,original,parent,attachments,m.get('thinking') or ''])
    return out
def raw_operation(r,msg,mutation='update'):
    src=record_body(r);session='ibimport:'+digest([r['owner'],r['principal'],r['fid'],src['conversation_key']])
    op={'op':mutation,'external_id':session+':message:'+digest(r['source_key']),
        'session_id':session,'conversation_id':session,'source_platform':'claude','source_channel':'import'}
    if mutation!='delete':
        op.update(role=msg['role'],content=msg['content'],
          occurred_at=dt.datetime.fromtimestamp(src['original_time']/1000,dt.timezone.utc).isoformat() if src['time_known'] else None,
          metadata={'memory_principal_id':r['principal'],'ib_message_id':r['mid'],
            'original_conversation_id':src.get('conversation_id'),'original_message_id':src.get('message_id'),
            'original_parent_id':src.get('parent_id'),'time_known':src['time_known'],
            'original_created_at':src.get('original_time'),'source_order':src['message_index'],
            'identity_kind':src['identity_kind'],'attachments':src['attachments'],
            'branch_known':bool(src.get('branch_known')),'import_batch_id':r['first_batch'],
            'source_revision_batch_id':src.get('revision_batch'),'content_manually_edited':msg['content']!=src['content']})
    return op
def sync_records(c,owner,fid,b,remote,limit=25):
    entries=c.execute("""SELECT DISTINCT r.* FROM hi_records r JOIN hi_items i ON i.mid=r.mid
       WHERE i.batch=? AND r.active=1 AND r.raw_id IS NULL LIMIT ?""",(b['id'],limit)).fetchall()
    synced=0;errors=[]
    for r in entries:
        src=record_body(r);m,row=cloud(c,owner,'chatMessages',r['mid'])
        if not m:continue
        op=raw_operation(r,m)
        try:
            c.commit()
            res=remote('history-raw',{'operations':[op]})
            receipt=res.get('results',[{}])[0];rid=receipt.get('canonical_raw_message_id')
            if receipt.get('index')!=1 or not isinstance(rid,str) or not re.fullmatch('[a-f0-9-]{36}',rid):raise ValueError('history_invalid_raw_receipt')
            h=digest({k:m[k] for k in ('id','role','content','timestamp')})
            # A different request cannot slip through the friend lock; cloud hash is still checked.
            current,_=cloud(c,owner,'chatMessages',r['mid'])
            if digest({k:current[k] for k in ('id','role','content','timestamp')})!=h:raise ValueError('history_source_changed')
            c.execute('UPDATE hi_records SET raw_id=? WHERE mid=?',(rid,r['mid']))
            c.execute('UPDATE messages SET raw_id=? WHERE scope=? AND id=? AND hash=?',(rid,r['scope'],r['mid'],h))
            c.execute('DELETE FROM source_barriers WHERE scope=? AND id=? AND target_hash=?',(r['scope'],r['mid'],h))
            c.execute("UPDATE hi_items SET error=NULL WHERE mid=? AND batch=?",(r['mid'],b['id']))
            c.commit();synced+=1
        except Exception as e:
            why=str(e)[:240];errors.append({'id':r['mid'],'reason':why})
            c.execute('UPDATE hi_items SET error=? WHERE mid=? AND batch=?',(why,r['mid'],b['id']));c.commit()
    return synced,errors
def source(c,owner,fid,mid):
    r=c.execute('SELECT * FROM hi_records WHERE mid=? AND owner=? AND fid=? AND active=1',(mid,owner,fid)).fetchone()
    if not r or r['principal']!=library_scope.current() or not r['raw_id']:raise ValueError('history_source_unsynced')
    m,_=cloud(c,owner,'chatMessages',mid)
    if not m or m.get('friendId')!=fid or str(m.get('threadId') or '')!=r['tid']:raise ValueError('history_source_changed')
    cached=c.execute('SELECT * FROM messages WHERE scope=? AND id=?',(r['scope'],mid)).fetchone()
    norm={k:m[k] for k in ('id','role','content','timestamp')}
    if not cached or cached['raw_id']!=r['raw_id'] or cached['hash']!=digest(norm):raise ValueError('history_source_changed')
    return r,m,{'id':mid,'hash':digest(norm),'raw_id':r['raw_id'],'sha256':hashlib.sha256(m['content'].encode()).hexdigest(),'provenance_hash':r['fingerprint']}
def check_proof(c,owner,fid,proof):
    for old in proof:
        r,m,now=source(c,owner,fid,old['id'])
        if now!=old:raise ValueError('history_source_changed')
def status(c,b,details=True):
    counts={r['action']:r['n'] for r in c.execute('SELECT action,count(*) n FROM hi_items WHERE batch=? GROUP BY action',(b['id'],))}
    pending=c.execute('SELECT count(DISTINCT r.mid) FROM hi_records r JOIN hi_items i ON i.mid=r.mid WHERE i.batch=? AND r.active=1 AND r.raw_id IS NULL',(b['id'],)).fetchone()[0]
    errors=[dict(r) for r in c.execute('SELECT item_key,error FROM hi_items WHERE batch=? AND error IS NOT NULL LIMIT 50',(b['id'],))] if details else []
    chunks={r['state']:r['n'] for r in c.execute('SELECT state,count(*) n FROM hi_chunks WHERE batch=? GROUP BY state',(b['id'],))}
    candidates=[]
    for r in c.execute("SELECT * FROM hi_candidates WHERE batch=? AND ? ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END,rowid LIMIT 50",(b['id'],int(details))):
        v=dec(r['body'],['candidate',r['id']]);candidates.append({'id':r['id'],'state':r['state'],'error':r['error'],**v})
    threads=[r['tid'] for r in c.execute("SELECT r.tid FROM hi_records r JOIN hi_items i ON i.mid=r.mid WHERE i.batch=? AND r.active=1 AND r.tid<>'' GROUP BY r.tid ORDER BY min(r.rowid)",(b['id'],))]
    return {'ok':True,'thread_count':len(threads),'first_thread_id':threads[0] if threads else '', 'batch_id':b['id'],'friend_id':b['fid'],'principal':b['principal'],'label':b['label'],
            'source_changes':source_changes(c,b) if details else [],'state':b['state'],'file_hash':b['file_hash'],'counts':counts,'pending_raw':pending,'errors':errors,'chunks':chunks,'candidates':candidates}
def observe_edit(c,owner,old,new):
    if not old or not is_import_id(old.get('id')):return
    r=c.execute('SELECT * FROM hi_records WHERE mid=? AND owner=?',(old['id'],owner)).fetchone()
    if not r:return
    if not new:c.execute('UPDATE hi_records SET active=0,raw_id=NULL WHERE mid=?',(r['mid'],))
    elif any(old.get(k)!=new.get(k) for k in ('content','role','timestamp','friendId','threadId','imp')):
        c.execute('UPDATE hi_records SET raw_id=NULL WHERE mid=?',(r['mid'],))
    else:return
    # Leases/results tied to edited source versions cannot later commit.
    c.execute("UPDATE hi_chunks SET state='stale',error='history_source_changed' WHERE batch IN (SELECT batch FROM hi_items WHERE mid=?) AND state IN ('pending','running')",(r['mid'],))
def commit_candidate(c,owner,fid,row,remote):
    if row['state']=='committed':return json.loads(row['receipt'])
    if row['state']=='rejected':raise ValueError('history_candidate_rejected')
    v=dec(row['body'],['candidate',row['id']]);ch=c.execute('SELECT * FROM hi_chunks WHERE id=?',(row['chunk'],)).fetchone()
    proof=dec(ch['proof'],['proof',ch['id']]);check_proof(c,owner,fid,proof)
    proposal=dec(row['proposal'],['proposal',row['id']]) if row['proposal'] else None
    if not proposal:
        sources=[]
        for ref in v['sources']:
            r,m,s=source(c,owner,fid,ref['message_id'])
            if m['role']!='user' or ref['quote'] not in m['content']:raise ValueError('history_invalid_evidence')
            sources.append({'raw_id':s['raw_id'],'sha256':s['sha256']})
        ctx=remote('context',{'topic_key':v['topic_key']});topics=ctx.get('topics',[])
        revision=next((x['revision'] for x in topics if x['topic_key']==v['topic_key']),0)
        # A changed understanding requires a fresh user decision, not a hidden rebase.
        if revision!=v['expected_revision']:raise ValueError('history_topic_changed_review_again')
        proposal={'request_id':str(uuid.uuid4()),'sources':sources,'disposition':'organize','reason':'用户启动 Claude 历史整理并采纳；来源证明仅表示可追溯，不表示结论已获独立证实',
          'topic_key':v['topic_key'],'event':v['event'],'understanding':v['understanding'],'activate':True,'expected_revision':revision}
        c.execute('UPDATE hi_candidates SET proposal=? WHERE id=?',(enc(proposal,['proposal',row['id']]),row['id']));c.commit()
    # Idempotent replay after a lost Sup response uses the exact same request.
    check_proof(c,owner,fid,proof);c.commit()
    result=remote('history-commit',proposal)
    if result.get('principal_id')!=library_scope.current() or result.get('activated') is not True:raise ValueError('history_invalid_commit_receipt')
    c.execute("UPDATE hi_candidates SET state='committed',receipt=?,error=NULL WHERE id=?",(cloud_sync.packed(result),row['id']));c.commit()
    return result
def source_changes(c,b):
    out=[]
    for r in c.execute("SELECT * FROM hi_source_updates WHERE batch=? AND state='pending' LIMIT 10",(b['id'],)):
        data=dec(r['body'],['source-update',b['id'],r['mid']])
        out.append({'id':r['mid'],'before':data['before_display']['content'][:2000],'after':data['after_source']['content'][:2000],'truncated':max(len(data['before_display']['content']),len(data['after_source']['content']))>2000})
    return out
def stage_source_barrier(c,r,norm):
    cached=c.execute('SELECT raw_id FROM messages WHERE scope=? AND id=?',(r['scope'],r['mid'])).fetchone()
    raw=(cached['raw_id'] if cached else None) or r['raw_id']
    if raw:c.execute('INSERT INTO source_barriers VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET raw_id=coalesce(source_barriers.raw_id,excluded.raw_id),target_hash=excluded.target_hash',(r['scope'],r['mid'],raw,digest(norm)))

def apply_source_update(c,owner,fid,b,mid,remote,invalidate,reject=False):
    row=c.execute('SELECT * FROM hi_source_updates WHERE batch=? AND mid=?',(b['id'],mid)).fetchone()
    if not row:raise ValueError('history_source_update_missing')
    if row['state']!='pending':return
    data=dec(row['body'],['source-update',b['id'],mid])
    if reject:
        c.execute("UPDATE hi_source_updates SET state='ignored' WHERE batch=? AND mid=?",(b['id'],mid))
        c.execute("UPDATE hi_items SET action='skipped',error=NULL WHERE batch=? AND mid=?",(b['id'],mid));return
    m,cr=cloud(c,owner,'chatMessages',mid)
    if not m or undo_stamp(m)!=data['before_stamp']:raise ValueError('history_source_updated_again')
    r=c.execute('SELECT * FROM hi_records WHERE mid=?',(mid,)).fetchone();src=data['after_source']
    display={**m,'role':src['role'],'content':src['content']}
    display['imp']={**m.get('imp',{}),'original_time':src['original_time'],'time_known':src['time_known'],
      'parent_id':src.get('parent_id'),'attachments':src['attachments'],'revision_batch':b['id']}
    if src.get('thinking') and src['role']=='assistant':display['thinking']=src['thinking']
    else:display.pop('thinking',None)
    src['revision_batch']=b['id'];data['after_stamp']=undo_stamp(display)
    c.execute("UPDATE hi_source_updates SET state='applied',body=? WHERE batch=? AND mid=?",(enc(data,['source-update',b['id'],mid]),b['id'],mid))
    # Keep original batch ownership so undoing this update restores instead of deleting.
    c.execute('UPDATE hi_records SET body=?,fingerprint=?,raw_id=NULL WHERE mid=?',(enc(src,['record',mid]),src['fingerprint'],mid))
    norm={k:display[k] for k in ('id','role','content','timestamp')}
    stage_source_barrier(c,r,norm)
    push(c,owner,'chatMessages',display,mid,invalidate)
    c.execute('UPDATE messages SET body=?,hash=?,raw_id=NULL WHERE scope=? AND id=?',(cloud_sync.packed(norm),digest(norm),r['scope'],mid))
    c.execute("UPDATE hi_items SET action='updated',error=NULL WHERE batch=? AND mid=?",(b['id'],mid))
    c.commit();sync_records(c,owner,fid,b,remote)
def undo_source_updates(c,owner,fid,b,remote,invalidate):
    blocked=[]
    for row in c.execute("SELECT * FROM hi_source_updates WHERE batch=? AND state IN ('applied','restoring') LIMIT 20",(b['id'],)).fetchall():
        mid=row['mid'];data=dec(row['body'],['source-update',b['id'],mid]);m,_=cloud(c,owner,'chatMessages',mid)
        if row['state']=='applied':
            if not m or undo_stamp(m)!=data['after_stamp']:
                blocked.append(mid);continue
            before=data['before_source'];display=data['before_display']
            c.execute('UPDATE hi_records SET body=?,fingerprint=?,raw_id=NULL WHERE mid=?',(enc(before,['record',mid]),before['fingerprint'],mid))
            r=c.execute('SELECT * FROM hi_records WHERE mid=?',(mid,)).fetchone()
            norm={k:display[k] for k in ('id','role','content','timestamp')}
            stage_source_barrier(c,r,norm)
            push(c,owner,'chatMessages',display,mid,invalidate)
            c.execute('UPDATE messages SET body=?,hash=?,raw_id=NULL WHERE scope=? AND id=?',(cloud_sync.packed(norm),digest(norm),r['scope'],mid))
            c.execute("UPDATE hi_source_updates SET state='restoring' WHERE batch=? AND mid=?",(b['id'],mid));c.commit()
        sync_records(c,owner,fid,b,remote)
        r=c.execute('SELECT raw_id FROM hi_records WHERE mid=?',(mid,)).fetchone()
        if r['raw_id']:
            c.execute("UPDATE hi_source_updates SET state='undone' WHERE batch=? AND mid=?",(b['id'],mid))
            c.execute("UPDATE hi_items SET action='undone_update',error=NULL WHERE batch=? AND mid=?",(b['id'],mid));c.commit()
    return blocked

def handle(c,owner,fid,route,body,remote,invalidate):
    principal=library_scope.current()
    if route=='list':
        return {'ok':True,'batches':[status(c,b,False) for b in c.execute('SELECT * FROM hi_batches WHERE owner=? AND fid=? ORDER BY created DESC LIMIT 20',(owner,fid))]}
    if route=='start':
        req=str(uuid.UUID(body.get('request_id','')));fh=text(body.get('file_hash'),64)
        if not re.fullmatch('[a-f0-9]{64}',fh) or body.get('mode') not in ('main','thread','auto'):raise ValueError('history_invalid_start')
        cfg,_=cloud(c,owner,'apiConfigs',fid)
        if not cfg or cfg.get('archived'):raise ValueError('history_target_missing')
        manifest={'file_hash':fh,'label':text(body.get('label','Claude 历史'),200),'mode':body['mode']}
        if body.get('graph_archive_expected') is not None:
            count=body['graph_archive_expected']
            if type(count) is not int or not 0<=count<=1000000:raise ValueError('history_graph_invalid_archive')
            manifest['graph_archive_expected']=count
        old=c.execute('SELECT * FROM hi_batches WHERE id=?',(req,)).fetchone()
        if old:
            if old['owner']!=owner or old['fid']!=fid or old['principal']!=principal or old['manifest']!=cloud_sync.packed(manifest):raise ValueError('history_request_changed')
        else:c.execute('INSERT INTO hi_batches VALUES(?,?,?,?,?,?,?,?,?,?)',(req,owner,fid,principal,manifest['label'],fh,manifest['mode'],'receiving',time.time(),cloud_sync.packed(manifest)))
        return status(c,batch(c,owner,fid,req))
    b=batch(c,owner,fid,body.get('batch_id'))
    if route=='status':return status(c,b)
    if b['state']=='undone' and route!='undo':raise ValueError('history_batch_undone')
    if route=='report':
        for r in body.get('rejected',[])[:100]:
            key='parse:'+str(r.get('key'));why=str(r.get('reason','unsupported'))[:240]
            c.execute('INSERT OR IGNORE INTO hi_items VALUES(?,?,NULL,?,?,?)',(b['id'],key,'failed',why,digest(r)))
        return status(c,b)
    if route=='chunk':
        if b['state']!='receiving':raise ValueError('history_upload_closed')
        items=body.get('messages')
        if not isinstance(items,list) or not 1<=len(items)<=25:raise ValueError('history_invalid_chunk')
        for i,m in enumerate(items):
            itemkey=str(m.get('item_key') or digest([m.get('conversation_index'),m.get('message_index')])) if isinstance(m,dict) else digest(['invalid',i])
            m={k:v for k,v in m.items() if k!='item_key'} if isinstance(m,dict) else m
            olditem=c.execute('SELECT * FROM hi_items WHERE batch=? AND item_key=?',(b['id'],itemkey)).fetchone()
            input_hash=digest({k:v for k,v in m.items() if k!="sort_time"})
            if olditem:
                if olditem['request_hash']!=input_hash:raise ValueError('history_chunk_replay_changed')
                if olditem['action']=='failed':continue
                continue
            try:
                s=normalized(m,b['file_hash'])
                old=c.execute('SELECT * FROM hi_records WHERE owner=? AND fid=? AND source_key=?',(owner,fid,s['source_key'])).fetchone()
                if old and old['principal']!=principal:raise ValueError('memory_binding_changed')
                if old and old['active'] and old['fingerprint']==s['fingerprint']:
                    c.execute('INSERT INTO hi_items VALUES(?,?,?,?,NULL,?)',(b['id'],itemkey,old['mid'],'skipped',input_hash));continue
                if old and old['active']:
                    before,_=cloud(c,owner,'chatMessages',old['mid'])
                    if not before:raise ValueError('history_source_deleted')
                    data={'before_source':record_body(old),'before_display':before,'before_stamp':undo_stamp(before),'after_source':s}
                    c.execute("INSERT INTO hi_source_updates VALUES(?,?,'pending',?)",(b['id'],old['mid'],enc(data,['source-update',b['id'],old['mid']])))
                    c.execute('INSERT INTO hi_items VALUES(?,?,?,?,NULL,?)',(b['id'],itemkey,old['mid'],'source_conflict',input_hash));continue
                # Ordinary IB cursors order equal-friend records by their timestamp-prefixed primary key.
                ts=int(record_body(old)['sort_time']) if old else int(s['sort_time'])
                s['sort_time']=ts
                mid=old['mid'] if old else 'msg_'+str(ts).zfill(13)+'_hi_'+digest([owner,fid,s['source_key']])[:48]
                tid='' if b['mode']=='main' else 'thread_hi_'+digest([owner,fid,s['conversation_key']])[:40]
                tid=history_graph.import_tid(c,owner,fid,s,tid)
                scope=digest([owner,fid,tid]);library_scope.attach(c,scope,principal)
                ts=int(s['sort_time']);imp={'v':19,'b':b['id'],'s':'claude','c':s.get('conversation_id'),'m':s.get('message_id'),
                    'original_time':s['original_time'],'time_known':s['time_known'],'order':s['message_index'],'identity_kind':s['identity_kind'],'conversation_key':s['conversation_key'],
                    'parent_id':s.get('parent_id'),'branch_known':bool(s.get('branch_known')),'attachments':s['attachments']}
                display={'id':mid,'friendId':fid,'role':s['role'],'content':s['content'],'timestamp':ts,'imp':imp}
                if tid:display['threadId']=tid
                if s.get('thinking') and s['role']=='assistant':display['thinking']=text(s['thinking'],262144,True)
                if tid:
                    thread,tr=cloud(c,owner,'chatThreads',tid)
                    if tr and tr['deleted'] and not old:raise ValueError('history_thread_deleted')
                    if not thread:push(c,owner,'chatThreads',{'id':tid,'friendId':fid,'name':s['title'],'memoryEnabled':True,'created':ts,'imp':{'v':19,'b':b['id'],'s':'claude'}},tid,invalidate)
                c.execute('INSERT INTO hi_records VALUES(?,?,?,?,?,?,?,?,?,?,NULL,1) ON CONFLICT(mid) DO UPDATE SET body=excluded.body,fingerprint=excluded.fingerprint,first_batch=excluded.first_batch,raw_id=NULL,active=1',
                  (mid,owner,fid,tid,principal,s['source_key'],scope,enc(s,['record',mid]),s['fingerprint'],b['id']))
                push(c,owner,'chatMessages',display,mid,invalidate)
                c.execute('INSERT OR REPLACE INTO hi_undo_proofs VALUES(?,?)',(mid,undo_stamp(display)))
                norm={k:display[k] for k in ('id','role','content','timestamp')}
                c.execute('INSERT OR IGNORE INTO scopes VALUES(?,0,?,?)',(scope,'{"nodes":[],"focus":null}',''))
                c.execute('INSERT INTO messages VALUES(?,?,?,?,NULL) ON CONFLICT(scope,id) DO UPDATE SET body=excluded.body,hash=excluded.hash,raw_id=NULL',(scope,mid,cloud_sync.packed(norm),digest(norm)))
                c.execute('INSERT INTO hi_items VALUES(?,?,?,?,NULL,?)',(b['id'],itemkey,mid,'imported',input_hash))
            except ValueError as e:
                c.execute('INSERT OR IGNORE INTO hi_items VALUES(?,?,NULL,?,?,?)',(b['id'],itemkey,'failed',str(e)[:240],input_hash))
        c.commit();sync_records(c,owner,fid,b,remote)
        return status(c,b)
    if route=='source-detail':
        row=c.execute('SELECT body FROM hi_source_updates WHERE batch=? AND mid=?',(b['id'],body.get('message_id'))).fetchone()
        if not row:raise ValueError('history_source_update_missing')
        data=dec(row['body'],['source-update',b['id'],body['message_id']])
        return {'ok':True,'before':data['before_display']['content'],'after':data['after_source']['content']}
    if route in ('source-accept','source-reject'):
        apply_source_update(c,owner,fid,b,body.get('message_id'),remote,invalidate,route=='source-reject')
        return status(c,b)
    if route in ('finish','sync'):
        if route=='finish':
            expected=json.loads(b['manifest']).get('graph_archive_expected')
            if expected is not None:
                count=c.execute('SELECT count(*) FROM (SELECT conversation,node_key FROM hg_parts WHERE batch=? GROUP BY conversation,node_key HAVING count(*)=max(total))',(b['id'],)).fetchone()[0]
                if count!=expected:raise ValueError('history_graph_archive_incomplete')
            c.execute("UPDATE hi_batches SET state='ready' WHERE id=?",(b['id'],))
        c.commit();sync_records(c,owner,fid,b,remote)
        return status(c,batch(c,owner,fid,b['id']))
    if route=='plan':
        if b['state']!='ready':raise ValueError('history_upload_not_finished')
        if c.execute('SELECT 1 FROM hi_chunks WHERE batch=? LIMIT 1',(b['id'],)).fetchone():return status(c,b)
        if source_changes(c,b):raise ValueError('history_source_changes_need_review')
        if status(c,b)['pending_raw']:raise ValueError('history_raw_still_pending')
        limit=body.get('max_calls',10)
        if type(limit) is not int or not 1<=limit<=500:raise ValueError('history_invalid_call_limit')
        model=text(body.get('model_signature'),300)
        eligible={r['mid'] for r in c.execute("SELECT DISTINCT r.mid FROM hi_records r JOIN hi_items i ON i.mid=r.mid WHERE i.batch=? AND r.active=1",(b['id'],))}
        buf=[];size=0;planned=0
        def persist(items,index):
            cid=str(uuid.uuid5(uuid.UUID(b['id']),str(index)));proofs=[]
            for mid in dict.fromkeys(x['id'] for x in items):proofs.append(source(c,owner,fid,mid)[2])
            c.execute('INSERT INTO hi_chunks VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)',(cid,b['id'],owner,fid,principal,'pending',enc(items,['chunk',cid]),enc(proofs,['proof',cid]),None,model))
        for segment in history_graph.organization_segments(c,owner,fid,eligible):
            buf=[];size=0
            for mid in segment['ancestors']+segment['ids']:
                context_only=mid not in segment['ids']
                try:rr,m,proof=source(c,owner,fid,mid)
                except ValueError:
                    if context_only:continue
                    raise
                s=record_body(rr)
                for start in range(0,len(m['content']),12000):
                    piece={'id':mid,'role':m['role'],'content':m['content'][start:start+12000],'offset':start,
                      'time':s['original_time'],'time_known':s['time_known'],'order':s['message_index'],
                      'context_only':context_only,'branch_head':segment['branch_head'],'branch_alternative':segment['uncertain']}
                    if buf and (len(buf)>=20 or size+len(piece['content'])>18000):
                        persist(buf,planned);planned+=1;buf=[];size=0
                    buf.append(piece);size+=len(piece['content'])
            if buf:persist(buf,planned);planned+=1
        if not planned:raise ValueError('history_no_synced_messages')
        return {**status(c,b),'planned_calls':planned,'run_limit':limit}
    if route=='next':
        row=c.execute("SELECT * FROM hi_chunks WHERE batch=? AND (state='pending' OR (state='running' AND leased<?)) ORDER BY rowid LIMIT 1",(b['id'],time.time()-600)).fetchone()
        if not row:return {'ok':True,'done':True,**status(c,b)}
        proof=dec(row['proof'],['proof',row['id']]);check_proof(c,owner,fid,proof)
        lease=str(uuid.uuid4());c.execute("UPDATE hi_chunks SET state='running',lease=?,leased=?,error=NULL WHERE id=?",(lease,time.time(),row['id']));c.commit()
        catalog=remote('catalog',{'offset':0}).get('topics',[])
        budget=12000;topics=[]
        for item in catalog:
            content=str(item.get('content',''))
            full=len(content)<=budget
            value=content if full else content[:200]
            if full:budget-=len(content)
            topics.append({'topic_key':item['topic_key'],'revision':item['revision'],'understanding':value,'complete':full})
        return {'ok':True,'done':False,'chunk_id':row['id'],'lease':lease,'messages':dec(row['body'],['chunk',row['id']]),
           'topics':topics,
           'model_signature':row['model']}
    if route=='release':
        c.execute("UPDATE hi_chunks SET state='pending',lease=NULL,leased=NULL WHERE id=? AND batch=? AND state='running' AND lease=?",(body.get('chunk_id'),b['id'],body.get('lease')))
        return status(c,b)
    if route=='result':
        ch=c.execute('SELECT * FROM hi_chunks WHERE id=? AND batch=?',(body.get('chunk_id'),b['id'])).fetchone()
        if not ch:raise ValueError('history_chunk_missing')
        if ch['state']=='done':return status(c,b)
        if ch['state']!='running' or ch['lease']!=body.get('lease'):raise ValueError('history_lease_changed')
        proof=dec(ch['proof'],['proof',ch['id']]);check_proof(c,owner,fid,proof)
        candidates=body.get('candidates')
        if not isinstance(candidates,list) or len(candidates)>6:raise ValueError('history_invalid_candidates')
        pieces=dec(ch['body'],['chunk',ch['id']]);accepted=[]
        for i,v in enumerate(candidates):
            if not isinstance(v,dict) or set(v)!={'topic_key','event','understanding','sources','kind'}:raise ValueError('history_invalid_candidate')
            for k,n in [('topic_key',120),('event',4000),('understanding',4000)]:text(v.get(k),n)
            refs=v.get('sources')
            if not isinstance(refs,list) or not 1<=len(refs)<=20:raise ValueError('history_invalid_evidence')
            seen=set()
            for ref in refs:
                if not isinstance(ref,dict) or set(ref)!={'message_id','quote'}:raise ValueError('history_invalid_evidence')
                quote=text(ref['quote'],600)
                if len(quote)<2 or ref['message_id'] in seen:raise ValueError('history_invalid_evidence')
                seen.add(ref['message_id'])
                if not any(m['id']==ref['message_id'] and m['role']=='user' and not m.get('context_only') and quote in m['content'] for m in pieces):raise ValueError('history_invalid_evidence')
            ctx=remote('context',{'topic_key':v['topic_key']});topic=next((x for x in ctx.get('topics',[]) if x['topic_key']==v['topic_key']),None)
            revision=topic['revision'] if topic else 0
            accepted.append({**v,'branch_alternative':any(m.get('branch_alternative') for m in pieces),'branch_heads':list(dict.fromkeys(m.get('branch_head') for m in pieces if m.get('branch_head'))),'expected_revision':revision,'previous_understanding':'\n\n'.join(x.get('content','') for x in ctx.get('items',[])), 'previous_truncated':any(x.get('content_truncated') for x in ctx.get('items',[]))})
        # Save all validated results before any external memory commit.
        c.execute("UPDATE hi_chunks SET state='done',result=? WHERE id=?",(enc(accepted,['result',ch['id']]),ch['id']))
        for i,v in enumerate(accepted):
            cid=str(uuid.uuid5(uuid.UUID(ch['id']),str(i)))
            c.execute("INSERT OR IGNORE INTO hi_candidates VALUES(?,?,?,?,?,?,'pending',?,NULL,NULL,NULL)",(cid,ch['id'],b['id'],owner,fid,principal,enc(v,['candidate',cid])))
        c.commit()
        if body.get('auto_new') is True:
            for r in c.execute("SELECT * FROM hi_candidates WHERE chunk=? AND state='pending'",(ch['id'],)).fetchall():
                v=dec(r['body'],['candidate',r['id']])
                if not v.get('branch_alternative') and v['expected_revision']==0 and v['kind'] in ('preference','agreement','experience','correction'):
                    try:commit_candidate(c,owner,fid,r,remote)
                    except Exception as e:c.execute('UPDATE hi_candidates SET error=? WHERE id=?',(str(e)[:240],r['id']));c.commit()
        return status(c,b)
    if route=='review':
        r=c.execute('SELECT * FROM hi_candidates WHERE id=? AND batch=?',(body.get('candidate_id'),b['id'])).fetchone()
        if not r or r['state']!='pending':raise ValueError('history_candidate_missing')
        if r['proposal'] and r['error'] not in ('organization_revision_conflict','history_topic_changed_review_again'):raise ValueError('history_previous_commit_unconfirmed_retry_accept_first')
        v=dec(r['body'],['candidate',r['id']]);ctx=remote('context',{'topic_key':v['topic_key']})
        v['expected_revision']=next((x['revision'] for x in ctx.get('topics',[]) if x['topic_key']==v['topic_key']),0)
        v['previous_understanding']='\n\n'.join(x.get('content','') for x in ctx.get('items',[]));v['previous_truncated']=any(x.get('content_truncated') for x in ctx.get('items',[]))
        c.execute('UPDATE hi_candidates SET body=?,proposal=NULL,error=NULL WHERE id=?',(enc(v,['candidate',r['id']]),r['id']))
        return status(c,b)
    if route in ('accept','reject'):
        r=c.execute('SELECT * FROM hi_candidates WHERE id=? AND batch=?',(body.get('candidate_id'),b['id'])).fetchone()
        if not r:raise ValueError('history_candidate_missing')
        if route=='reject':
            if r['state']=='committed':raise ValueError('history_candidate_already_committed')
            c.execute("UPDATE hi_candidates SET state='rejected' WHERE id=?",(r['id'],))
        else:
            try:commit_candidate(c,owner,fid,r,remote)
            except Exception as e:
                c.execute('UPDATE hi_candidates SET error=? WHERE id=?',(str(e)[:240],r['id']));c.commit();raise
        return status(c,b)
    if route=='undo':
        c.execute("UPDATE hi_batches SET state='undoing' WHERE id=?",(b['id'],));c.execute("UPDATE hi_chunks SET state='cancelled' WHERE batch=? AND state IN ('pending','running')",(b['id'],));c.commit()
        records=c.execute("SELECT DISTINCT r.* FROM hi_records r JOIN hi_items i ON i.mid=r.mid WHERE i.batch=? AND i.action='imported' AND r.first_batch=? AND r.active=1 LIMIT 25",(b['id'],b['id'])).fetchall()
        blocked=undo_source_updates(c,owner,fid,b,remote,invalidate)
        c.execute("UPDATE hi_source_updates SET state='ignored' WHERE batch=? AND state='pending'",(b['id'],))
        for r in records:
            s=record_body(r);m,_=cloud(c,owner,'chatMessages',r['mid'])
            original=c.execute('SELECT stamp FROM hi_undo_proofs WHERE mid=?',(r['mid'],)).fetchone()
            if m and (not original or undo_stamp(m)!=original['stamp']):
                blocked.append(r['mid']);c.execute('UPDATE hi_items SET error=? WHERE batch=? AND mid=?',('history_edited_after_import_preserved',b['id'],r['mid']));continue
            if m:push(c,owner,'chatMessages',None,r['mid'],invalidate,True)
            c.commit()
            try:
                res=remote('history-raw',{'operations':[raw_operation(r,m or {},'delete')]})
                if res.get('results',[{}])[0].get('status') not in ('deleted','missing'):raise ValueError('history_delete_unconfirmed')
                c.execute("DELETE FROM messages WHERE scope=? AND id=?",(r['scope'],r['mid']))
                c.execute("DELETE FROM source_barriers WHERE scope=? AND id=?",(r['scope'],r['mid']))
                c.execute("UPDATE hi_records SET active=0,raw_id=NULL WHERE mid=?",(r['mid'],))
                c.execute("UPDATE hi_items SET action='undone',error=NULL WHERE batch=? AND mid=?",(b['id'],r['mid']))
                c.commit()
            except Exception as e:
                c.execute("UPDATE hi_records SET active=1 WHERE mid=?",(r['mid'],))
                c.execute('UPDATE hi_items SET error=? WHERE batch=? AND mid=?',(str(e)[:240],b['id'],r['mid']));c.commit()
        left=c.execute("SELECT count(*) FROM hi_records WHERE first_batch=? AND active=1",(b['id'],)).fetchone()[0]
        left+=c.execute("SELECT count(*) FROM hi_source_updates WHERE batch=? AND state IN ('applied','restoring')",(b['id'],)).fetchone()[0]
        if not left:c.execute("UPDATE hi_batches SET state='undone' WHERE id=?",(b['id'],))
        return {**status(c,batch(c,owner,fid,b['id'])),'remaining':left,'blocked_edited_ids':blocked}
    raise ValueError('history_not_found')
