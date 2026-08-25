# SPEC-VOICE — 语音接入（ASR + TTS，全本地开源）

> 2026-08-25 · 目标：快捷键对 RoboJex 口述任务 + 语音汇报回复。全开源、本地部署、零云依赖。

## 调研结论（2026-08 视角，近月横评 + 各家发布）

### ASR（中文优先）
| 模型 | 组织 | 强项 | 规格 | 许可 | 结论 |
|---|---|---|---|---|---|
| **SenseVoice-small** | 阿里 FunAudioLLM | zh/en/ja/ko + ITN + 标点，速度 15× Whisper-large | ONNX ~230MB，CPU 实时 | Apache-2.0 | **V1 落地**（sherpa-onnx） |
| Qwen3-ASR 0.6B/1.7B | 阿里通义 2026-01 | 30 语种/22 中文方言、流式、歌声 | 1.7B，GPU 友好 | 免费商用 | 质量层升级路径 |
| FireRedASR v2 | 小红书 | 中文精度王（WER≈3.76%），VAD/标点一体 | FunASR 可调 | Apache-2.0 | 质量层备选 |
| Voxtral-Mini-3B | Mistral | 语音转写+摘要问答 | 3B | Apache-2.0 | 英语向，zh 弱 |
| Whisper large-v3 / faster-whisper | OpenAI | 通用多语 | 1.5B | MIT | zh 不敌上述 |

### TTS（短句汇报：延迟 > 拟人度 > 克隆）
| 模型 | 强项 | 规格 | 结论 |
|---|---|---|---|
| **Kokoro v1.1 zh** | 82M 超轻，CPU RTF≈0.05，中文自然 | ONNX ~300MB | **V1 落地**（sherpa-onnx） |
| Fun-CosyVoice3-0.5B-2512 | 多语/18 方言、拟人度更高 | 0.5B + 生态栈 | 质量层 |
| IndexTTS2 | B 站，中文表现顶级 | torch 栈 | 质量层 |
| F5-TTS | 2 秒参考音克隆 | torch 栈 | 克隆场景 |
| VibeVoice / Higgs Audio V2 | 长文档朗读 | 大 | 非本场景 |

**选型理由**：单 sherpa-onnx 运行时同时跑 ASR+TTS（零 python/torch 栈、WSL 稳、秒级冷启、Node 原生绑定），RTX 4060 Ti 16GB 留给质量层按需升级。

## 架构

```
[Electron main] --globalShortcut--> [hidden recorder window]
      │  Ctrl+Alt+V 按讲/再按止          navigator.mediaDevices 16k mono
      │  Ctrl+Alt+R 朗读最新回复          → WAV blob → IPC → main
      ▼                                    │
[voiced :7640]  POST /asr (wav)→{text}     │ POST
      │         POST /tts ({text})→wav    ▼
      ▼                              POST /api/chat {text}
[SenseVoice-small ONNX]                 → ceo-core 广播 chat_out(user/jex)
[Kokoro v1.1 zh ONNX]      ← renderer 侦听 jex chat_out（开关开时）POST /tts → 播放
```

- **packages/voiced/**：Node 守护（sherpa-onnx-node）。`GET /health` `{asr:"sensevoice|loading|idle|down", tts:...}`；`POST /asr`（body=wav 16-bit PCM，回 `{text}`，SenseVoice zh pin + ITN 标点）；`POST /tts`（`{text, sid?}`，回 `audio/wav`）。懒加载模型（首请求加载并常驻）；模型在 `packages/voiced/models/`（gitignored，`scripts/download-voice-models.sh` 从 GitHub releases 下载、HF-mirror 兜底）；CORS 放开（渲染层直连 /tts）。守护常驻 `scripts/voiced-grd.sh start|stop|status`（setsid 免收割）。
- **Electron**：main 持快捷键与录制药丸窗（`voice.html` 静态页打进 electron 包，16k mono ScriptProcessor→PCM16 WAV→IPC）；transcript 经 main 直发 `POST /api/chat`（UI 经既有 chat_out 广播自然显示，无需新 UI 通道）；media 权限仅对 voice 页放行。**实现修正**：Ctrl+Alt+R 与自动汇报都走 renderer（web/src/state/voice.ts fetch /tts→Audio，Electron 默认无手势放行；浏览器同路径可测）——Ctrl+Alt+R 经 robojex:action 桥到 AppFrame（浏览器内同键同效）。汇报开关 localStorage `robojex-voice-report`（web 侧）。
- **失败语义**：voiced 不通 → 药丸显示「语音服务异常」/ console 警告；ASR 空文本 → 「没听清，请再试」；TTS 失败 → 静默降级文字。
- **e2e**：`e2e/mock-voiced.mjs` 桩（/tts 记账 + /hits 断言接口），场景 47（开关即朗读/关即静音）48（Ctrl+Alt+R 手动朗读，pref 无关）——不碰真音频（headless autoplay 必挂）。

## 非目标（V1）
流式边讲边转、说话人克隆、多声线切换、唤醒词。质量层（Qwen3-ASR/CosyVoice3）仅留配置位与文档，不实现。

## 来源
- MarkTechPost 2026-07 开源 ASR 横评 · 腾讯云中文 ASR 六模横评 · 声网 2026-05 TTS 横评 · Qwen3-ASR ModelScope/量子位 · sherpa-onnx GitHub
