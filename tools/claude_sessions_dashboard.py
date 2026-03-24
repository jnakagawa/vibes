#!/usr/bin/env python3
"""Claude Sessions Dashboard — zero-dependency local web UI for browsing resumable sessions."""

import json
import os
import re
import sys
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

PROJECTS_DIR = Path.home() / ".claude" / "projects"
DEFAULT_PORT = 8484
HEAD_BYTES = 8192  # first 8KB — enough for metadata + first prompt
TAIL_BYTES = 4096  # last 4KB — summaries, titles, tags written at end


def _extract_text(content):
    """Pull plain text from message content (string or content-block list)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(parts)
    return str(content)


def _grep_json_value(text, key):
    """Fast regex extract of a JSON string value by key name (no full parse)."""
    m = re.search(rf'"{key}"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    return m.group(1) if m else None


def _head_tail(path, size):
    """Read the first HEAD_BYTES and last TAIL_BYTES of a file."""
    with open(path, "rb") as f:
        head = f.read(HEAD_BYTES).decode("utf-8", errors="replace")
        if size > HEAD_BYTES + TAIL_BYTES:
            f.seek(-TAIL_BYTES, 2)
            tail = f.read().decode("utf-8", errors="replace")
        elif size > HEAD_BYTES:
            tail = head  # small file — head covers it all
        else:
            tail = head
    return head, tail


def _extract_first_prompt(head):
    """Get the first user prompt text from the head bytes (regex, no full parse)."""
    # Find first non-meta user message and extract its content text
    # Look for "type":"user" lines that don't have "isMeta":true
    for line in head.split("\n"):
        if '"type":"user"' not in line and '"type": "user"' not in line:
            continue
        if '"isMeta":true' in line or '"isMeta": true' in line:
            continue
        # Try to extract content text
        text = _grep_json_value(line, "text")
        if text:
            return text[:200]
        content = _grep_json_value(line, "content")
        if content:
            return content[:200]
    return ""


def scan_sessions():
    """Discover all sessions from JSONL files on disk using head+tail reads.
    Mirrors Claude's internal lite scan approach — stat + partial reads only."""
    if not PROJECTS_DIR.is_dir():
        return []

    sessions = []
    for project_dir in PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        project_dir_name = project_dir.name
        for jsonl in project_dir.iterdir():
            if not jsonl.name.endswith(".jsonl") or not jsonl.is_file():
                continue
            try:
                st = jsonl.stat()
                size = st.st_size
                if size < 50:
                    continue
                sid = jsonl.stem
                head, tail = _head_tail(jsonl, size)

                # Skip sidechains
                if '"isSidechain":true' in head or '"isSidechain": true' in head:
                    continue

                first_prompt = _extract_first_prompt(head)
                project_path = _grep_json_value(head, "cwd") or ""
                git_branch = _grep_json_value(tail, "gitBranch") or _grep_json_value(head, "gitBranch") or ""
                summary = _grep_json_value(tail, "summary") or ""
                custom_title = _grep_json_value(tail, "customTitle") or ""

                # Skip sessions with no real content
                if not first_prompt and not summary and not custom_title:
                    continue

                project_name = os.path.basename(project_path) if project_path else project_dir_name

                sessions.append({
                    "sessionId": sid,
                    "projectName": project_name,
                    "projectPath": project_path,
                    "gitBranch": git_branch,
                    "firstPrompt": first_prompt,
                    "summary": summary,
                    "customTitle": custom_title,
                    "mtime": st.st_mtime,
                    "ctime": st.st_birthtime if hasattr(st, "st_birthtime") else st.st_ctime,
                    "size": size,
                })
            except Exception:
                continue

    sessions.sort(key=lambda s: s["mtime"], reverse=True)
    return sessions


