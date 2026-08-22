# scripts/browser-use-explore.py — exploratory UI test of the live RoboJex web
# app driven by browser-use + DeepSeek. Complements the deterministic probe:
# this is a free-roaming agent poking the same surfaces a user would.
#
# Run: ~/.venvs/bu/bin/python scripts/browser-use-explore.py [task1|task2]
# (default: original full 7-step sweep — deepseek-chat sometimes trips the
# strict output schema on long runs, so the split tasks are the reliable way)
import asyncio
import json
import sys

from browser_use.agent import Agent
from browser_use.browser.profile import BrowserProfile
from browser_use.llm.deepseek.chat import ChatDeepSeek

BASE = "http://127.0.0.1:7620"
KEY = json.load(open("runtime/config.json"))["apiKey"]

TASKS = {
    "task1": f"""目标网址（第一件事就是导航到它，URL 必须一字不差、不要附加任何其他字符）：
{BASE}

这是 RoboJex 桌面 AI 助手网页版，中文界面，深色主题。导航成功后只做两件事：
1) 点击侧栏「新对话」按钮，在底部输入框输入"用一句话介绍你自己"并点击发送，等待回复出现；
2) 点击输入区的挡位 chip（显示"均衡"）打开弹层，选择「专注」挡，确认 chip 文案变为「专注」，再切回「均衡」。
不要做其他操作。完成后输出两行中文结论：【第1步 通过/异常+原因】【第2步 通过/异常+原因】。""",
    "task2": f"""目标网址（第一件事就是导航到它，URL 必须一字不差、不要附加任何其他字符）：
{BASE}

这是 RoboJex 桌面 AI 助手网页版，中文界面，深色主题。导航成功后只做三件事：
1) 依次点击顶栏的「任务板」「活动」「驾驶舱」视图标签，每个停留看一眼是否有内容渲染；
2) 点击顶栏齿轮图标打开设置，随便浏览两个分区后关闭；
3) 点击主题切换按钮一次，观察变化即可（不用切回）。
不要做其他操作。完成后输出三行中文结论，每行【第N步 通过/异常+原因】。""",
    "task3": f"""目标网址（先导航到它，URL 一字不差、不附加任何字符）：
{BASE}

导航成功后只做一件事：点击顶栏「驾驶舱」视图标签，看一眼页面是否渲染出内容（挡位表盘/用量图等）。
完成后输出一行中文结论：【通过/异常+原因】。""",
    "task4": f"""目标网址（先导航到它，URL 一字不差、不附加任何字符）：
{BASE}

导航成功后只做一件事：点击顶栏齿轮图标打开设置弹窗，随便看一眼表单内容，然后按 Esc 关闭。
完成后输出一行中文结论：【通过/异常+原因】。""",
    "task5": f"""目标网址（先导航到它，URL 一字不差、不附加任何字符）：
{BASE}

导航成功后只做一件事：点击顶栏的主题切换按钮一次，观察页面深浅色变化。
完成后输出一行中文结论：【通过/异常+原因】。""",
}

TASK = TASKS.get(sys.argv[1] if len(sys.argv) > 1 else "", None) or f"""打开 {BASE} —— 这是 RoboJex 桌面 AI 助手的网页版（中文界面，深色主题）。请做一轮探索性测试，像真实用户一样操作：
1) 点击侧栏的新对话按钮，在输入框发送一条消息（例如"用两句话介绍你自己"），等待流式回复完成；
2) 点击输入区的挡位 chip 打开挡位弹层，切换到「专注」挡，确认 chip 文案变化；
3) 依次点击顶栏的 Agent 板、活动、思考流视图标签，确认每个视图都有内容渲染；
4) 打开设置（齿轮图标），浏览各个分区后关闭；
5) 按 Ctrl+K 打开命令面板，输入"视图"并执行其中一个命令，按 Esc 关闭；
6) 点击主题切换按钮观察深浅主题变化，再切回深色；
7) 最后回到聊天视图。
注意：不要删除已有会话。全程留意控制台报错、布局破裂、文字溢出、按钮无响应等异常。
完成后输出一份简明中文测试报告，格式：每步 【通过/异常】+ 一句说明；最后给出发现的异常清单（没有则写"无"）。"""

async def main():
    llm = ChatDeepSeek(
        base_url="https://api.deepseek.com/v1",
        # v4-* named models are thinking-mode and reject forced tool_choice;
        # deepseek-chat (non-thinking alias) accepts them — browser-use needs
        # forced tool calls
        model="deepseek-chat",
        api_key=KEY,
        temperature=0.2,
    )
    agent = Agent(
        task=TASK,
        llm=llm,
        browser_profile=BrowserProfile(headless=True, disable_security=True),
        max_steps=18,
    )
    result = await agent.run()
    print("\n===== browser-use final report =====")
    print(result.final_result() or "(no final result)")

asyncio.run(main())
