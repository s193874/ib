"""Human memory editor; only the authenticated adapter can reach this module."""
import hashlib
import json
import threading
import time
import uuid
import library_scope

WRITES = threading.RLock()
KNOWN = {'memory_revision_conflict','manual_request_id_reused','manual_source_changed',
         'scope_denied','thought_not_active','invalid_manual_request'}


def init(c):
    c.executescript('''
    CREATE TABLE IF NOT EXISTS memory_policy(owner INTEGER,thought_id TEXT,paused INTEGER,revision INTEGER,
      PRIMARY KEY(owner,thought_id));
    CREATE TABLE IF NOT EXISTS memory_policy_events(owner INTEGER,thought_id TEXT,revision INTEGER,
      paused INTEGER,created REAL,PRIMARY KEY(owner,thought_id,revision));
    CREATE TABLE IF NOT EXISTS manual_memory_jobs(id TEXT PRIMARY KEY,owner INTEGER,thought_id TEXT,
      client_body TEXT,request TEXT,state TEXT,result TEXT,error TEXT,created REAL);
    ''')


def pending(c):
    return c.execute("SELECT count(*) FROM manual_memory_jobs WHERE state='pending' AND principal=?",(library_scope.current(),)).fetchone()[0]


def paused(c, owner):
    return {r['thought_id'] for r in c.execute('SELECT thought_id FROM memory_policy WHERE owner=? AND paused=1',(owner,))}


def clock(c):
    c.execute('UPDATE source_clock SET revision=revision+1 WHERE id=1')
    c.execute('INSERT INTO library_source_clock VALUES(?,1) ON CONFLICT(principal) DO UPDATE SET revision=revision+1',(library_scope.current(),))


def identity(value):
    try:
        if str(uuid.UUID(value)) != value:raise ValueError()
    except (ValueError,TypeError,AttributeError):raise ValueError('invalid_memory_id')
    return value


def policy(c, owner, target):
    row=c.execute('SELECT paused,revision FROM memory_policy WHERE owner=? AND thought_id=?',(owner,target)).fetchone()
    return dict(row) if row else {'paused':0,'revision':0}


def replay(c, remote, row):
    if row['principal']!=library_scope.current():raise ValueError('scope_denied')
    c.commit()
    try:
        result=remote('manual',json.loads(row['request']))
        if result.get('request_id')!=row['id'] or result.get('thought_id')!=row['thought_id']:
            raise OSError('invalid_manual_receipt')
    except ValueError as e:
        if str(e) not in KNOWN:raise
        c.execute("UPDATE manual_memory_jobs SET state='failed',error=? WHERE id=?",(str(e),row['id']))
        clock(c);c.commit();raise
    c.execute("UPDATE manual_memory_jobs SET state='done',result=?,error=NULL WHERE id=?",(json.dumps(result),row['id']))
    clock(c);c.commit()
    return result


def retry(c, remote, owner):
    c.commit()
    with WRITES:
        for row in c.execute("SELECT * FROM manual_memory_jobs WHERE owner=? AND principal=? AND state='pending' ORDER BY created LIMIT 3",(owner,library_scope.current())).fetchall():
            try:replay(c,remote,row)
            except (OSError,ValueError):pass


