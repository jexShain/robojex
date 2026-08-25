# PLAN-VOICE

- [x] T1 `packages/voiced/` 守护：Node + sherpa-onnx-node；/health /asr /tts；懒加载；--port 7640；CORS（渲染层直连 /tts）
- [x] T2 `scripts/download-voice-models.sh`：SenseVoice-small ONNX + Kokoro v1.1 zh（github releases，HF-mirror 兜底，幂等）
- [x] T3 模型落盘 + 冒烟：回环 TTS→ASR 中文“语音联路测试。”/英文"Hello, World test." ✓（zh pin 消除 auto-LD 乱字；scripts/voiced-smoke.sh）
- [x] T4 electron/main.js：Ctrl+Alt+V 按讲（voice pill 窗口→IPC→/asr→POST /api/chat 都在 main 侧，无 CORS/端口泄漏）、Ctrl+Alt+R → sendAction('voice-readback')；media 权限仅对 voice 页放行
- [x] T5 electron/voice.html + preload `voice.{onState,sendClip,event}`；ScriptProcessor 16k mono → PCM16 WAV（零编解码依赖）
- [ ] T6 web 设置：语音汇报开关（新 voice 卡片；localStorage 'robojex-voice-report'；renderer 侦听 jex chat_out → POST voiced /tts → Audio 播放；Ctrl+Alt+R action 同路）+ i18n
- [ ] T7 e2e mock-voiced.mjs + 场景 47/48（按讲到气泡、朗读键激活 audio）+ 全量
- [ ] T8 vitest（voiced 协议单测：wav 解析、health 形状）
- [ ] T9 打包 voice.html 进 electron-builder files；0.2.17 言听计从版落桌面
