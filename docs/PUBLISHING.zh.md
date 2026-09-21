# 发布

[English](PUBLISHING.md) | 中文

本包的一次发布是怎么切出来的。它很短，因为大部分是自动的；而**没被自动化的那几步，
正是出过事的那几步**。

## 五道守卫，按这个顺序

```bash
export PATH="$HOME/.local/bin:$PATH"     # 非登录的 WSL shell 里 PATH 上没有 node
cd <repo>
node test/run.mjs                                  # 1) 测试与计数
node tools/verify-translation-pairing.mjs --write  # 2) 重录双语配对哈希
node tools/verify-doc-numbers.mjs                  # 3) 文档数字 vs 真实运行
bash -n install.sh && bash -n uninstall.sh         # 4) shell 语法
node tools/verify-version-consistency.mjs --dsh <version>   # 5) 声明范围 vs 实测
```

顺序是有讲究的：**先改数字 → 再重录配对 → 最后复核数字**。反着做，或漏掉中间那步，
你就会收获一片红的 CI 矩阵，然后去排查一段从来没出错的代码。

**不会失败的守卫不算守卫。** 上面每一条都拿一份**故意改坏**的副本跑过，确认它真的会红。

## 需要改版本号的地方

`node tools/verify-doc-numbers.mjs` 会点名它检查的每一处：

- `package.json`
- `SECURITY.md` 的支持表
- `README.md` 与 `README.zh.md`（任何写出的版本或范围）

## 发版

```bash
git add -A && git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push && git push origin vX.Y.Z
gh run list --repo <owner>/<repo> --limit 6
gh release view vX.Y.Z --repo <owner>/<repo>
```

最后一条不是走过场。GitHub Release 是 `release.yml` 自己建的，所以推 tag 之后
仓库的 Releases 面板应该跟着动 —— 如果 tag 与提交都动了、面板却还停在上一个版本，
那就是建 Release 那一步没有跑。常见原因是工作流的 `permissions: contents: read`，
建 Release 需要 `contents: write`。另注意建 Release 那一步是**故意**带
`if: always()` 的，这样即使 `npm publish` 因为缺凭据失败，Release 仍然会被建出来。

## publish job 变绿 ≠ 包已经发出去了

npm 的传播要几分钟。先确认它传播到了，然后**把 tarball 拆开**：

```bash
npm view <pkg> version
cd /tmp && rm -rf tgz && mkdir tgz && cd tgz
curl -sL "$(npm view <pkg> dist.tarball)" -o p.tgz && tar xzf p.tgz
grep -rl '<只有本次发布才含有的字符串>' package/
```

CI 绿 + npm 显示新版本，合起来只证明「有个包上去了」。
只有在 tarball 里找到**本次**发布的代码，才证明发出去的是**这一次**。

## 市场投递

搜索索引只读**一个字段**：`data/plugins/<OWNER>__<repo>--<sub>.yml` 里的 `description`。
不读 README，也不读 npm keywords。多词查询必须命中**同一个字段**，中文词还必须**连续出现**
—— 所以描述得**准确**，而不是堆关键词。夸大是投递被打回的**唯一**原因。

## 要提醒用户的事

pnpm 默认有 24 小时发布冷却期，所以刚发布的版本会**静默地**解析到上一个版本。
要立刻拿到就钉住版本号：

```bash
dsh plugin --profile web add <pkg>@X.Y.Z
```
