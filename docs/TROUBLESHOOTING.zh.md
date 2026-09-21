# 故障排查

[English](TROUBLESHOOTING.md) | 中文

现象、原因，以及真正管用的修法。每一条都是**发生过**的事，不是可能发生的事。

## 会话里看不到这些工具

插件注册在某个 profile 上，而 profile 的 bundle 是在**启动装配期**读取的。
装完请重启 harness：

```bash
dsh --profile web --dump-config | grep -c 'id: tool-git'    # 期望是 1
```

如果这个计数是 1 而工具仍然不见，说明插件加载了、但注册失败了。
去 harness 日志里找那条点名某个工具的报错。

## `tool "git_status" is already registered`

同一个 profile 里的另一个插件注册了相同的工具名。
这是**整个 profile 的启动硬失败**，不是局限在某个工具上的冲突。

有两个性质让它很难诊断：

- **`--dump-config` 看不见它。** 它只合成配置、从不调用 `apply()`，
  所以在启动失败的那一刻，它照样报告一棵干净的树。
- **注册成功不等于能用。** `ctx.tools.register()` 只校验 `output.schema`，
  所以一个 `parameters` 写坏的定义**照样能占住名字**，直到更晚才失败 ——
  在模型 provider 那里，而那里的报错点名的是工具，不是原因。

把两者中你**不打算用**的那个卸掉。见 [`AGENTS.md`](../AGENTS.md) 第 4 条。

## 找不到 `git`

二进制由 subprocess 接缝按正常 PATH 顺序解析。要么没装 git，
要么 harness 进程跑在一个不含它的 PATH 上。

```bash
git --version
```

## 写操作被拒绝了

`git_commit`，以及 `git_branch`、`git_stash` 的写入动作，都需要一个审批决定。
拒绝有两种不同形态：

- **没有装审批服务。** 这是 fail-closed 的默认行为。装载
  `@deepseek-ai/dsh-user-approval`，或者把 `requireApprovalForWrites` 设为 `false`
  来知情地接受无保护的写入。
- **有审批服务，但它拒绝了。** 消息里会点明结果。

## diff 看起来被截断了

有一个行数上限（`maxLines`，默认 500），以及 subprocess 请求里每路 8 MiB 的上限。
截断是**被报告**的，不是静默的；当接缝把输出溢写到磁盘时，结果里会带上完整输出的路径。

## 路径返回成了八进制转义

不该出现：`core.quotepath=false` 与 `-z` 记录格式都能防住它。
如果看到 `"\346\226\207"`，要么用的是不受支持的 git 版本，
要么有东西绕开了 `src/exec.js` 自己拼了一套 git 调用。
