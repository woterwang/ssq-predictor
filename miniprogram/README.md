# 双色球数据观察 · 原生微信小程序

第11–12批实现，使用 TypeScript 与 TDesign 1.17.0。只有公众只读接口与无状态选号体检POST，没有管理凭证、生成/换号、支付或购彩操作。

## 开发与导入

1. 在本目录安装依赖：`npm ci`。
2. 严格类型检查：`npm run typecheck`；生成可运行代码：`npm run build`。
3. 微信开发者工具导入本目录，使用 [project.config.json](project.config.json)。也可导入上级项目根目录，两份配置都指向同一构建产物。保留用户已填入的AppID。
4. 不要把 [src/app.ts](src/app.ts) 所在源码目录作为运行根目录。此工程先由TypeScript编译为JS，未启用微信工具的TS编译插件。修改源码后重新构建、再在开发者工具编译。
5. 不需另点“构建npm”：构建脚本已按页面实际依赖生成TDesign闭包；手动执行整库npm构建可能覆盖按需结果并带入无关组件。若不慎覆盖，重新执行 `npm run build`。

运行产物由 [scripts/build.cjs](scripts/build.cjs) 生成，不提交到Git。主包为7个页面（含号码分析Tab）；`research` 分包为策略说明/回测看板/选号体检，`charts` 分包为结构走势图。ECharts 6.1.0 由 [scripts/echarts-entry.mjs](scripts/echarts-entry.mjs) 按需打包（折线+网格+提示框+Canvas），只进入 `charts` 分包并附带许可证；使用Canvas 2D，组件布局完成后初始化、卸载时销毁，只转发点按不拦截滚动。

## 接口与本地调试

- 公开服务地址在 [src/config/environment.ts](src/config/environment.ts)。`develop`默认电脑回环地址，体验版/正式版地址为空，未设置合法HTTPS地址会明确阻止请求，不回退到开发服务器。
- 开发者工具调试电脑本地服务时，在**本地设置**临时选择“不校验合法域名、web-view（业务域名）、TLS版本以及HTTPS证书”。共享配置仍保留 `urlCheck: true`；体验/正式版需设置合法HTTPS服务域名，不可用HTTP。
- 真机的127.0.0.1指手机本身；develop当前配置为电脑WLAN地址 `http://192.168.0.110:3001`，后端需监听该地址（如 `API_HOST=192.168.0.110`），手机连同一Wi-Fi并在预览时打开“开发调试”。电脑IP变化需同步修改，不能因此放开正式环境安全约束。
- 后端正常启动入口有调度功能，会按既有政策同步/核验/固化。仅想验证展示时，使用下述只读联调脚本；不要为前端传管理密钥，也不要伪造服务器时间或目标开奖记录。
- 核验与目标开奖来自独立HTTP响应，没有共享快照证明，故不叠加跨快照球号命中描边。命中文字仅复述核验响应时点的 `latest`，不会以 `versions[0]`替代当前结果。

## 可重复验收

- `npm run verify`：路由与组件依赖、编译后JS、环境阻断、Retry-After、分页/失败保留、卸载响应、核验修正及空值口径；第12批的统计缓存与窗口校验、回测缺值、体检POST字段与结果失效、走势分页与null断线，以及ECharts在Canvas 2D桩上的绘制/销毁。验收桩仅存在于Node脚本，不打包到小程序。
- 已安装微信开发者工具时，会调用其官方WXML/WXS与WXSS离线编译器。默认定位标准Windows安装目录；其他路径通过 `WECHAT_COMPILER_DIR`指定。找不到会明确标注跳过，不能据此宣称模板验收。
- `npm run verify:live`：需先构建同项目后端。SQLite以 `readonly: true`打开，临时注入**无调度/管理禁用**API，执行真实HTTP GET及唯一的无状态体检POST，并将响应交给构建后的页面逻辑和网络字段校验；所有SQLite表前后快照必须一致。默认使用项目现有数据库与停售配置，可用 `SSQ_VERIFY_DATABASE`、`SSQ_VERIFY_CALENDAR`指定测试文件。
- 只读联调结束自动关闭临时监听，不留下后台进程。Node中的wx.request桥接与离线模板编译不替代微信模拟器/真机、触控、读屏、安全区和上传包大小验收。
- 如需自动化模拟器验收，请在微信开发者工具**设置 → 安全设置**开启服务端口。当前机器该端口关闭，CLI调用被拒绝，尚未完成模拟器连后端验收；脚本不会擅自更改此设置，也不会上传/发布。

## 第三方资源与隐私

构建仅使用TDesign实际组件依赖，保留其MIT许可证。按钮/标签/输入所需图标依赖的官方字体原本使用CDN；为避免额外网络请求，本工程缓存 [assets/tdesign-icons-0.4.5.woff](assets/tdesign-icons-0.4.5.woff)，构建时校验后内联，不动态下载字体。

- 来源：<https://tdesign.gtimg.com/icon/0.4.5/fonts/t.woff>，TDesign官方0.4.5图标字体。
- SHA-256：`377024275d01176d32461000713af752fbefb0d2520c49b0aeda82a3a3150b54`。
- 上游组件安装与许可说明：<https://tdesign.tencent.com/miniprogram/getting-started>。
- 不打包Upload、地图或登录业务。号码/哈希复制仅由用户点击触发，写入剪贴板，不读取剪贴板；生产隐私指引、IP日志策略及小程序类目/主体仍须上线前核实。
