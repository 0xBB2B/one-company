---
name: 01-readme-banner
description: 用网页画出新横幅图，导出成 1600×560 的 webp，替换旧图
---
# 新横幅图

## 目标
`assets/onecompany-banner.webp` 换成更矮、只画产品真实流程的新图。

## 业务规则（来源：PRD 01-readme-banner）
- 文件路径不变，替换内容。宽 1600 像素、高 560 像素，不超过 200 KB。
- 图上有 OneCompany 字样、标语 `ONE HUMAN. A GOVERNED AUTONOMOUS COMPANY.`、七个节点 CLARIFY、APPROVE、PLAN、BUILD、REVIEW、VERIFY、DELIVER，以及图例 `AGENTS`、`ONLY YOU`。
- APPROVE、VERIFY、DELIVER 的圆点和文字是琥珀色 `#ffbf66`，其余四个的圆点是蓝色 `#7cb0ff`。
- 底部发蓝光的圆弧不压住任何文字。没有机器人，没有旧图的 STRATEGY、MONITORING 等节点名。
- 导出用的网页只放在 `.bb-spec/.cache/banner/`，不进 git。决策理由：文字准确、和主页七步一致；导出后只留图片。

## 涉及文件
- 修改：`assets/onecompany-banner.webp`
- 新建：`tests/readme-banner.test.ts`
- 临时（不提交）：`.bb-spec/.cache/banner/banner.html`、`.bb-spec/.cache/banner/banner.png`

## 成品定义

把下面的内容存成 `.bb-spec/.cache/banner/banner.html`：

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:1600px;height:560px;overflow:hidden}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.bn{position:relative;overflow:hidden;width:1600px;height:560px;background:#080b12;color:#e9edf5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.arc{position:absolute;left:50%;top:752px;width:2720px;height:2720px;margin-left:-1360px;margin-top:-264px;border-radius:50%;border-top:1px solid rgba(124,176,255,.6);box-shadow:0 -64px 176px rgba(124,176,255,.2),inset 0 96px 176px rgba(124,176,255,.08)}
.in{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;padding:61px 112px 0}
.word{font-size:134px;line-height:1.05;font-weight:680;letter-spacing:-.03em;background:linear-gradient(90deg,#fff 45%,#9cc4ff);-webkit-background-clip:text;background-clip:text;color:transparent}
.tag{margin-top:18px;font-size:22px;letter-spacing:.32em;color:#a9b8d0}
.rail{display:grid;grid-template-columns:repeat(7,1fr);width:100%;margin:58px 0 0;padding:0;list-style:none;border-top:1px solid #33425f;font-size:20px;letter-spacing:.1em;color:#a9b8d0}
.rail li{position:relative;padding-top:27px;text-align:center}
.rail i{position:absolute;top:-8px;left:50%;width:16px;height:16px;margin-left:-8px;border-radius:50%;background:#7cb0ff;box-shadow:0 0 19px rgba(124,176,255,.9)}
.rail .you{color:#ffbf66}.rail .you i{background:#ffbf66;box-shadow:0 0 22px rgba(255,191,102,.95)}
.key{display:flex;gap:38px;margin-top:24px;font-size:16px;letter-spacing:.14em;color:#7f8ca3}
.key i{display:inline-block;width:11px;height:11px;margin-right:10px;border-radius:50%;background:#7cb0ff}
.key .you{color:#ffbf66}.key .you i{background:#ffbf66}
</style></head><body>
<div class="bn"><div class="arc"></div><div class="in">
<div class="word">OneCompany</div>
<div class="tag mono">ONE HUMAN. A GOVERNED AUTONOMOUS COMPANY.</div>
<ol class="rail mono"><li><i></i>CLARIFY</li><li class="you"><i></i>APPROVE</li><li><i></i>PLAN</li><li><i></i>BUILD</li><li><i></i>REVIEW</li><li class="you"><i></i>VERIFY</li><li class="you"><i></i>DELIVER</li></ol>
<div class="key mono"><span><i></i>AGENTS</span><span class="you"><i></i>ONLY YOU</span></div>
</div></div>
</body></html>
```

导出步骤：

1. 用浏览器以 1600×560 的窗口、设备像素比 1 打开这个网页，截图存成 `.bb-spec/.cache/banner/banner.png`。
2. 运行 `cwebp -q 88 .bb-spec/.cache/banner/banner.png -o assets/onecompany-banner.webp`。
3. 文件超过 200 KB 时降低质量参数重新导出。

## 函数清单
无业务代码。测试文件 `tests/readme-banner.test.ts` 从 webp 文件头读出尺寸。

## 协作关系
`README.md` 引用这张图。`package.json` 的 `files` 已包含 `assets`，不用改。

## 验证方式
- 测试入口：`pnpm exec vitest run tests/readme-banner.test.ts`
- 测试输入：仓库里的 `assets/onecompany-banner.webp` 和分支文件列表。
- 预期结果：文件头是 RIFF/WEBP，宽 1600、高 560；文件不超过 200 KB（204800 字节）；`assets/` 目录只有这一个文件。
- [ ] 尺寸和大小测试通过。
- [ ] 打开图片逐项看：七个节点顺序和颜色正确，圆弧没有压住文字，没有机器人和旧节点名。
