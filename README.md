# SillyTavern API 账户管理器

一个面向 **SillyTavern 1.14.x** 的轻量第三方扩展，用来集中管理多个 API 账户和模型。它不需要构建步骤，仓库内容可以直接放入酒馆的第三方扩展目录。

## 功能

- 填写 API 地址和 Key，调用 OpenAI 兼容的 `GET /models` 获取模型并选择默认模型。
- 为账户设置名称和分组，按分组筛选、编辑、删除。
- 对支持余额接口的服务商查询余额；支持自定义余额 URL、点号字段路径（例如 `data.balance`）和货币单位。
- 提供 OpenAI、DeepSeek、OpenRouter、硅基流动、月之暗面、智谱、Groq、Together AI 等常用预设。
- 可手动把保存的账户应用到当前酒馆连接设置；可按间隔自动刷新余额。
- API Key 默认不回显到列表，编辑时将输入框留空即可保留原 Key。

## 安装

### 从 GitHub 安装（推荐）

1. 在 SillyTavern 打开 **扩展 → 安装扩展**。
2. 在 Git URL 输入框粘贴本仓库地址：

   ```text
   https://github.com/djskfjs/sillytavern-api-manager
   ```

3. 分支或标签输入框留空，点击 **Install just for me（仅为我安装）**。只有需要给所有用户安装时，才选择 **Install for all users**。
4. 安装完成后重新加载页面，在扩展设置中找到“API 账户管理”。

仓库根目录已包含扩展清单和运行文件，无需下载 ZIP、编译或手动复制文件。后续可在酒馆的扩展管理中检查更新。

### 手动安装

如果不使用安装器，将本仓库文件夹复制到当前用户的扩展目录（1.14.0 默认是 `data/<用户>/extensions/`）：

```text
SillyTavern/data/default-user/extensions/sillytavern-api-manager/
```

多用户部署时把 `default-user` 换成实际用户目录名。管理员要安装为所有用户时，才使用酒馆的全局第三方扩展目录 `public/scripts/extensions/third-party/`。目录中应至少包含 `manifest.json`、`index.js`、`settings.html` 和 `style.css`。然后重启酒馆。

## 使用

1. 从“常用 API”选择预设，或选择自定义并填写 API 基础地址。
2. 输入 Key，点击“获取模型”，在模型下拉框中选择默认模型。
3. 填写账户名称和可选分组，点击“保存账户”。
4. 对账户点击“应用”，然后到酒馆的 API 连接面板核对设置并点击连接；点击“余额”可立即查询。

当前版本的“应用”对自定义连接控件的适配尚不完整。使用中转站或其他 OpenAI 兼容服务时，请在酒馆的“聊天补全 → 自定义（OpenAI 兼容）”中手动确认 API 地址、Key 和模型。

## 余额接口说明

不同服务商的余额接口和返回字段并不统一。预设只提供已知的 URL/字段；如果服务商没有公开余额接口，账户会显示“未配置接口”。对于其他服务商，可在“余额查询设置”中填写完整余额 URL 和字段路径。余额请求使用浏览器 `fetch`，如果服务商没有允许跨域（CORS），浏览器会拒绝请求；这不是扩展可以绕过的限制，可改用酒馆后端代理或配置服务商的 CORS。

## 安全与隐私

Key 会随 SillyTavern 的扩展设置保存在本机浏览器/服务器设置中，并会直接发送到你填写的服务商接口。扩展不会把 Key 写入日志、账户列表或 GitHub；请不要把包含个人设置文件的目录提交到仓库，也不要把 Key 写进预设或源码。删除账户会同时删除本地保存的 Key。

## 兼容性

- 目标版本：SillyTavern 1.14.0 及相近 1.14.x 版本。
- 模型获取协议：OpenAI 兼容 `GET <baseUrl>/models`，响应支持 `{ data: [{ id }] }`、`{ models: [...] }` 等常见格式。
- “应用”按钮会尝试填充酒馆 1.14.x 的 OpenAI/自定义连接控件；如果当前页面没有打开连接设置，仍可正常保存和管理账户。

## 开发

这是无构建依赖的 ES module 扩展。修改后把仓库目录放回 `public/scripts/extensions/third-party/`，刷新页面即可验证。提交前建议运行：

```bash
node --check index.js
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
