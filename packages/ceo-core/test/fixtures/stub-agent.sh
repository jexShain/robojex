#!/usr/bin/env bash
# packages/ceo-core/test/fixtures/stub-agent.sh
# Fake sub-agent: prints 300 lines then exits 0.
for i in $(seq 1 300); do echo "line $i: doing fake work"; done
echo "FINAL: stub completed the task successfully"