def read_session_messages(session_id):
    """Read the JSONL file for a session and extract human-readable messages."""
    for jsonl in PROJECTS_DIR.glob(f"*/{session_id}.jsonl"):
        messages = []
        try:
            with open(jsonl) as f:
                for line in f:
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    msg_type = obj.get("type")
                    if msg_type == "user" and not obj.get("isMeta"):
                        content = obj.get("message", {}).get("content", "")
                        text = _extract_text(content)
                        if text.strip():
                            messages.append({"role": "user", "text": text})
                    elif msg_type == "assistant":
                        content = obj.get("message", {}).get("content", [])
                        text = _extract_text(content)
                        if text.strip() and text != "(no content)":
                            messages.append({"role": "assistant", "text": text})
        except Exception:
            pass
        return messages
    return []


DASHBOARD_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Sessions</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--surface:#161b22;--border:#30363d;
  --text:#e6edf3;--dim:#8b949e;--accent:#58a6ff;
  --green:#3fb950;--red:#f85149;--row-hover:#1c2128;
  --user-bg:#1a2233;--asst-bg:#121820;
}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;height:100vh;overflow:hidden;display:flex;flex-direction:column}

.header{padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap;flex-shrink:0}
.header h1{font-size:15px;font-weight:600;white-space:nowrap;font-family:'SF Mono',SFMono-Regular,Consolas,monospace}
.status{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0}
.status.ok{background:var(--green)}.status.err{background:var(--red)}
.controls{display:flex;gap:8px;flex:1;min-width:0;flex-wrap:wrap;align-items:center}
input[type=text],select{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:12px;outline:none;font-family:inherit}
input[type=text]{flex:1;min-width:160px}
input[type=text]:focus,select:focus{border-color:var(--accent)}
select{min-width:130px}
.count{color:var(--dim);font-size:11px;white-space:nowrap}
.hide-sc label{color:var(--dim);font-size:12px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:4px}

.main{flex:1;display:flex;overflow:hidden}

