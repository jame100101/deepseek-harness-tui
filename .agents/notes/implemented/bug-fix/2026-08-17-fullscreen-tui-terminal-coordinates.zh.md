# Agent Note：全屏 TUI 终端坐标

Status: implemented

[English](2026-08-17-fullscreen-tui-terminal-coordinates.md) | 中文

## 问题

TUI 以不带尾随换行符的帧填满备用屏幕，但 Ink 7.1.1 的光标后缀仍从渲染输出之后的一条假想行计算垂直移动。`NativeCursor` 为此把 `measureElement()` 测得的行加一再上报，导致虚构行被保存为 `previousCursorPosition`。Ink 的 `buildCursorOnlySequence` 也继续使用假想的可见行原点；纯空格 composer 输入和导航可能不改变帧字节，因此每次 cursor-only 更新都会从与已保存行不一致的实际行返回，并累计向上漂移。

TUI 还用 `string-width` 7.2.0 计算 composer 显示列，而 Ink 7.1.1 用 `string-width` 8.2.2 计算布局。两者对 `⚙` 等符号的宽度判断不同，因此 composer 可能在与 renderer 不同的列换行。scrollbar 的 rail 使用 `│`、thumb 使用 `█`，并只给 thumb 加粗；统一 glyph 可以消除字体 bearing 差异，但在终端最后一个物理列绘制仍会激活 DECAWM pending-wrap 状态。VTE 与 Windows Terminal 对后续 LF 和光标控制序列如何处理该状态存在差异，因此正确的单 cell Yoga gutter 仍可能在相邻行或列出现错位。

## 决策

光标坐标保持为从零开始的 Ink 布局坐标。`NativeCursor` 把 `measureElement()` 的精确位置传给 `useCursor`。固定的 Ink 7.1.1 补丁让 `buildCursorSuffix` 和 `buildCursorOnlySequence` 接收写入输出后实际占据的行（`splitLines.length - 1`），而不是假设存在尾随换行符的可见行数。标准、增量、首帧、重绘、sync 和 cursor-only 路径因此共用一个坐标模型。坐标计算不包含平台分支。

npm launcher 在 bundled runtime 中嵌入 patched Ink payload，同时保留 Ink registry dependency 以安装其 dependency graph。这个 runtime-local 副本确保 npm installation 与 pnpm workspace 使用相同的 cursor 实现；assembly step 会拒绝未打补丁或版本不匹配的 Ink installation。

TUI 固定使用 `string-width` 8.2.2，与 Ink 的布局依赖一致。帧宽比物理终端少一个 cell，最后一个 cell 保持空白，scrollbar gutter 位于其左侧。scrollbar 的 rail 和 thumb 都以相同字重渲染 `█`，状态由 dim rail 和 cyan thumb 的颜色表达。TUI 为 scrollbar cell 使用私有 marker，Ink output serializer 输出 CHA 后再将 marker 转为 `█`；因此即使终端对前面的 emoji 采用不同宽度，gutter 也会回到其 Yoga column，其他 full-block glyph 仍按普通 transcript 或 chrome 内容处理。鼠标命中范围覆盖 rail 与空白安全 cell，在不绘制 autowrap 列的同时保留两 cell target。

`runInk` 显式声明 `interactive: true`。普通命令、Ctrl+D 和连续两次 Ctrl+C 的退出路径会在要求 Ink 卸载前重置应用持有的鼠标模式，因为备用屏幕卸载阶段的 effect cleanup 输出可以被丢弃。终端 owner 在卸载后还会以 best-effort 方式重复重置，覆盖进程退出路径。

## 曾考虑的备选方案

- 不采用 Linux 专用的行数减一，因为光标原点取决于终端输出帧，而不是操作系统。
- 不保留 `y + 1` 调整，因为它会污染 Ink 保存的光标位置，只能掩盖第一帧问题。
- 不添加尾随换行符，因为这会改变输出光标行和固定高度渲染模型，却不会消除右边界 pending-wrap 状态。
- 不禁用 DECAWM，因为这会修改共享终端状态，并增加一次可能被崩溃绕过的恢复义务。
- 不在每次输入时清屏重绘，因为它只会遮蔽状态错误、产生闪烁，并绕开 Ink 的增量光标生命周期。
- 不保留混合 scrollbar glyph 后再调整颜色或 padding，因为 padding 会改变 gutter 宽度，而颜色不能修正不同 glyph bearing。

## 影响

升级 Ink 时必须重新评估该补丁；上游正确暴露写入输出后的光标行后可删除它。composer 换行与光标定位现在共用一份 Unicode width table。scrollbar drag、mouse wheel、selection、composer editing 和 transcript 行预算保留既有语义。

回归覆盖分为三层：pure viewport 测试覆盖宽度边界、Unicode 列和保留的 terminal column；直接 Ink log-update 测试覆盖重复 cursor-only 移动；alternate-screen Ink render 与 real PTY 测试覆盖输入、编辑、resize、由 CHA 锚定的 scrollbar column、scroll、drag、back-to-bottom、正常退出和 Ctrl+C teardown。Windows ConPTY 会在 parent emulator 观察前消费并重新序列化定位控制，而 Unix PTY 保留原始字节；GUI terminal 仍由手工 smoke 覆盖，因为 CI PTY 不执行 VTE 本身。
