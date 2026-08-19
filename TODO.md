# TODO

## 2026-08-19 描述性文字 "CEO" → "jex" 重命名（已完成 ✅）

- [x] 扫描全部 44 处大写 "CEO"，区分描述性文字 vs 技术命名
- [x] 源码注释/prompt/UI 字符串：ceo-core(skills/auditor/index/loop/orchestrator/toolscout/tentacles)、takeoverd(screen/server)、viewer placeholder
- [x] 文档：readme.md、docs/REQUIREMENTS.md、skills/hermes.md、skills/claude-code.md、.github/workflows/release.yml(发布包 README.txt)
- [x] 保留技术命名：包名 `ceo-core`、二进制 `robojex-ceo`、日志前缀 `[ceo]`、启动横幅 `ceo-core running`
- [x] 验证：`tsc -b` 编译通过；vitest 160/161 通过（1 个失败为改动前即存在的 WSL2 环境性失败：`ws: unreachable takeoverd` 重连时序）

### 命名约定（后续遵循）
- 描述性文字中指代主 agent 用 `jex`（句首英文大写 `Jex`）
- 项目/品牌上下文用 `robojex`
- 代码标识符、包名、二进制名保持 `ceo-core` / `robojex-ceo` 不变
