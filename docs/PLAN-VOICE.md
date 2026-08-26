# PLAN-VOICE

- [x] T1 `packages/voiced/` 守护：Node + sherpa-onnx-node；/health /asr /tts；懒加载；--port 7640；CORS（渲染层直连 /tts）
- [x] T2 `scripts/download-voice-models.sh`：SenseVoice-small ONNX + Kokoro v1.1 zh（github releases，HF-mirror 兜底，幂等）
- [x] T3 模型落盘 + 冒烟：回环 TTS→ASR 中文“语音联路测试。”/英文"Hello, World test." ✓（zh pin 消除 auto-LD 乱字；scripts/voiced-smoke.sh）
- [x] T4 electron/main.js：Ctrl+Alt+V 按讲（voice pill 窗口→IPC→/asr→POST /api/chat 都在 main 侧，无 CORS/端口泄漏）、Ctrl+Alt+R → sendAction('voice-readback')；media 权限仅对 voice 页放行
- [x] T5 electron/voice.html + preload `voice.{onState,sendClip,event}`；ScriptProcessor 16k mono → PCM16 WAV（零编解码依赖）
- [x] T6 web 设置：语音汇报开关（设置›聊天卡片；localStorage 'robojex-voice-report'；renderer 侦听 jex chat_out 与流结束 → POST voiced /tts → Audio 播放；Ctrl+Alt+R 走 robojex:action 桥 + AppFrame 键盘路径双入口）+ 中英文案；顺手接活 onAction 死线（托盘新对话/挡位）
- [x] T7 e2e mock-voiced.mjs（/tts 记账 + /hits）+ 场景 47（开关即朗读/关即静音）48（Ctrl+Alt+R 手动朗读，pref 无关，相对基线）；全量 e2e 48/48
- [x] T8 vitest：voiced wav 协议 5 用例（header 形状/钳位/回环/LIST 块跳过/坏输入拒绝）；全仓 661/661
- [x] T9 voice.html+voice.js 进 electron-builder files（asar 已核）；0.2.17 言听计从版 portable+Setup 落桌面（commit ad197e0 已推）
- [x] **0.2.18 语音自持版**（commit 2e609b6，含并行会话 review 修复 039ec4f）：voiced Windows sidecar 打包（--models 覆盖 → %APPDATA%/RoboJex/voiced-models、createVoiceHandler 工厂化 + isMain 入口、asarUnpack 原生模块）；跨平台下载器 download-voice-models.mjs（Win10+ bsdtar/curl、hf-mirror 兜底）；main.js ensureVoiced 探活自启 + 设置卡健康行/下载按钮；e2e 场景 49；review 修复：patrol 事件内嵌 ";" 碎片化→原始数组传递（R138c）、all-clear 闸内容感知 isBareAllClear、/tts 200 wav 补 CORS、懒加载失败不楔死、speak blob URL 泄漏清理
