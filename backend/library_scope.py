"""Server-resolved library identity; context-local across concurrent HTTP requests."""
from contextvars import ContextVar
from contextlib import contextmanager

_principal = ContextVar('ib_memory_principal', default=None)

def current():
    value = _principal.get()
    if not value:
        raise ValueError('memory_binding_missing')
    return value

@contextmanager
def use(value):
    token = _principal.set(value)
    try:
        yield
    finally:
        _principal.reset(token)

def init(c):
    c.executescript('''
    CREATE TABLE IF NOT EXISTS library_scope_map(scope TEXT PRIMARY KEY,principal TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS library_source_clock(principal TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO library_scope_map SELECT scope,'changchuan' FROM scopes;
    INSERT OR IGNORE INTO library_scope_map SELECT DISTINCT scope,'changchuan' FROM messages;
    INSERT OR IGNORE INTO library_source_clock VALUES('changchuan',0);
    ''')
    if 'principal' not in {r['name'] for r in c.execute('PRAGMA table_info(bindings)')}:
        c.execute("ALTER TABLE bindings ADD COLUMN principal TEXT NOT NULL DEFAULT 'changchuan'")
    if 'principal' not in {r['name'] for r in c.execute('PRAGMA table_info(manual_memory_jobs)')}:
        c.execute("ALTER TABLE manual_memory_jobs ADD COLUMN principal TEXT NOT NULL DEFAULT 'changchuan'")
    for action in ('insert','update','delete'):
        ref='OLD' if action=='delete' else 'NEW'
        c.execute('DROP TRIGGER IF EXISTS source_barrier_'+action)
        c.execute(f'''CREATE TRIGGER source_barrier_{action} AFTER {action.upper()} ON source_barriers
          BEGIN UPDATE source_clock SET revision=revision+1 WHERE id=1;
          INSERT INTO library_source_clock(principal,revision)
            SELECT principal,1 FROM library_scope_map WHERE scope={ref}.scope
            ON CONFLICT(principal) DO UPDATE SET revision=revision+1; END''')

def attach(c, scope, principal):
    c.execute('INSERT OR IGNORE INTO library_scope_map VALUES(?,?)',(scope,principal))
    row=c.execute('SELECT principal FROM library_scope_map WHERE scope=?',(scope,)).fetchone()
    if row['principal']!=principal:
        raise ValueError('memory_binding_changed')
    c.execute('INSERT OR IGNORE INTO library_source_clock VALUES(?,0)',(principal,))
