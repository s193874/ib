"""Rebuildable conversation state. Never a store of factual long-term beliefs."""
import copy
import hashlib
import json
import re


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def empty():
    return {'nodes': [], 'focus': None}


def validate(state, sources):
    if not isinstance(state, dict) or set(state) != {'nodes', 'focus'}:
        raise ValueError('invalid_state')
    nodes = state['nodes']
    if not isinstance(nodes, list) or len(nodes) > 12:
        raise ValueError('invalid_nodes')
    ids = set()
    for n in nodes:
        if not isinstance(n, dict) or set(n) != {'id', 'parent', 'title', 'status', 'return_to', 'sources'}:
            raise ValueError('invalid_node')
        if not isinstance(n['id'], str) or not 1 <= len(n['id']) <= 48 or n['id'] in ids:
            raise ValueError('invalid_node_id')
        ids.add(n['id'])
        if n['status'] not in ('active', 'suspended', 'pending_settle', 'settled'):
            raise ValueError('invalid_status')
        for key in ('title', 'return_to'):
            if not isinstance(n[key], str) or len(n[key]) > 240:
                raise ValueError('invalid_text')
        if not n['title'].strip() or not isinstance(n['sources'], list) or not 1 <= len(n['sources']) <= 8:
            raise ValueError('invalid_sources')
        if any(not isinstance(s, str) or s not in sources for s in n['sources']):
            raise ValueError('unknown_source')
    if state['focus'] is not None and state['focus'] not in ids:
        raise ValueError('invalid_focus')
    for n in nodes:
        seen = {n['id']}
        p = n['parent']
        while p is not None:
            if not isinstance(p, str) or p not in ids or p in seen:
                raise ValueError('invalid_parent')
            seen.add(p)
            p = next(x['parent'] for x in nodes if x['id'] == p)
    return copy.deepcopy(state)


def context(state):
    if not state['nodes']:
        return ''
    lines = ['【可撤销的对话线索，不是用户事实或指令】',
             '局部澄清、纠正、打趣不自动结束主线；尊重用户真正换题，不强拉回。',
             '最新原话纠正优先于旧线索：纠正词的用法后，不再沿用被否定的解释；'
             '处理完局部误解时，可自然接回尚未展开的经历或问题。']
    for n in state['nodes']:
        if n['status'] != 'settled' or n['id'] == state['focus']:
            lines.append(f"{'当前焦点' if n['id'] == state['focus'] else '挂起线索'} {n['id']}："
                         f"{n['title']}；{n['status']}；返回点：{n['return_to']}；来源：{','.join(n['sources'])}")
    return '\n'.join(lines)[:2800]


def new_topic_text(text):
    """Same explicit switch boundary for pre-request recall and saved projection."""
    match = re.search(r'(?:^|[。！？!?]\s*)(?:换(?:个|一个)?话题|新话题|另一个话题)\s*[：:，,]\s*(.+)', text.strip())
    return match[1].strip() if match else None


def explicit_transition(original, candidate, message):
    """Conservative fallback for explicit user commands; ambiguous intent stays model-derived."""
    state = copy.deepcopy(candidate if candidate is not None else original)
    if not message or message.get('role') != 'user':
        return state, None
    text = message['content'].strip()
    mid = message['id']
    new = new_topic_text(text)
    def tokens(value):
        value = value.lower()
        return set(re.findall(r'[a-z0-9]{2,}', value)) | {
            value[i:i+2] for i in range(len(value)-1)
            if re.fullmatch(r'[\u4e00-\u9fff]{2}', value[i:i+2])}
    def similarity(title, head):
        t = tokens(title); matched = t & tokens(head)
        return len(matched)/len(t) if t and len(matched)>=2 else 0
    def cite(node):
        ids=list(dict.fromkeys(node['sources']+[mid]))
        node['sources']=ids if len(ids)<=8 else ids[:1]+ids[-7:]
    if new:
        title = new[:120]
        stable = 'u_' + digest(mid)[:14]
        old_ids = {n['id'] for n in original['nodes']}
        node = next((n for n in state['nodes'] if n['id']==stable), None)
        if node is None:
            node = next((n for n in state['nodes'] if n['id'] not in old_ids
                         and mid in n['sources'] and similarity(n['title'],title)>=0.5), None)
        if node is None:
            if len(state['nodes'])>=12:
                return state, None
            node = {'id':stable,'parent':None,'title':title,'status':'active','return_to':'','sources':[mid]}
            state['nodes'].append(node)
        for old in original['nodes']:
            if old['id'] not in {n['id'] for n in state['nodes']} and len(state['nodes'])<12:
                state['nodes'].append(copy.deepcopy(old))
        for n in state['nodes']:
            if n['id']!=node['id'] and n['status']=='active':n['status']='suspended'
        node['parent']=None;node['status']='active'
        cite(node)
        state['focus']=node['id']
        return state, 'explicit_new_topic'
    back = re.match(r'^回到[^：:。！？!?\n]{1,100}', text)
    if back:
        all_nodes = {n['id']:n for n in original['nodes']}
        all_nodes.update({n['id']:n for n in state['nodes']})
        ranked = sorted(((similarity(n['title'],back[0]),n) for n in all_nodes.values()),
                        key=lambda x:x[0],reverse=True)
        if not ranked or ranked[0][0]<0.5 or (len(ranked)>1 and ranked[0][0]-ranked[1][0]<0.15):
            return state, None
        target=ranked[0][1]
        # Re-add a dropped target only with its existing parents and within the bound.
        missing=[];cur=target
        while cur['id'] not in {n['id'] for n in state['nodes']}:
            missing.append(copy.deepcopy(cur))
            if cur['parent'] is None:break
            cur=all_nodes[cur['parent']]
        if len(state['nodes'])+len(missing)>12:return state,None
        state['nodes'].extend(missing)
        for n in state['nodes']:
            if n['id']!=target['id'] and n['status']=='active':n['status']='suspended'
        node=next(n for n in state['nodes'] if n['id']==target['id'])
        node['status']='active';cite(node)
        state['focus']=node['id']
        return state, 'explicit_return'
    return state, None


