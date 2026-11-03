---
name: 01-readme-banner
description: 把 README 横幅图换成更矮、只画产品真实流程的新图
date: 2026-11-03
---

# 新横幅图

## 用户故事

### P0：作为第一次打开仓库的读者，我想要横幅图占地不大、内容真实，以便第一屏还能看到介绍，也不被产品没有的东西误导

**用例（主路径）**
- 场景：读者在 GitHub 上打开仓库首页。
- 操作：看 README 最顶上的图。
- 预期：图上是 OneCompany 字样、标语和七个流程节点，没有机器人，没有 STRATEGY、MONITORING。

## 约束

- 图片文件仍是 `assets/onecompany-banner.webp`，替换旧图内容。
- 图片宽 1600 像素、高 560 像素。
- 图片背景是接近黑色的深蓝（`#080b12`），底部有一条发蓝光的圆弧，圆弧不压住任何文字。
- 图片上方居中是 "OneCompany" 字样，从左到右由白色渐变到浅蓝。
- 字样下面是全大写、字距较宽的标语：`ONE HUMAN. A GOVERNED AUTONOMOUS COMPANY.`
- 标语下面是一条横线，线上等距排列七个圆点，圆点下写：CLARIFY、APPROVE、PLAN、BUILD、REVIEW、VERIFY、DELIVER。
- APPROVE、VERIFY、DELIVER 三个节点的圆点和文字是琥珀色（`#ffbf66`），其余四个的圆点是蓝色（`#7cb0ff`）、文字是灰蓝色。
- 横线下面居中是图例：蓝点配 `AGENTS`，琥珀点配 `ONLY YOU`。
- 图片上不出现 STRATEGY、MONITORING、REQUIREMENTS、PLANNING、ENGINEERING、REVIEW & QA、RELEASE，也不出现机器人。
- 仓库里不提交导出图片用的网页文件。
- 图片文件不超过 200 KB。

## 验收

- [ ] `assets/onecompany-banner.webp` 存在，实际尺寸是 1600×560。
- [ ] 文件大小不超过 200 KB。
- [ ] 图上能读到 OneCompany、标语和七个节点名，节点顺序和约束一致。
- [ ] APPROVE、VERIFY、DELIVER 是琥珀色，其余四个节点是蓝色圆点。
- [ ] 圆弧没有压住图例或节点文字。
- [ ] 图上没有旧图的机器人和旧图的节点名。
- [ ] 分支里没有新增导出图片用的网页文件。

## 验证路径

1. 用 `sips -g pixelWidth -g pixelHeight assets/onecompany-banner.webp` 看尺寸 → 输出 1600 和 560。
2. 用 `ls -l assets/onecompany-banner.webp` 看大小 → 不超过 200 KB。
3. 打开图片逐项看 → 和约束一致。
