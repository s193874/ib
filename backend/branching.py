"""Authenticated, atomic conversation snapshots. Inherited text is not new Raw."""
import copy
import json
import re
import time
import uuid
import cloud_sync
from continuity import digest

MAX_MESSAGES = 2000
MAX_BYTES = 64 * 1024 * 1024


def init(c):
    c.executescript('''
    CREATE TABLE IF NOT EXISTS ib_branch_jobs(owner INTEGER,request_id TEXT,
        request_hash TEXT,thread_id TEXT,created REAL,PRIMARY KEY(owner,request_id));
    CREATE TABLE IF NOT EXISTS ib_branch_copies(scope TEXT,id TEXT,source_fid TEXT,
        source_tid TEXT,source_id TEXT,source_hash TEXT,PRIMARY KEY(scope,id));
    ''')


def reference(c, scope, mid):
    return c.execute('SELECT 1 FROM ib_branch_copies WHERE scope=? AND id=?', (scope, mid)).fetchone() is not None


def read(c, owner, store, mid):
    row = c.execute('SELECT body,version,deleted FROM cloud_records WHERE owner=? AND store=? AND id=?',
                    (owner, store, mid)).fetchone()
    if not row or row['deleted']:
        return None
    return json.loads(cloud_sync.record_text(c, row, owner, store, mid))


def result(c, owner, tid):
    thread = read(c, owner, 'chatThreads', tid)
    if not thread:
        raise ValueError('branch_already_deleted')
    return {'ok': True, 'thread': thread, 'copied_count': thread['branch']['copied_count']}


def create(c, owner, fid, source_tid, body, stamp, invalidate):
    allowed = {'friend_id', 'thread_id', 'request_id', 'target_id', 'prefix_hash',
               'seal_timestamp', 'name', 'memory_enabled'}
    if set(body) != allowed:
        raise ValueError('invalid_branch_request')
    rid = body['request_id']
    try:
        if not isinstance(rid, str) or str(uuid.UUID(rid)) != rid:
            raise ValueError()
    except (ValueError, AttributeError):
        raise ValueError('invalid_branch_request_id')
    name = body['name']
    target = body['target_id']
    if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 24 or
            not isinstance(target, str) or not 1 <= len(target) <= 150 or
            not isinstance(body['prefix_hash'], str) or not re.fullmatch('[a-f0-9]{64}', body['prefix_hash']) or
            type(body['memory_enabled']) is not bool or type(body['seal_timestamp']) not in (int, float) or
            not 0 <= body['seal_timestamp'] < 32503680000000):
        raise ValueError('invalid_branch_request')
    request_hash = digest(body)
    previous = c.execute('SELECT * FROM ib_branch_jobs WHERE owner=? AND request_id=?', (owner, rid)).fetchone()
    if previous:
        if previous['request_hash'] != request_hash:
            raise ValueError('branch_request_changed')
        return result(c, owner, previous['thread_id'])
    cfg = read(c, owner, 'apiConfigs', fid)
    parent = read(c, owner, 'chatThreads', source_tid) if source_tid else cfg
    if not cfg or fid.startswith('group_') or not parent or (source_tid and parent.get('friendId') != fid):
        raise ValueError('branch_source_unavailable')
    seal = parent.get('sealTimestamp') or 0
    if seal != body['seal_timestamp']:
        raise ValueError('branch_source_changed')
    messages = []
    for row in c.execute("SELECT id,body,version,deleted FROM cloud_records WHERE owner=? AND store='chatMessages' AND deleted=0", (owner,)):
        message = json.loads(cloud_sync.record_text(c, row, owner, 'chatMessages', row['id']))
        if (message.get('friendId') == fid and str(message.get('threadId') or '') == source_tid and
                message.get('role') in ('user', 'assistant') and not message.get('generation_error') and
                not message.get('callFold') and not message.get('mark') and message.get('timestamp', 0) > seal):
            messages.append(message)
    messages.sort(key=lambda m: (m['timestamp'], m['id']))
    position = next((i for i, message in enumerate(messages) if message['id'] == target), None)
    if position is None:
        raise ValueError('branch_source_unavailable')
    prefix = messages[:position + 1]
    if len(prefix) > MAX_MESSAGES:
        raise ValueError('branch_history_too_large')
    proofs = [[message['id'], digest(stamp(message))] for message in prefix]
    if digest(proofs) != body['prefix_hash']:
        raise ValueError('branch_source_changed')
    now = int(time.time() * 1000)
    tid = 'thread_branch_' + rid
    scope = digest([owner, fid, tid])
    thread = {'id': tid, 'friendId': fid, 'name': name.strip(), 'created': now,
              'kind': 'branch', 'memoryEnabled': body['memory_enabled'], 'quiet': bool(parent.get('quiet')),
              'sealTimestamp': seal, 'branch': {'version': 1, 'source_friend_id': fid,
                  'source_thread_id': source_tid, 'source_name': parent.get('name') or '主线',
                  'target_message_id': target, 'target_timestamp': prefix[-1]['timestamp'],
                  'created_at': now, 'copied_count': len(prefix), 'request_id': rid}}
    copies = []
    size = 0
    for index, original in enumerate(prefix):
        message = copy.deepcopy(original)
        mid = 'msg_' + str(int(original['timestamp'])) + '_branch_' + f'{index:06d}_' + rid
        message.update(id=mid, threadId=tid, branch_copy={'version': 1,
            'source_friend_id': fid, 'source_thread_id': source_tid, 'source_message_id': original['id'],
            'source_hash': proofs[index][1], 'copied_at': now})
        # Past request receipts and tool results retain their original identity.
        # They are displayed read-only and never fed or executed as new results.
        for field in ('dwell', 'dwell_calls', 'regeneration_versions', 'output_attempts', 'usage'):
            if field in message:
                message.setdefault('branch_original_metadata', {})[field] = message.pop(field)
        message.pop('truncated', None)
        for tool in message.get('wsResults') or []:
            if isinstance(tool, dict):
                tool.update(running=False, pendingConfirm=False, fed=True, branch_readonly=True)
        size += len(cloud_sync.packed(message).encode())
        if size > MAX_BYTES:
            raise ValueError('branch_history_too_large')
        copies.append(message)
    def push(store, value, index):
        response = cloud_sync.handle(c, owner, 'sync/push', {'store': store, 'id': value['id'], 'base': 0,
            'deleted': False, 'value': value, 'op': 'branch_' + rid + '_' + str(index), 'client_version': 3}, invalidate)
        if response['conflict']:
            raise ValueError('branch_identity_conflict')
    # Publish messages first and the visible channel last, within the same SQLite
    # transaction; other clients never discover a half-created branch channel.
    for index, message in enumerate(copies):
        c.execute('INSERT INTO ib_branch_copies VALUES(?,?,?,?,?,?)',
                  (scope, message['id'], fid, source_tid, prefix[index]['id'], proofs[index][1]))
        push('chatMessages', message, index)
    push('chatThreads', thread, len(copies))
    c.execute('INSERT INTO ib_branch_jobs VALUES(?,?,?,?,?)', (owner, rid, request_hash, tid, time.time()))
    return {'ok': True, 'thread': thread, 'copied_count': len(copies)}
