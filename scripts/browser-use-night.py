# scripts/browser-use-night.py — overnight UI exploration (PLAN-SUPERHUMAN R25).
# Runs browser-use against the isolated live instance on :7630 and exercises
# tonight's surface: chat tool chips, command-center event highlights, i18n.
# Run: ~/.venvs/bu/bin/python scripts/browser-use-night.py   (from repo root)
import asyncio
import json

from browser_use.agent import Agent
from browser_use.browser.profile import BrowserProfile
from browser_use.llm.deepseek.chat import ChatDeepSeek

BASE = "http://127.0.0.1:7630"
KEY = json.load(open("runtime/config.json"))["apiKey"]

TASK = f"""目标网址（第一件事就是导航到它，URL 必须一字不差、不要附加任何其他字符）：
{BASE}
你是 UI 质检员。依次完成并如实汇报（不要美化，坏就是坏）：
1. 打开上述网址，确认应用加载出界面。左侧应有会话列表，顶部有视图切换（含「指挥中心」）。
2. 点击新建会话（若有「新对话/新建」按钮），在聊天输入框输入：现在几点了？用工具查真实数据 —— 然后发送。
3. 等待回复完成（最多120秒）。观察回复上方是否出现一个带 🔍 图标的工具执行卡片（可能显示 terminal 命令和结果预览）。记录：卡片是否出现、显示的工具名、回复里是否有具体时间。
4. 切换到「指挥中心」视图。观察右侧思考日志是否有条目、任务板/甘特区是否渲染。记录看到的内容类型。
5. 最终汇报（中文，分 5 条对应上面 5 步，每条以 成功/失败/部分 开头）。
"""


async def main() -> None:
    llm = ChatDeepSeek(model="deepseek-chat", api_key=KEY)
    profile = BrowserProfile(headless=True, viewport={"width": 1440, "height": 900}, locale="zh-CN")
    agent = Agent(task=TASK, llm=llm, browser_profile=profile)
    result = await agent.run(max_steps=40)
    print("=== FINAL ===")
    final = getattr(result, "final_result", lambda: None)() or "(no final text)"
    print(final)
    print("=== ERRORS ===")
    for e in result.errors[-5:]:
        print(e)


asyncio.run(main())
