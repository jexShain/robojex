# Hermes Agent — usage manual for jex

## Invoke (headless, full permission)
hermes -p "<task prompt>" --yolo

## Strengths
- Multi-platform automation (telegram/discord/slack delivery), cron scheduling
- Kanban task graphs with goal-judge + quality gates
- 200+ tools, skills library, memory system

## Weaknesses / failure modes
- First run needs `hermes setup` (interactive) — verify with `hermes --version`
- Webhook/cron features need the gateway daemon, avoid in one-shot mode
- Output can be verbose; rely on the tail, not the head

## When to choose
Platform delivery, scheduled jobs, research with web search, long tool chains.
