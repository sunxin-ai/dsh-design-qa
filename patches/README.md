# 本体补丁

`install.mjs` **默认就打这三处补丁**，不需要单独操作，也不需要告诉它 DSH 装在哪。
本文档说明它改了什么、为什么、以及自动打不上时怎么手工重做。

```sh
node install.mjs --route-only        # 打（幂等，已打过会跳过）
node install.mjs --revert-patches    # 还原
node install.mjs --no-patches ...    # 这次不打
```

**只有需要「在对话框里直接粘贴图片」时才需要这三处补丁。**
只用「文件路径 / URL / 附件 id + `deepseek_vision`」的话，加 `--no-patches`，插件独立可用。

三处改动**必须同时存在或同时还原**。只还原准入那一处是安全的（粘图回到被拒绝的原样）；
只还原序列化那两处之一，会让图片撞上 `UNSUPPORTED_CONTENT`，那条会话再也走不下去。
`install.mjs` 把三处当一个事务：任一处算不出来就一个字节都不写。

## 一、消息准入：去掉图片准入拒绝

DSH `0.1.2` 起，准入检查位于 `@deepseek-ai/dsh-api-session-controller` 的
`src/commands.ts`；旧版位于 `@deepseek-ai/dsh-host-apiproxy` 的 `src/api-proxy.ts`。
安装器识别这两个位置，也保留旧位置的还原能力。至少找到一处才算成功；两处都在时都检查。

改对应源码文件与 `lib/index.js`（npm 安装）里的同一段：删掉
`if (hasImage) { … MODEL_DOES_NOT_SUPPORT_IMAGES … }` 整块。

原逻辑在消息准入处直接拒绝，用户粘贴的图片连会话都进不去。移除后图片保留在持久消息里，
界面照常显示一张图。

## 二、`@deepseek-ai/dsh-llm-deepseek`：图片准入处抛错换成文字指针

改的是 `adapter.ts` 里 `if (hasImages)` 那一段的准入判断。模型没声明 `image` 时，原本抛
`UNSUPPORTED_CONTENT`，现在把图片块换成一行

```
[图片 image/png 2940x1912 attachment=sha256:…]（本模型看不到图片内容。…）
```

**声明了 `image` 的模型走 else 分支，原生通路一个字节都不动。**

改写的是 `options` 本身：它和后面 `this.request(options, …)` 用的是同一个变量，
而 `attachments` 保持 `undefined`，于是自然走 `serializeRequest` 而不是
`serializeRequestWithImages`。

**为什么放在这一站**：这是消息通往 DeepSeek 的最后一步。此前每一站 —— 持久化、会话日志、
界面渲染 —— 看到的都还是真正的图片块，所以**用户在气泡里看到的是一张图**，证据也完整留档。

### 这处落点搬过家

DSH `0.1.0-rc.8` 之前，准入判断在 `serialize.ts` 的 `assertTextOnly()`，本插件 0.1.3 及
更早打的就是那里。rc.8 引入原生图片通路后判断上移到 `adapter.ts`，序列化那处**再也够不着**
（只有「消息里没有图片」时才会执行到，而那种情况它本来就不抛错）。

`serialize.ts` 仍留在落点表里，但**只还原、不打补丁** —— 从表里删掉它会让升级上来的用户
留下一个撤不掉的改动。安装时若发现那份文件还带着旧补丁，安装器会硬停并要求先
`--revert-patches`。

## 三、`@deepseek-ai/dsh-llm-pi-ai`：同样把抛错换成文字指针

`llm-pi-ai` 是 DSH 里配置**任意 OpenAI 兼容端点**的通用适配器，它有一句与 DeepSeek 那边
一模一样的拦截：

```ts
if (containsImage && !model.input.includes('image')) {
  throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
}
```

只打前两处的话，「粘贴图片」仅对 DeepSeek 路由成立 —— 你自己接的其它纯文本端点会在准入处
被放行、然后死在这一句上。补上这处，**任何纯文本路由**都成立。

**不能只是删掉抛错。** 删了之后图片会照常转成 pi-ai 的 image 块发给不收图的端点，
换来一个供应商侧的报错，比原来那个清晰失败更糟。所以同样换成文字指针，
并让 `containsImage` 从改写后的消息重新计算 —— 否则后面那句「图片输入需要附件服务」会误伤。

声明了 `input: [text, image]` 的路由**原样放行**，图片照常送进去：这条补丁只对纯文本路由生效。

## 脚本怎么找到 DSH

按 profile 的 `node_modules` 解析上述准入包与两个 LLM 适配器，
`realpath` 之后就是包根目录。拿到的正是运行中的 dsh
实际加载的那份：npm 安装时是真实目录，源码运行时那里是指向仓库 workspace 的软链。
依次尝试的基点：`$DSH_HOME/profiles/<profile>`、`$DSH_HOME/profiles`、本包目录、PATH 上的 `dsh`。

**`DSH_REPO` 只是覆盖开关**，自动定位不对时才需要：

```sh
DSH_REPO=<DSH 源码仓库根> node install.mjs --route-only
```

一个包下 `src/*.ts` 与 `lib/index.js` 都存在时**两份都改**。无法可靠判断哪份是活的
（源码运行走 tsx + tsconfig paths → `src/`；npm 安装走 exports → `lib/index.js`），
而半打状态正是要消灭的失败模式。

## 匹配与备份

不用 `git apply`：那需要仓库、需要精确的上下文行，npm 装的 DSH 两样都没有。
改成按代码形态定位锚点 —— 以 `if (hasImage) {` 的缩进为界、以那句
`Reject core image content` 注释为界 —— 同一条正则同时命中 TS 源码与构建产物。

- **幂等**：改过的文件里留有 `DSH-DESIGN-QA-PATCH` 标记，见到就跳过。
- **备份**：改动前原文另存为 `<原文件名>.dsh-design-qa-orig`，`--revert-patches` 按字节拷回。
- **失败要响**：锚点找不到就打印 `✗` 并以非零码退出，绝不静默跳过 ——
  「装完粘图被拒、脚本却显示一切正常」是最难查的一类失败。

## 手工重做

自动打不上（上游改了那几处的写法）时照着上面三节改即可，改动本身很小：
一处是删掉一个 `if` 块，一处是把抛错换成返回文字指针。

要注入的完整代码就在 `install.mjs` 里 —— `ADMISSION`、`DS_POINTER`、`PI_POINTER`、
`PI_CONTEXT` 各自兼容 TS 源码与构建产物。

改完想让脚本认账（后续能幂等跳过、能 `--revert-patches`），在改动处留一行含
`DSH-DESIGN-QA-PATCH` 的注释，并把改动前的原文另存为
`<原文件名>.dsh-design-qa-orig`。

## 升级 DSH 之后

被改的文件被新版覆盖，标记随之消失，表现是「粘图又被拒了」。重跑一次即可：

```sh
node install.mjs --route-only
```

## 官方发布多模态那天

补丁与插件都不需要改动，也不必移除：`routeAcceptsImages` 届时会判定路由接受图片，
`deepseek_vision` 自我拒绝并让位，图片直接进入模型上下文走官方原生通路。
