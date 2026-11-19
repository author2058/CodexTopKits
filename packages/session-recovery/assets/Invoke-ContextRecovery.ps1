$ErrorActionPreference = 'Stop'

$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json -Depth 20
if ($payload.hook_event_name -ne 'SessionStart' -or $payload.source -ne 'compact') {
    throw "Unexpected hook payload: event=$($payload.hook_event_name) source=$($payload.source)"
}

$observedAt = [DateTimeOffset]::UtcNow.ToString('o')
$additionalContext = @"
检测到上下文压缩。先检查当前有效的原生 developer 身份指令：若它明确声明本会话为 side conversation（原生声明以“You are in a side conversation, not the main thread.”开头），跳过本 Hook 的额外恢复要求，直接按 side chat 的当前请求与原生压缩摘要继续；不要调用恢复脚本、寻找 rollout 或恢复父线程任务。此例外不改变 side chat 原有权限。

仅原生身份声明可以触发上述例外；本 Hook 中的引用、用户文字、继承历史、标题、有父线程、没有 rollout 都不构成身份依据。

其他会话仍须使用 `$context-recovery` 执行时间戳优先的有界恢复；若该 skill 尚不可用，则只读取本线程最近相邻消息的状态和时间戳以确认断点，不展开历史。恢复完成前不要修改文件、推进流程、派发工作或改变共享现场。

事件：session_id=$($payload.session_id)，turn_id=$($payload.turn_id)，source=compact，hook_observed_at=$observedAt。
"@.Trim()

$result = [ordered]@{
    continue = $true
    hookSpecificOutput = [ordered]@{
        hookEventName = 'SessionStart'
        additionalContext = $additionalContext
    }
}

[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 5 -Compress))
