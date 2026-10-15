# dsh-sidebar-focus

左侧工作区的排序与展开：按「有没有在跑」**和**「你正在哪儿」决定。六条规则，每条一个开关，位置在
**插件页 → 点开 `dsh-sidebar-focus` 之后的详情页**里（在描述与行列表之间）。

## 安装

```sh
dsh plugin --profile web add dsh-sidebar-focus
```

还没上 npm 时用 GitHub 源：

```sh
dsh plugin --profile web add github:wjingshan/dsh-sidebar-focus
```

装完**刷新页面**即可 —— 本插件是纯客户端（宿主半身是空的），不需要重启 `dsh web`。

## 它做什么

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| 置顶最近有活动的工作区 | 开 | 有会话跑过的工作区排到最前，按**最近一次活动**排序。跑完**不会掉回原位**，只有更新的活动才把它往下挤一位。**只影响显示**，你手动拖出来的工作区顺序从不被改写 |
| 置顶当前会话所在的工作区 | 开 | 你正在用的那个会话（**包括刚新建、还没开始跑的**）所在的工作区也排到最前。新建的会话不渲染状态点，只靠上面那条永远浮不上来 |
| 自动展开正在运行的工作区 | 开 | 有会话在跑、或正在等你的工作区自动展开。宿主本身只在「当前会话所在的工作区」上这么做，这条把它扩展到所有在跑的工作区 |
| 置顶正在进行的会话 | 开 | 运行中与等待你处理的会话排到所属工作区的最前 |
| 收起没有运行的工作区 | 开 | 没有会话在跑的工作区保持折叠；**刚跑完的会先留 2.5 秒再收**（宿主分两步报告「跑完了」：先清 `running`、之后才升起完成提醒） |
| 保留未读完成提醒 | 开 | 含「已完成未查看」的工作区不自动折叠，避免刚跑完的会话被收起来 |

## 交互语义：什么时候它不接管

自动折叠最烦人的失败模式是「你点开、它立刻折回去」。所以两侧都留了 **意图豁免**：

- 你**亲手展开**一个空闲工作区 → 它保持展开，插件不再碰它，直到这个工作区重新变忙再变闲；
- 你**亲手折叠**一个正在运行的工作区 → 它保持折叠，插件不替你展开，同样直到忙碌状态再次变化。

豁免只在**本次页面会话内**有效，刷新后回到规则本身。判断依据是 `aria-expanded` 上不是本插件
写出的翻转——所以「搜索结果跳转」「新建会话」这类宿主自己的展开，也被当成你的意图而保留。

另外两条不参与自动折叠的例外：

- **未分组（Ungrouped）永不折叠**：那是散落会话的收容所，不是谁主动选的工作区；
- **当前选中会话所在的工作区保持展开**：否则切换会话会落到一个被折起来的组上
  （宿主的自动展开只对「没有存过状态」的组生效，而本插件会写状态）。

## 做法，以及为什么

- **排序不移动 DOM**：列表列原本是 `overflow-y:auto` 的块容器，`order` 对它无效；插件先把它变成
  flex 列（`[data-wsf-rank-tree]`），再用 `order` 给忙碌工作区 / 活动会话排名。DOM 节点从不移动，
  所以 React 的 reconciliation 与内置的 FLIP 行动画都不受影响。
  - `order` 作用在 **flex item** 上，而每一行外面还套着 `HoverCard` 的 `<span>`，所以排名规则用
    `:has()` 同时匹配「被包一层」与「裸行」两种形状；JS 侧同样**不能假设 `parentElement`**，
    分组位置一律由 `sectionOf()` 向上解析。
  - 排序是**纯展示**：不写 `Workspace.sessionIds`，也不碰你手动排序的结果。
