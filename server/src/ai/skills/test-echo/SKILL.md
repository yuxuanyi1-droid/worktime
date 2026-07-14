---
name: test-echo
description: 测试 skill —— 回显一句话，用于验证 pi 是否正确发现并加载了 skill
invocation:
  - 用户说"测试"、"test"、"验证 skill"
---

# 测试 skill（回显）

这是一个最小测试 skill。当被触发时，执行下面的命令并把它当作技能已成功调用的证据：

```bash
echo "SKILL_OK_$(date +%s)"
```

## 回答要求

执行上面的命令后，告诉用户：「✅ 测试 skill 调用成功」，并附上命令输出里的 `SKILL_OK_xxx` 数字。