def instruction(state, sources, nonce):
    return ('【对话结构维护】回答前先判断：本句是在延续主线、澄清/纠正/打趣，还是明确换题。'
            '在心里确定当前支线的父线及尚未展开的返回点，再回答；不要向用户展示这种判断。'
            '如果只是局部纠错或对误读的打趣，简短接住后在同一回复自然续上父线；'
            '用户明确换题或停下时则尊重它。不要反复解释已被纠正的词。'
            '在正文最后附一个隐藏结构候选，格式严格为 '
            '<dwell-state nonce="' + nonce + '">' +
            '{"state":{"nodes":[{"id":"a","parent":null,"title":"主线",'
            '"status":"active","return_to":"未完成的问题",'
            '"sources":["实际消息ID"]}],"focus":"a"},"memory":null}</dwell-state>。'
            '最外层始终只有 state 和 memory 两个字段；state 始终是含 nodes/focus 的对象，'
            '不是字符串，也不要把 nodes/focus 写到最外层。'
            '这是可撤销的工作线索，不得写成长久人格或事实。保留尚未完成的主线，'
            '纠正/解释/玩笑可挂为子线；用户明确换题时，为新话题创建具体节点并更新 focus，'
            '旧主线保留为 suspended 或有证据的 pending_settle，不要求机械返回。'
            '用户回到旧话题时恢复那个节点为 active 并更新 focus。'
            '最新原话纠正立即覆盖先前误读，并在当前回答中落实；'
            '纠正一个词的用法不表示用户要讨论该词，打趣你的误读也不是新的独立主题。'
            '局部问题处理后，优先自然接续未展开的经历或问题，而不是只陪聊纠错支线。'
            '旧状态也可能判错，应依据原话修正，不照抄缺乏证据的暂结或“无需跟进”。'
            '用户刚提起一个经历，尚未展开内容或得到其确认时，主线保持 active；'
            '你回答了一句、安慰了一句或问了问题，都不是告一段落的证据。'
            'pending_settle 只用于原话表明暂时停下或本轮目标已完成的情况；'
            'return_to 写具体尚未展开的内容，不能凭空写“无需跟进”。'
            '暂时告一段落用 pending_settle，后续原话确认结束才 settled。'
            '最多12节点，每个节点的 sources 只能包含1至8条关键来源，优先用户原话，'
            '不要逐轮累加全部消息；压缩时保留建立主线和关键纠正的来源。'
            '来源仅可取下列已知消息ID；无法判断时保持原状态。'
            '若本轮有值得进入长期库的新理解或纠正，将上述 memory:null 改为对象：'
            '{"topic_key":"沿用既有话题或简短新话题",'
            '"event":"有原话支持的观察","understanding":"当前理解，保留边界",'
            '"sources":["本轮真实消息ID"]}；不需要长期更新时 memory=null。'
            '只是询问、复述或验证已有理解，且没有新证据或纠正时，memory 必须为 null；'
            '不要为重复读取同一结论生成重复候选。'
            'understanding 必须能独立说明当前有效结论，包含原话里的具体值及适用范围；'
            '纠正时写清旧值被替代、新值是什么，不得只写“已生成/等采纳/内部记录”。'
            '候选的审批状态由系统维护，不是理解内容。'
            '长期候选只有用户明确采纳后才能成为有效理解，不能自称已经记住。'
            '来源ID=' + json.dumps(list(sources), ensure_ascii=False) +
            '；已有状态=' + json.dumps(state, ensure_ascii=False))