- **「浮到顶部」有两个互相独立的理由**：工作区**忙**（行状态点 ∪ 状态快照），或者它**装着你当前选中的
  会话**。后者专门为 blank 的新会话而加：宿主的 `SessionNodeItem` 把状态槽写成 `!row.blank && …`，
  一个刚建、还没发消息的会话**一个状态点都不渲染**（`data-state` 根本不存在），状态快照里也还没有它，
  所以「忙」这条路**永远看不见它**；而 `aria-selected="true"` 对 blank 行同样成立，正好补上这个缺口。
  两条理由分别由 `pinBusyWorkspaces` 与 `pinCurrentWorkspace` 掌管，关掉一条不会影响另一条。
- **名次是锁存的，不是实时读数**：只有工作区**从「不活跃」变成「活跃」的那一刻**才记时间戳，活跃期间
  不再刷新；排名按时间戳倒序写成**内联 `order`**（每条工作区的名次都不同，静态 CSS 表达不了），
  从未活动过的工作区不带 `order`，保持原生顺序排在后面。于是**跑完不掉位**，只有更新的活动才把它
  往下挤一位 —— 这就是「正在跑的那个置顶、原来那个顺延」。
- **折叠要等连续空闲 2.5 秒**：宿主分两步报告「跑完了」（先清 `running`，之后才升起
  `completionUnread`），在第一帧「看起来空闲」时就折，会关掉一个刚出结果、提醒还没到的工作区。
  两个配套细节：宽限期到点时若没有任何 DOM 变化，是**没有人来叫醒扫描**的（用 `wakeIn()` 定时器补）；
  新活动挣到的名次是在扫描**过程中**发现的，而 `ranking` 算在扫描**开头**（用 `rankDirty` 补一次扫描）。
- **折叠是一次状态写入**：折叠的组根本不渲染会话行（宿主的 `deriveGroups` 对折叠组返回空
  `sessions`），所以 DOM 层做不到，必须改展开状态本身。写入走宿主自己的视图 store：
  `ctx.get('uiWorkspace').view.setGroupExpanded(key, expanded)`，键就是工作区 id。
- **「有没有在跑」不能只读行**：只看 DOM 的判据在这里必然出错——组一折起来就没有行可读，于是
  「里面有会话开始跑了」永远看不见，那个工作区会一直关着（用户报过：正在运行的工作区被折叠，打不开）。
  忙碌判定因此改为读 **Session 状态快照** `useSessionStatus`（`running` / `pendingInteraction` /
  `completionUnread`，与三条判据一一对应）加 **Workspace 成员表** `useWorkspaces`
  （`items[].sessionIds` 说明哪些会话属于哪个工作区）。这两个事实与「有没有渲染成一行」无关，
  折叠态照样成立，所以折叠中的工作区一旦开工就会被看见并展开。
  两个 hook 由挂在 `shell.overlay` 上的**零渲染桥接组件**发布给 watcher（选它只因为那个席位永远挂载）。
  行仍然照读——行级标记要用，快照未就绪时也要回退；两个来源取**并集**，任一见到在跑就不许关。
- **所有开关都是开关**：关闭时对应的 `data-wsf-*` 标记会被移除，CSS 规则随之失效，侧栏回到原生
  布局与原生折叠行为——不做「半开」状态。

### 依赖的宿主契约（实测于本 profile 的内置 `dsh-client-ui-workspace`）

| 事实 | 来源 |
| --- | --- |
| 会话列表是 `div[role="tree"]` | `AnimatedRows.render` |
| 工作区行是 `div[data-row-key="workspace:<key>"][role="treeitem"][aria-expanded]` | `ProjectRowItem` |
| **每一行都被 `HoverCard` 套了一层 `<span>`**，所以行的 `parentElement` **不是**分组容器；分组要向上找（父元素是列表列本身，或父元素是 `role="group"` 容器）。未分组是唯一例外——宿主对它直接返回裸行 | `ProjectRowItem` / `HoverCard` |
| 会话行是 `div[data-row-key="session:<id>"][role="treeitem"][aria-selected]`，**第一个子元素**是该行自己的状态槽（同样被 `HoverCard` 包着，所以 `:scope >` 读不到它） | `SessionNodeItem` |
| 状态点带 `data-state` ∈ {`ongoing`, `warning`, `done`, `error`, `idle`} | `ui-primitives` 的 `StateDot` |
| 展开状态存在 `dsh.workspace.view.v5`，`groupExpansion[key]` 显式为 `false` 才折叠 | `createWorkspaceViewStore` / `deriveGroups` |
| 接口是 `ctx.get('uiWorkspace').view.setGroupExpanded(key, expanded)` | `UiWorkspaceService` 的 `view` 字段 |
| 折叠的组**不渲染任何会话行**，所以运行状态必须另有来源 | `deriveGroups` 的 `GroupNode.sessions` |
| 槽位标准钩子 `useSessionStatus` / `useWorkspaces` 提供状态快照与工作区成员 | `shell.overlay` 的 standardProps |
| `WorkspaceSnapshot.items[].sessionIds` 是「谁属于哪个工作区」 | `dsh-api-workspace-controller` 的 `WorkspaceView` / `WorkspaceSnapshot` |

