"""Owner-authenticated IB data sync with encrypted payloads at rest."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

STORES = ('posts','categories','about','music','apiSettings','chatMessages','letters','apiConfigs','groups',
          'blogComments','memories','chatThreads','chatSummaries','uploadedFiles','blogAnnotations',
          'projects','projectFiles','autoMemory','calEvents','calNotes','calLedger','feed',
          'ibPreferences','ibMedia','ibMediaJobs')
ROLE_FIELDS = set(('id nickname relationship provider endpoint model systemPrompt temperature '
    'autoMem autoMemMode autoMemBudget amRecordOnly streaming thinkingEnabled vision webSearch '
    'promptCache cacheTtl1h fallbackMode fallbackModels memWrite beyond avatar created archived '
    'sortOrder sealTimestamp').split())
SECRET = re.compile(r'(?:^(?:key|authorization|cookie|headers|password|secret|token)$|'
                    r'api.?key|access.?token|refresh.?token|imageGenKey|sttKey|igKey)', re.I)
MAX_RECORD = 16 * 1024 * 1024
MAX_MEDIA = 256 * 1024 * 1024
_cipher = None


def seal(text, identity):
    if _cipher is None:
        raise ValueError('sync_encryption_unavailable')
    nonce = os.urandom(12)
    return 'enc1:' + base64.b64encode(nonce + _cipher.encrypt(nonce, text.encode(), packed(identity).encode())).decode()


def open_text(text, identity):
    if not text.startswith('enc1:'):
        return text  # Upgrade existing records without changing the cloud version.
    if _cipher is None:
        raise ValueError('sync_encryption_unavailable')
    value = base64.b64decode(text[5:], validate=True)
    return _cipher.decrypt(value[:12], value[12:], packed(identity).encode()).decode()


def store_payload(c, text, owner, store, mid, version):
    c.execute('DELETE FROM cloud_payload_parts WHERE owner=? AND store=? AND id=?',(owner,store,mid))
    if len(text) <= 196608:
        return seal(text,[owner,store,mid])
    for idx,start in enumerate(range(0,len(text),196608)):
        c.execute('INSERT INTO cloud_payload_parts VALUES(?,?,?,?,?,?)',
                  (owner,store,mid,version,idx,seal(text[start:start+196608],[owner,store,mid,version,idx])))
    return 'parts1:'+str(len(text))


def record_text(c, row, owner, store, mid):
    if not row['body'].startswith('parts1:'):
        return open_text(row['body'],[owner,store,mid])
    parts=c.execute('SELECT idx,body FROM cloud_payload_parts WHERE owner=? AND store=? AND id=? AND version=? ORDER BY idx',
                    (owner,store,mid,row['version'])).fetchall()
    text=''.join(open_text(r['body'],[owner,store,mid,row['version'],r['idx']]) for r in parts)
    if len(text)!=int(row['body'][7:]):
        raise ValueError('sync_incomplete_payload')
    return text


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def clean(value, depth=0):
    if depth > 32:
        raise ValueError('sync_record_too_deep')
    if isinstance(value, dict):
        return {k: clean(v, depth+1) for k, v in value.items()
                if k not in ('__proto__', 'constructor', 'prototype')}
    if isinstance(value, list):
        return [clean(v, depth+1) for v in value]
    return value


def sanitize(store, value):
    if not isinstance(value, dict):
        raise ValueError('sync_invalid_record')
    value = clean(value)
    return value


def init(c):
    global _cipher
    filename = c.execute('PRAGMA database_list').fetchone()[2]
    if not filename:
        raise ValueError('sync_requires_durable_database')
    key_path = Path(filename).parent / 'cloud-key'
    if not key_path.exists():
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(AESGCM.generate_key(bit_length=256))
    _cipher = AESGCM(key_path.read_bytes())
    c.executescript('''
    CREATE TABLE IF NOT EXISTS cloud_clock(owner INTEGER PRIMARY KEY,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cloud_records(owner INTEGER,store TEXT,id TEXT,version INTEGER,
       deleted INTEGER,body TEXT,hash TEXT,PRIMARY KEY(owner,store,id));
    CREATE INDEX IF NOT EXISTS cloud_feed ON cloud_records(owner,version);
    CREATE TABLE IF NOT EXISTS cloud_receipts(owner INTEGER,op TEXT,request_hash TEXT,result TEXT,
       PRIMARY KEY(owner,op));
    CREATE TABLE IF NOT EXISTS cloud_chunks(owner INTEGER,op TEXT,idx INTEGER,total INTEGER,
       body TEXT,created REAL,PRIMARY KEY(owner,op,idx));
    CREATE TABLE IF NOT EXISTS cloud_payload_parts(owner INTEGER,store TEXT,id TEXT,version INTEGER,
       idx INTEGER,body TEXT,PRIMARY KEY(owner,store,id,idx));
    ''')
    if 'size' not in {r['name'] for r in c.execute('PRAGMA table_info(cloud_chunks)')}:
        c.execute('ALTER TABLE cloud_chunks ADD COLUMN size INTEGER NOT NULL DEFAULT 0')
    for r in c.execute('SELECT * FROM cloud_records WHERE body NOT LIKE \'enc1:%\' AND body NOT LIKE \'parts1:%\'').fetchall():
        c.execute('UPDATE cloud_records SET body=? WHERE owner=? AND store=? AND id=?',
                  (store_payload(c,r['body'],r['owner'],r['store'],r['id'],r['version']),r['owner'],r['store'],r['id']))
    for r in c.execute('SELECT * FROM cloud_chunks WHERE body NOT LIKE \'enc1:%\'').fetchall():
        c.execute('UPDATE cloud_chunks SET body=?,size=? WHERE owner=? AND op=? AND idx=?',
                  (seal(r['body'],[r['owner'],r['op'],r['idx']]),len(r['body'].encode()),r['owner'],r['op'],r['idx']))


def key(body):
    store, mid = body.get('store'), body.get('id')
    if store not in STORES or not isinstance(mid, str) or not 1 <= len(mid) <= 180:
        raise ValueError('sync_invalid_key')
    return store, mid


def number(value, maximum=2**53-1):
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError('sync_invalid_number')
    return value


def operation(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{16,80}', value):
        raise ValueError('sync_invalid_operation')
    return value


def meta(row):
    return {'store': row['store'], 'id': row['id'], 'version': row['version'],
            'deleted': bool(row['deleted'])}


def handle(c, owner, route, body, invalidate):
    c.execute('INSERT OR IGNORE INTO cloud_clock VALUES(?,0)', (owner,))
    if route == 'sync/status':
        return {'ok': True, 'owner': owner, 'stores': list(STORES),
                'version': c.execute('SELECT version FROM cloud_clock WHERE owner=?', (owner,)).fetchone()[0]}
    if route == 'sync/stage':
        op = operation(body.get('op')); idx = number(body.get('index'), 2047)
        total = number(body.get('total'), 2048); text = body.get('text')
        if not total or idx >= total or not isinstance(text, str) or len(text.encode()) > 800000:
            raise ValueError('sync_invalid_chunk')
        c.execute('DELETE FROM cloud_chunks WHERE created<?', (time.time()-172800,))
        old = c.execute('SELECT body,total FROM cloud_chunks WHERE owner=? AND op=? AND idx=?', (owner,op,idx)).fetchone()
        if old and (open_text(old['body'],[owner,op,idx]) != text or old['total'] != total):
            raise ValueError('sync_chunk_changed')
        sizes = c.execute('SELECT coalesce(sum(size),0) FROM cloud_chunks WHERE owner=? AND op=?', (owner,op)).fetchone()[0]
        if not old and sizes+len(text.encode()) > MAX_MEDIA:
            raise ValueError('sync_record_too_large')
        c.execute('INSERT OR IGNORE INTO cloud_chunks(owner,op,idx,total,body,created,size) VALUES(?,?,?,?,?,?,?)',
                  (owner,op,idx,total,seal(text,[owner,op,idx]),time.time(),len(text.encode())))
        return {'ok': True}
    if route == 'sync/push':
        if body.get('client_version') != 3:
            raise ValueError('客户端已更新，请刷新 IB 页面后自动同步')
        store, mid = key(body); op = operation(body.get('op')); base = number(body.get('base'))
        deleted = body.get('deleted')
        if type(deleted) is not bool:
            raise ValueError('sync_invalid_delete')
        value = None if deleted else body.get('value')
        if not deleted and body.get('staged') is True:
            chunks = c.execute('SELECT * FROM cloud_chunks WHERE owner=? AND op=? ORDER BY idx', (owner,op)).fetchall()
            if not chunks or len(chunks) != chunks[0]['total'] or [r['idx'] for r in chunks] != list(range(len(chunks))):
                raise ValueError('sync_incomplete_chunks')
            value = json.loads(''.join(open_text(r['body'],[owner,op,r['idx']]) for r in chunks))
        if not deleted:
            value = sanitize(store,value)
            if value.get('name' if store=='categories' else 'id') != mid:
                raise ValueError('sync_id_mismatch')
        text = packed(value)
        if len(text.encode()) > (MAX_MEDIA if store=='ibMedia' else MAX_RECORD):
            raise ValueError('sync_record_too_large')
        h = hashlib.sha256(text.encode()).hexdigest()
        req_hash = hashlib.sha256(packed([store,mid,base,deleted,h]).encode()).hexdigest()
        receipt = c.execute('SELECT * FROM cloud_receipts WHERE owner=? AND op=?', (owner,op)).fetchone()
        if receipt:
            if receipt['request_hash'] != req_hash:
                raise ValueError('sync_operation_changed')
            replay = json.loads(receipt['result'])
            if replay['conflict']:
                current = c.execute('SELECT * FROM cloud_records WHERE owner=? AND store=? AND id=?', (owner,store,mid)).fetchone()
                if current:
                    replay['record'] = meta(current)
            return replay
        row = c.execute('SELECT * FROM cloud_records WHERE owner=? AND store=? AND id=?', (owner,store,mid)).fetchone()
        version = row['version'] if row else 0
        # Equal content is a replay, never permission to overwrite a newer version.
        same = row and row['hash'] == h and bool(row['deleted']) == deleted
        if base != version and not same:
            result = {'ok':True, 'conflict':True, 'record':meta(row) if row else
                      {'store':store,'id':mid,'version':0,'deleted':True}}
        elif same:
            result = {'ok':True, 'conflict':False, 'record':meta(row)}
        else:
            version = c.execute('UPDATE cloud_clock SET version=version+1 WHERE owner=? RETURNING version', (owner,)).fetchone()[0]
            old_value = json.loads(record_text(c,row,owner,store,mid)) if row and not row['deleted'] else None
            payload = store_payload(c,text,owner,store,mid,version)
            c.execute('INSERT INTO cloud_records VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,store,id) DO UPDATE SET '
                      'version=excluded.version,deleted=excluded.deleted,body=excluded.body,hash=excluded.hash',
                      (owner,store,mid,version,int(deleted),payload,h))
            if store == 'chatMessages':
                invalidate(c, old_value, value)
            result = {'ok':True, 'conflict':False,
                      'record':{'store':store,'id':mid,'version':version,'deleted':deleted}}
        c.execute('INSERT INTO cloud_receipts VALUES(?,?,?,?)', (owner,op,req_hash,packed(result)))
        # Retain staged input for 48h: a lost response can safely replay the same op.
        return result
    if route == 'sync/pull':
        cursor = number(body.get('cursor',0))
        rows = c.execute('SELECT store,id,version,deleted FROM cloud_records WHERE owner=? AND version>? '
                         'ORDER BY version LIMIT 100', (owner,cursor)).fetchall()
        return {'ok':True, 'records':[meta(r) for r in rows],
                'cursor':rows[-1]['version'] if rows else cursor, 'more':len(rows)==100}
    if route == 'sync/read':
        store, mid = key(body); version = number(body.get('version')); offset = number(body.get('offset',0),MAX_MEDIA)
        row = c.execute('SELECT body,version,deleted FROM cloud_records WHERE owner=? AND store=? AND id=?', (owner,store,mid)).fetchone()
        if not row or row['version'] != version:
            return {'ok':True, 'changed':True}
        if row['body'].startswith('parts1:'):
            length=int(row['body'][7:]);idx=offset//196608
            value=c.execute('SELECT body FROM cloud_payload_parts WHERE owner=? AND store=? AND id=? AND version=? AND idx=?',
                            (owner,store,mid,version,idx)).fetchone()
            if not value or offset%196608:
                raise ValueError('sync_invalid_payload_offset')
            part=open_text(value['body'],[owner,store,mid,version,idx])
            return {'ok':True,'changed':False,'text':part,'next':offset+len(part),'done':offset+len(part)>=length}
        text = open_text(row['body'],[owner,store,mid]); part = text[offset:offset+196608]
        return {'ok':True, 'changed':False, 'text':part, 'next':offset+len(part), 'done':offset+len(part)>=len(text)}
    raise ValueError('not_found')
