# Claude Code — usage manual for the CEO

## Invoke (headless, full permission)
claude -p "<task prompt>" --dangerously-skip-permissions

## Strengths
- Best-in-class code editing, refactors, multi-file changes
- Strong test debugging and git workflows

## Weaknesses / failure modes
- Requires ANTHROPIC_API_KEY or subscription login; check `claude --version`
- Network filesystems confuse its file watcher — prefer local paths

## When to choose
Any task that edits code: features, bugfixes, refactors, test writing.