这些是构建产物的结构，不是文档化 API：宿主升级后**如果**结构变了，插件会安静地什么都不做
（`data-wsf-*` 标记无处可落），而不是弄坏侧栏。若 `uiWorkspace.view.setGroupExpanded` 不存在，
折叠会被整体关闭，并在**该插件的详情页**上显示告警、控制台打印原因——不会静默失败。

## 已知限制

- **不折叠未分组**，理由见上；如果你要连它一起收，改 `scanGroup` 里的 `key === ''` 判断。
- **自动折叠写的是宿主自己的视图偏好**：被自动折起来的工作区，其 `groupExpansion[key]` 会以
  `false` 持久化。卸载本插件后它们会保持折叠——手动点开即可恢复，或在插件页里禁用这个包再刷新。
- **子工作区（树形分组）不参与置顶**：子组在父组的 `role="group"` 容器里，不是列表列的直接子元素，
  `order` 在那里无效。会话级排序不受影响。
- 状态判定只读「运行中 `ongoing`」与「等待你 `warning`」；`error` 不参与。

## 验证状态

已验证：

- `node --check` 通过；manifest 解析通过；
- 安装返回 `application: applied`，profile 的 `dependencies` 与 `dsh.profile.bundles` 都已登记；
- **实时**客户端注册已生效：`plugins.bundle.config` 席位上出现了 `dsh-sidebar-focus` 这个 key
  （`cordis_inspect_query` 可见）。插件页只在**存在该 key 的注册**时才渲染那块配置
  （owner 的判据是 `ledger.bundles.has(pkg.name)`），所以这一条同时证明详情页里会出现这 6 个开关；
- 原先在「设置 → 通用」的 5 行已确认从 `settings.general.item` 移除，不会两处重复；
- 状态桥接已确认挂载：`shell.overlay` 的实时占用者里有 `dsh-sidebar-focus.status-bridge`，
  而该席位的 standardProps 同时提供 `useSessionStatus` 与 `useWorkspaces`。

未验证（本机 GUI 需要启动令牌，agent 浏览器无法进入；按插件规范的验证边界，未用截图或模拟 DOM 冒充）：

- **0.1.1 的根因修复本身**：`sectionOf()` 的三种形状（真实工作区 / 未分组 / 子工作区）与 CSS 的
  `:has()` 规则都是**从宿主源码推演**的，我没有在真实页面上跑过。推演依据是 `ProjectRowItem`
  的 `if (row.createdAt === void 0) return ownRow` 与 `HoverCard` 的 `return jsxs("span", …)`；
- 视觉结果（置顶后的实际顺序、flex 化后的行高与间距、浅色/深色两套主题下的观感）；
- 六条规则在真实运行/空闲会话上的实际效果，**尤其是这两条**：在一个已折叠的工作区里启动会话，
  它应当自动展开；以及新建一个会话后，它所在的工作区应当立刻浮到顶部；
- 与内置 FLIP 行动画、拖拽排序的共存表现。

自查方式：刷新 Web 页面 → 打开一个正在跑的工作区（应自动展开并置顶）→ 打开一个空闲工作区
（应保持折叠，你手动展开后应保持展开）→ 控制台不应出现 `[dsh-sidebar-focus]` 开头的报错。