def handle(c, owner, fid, tid, route, body, remote, lock, cloud_current):
    target=identity(body.get('thought_id')) if route!='memory/list' else None
    if route=='memory/retry':
        remote('manage-detail',{'thought_id':target,'offset':0})
        retry(c,remote,owner)
        return {'ok':True,'pending_manual':pending(c)}
    if route in ('memory/list','memory/detail'):
        offset=body.get('offset',0)
        if type(offset) is not int or not 0<=offset<=100000:raise ValueError('invalid_offset')
        if route=='memory/list':
            result=remote('manage-list',{'offset':offset})
            for item in result['items']:
                item.update(policy(c,owner,item['thought_id']))
            return result
        result=remote('manage-detail',{'thought_id':target,'offset':offset})
        result['item'].update(policy(c,owner,target))
        result['policy_history']=[dict(x) for x in c.execute('SELECT revision,paused,created FROM memory_policy_events '
            'WHERE owner=? AND thought_id=? ORDER BY revision DESC LIMIT 20',(owner,target))]
        result['pending_manual']=c.execute("SELECT count(*) FROM manual_memory_jobs WHERE owner=? AND thought_id=? AND state='pending'",(owner,target)).fetchone()[0]
        return result
    c.commit()
    with WRITES:
        if route=='memory/policy':
            # The canonical reader proves the thought belongs to this principal.
            remote('manage-detail',{'thought_id':target,'offset':0})
            if type(body.get('paused')) is not bool or type(body.get('expected_revision')) is not int:
                raise ValueError('invalid_memory_policy')
            with lock:
                current=policy(c,owner,target)
                if current['revision']!=body['expected_revision']:raise ValueError('memory_policy_conflict')
                rev=current['revision']+1
                c.execute('INSERT INTO memory_policy VALUES(?,?,?,?) ON CONFLICT(owner,thought_id) DO UPDATE SET '
                    'paused=excluded.paused,revision=excluded.revision',(owner,target,int(body['paused']),rev))
                c.execute('INSERT INTO memory_policy_events VALUES(?,?,?,?,?)',(owner,target,rev,int(body['paused']),time.time()))
                clock(c);c.commit()
            return {'ok':True,**policy(c,owner,target)}
        if route!='memory/revise':raise ValueError('not_found')
        request_id=identity(body.get('request_id'))
        content=body.get('content');reason=body.get('reason','');token=body.get('expected_token');ids=body.get('source_ids',[])
        if not isinstance(content,str) or not 1<=len(content.strip())<=8000 or not isinstance(reason,str) or len(reason)>2000:
            raise ValueError('invalid_manual_text')
        if not isinstance(token,str) or len(token)!=32 or not isinstance(ids,list) or len(ids)>10 or any(not isinstance(x,str) for x in ids) or len(set(ids))!=len(ids):
            raise ValueError('invalid_manual_request')
        client=json.dumps({'thought_id':target,'expected_token':token,'content':content,'reason':reason,'source_ids':ids},sort_keys=True)
        old=c.execute('SELECT * FROM manual_memory_jobs WHERE id=?',(request_id,)).fetchone()
        if old:
            if old['owner']!=owner or old['principal']!=library_scope.current() or old['client_body']!=client:raise ValueError('manual_request_id_reused')
            if old['state']=='done':return json.loads(old['result'])
            if old['state']=='failed':raise ValueError(old['error'])
            return replay(c,remote,old)
        # Only server-resolved, current user records from this exact channel may be selected.
        scope=hashlib.sha256(json.dumps([owner,fid,tid],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        refs=[]
        with lock:
            for mid in ids:
                row=c.execute('SELECT * FROM messages WHERE scope=? AND id=?',(scope,mid)).fetchone()
                msg=json.loads(row['body']) if row else None
                if not row or not row['raw_id'] or row['hash']=='deleted' or msg['role']!='user' or not cloud_current(c,fid,tid,msg):
                    raise ValueError('manual_source_changed')
                refs.append({'raw_id':row['raw_id'],'sha256':hashlib.sha256(msg['content'].encode()).hexdigest()})
            request={'request_id':request_id,'thought_id':target,'expected_token':token,'content':content.strip(),
                     'reason':reason.strip(),'actor_owner':owner,'source_refs':refs}
            c.execute("INSERT INTO manual_memory_jobs(id,owner,thought_id,client_body,request,state,result,error,created,principal) VALUES(?,?,?,?,?,'pending',NULL,NULL,?,?)",
                      (request_id,owner,target,client,json.dumps(request,ensure_ascii=False),time.time(),library_scope.current()))
            clock(c);c.commit()
        return replay(c,remote,c.execute('SELECT * FROM manual_memory_jobs WHERE id=?',(request_id,)).fetchone())
