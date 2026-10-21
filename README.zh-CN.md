<h1>
  <img src="docs/assets/wordmark.svg" width="196" height="44" alt="Tabgent">
</h1>

**每个标签页，都有你的智能助手。**

Tabgent 是一个 Chrome 扩展，让你在浏览器侧边栏使用 Codex。它能阅读当前网页、比较多个标签页、解释和标注 PDF，为网页、PDF 和 EPUB 电子书保存高亮和阅读笔记，也能按你的要求点击、填表和搜索。

[**开始使用 →**](#开始使用) · [功能演示](#功能演示) · [使用场景](docs/use-cases.zh-CN.md)

[English](README.md) · **简体中文**

<sub>macOS · Chrome 142+ · 使用现有 Codex 登录 · MIT 开源许可 · 早期预览版</sub>

## 功能演示

点击动图可查看大图。

<table>
  <tr>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/11-ask-about-tabs.gif"><img src="docs/assets/demos/11-ask-about-tabs.gif" alt="询问网页内容" width="180"></a><br>
      <strong>询问网页内容</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/12-hotel-comparison.gif"><img src="docs/assets/demos/12-hotel-comparison.gif" alt="比较酒店" width="180"></a><br>
      <strong>比较酒店</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/04-pdf-explain-highlight.gif"><img src="docs/assets/demos/04-pdf-explain-highlight.gif" alt="阅读标注论文" width="180"></a><br>
      <strong>阅读标注论文</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/03-github-code.gif"><img src="docs/assets/demos/03-github-code.gif" alt="导航讲解代码" width="180"></a><br>
      <strong>导航讲解代码</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/05-fill-search-form.gif"><img src="docs/assets/demos/05-fill-search-form.gif" alt="填写搜索条件" width="180"></a><br>
      <strong>填写搜索条件</strong>
    </td>
  </tr>
  <tr>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/13-manual.gif"><img src="docs/assets/demos/13-manual.gif" alt="查找说明书步骤" width="180"></a><br>
      <strong>查找说明书步骤</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/14-job-application.gif"><img src="docs/assets/demos/14-job-application.gif" alt="填写求职申请" width="180"></a><br>
      <strong>填写求职申请</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/15-event-registration.gif"><img src="docs/assets/demos/15-event-registration.gif" alt="填写报名表" width="180"></a><br>
      <strong>填写报名表</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/07-recipe-quantities.gif"><img src="docs/assets/demos/07-recipe-quantities.gif" alt="换算食谱份量" width="180"></a><br>
      <strong>换算食谱份量</strong>
    </td>
    <td width="20%" align="center" valign="top">
      <a href="docs/assets/demos/10-page-history.gif"><img src="docs/assets/demos/10-page-history.gif" alt="找回历史对话" width="180"></a><br>
      <strong>找回历史对话</strong>
    </td>
  </tr>
</table>

[中文对话截图与详细示例 →](docs/features.zh-CN.md)

## 划线、提问，留下阅读笔记

在网页、PDF 和 EPUB 电子书中划线，随时向 Codex 提问，每段讨论都以 Markdown 笔记保存在你的 Mac 上。

- **高亮、评论或提问：** 在网页、在 Chrome 中打开的本地文件、Tabgent 的 PDF 阅读器、EPUB 阅读器，或剪藏与订阅的阅读视图中选中文字。点击 **高亮** 保存这段原文；点击 **评论** 会同时保存原文和评论；点击 **询问 AI** 还会打开侧边栏，并把这段原文作为引用附上。重新打开网页、PDF 或书时（包括重启 Chrome 之后），高亮和评论会自动恢复；保存它们不需要 Codex 在线。
- **评论一段原文：** 在选区上选择 **评论**，或点击高亮后选择 **评论** / **编辑评论**。取消或按 Esc 不会保存。侧边栏的高亮列表也会显示评论，并可以在那里编辑。笔记文件里，评论写在对应高亮下的 **评论** 一行。
- **全文评论和标签：** 在 Tabgent 阅读视图的标题下方、侧边栏的页面抽屉里，或资料库每篇文档下方，为整篇文档写评论、加标签，不需要先高亮或剪藏。输入标签时会提示你已经用过的标签；在资料库里点标签即可按这个标签筛选，也可以重命名、合并和删除标签。两者都保存在这篇文档的笔记里（**全文评论** 一节和 front matter 的 `tags` 字段），也可以直接在 Obsidian 中修改。
- **围绕原文讨论：** Codex 会收到选中的原文、前后文、文档标题、你对这条高亮写的评论、你对整篇文档的全文评论和标签（标明是你的看法，与作者原文区分），以及此前关于它的讨论，回答会围绕你正在读的内容展开。可以在同一个对话里继续追问；之后点击这条高亮，选择 **查看讨论**，即可接着聊。
- **随处可打开的笔记：** 每篇文档在 `~/Tabgent`（或你指定的文件夹）中有一个 Markdown 笔记，像 Readwise 导出那样按类别放在 `Articles/`、`Tweets/`、`Videos/`、`Podcasts/`、`PDFs/`、`Books/`、`Local Files/` 中。笔记列出每条高亮、你的评论及其位置（章节标题、页码或章节）；你的提问和 Codex 的回答单独存放在 `Discussions/` 中，和笔记互相链接，全文在 `Full Document Contents/` 中。打开 **保存到阅读笔记** 时，针对整篇文档的提问也会保存。这个文件夹可以用 Obsidian、VS Code 或任意文本编辑器打开。
- **把读过的内容联系起来：** 可以问“这段话和我之前读过的内容有什么联系？”。Codex 会用只读工具检索你的笔记，并说明用到了哪篇文档、哪条高亮和哪个文件。问题需要时，它也可以读取 PDF 的指定页，或读取随导入的 PDF 或 EPUB 保存的页面文本或章节文本。
- **资料库：** 右键点击工具栏中的 Tabgent 按钮，选择 **打开资料库**，或在侧边栏的阅读笔记菜单中选择它。资料库列出笔记文件夹中的所有文档（网页、在线 PDF、导入的 PDF 和 EPUB 电子书）及其高亮数量，点击即可在对应的位置重新打开，剪藏过的网页在 Tabgent 的离线阅读视图中打开。 支持搜索标题、作者、网址、个人评论、高亮和已有全文，按类别、标签、有评论 / 高亮、阅读状态组合筛选。
- **Mac 上的 PDF 和电子书：** 在资料库中选择或拖入 PDF 或 EPUB 文件。文件会复制到笔记文件夹，之后无需原文件即可从资料库重新打开。PDF 在 Tabgent 的 PDF 阅读器中打开，可以像在线 PDF 一样高亮、评论和向 Codex 提问；每一页的文字也会另存为 Markdown，即使关闭了标签页，Codex 也能检索和阅读这篇论文。电子书在 EPUB 阅读器中打开，支持目录、字号调整，以及分页或滚动阅读。
- **剪藏网页：** 右键点击工具栏中的 Tabgent 按钮或网页本身，选择 **剪藏此网页**，或按 ⌥⇧S。网页正文会按你看到的样子存为 Markdown，放在 `Full Document Contents/` 中并从该网页的笔记链接过去，之后 Codex 可以检索和阅读，也能在 Obsidian 中打开。在 X 上，会保存帖子以及作者在页面上已加载的连续回复。选择 **打开剪藏版** 可以在 Tabgent 的阅读视图中离线阅读，并像在网页上一样高亮、评论和向 Codex 提问。
- **订阅：** 在资料库的 **订阅** 页订阅 RSS、Atom 和 JSON Feed，可以填订阅源或网站地址，也可以导入 OPML 文件。Chrome 会定时检查（请求不带 Cookie）。条目在 Tabgent 的阅读视图中阅读（订阅源只给摘要时加载全文），可以归入稍后读或归档；高亮或提问时，这一条会像剪藏的网页一样保存到笔记文件夹。
- **在 Chrome 中打开的文件：** 在 Mac 上双击 PDF、Markdown、文本或 HTML 文件，照常在 Chrome 中阅读；选中文字即可高亮或向 Codex 提问，和在网页上一样。PDF 会在同一个标签页中切换到 Tabgent 的 PDF 阅读器。第一次高亮时，它会被复制到笔记文件夹，所以移动或重命名文件后笔记仍在；在资料库中导入同一份 PDF 也共用这些笔记。Chrome 需要你授权一次：为 Tabgent 打开“允许访问文件网址”。第一次打开文件时，Tabgent 会告诉你怎么做。

[了解阅读笔记的详细用法 →](docs/features.zh-CN.md#划线提问保存阅读笔记)

## 更多功能

- **[上传附件](docs/features.zh-CN.md#把相关材料一起交给助手)**：支持图片、PDF、Word（DOCX）和文本文件，可以结合当前网页提问。
- **[会话历史](docs/features.zh-CN.md#让网页和会话保持关联)**：查看当前网址下的历史对话；从链接打开的会话会记录来处，点击可切换标签页。聊天也可以展开为独立页面。
- **[补充要求或停止任务](docs/features.zh-CN.md#任务进行中也能随时调整)**：执行过程中可以继续发消息，用 Steer 调整当前任务，或点击停止。排队中的消息支持编辑和删除；操作位置和执行记录也可以查看。
- **[计划与目标](docs/features.zh-CN.md#任务进行中也能随时调整)**：支持计划模式，也可以设置任务目标和 token 用量上限，并暂停或恢复目标。
- **[模型与权限](docs/features.zh-CN.md#按你的习惯使用)**：选择模型、思考强度、操作批准方式，以及允许操作的浏览器窗口。
- **[技能与工具](docs/features.zh-CN.md#按你的习惯使用)**：使用 Codex 中已有的技能、网页搜索和已连接的服务。回答可以复制，会话消息可以导出为 Markdown。

部分功能需要相应的 Codex 版本、模型或配置支持。

## 其他使用场景

[收集每月发票](docs/use-cases.zh-CN.md#月底收发票不再逐个翻找) · [填写求职申请](docs/use-cases.zh-CN.md#申请工作少填一遍简历) · [比较房源](docs/use-cases.zh-CN.md#房源看得太多把条件放在一起比较)

[查看七个场景的具体用法 →](docs/use-cases.zh-CN.md)

这些场景提供了提问和操作建议，尚未逐一验证完整流程，实际效果取决于网站。

## 开始使用

### 安装要求

- **macOS**、**Chrome 142+** 和 **Python 3.9+**。
- **已安装并登录 Codex**，且版本兼容。参见[兼容性说明](docs/installation.md#requirements)。
- 仓库处于私有状态期间，需要拥有该 GitHub 仓库的访问权限。

Tabgent 使用你现有的 Codex 账号和配置，目前需要手动加载扩展，尚未上架 Chrome 应用商店。

### 方式一：让 Codex 帮你安装

将下面这段话复制到 Codex：

```text
请从 https://github.com/FibonaAI/tabgent 安装 Tabgent。

检查这台 Mac 是否有 Python 3.9+、Chrome 142+ 和兼容的 Codex。
使用我现有的 GitHub 权限，将仓库克隆到一个未被占用的目录，
阅读 docs/installation.md，并运行：
python3 extension/native/install.py

使用我现有的 CODEX_HOME 和 Codex 登录。打开 chrome://extensions，
启用开发者模式，从以下目录加载已解压的扩展：
~/Library/Application Support/Tabgent/extension

固定扩展并打开 Agent 侧边栏。保留我现有的 Chrome 配置和标签页。
如果可以控制浏览器，请直接操作；否则只引导我完成剩余点击。
帮助解决访问权限、依赖或登录问题，验证侧边栏显示“Codex connected”，
并告诉我实际验证了哪些内容。
```

### 方式二：手动安装

1. 克隆或下载本仓库。
2. 双击 **Install.command**，或在仓库根目录运行：

   ```sh
   python3 extension/native/install.py
   ```

3. 打开 `chrome://extensions`，启用**开发者模式**，选择**加载已解压的扩展程序**，然后选择：

   ```text
   ~/Library/Application Support/Tabgent/extension
   ```

   自定义 `CODEX_HOME` 不会改变这个安装位置；它只指定 Codex 的账号、配置和数据目录。

   要在从 Mac 打开的 PDF 等文件上使用 Tabgent，请点击 Tabgent 下方的**详情**，打开“允许访问文件网址”。

4. 固定 Tabgent，打开一个网页，点击工具栏中的扩展图标。看到 **Codex connected** 后，试着问：**“总结一下这个网页。”**

**更新：** 等正在执行的任务结束后，重新运行安装程序，再到 `chrome://extensions` 重新加载 Tabgent。连接问题、自定义配置和卸载方法请参阅[安装与故障排查](docs/installation.md)。

## 隐私与控制

- **选择操作的批准方式：** Ask for approval（请求批准）、Approve for me（代为审批）或 Full access（完全访问）。
- **选择助手可以使用的窗口：** 当前窗口或所有窗口。这项设置只限制 Tabgent 对浏览器的操作；Codex 的其他工具和已连接服务不受此设置限制。
- **连接本机 Codex：** Tabgent 连接 Mac 上已安装的 Codex，没有单独处理会话的 Tabgent 云端服务。
- **对话内容会发送到 Codex 服务：** 为了回答问题或执行任务，你的消息、提供的网页内容及使用的附件会发送到你配置的 Codex 服务，并非只在这台电脑上处理。对于从 Mac 打开的文件，文件路径会作为页面地址发送。
- **订阅直接从你的 Mac 抓取：** Chrome 运行时会直接检查你订阅的订阅源，请求不带 Cookie 和 Referer，中间没有任何订阅服务。**暂停所有订阅** 可以停止定时检查。条目的全文从文章网页加载；只有当条目就在该订阅源自己的网站上时，才会带上这个网站的 Cookie（不会发给链接或重定向指向的其他网站）；条目图片加载时不带 Cookie，但会带上文章网页本来会发送的 Referer。
- **阅读笔记保存在本地文件夹：** 高亮、已保存的讨论、剪藏的网页正文、打开过的 EPUB 电子书以及你高亮过的 Mac 上的 PDF 都存放在你的笔记文件夹中（默认是 `~/Tabgent`），Tabgent 不会上传这些内容。Tabgent 的 `reading_vault` 工具只读取 Tabgent 在其中写入的笔记文件；Codex 自身的命令遵循你选择的权限模式，不限于这些文件。读取的内容会像其他对话内容一样发送到你的 Codex 服务。

数据流、存储位置和 Chrome 权限详见[隐私与权限](docs/privacy.md)。安全问题请按 [SECURITY.md](SECURITY.md) 中的方式报告。

## 当前限制

Tabgent 仍处于早期预览阶段，**主要支持 macOS 和 Chrome**。部分旧版 Codex 可能需要更新。Tabgent 会话不会与 Codex 桌面端实时同步；重启浏览器后，历史会话可能仍然保留，但不一定能自动回到原来的标签页。

网页高亮只支持页面本身，不支持页面内嵌的框架（iframe）。PDF 高亮需要使用 Tabgent 的 PDF 阅读器，它打开在线（HTTP 或 HTTPS）PDF、从 Mac 打开的 PDF 和从资料库打开的 PDF，且文字需要可以选中。从 Mac 打开的文件需要开启“允许访问文件网址”；未开启时它们照常在 Chrome 中打开，但无法使用 Tabgent。如果 Chrome 未运行，双击的 PDF 会先短暂显示 Chrome 自带的阅读器，再切换到 Tabgent 的阅读器。Markdown 文件以纯文本显示。Markdown、文本和 HTML 文件的笔记跟随文件路径，移动或重命名后不会跟过去。Agent 可以读取你打开的文件，但不能在其中点击或输入，也不能自行打开文件。在线 PDF 和 Mac 上同一文件的副本各自保存笔记。页面文字通过 macOS PDFKit 保存；扫描页没有文字，也不会进行 OCR 识别。固定版式的 EPUB 会保存高亮，但不会在书中显示。剪藏每页最多保存 50 张图片；SVG 图片和过大的图片仍链接到网上。如果找不到某条高亮对应的原文，Tabgent 会保留笔记并标记为未找到，而不会错误地标注其他文字；目前还不能重新定位这条高亮。

## 参与贡献

欢迎反馈问题、提出建议或提交 Pull Request。参与开发前请阅读[开发指南](docs/development.md)和[贡献指南](CONTRIBUTING.md)。

| 文档                             | 内容                       |
| -------------------------------- | -------------------------- |
| [安装指南](docs/installation.md) | 安装、更新、故障排查和卸载 |
| [开发指南](docs/development.md)  | 本地运行、测试和打包       |
| [架构说明](docs/architecture.md) | 扩展与本地连接器的内部结构 |
| [隐私与权限](docs/privacy.md)    | 数据处理和访问边界         |

本页和使用指南均提供中英文版本；上方技术文档目前为英文。

## 许可证

采用 [MIT 许可证](LICENSE)。内置依赖保留各自的许可证，详见[第三方声明](THIRD_PARTY_NOTICES.md)。

Tabgent 是独立项目，并非 OpenAI 或 Google 的官方产品。