.list-pane{width:420px;min-width:320px;max-width:500px;border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0}
.row{padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s}
.row:hover{background:var(--row-hover)}
.row.active{background:var(--row-hover);border-left:3px solid var(--accent);padding-left:13px}
.row-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:2px}
.row-project{color:var(--accent);font-weight:600;font-size:12px}
.row-time{color:var(--dim);font-size:11px;white-space:nowrap}
.row-summary{font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.row-meta{display:flex;gap:10px;color:var(--dim);font-size:11px;align-items:center}
.branch-tag{font-size:10px;background:#1c2128;padding:0 5px;border-radius:3px;color:var(--dim)}

.preview-pane{flex:1;display:flex;flex-direction:column;overflow:hidden}
.preview-header{padding:12px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;gap:10px}
.preview-title{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.preview-actions{display:flex;gap:8px;flex-shrink:0;align-items:center}
.btn{background:var(--accent);color:#0d1117;border:none;border-radius:5px;padding:5px 12px;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;transition:opacity .15s}
.btn:hover{opacity:.85}
.btn.copied{background:var(--green)}

.preview-body{flex:1;overflow-y:auto;padding:0}
.empty-preview{display:flex;align-items:center;justify-content:center;height:100%;color:var(--dim);font-size:14px}

.msg-group{padding:12px 20px;border-bottom:1px solid var(--border)}
.msg-group.user{background:var(--user-bg)}
.msg-group.assistant{background:var(--asst-bg)}
.msg-role{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.msg-role.user{color:var(--accent)}
.msg-role.assistant{color:var(--green)}
.msg-text{font-family:'SF Mono',SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--text)}
.msg-divider{text-align:center;padding:8px 20px;color:var(--dim);font-size:11px;border-bottom:1px solid var(--border);background:var(--bg);cursor:pointer}
.msg-divider:hover{color:var(--accent)}
.preview-info{padding:12px 20px;border-bottom:1px solid var(--border);display:flex;gap:16px;color:var(--dim);font-size:12px;flex-wrap:wrap;flex-shrink:0}
</style>
</head>
<body>
<div class="header">
  <span class="status" id="status"></span>
  <h1>Claude Sessions</h1>
  <div class="controls">
    <input type="text" id="search" placeholder="Search sessions...">
    <select id="projectFilter"><option value="">All projects</option></select>
  </div>
  <span class="count" id="count"></span>
</div>
<div class="main">
  <div class="list-pane" id="listPane"></div>
  <div class="preview-pane" id="previewPane">
    <div class="empty-preview">Hover over a session to preview</div>
  </div>
</div>

<script>
let allSessions = [];
let activeId = null;
let hoveredId = null;
let displayedId = null;
let msgCache = {};
let expandedFull = {};

const listPane = document.getElementById('listPane');
const previewPane = document.getElementById('previewPane');
const search = document.getElementById('search');
const projectFilter = document.getElementById('projectFilter');
const statusDot = document.getElementById('status');
const countEl = document.getElementById('count');

function relTime(ts) {
  if (!ts) return '';
  let ms = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : new Date(ts).getTime();
  const diff = (Date.now() - ms) / 1000;
  if (diff < 0) return 'just now';
  if (diff < 60) return Math.floor(diff) + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString();
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function displayName(s) {
  return s.customTitle || s.summary || s.firstPrompt || s.sessionId.slice(0, 8);
}

function renderList() {
  const q = search.value.toLowerCase();
  const proj = projectFilter.value;
  const filtered = allSessions.filter(s => {
    if (proj && s.projectName !== proj) return false;
    if (q) {
      const hay = [s.summary||'', s.customTitle||'', s.firstPrompt||'', s.projectName||'', s.gitBranch||''].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  countEl.textContent = filtered.length + ' / ' + allSessions.length;
  listPane.innerHTML = filtered.map(s => {
    const isActive = s.sessionId === (activeId || hoveredId);
    return `<div class="row${isActive ? ' active' : ''}" data-sid="${s.sessionId}"
                 onmouseenter="onRowHover('${s.sessionId}')"
                 onclick="onRowClick('${s.sessionId}')">
      <div class="row-top">
        <span class="row-project">${esc(s.projectName)}</span>
        <span class="row-time">${relTime(s.mtime)}</span>
      </div>
      <div class="row-summary">${esc(displayName(s))}</div>
      <div class="row-meta">
        ${s.gitBranch ? '<span class="branch-tag">' + esc(s.gitBranch) + '</span>' : ''}
        <span>${(s.size / 1024).toFixed(0)} KB</span>
      </div>
    </div>`;
  }).join('');
}

function showPreview(sessionId) {
  if (!sessionId) {
    previewPane.innerHTML = '<div class="empty-preview">Hover over a session to preview</div>';
    displayedId = null;
    return;
  }
  if (sessionId === displayedId) return;
  displayedId = sessionId;

  const s = allSessions.find(x => x.sessionId === sessionId);
  if (!s) return;

  const cmd = (s.projectPath ? 'cd ' + s.projectPath + ' && ' : '') + 'claude --resume ' + s.sessionId;
  const cmdEsc = cmd.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

  previewPane.innerHTML = `
    <div class="preview-header">
      <span class="preview-title">${esc(displayName(s))}</span>
      <div class="preview-actions">
        <button class="btn" onclick="copyCmd(this, \`${cmdEsc}\`)">Copy resume cmd</button>
      </div>
    </div>
    <div class="preview-info">
      <span>${esc(s.projectName)}</span>
      ${s.gitBranch ? '<span>branch: ' + esc(s.gitBranch) + '</span>' : ''}
      <span>modified ${relTime(s.mtime)}</span>
      <span>created ${relTime(s.ctime)}</span>
      <span>${(s.size / 1024).toFixed(0)} KB</span>
    </div>
    <div class="preview-body" id="previewBody">
      <div class="empty-preview" style="height:200px">Loading messages...</div>
    </div>`;

  if (msgCache[sessionId]) {
    renderMessages(sessionId, msgCache[sessionId]);
  } else {
    fetch('/api/messages?id=' + sessionId)
      .then(r => r.json())
      .then(msgs => {
        msgCache[sessionId] = msgs;
        if (displayedId === sessionId) renderMessages(sessionId, msgs);
      })
      .catch(() => {
        const body = document.getElementById('previewBody');
        if (body && displayedId === sessionId) body.innerHTML = '<div class="empty-preview">Could not load messages</div>';
      });
  }
}

function renderMessages(sessionId, msgs) {
  const body = document.getElementById('previewBody');
  if (!body) return;
  if (!msgs.length) {
    body.innerHTML = '<div class="empty-preview">No messages in this session</div>';
    return;
  }

  const PEEK = 3;
  const full = expandedFull[sessionId];
  const needsCollapse = msgs.length > PEEK * 2 + 1 && !full;

  let toShow;
  if (needsCollapse) {
    const hiddenCount = msgs.length - PEEK * 2;
    toShow = [
      ...msgs.slice(0, PEEK),
      { _divider: true, count: hiddenCount },
      ...msgs.slice(-PEEK)
    ];
  } else {
    toShow = msgs;
  }

  body.innerHTML = toShow.map(m => {
    if (m._divider) {
      return `<div class="msg-divider" onclick="expandAll('${sessionId}')">
        ${m.count} more messages — click to show all
      </div>`;
    }
    const maxLen = full ? Infinity : 2000;
    const text = m.text.length > maxLen ? m.text.slice(0, maxLen) + '\n... (truncated)' : m.text;
    return `<div class="msg-group ${m.role}">
      <div class="msg-role ${m.role}">${m.role}</div>
      <div class="msg-text">${esc(text)}</div>
    </div>`;
  }).join('');
}

function expandAll(sessionId) {
  expandedFull[sessionId] = true;
  if (msgCache[sessionId]) renderMessages(sessionId, msgCache[sessionId]);
}

let hoverTimer = null;
function onRowHover(sid) {
  if (activeId) return;
  hoveredId = sid;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => showPreview(sid), 80);
  listPane.querySelectorAll('.row').forEach(r => r.classList.toggle('active', r.dataset.sid === sid));
}

function onRowClick(sid) {
  if (activeId === sid) {
    activeId = null;
  } else {
    activeId = sid;
    hoveredId = sid;
    showPreview(sid);
  }
  listPane.querySelectorAll('.row').forEach(r => r.classList.toggle('active', r.dataset.sid === (activeId || hoveredId)));
}

function copyCmd(btn, cmd) {
  navigator.clipboard.writeText(cmd).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy resume cmd'; btn.classList.remove('copied'); }, 1500);
  });
}

function populateProjectFilter() {
  const projects = [...new Set(allSessions.map(s => s.projectName))].sort();
  const cur = projectFilter.value;
  projectFilter.innerHTML = '<option value="">All projects</option>' +
    projects.map(p => `<option value="${esc(p)}"${p === cur ? ' selected' : ''}>${esc(p)}</option>`).join('');
}

async function fetchSessions() {
  try {
    const res = await fetch('/api/sessions');
    allSessions = await res.json();
    statusDot.className = 'status ok';
    populateProjectFilter();
    renderList();
  } catch (e) {
    statusDot.className = 'status err';
  }
}

search.addEventListener('input', renderList);
projectFilter.addEventListener('change', renderList);

listPane.addEventListener('mouseleave', () => {
  if (!activeId) {
    hoveredId = null;
    clearTimeout(hoverTimer);
  }
});

fetchSessions();
setInterval(fetchSessions, 5000);
</script>
</body>
</html>"""


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/sessions":
            self._json_response(scan_sessions())
        elif self.path.startswith("/api/messages"):
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            sid = params.get("id", [""])[0]
            self._json_response(read_session_messages(sid) if sid else [])
        elif self.path in ("/", "/index.html"):
            page = DASHBOARD_HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
        else:
            self.send_error(404)

    def _json_response(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if args and str(args[0]).startswith("4"):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"Claude Sessions Dashboard running at http://localhost:{port}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
