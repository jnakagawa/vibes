# Tools

## Claude Sessions Dashboard

A local web UI for browsing your Claude Code session history. Zero dependencies — just Python 3.6+.

### Prerequisites

- Python 3.6+ (pre-installed on macOS and most Linux distros)
- [Claude Code](https://claude.ai/code) installed (the dashboard reads from `~/.claude/projects/`)

### Install & Run

**Option 1: Download and run the script directly**

```bash
curl -O https://raw.githubusercontent.com/jnakagawa/vibes/main/tools/claude_sessions_dashboard.py
python3 claude_sessions_dashboard.py
```

**Option 2: Clone the repo**

```bash
git clone https://github.com/jnakagawa/vibes.git
python3 vibes/tools/claude_sessions_dashboard.py
```

Then open http://localhost:8484 in your browser.

### Custom port

```bash
python3 claude_sessions_dashboard.py 9090
```

### Features

- Search and filter sessions by project, branch, or content
- Preview session messages inline
- Copy `claude --resume` commands to clipboard
- Auto-refreshes every 5 seconds
