# 源码检查

需要独立 Node.js 24 和匹配的 Core 本地归档。安装脚本默认禁用；本组件没有额外的第三方运行时依赖。

```powershell
npm install --no-save --package-lock=false --strict-peer-deps --ignore-scripts CORE_TGZ
npm test
node test/browser-smoke.mjs 'EDGE_EXECUTABLE'
```

浏览器检查使用已安装 Edge 的绝对路径、独立无界面配置及本机合成页面，不读取登录、真实会话或日常浏览器配置。它验证真实 DOM/CSS、source=null 的原生消息形状、异步元数据和导航竞争，不代表已在某个实际 Codex 版本完成全部接线。报告和浏览器配置保留在 Temp，不进入包。

实际客户端接线应独立记录程序版本、主窗口及非主窗口的结果。只读接口探测、合成浏览器和完整新部署分别记录，不能互相替代。验证不得关闭其他会话、修改真实配色或开启额外模型请求；涉及实际运行切换前先获得用户允许。
