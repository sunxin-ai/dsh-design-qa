#!/usr/bin/env node
/**
 * dsh-design-qa 的安装与重启，一份实现覆盖 macOS / Linux / Windows。
 *
 * 为什么用 Node 而不是 shell：DSH 自身要求 `node ^22.19 || >=24`，所以 Node 一定在；
 * 而 bash 在 Windows 上不一定有，`pgrep` / `pkill` / `lsof` / `setsid` 更是一个都没有。
 * 写三份平台脚本的结果是三份各自腐坏，所以只留这一份。
 *
 *   node install.mjs [profile]            安装（profile 默认 web）
 *   node install.mjs --route-only         只补路由/skill/补丁，不写插件行
 *                                         （从 GitHub 用 `dsh plugin add` 装时用这个）
 *   node install.mjs --no-patches         不给 DSH 本体打补丁（粘贴图片将仍被拒绝）
 *   node install.mjs --revert-patches     还原本体补丁并退出
 *   node install.mjs --check-patches      只检查三处锚点认不认得出当前 DSH，不写盘（CI 用）
 *   node install.mjs --restart            只重启，可从 dsh 自己的进程内部调用
 *                                         （加 --force 可无视重启前体检的拦截）
 *
 * 重启相关的环境变量（都只在自动探测不成时才需要）：
 *   DSH_PROCESS_PATTERN  用来认出 dsh 进程的命令行片段
 *   DSH_CWD              dsh 的工作目录（Windows 上没有 /proc 也没有 lsof，必须给）
 *   DSH_RESTART_CMD      dsh 的完整启动命令
 *
 * **本体补丁默认就打**，且自动定位 DSH —— 不需要源码仓库，npm 装的也认。
 * 打不上就硬报错并以非零码退出：装完粘贴图片被拒、脚本却显示成功，是最难查的一类失败。
 *
 * 平台差异只剩「列出进程」一处需要分支，其余用 Node 原生 API 抹平。
 * @module dsh-design-qa/install
 */
import { execFile, spawn } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, symlinkSync, copyFileSync, realpathSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, platform } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const WIN = platform() === 'win32'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 「settings.yaml 里像是配过 bailian 路由了」。写入判断与自检共用，避免两处口径不一致。 */
const ROUTE_PRESENT = /^ *bailian:/m

const bold = (text) => `[1m${text}[0m`
const warn = (text) => console.log(`[33m${text}[0m`)

/**
 * 备份一个文件，并只回收**本脚本自己写过**的旧备份。
 *
 * 回收的匹配串是脚本自己的完整格式 `.bak-<14位数字>-<pid>`，绝不按 `.bak-` 前缀通配 ——
 * 那样会连用户手工留的备份一起删掉，而 `rmSync` 不可撤销。
 * 排序也按 mtime 而非字典序：字母后缀在字典序里排在数字后面，会导致「保留最新」实际保留最旧。
 * @param path - 要备份的文件；不存在则跳过。
 */
function backup(path) {
  if (!existsSync(path)) return
  const dir = dirname(path)
  const own = new RegExp(`^${basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak-\\d{14}-\\d+$`)
  const mine = readdirSync(dir)
    .filter(entry => own.test(entry))
    .map(entry => ({ entry, time: statSync(join(dir, entry)).mtimeMs }))
    .sort((a, b) => a.time - b.time)
  for (const { entry } of mine.slice(0, -2)) rmSync(join(dir, entry), { force: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '')
  copyFileSync(path, `${path}.bak-${stamp}-${process.pid}`)
}

/**
 * 建立软链；Windows 上非管理员且未开开发者模式时会失败，退化为复制。
 * 复制的代价是「包内那份不再是唯一来源」，所以只在不得已时用，并明确告知。
 */
function linkOrCopy(target, linkPath) {
  // 目标不存在时 symlinkSync 仍会成功，只是造出一条悬空链 —— 那比报错更难查。
  if (!existsSync(target)) throw new Error(`找不到 ${target}，无法链接到 ${linkPath}`)
  rmSync(linkPath, { recursive: true, force: true })
  try {
    symlinkSync(target, linkPath, WIN ? 'junction' : 'dir')
    return 'link'
  } catch {
    cpSync(target, linkPath, { recursive: true })
    return 'copy'
  }
}

/**
 * 列出进程的 pid 与命令行。**这是唯一需要按平台分支的地方。**
 * Node 没有可移植的进程枚举 API，只能各叫各的系统命令。
 */
async function listProcesses() {
  if (WIN) {
    const { stdout } = await run('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'])
    const rows = JSON.parse(stdout || '[]')
    return (Array.isArray(rows) ? rows : [rows])
      .filter((row) => row?.CommandLine)
      .map((row) => ({ pid: row.ProcessId, command: row.CommandLine }))
  }
  const { stdout } = await run('ps', ['-Ao', 'pid=,command='])
  return stdout.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    return match === null ? undefined : { pid: Number(match[1]), command: match[2] }
  }).filter((entry) => entry !== undefined)
}

/**
 * 读另一个进程的工作目录。**必须从被重启的那个进程读**，不能用本脚本自己的 ——
 * 用安装脚本自己的 cwd 去拉起，命令里的相对路径（如 `--patch ./some.cordis.yml`）会全部失效：
 * 旧进程已被杀掉，新进程却起不来。
 *
 * Node 没有可移植 API：Linux 读 /proc，macOS 用 lsof，Windows 两者都没有 —— 那里需要显式给 DSH_CWD。
 */
async function processCwd(pid) {
  if (process.env.DSH_CWD !== undefined) return process.env.DSH_CWD
  if (platform() === 'linux') {
    try { return await readlink(`/proc/${pid}/cwd`) } catch { /* 权限或已退出 */ }
  }
  if (!WIN) {
    try {
      const { stdout } = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      const line = stdout.split('\n').find((entry) => entry.startsWith('n'))
      if (line !== undefined) return line.slice(1)
    } catch { /* 没装 lsof */ }
  }
  return undefined
}

/**
 * dsh 的几种启动形态。npm 安装最常见的是**通过 bin 垫片**起（`node node_modules/.bin/dsh web`），
 * 全局安装则是垫片软链到入口、由 shebang 交给 node（命令行里出现 `dsh/lib/bin.js`）。
 */
const DSH_PATTERNS = ['.bin/dsh', 'dsh/lib/bin.js', 'apps/cli/src/bin.ts', 'bin.js web', 'bin.ts web']

/**
 * 这条命令行是不是「真的在跑一个程序」，而不是某个恰好提到了匹配串的 shell。
 *
 * 光按子串匹配会误伤：调用方自己的 shell 命令里若出现 `dsh/lib/bin.js`
 * （比如它正打算 grep 一下 dsh 进程），那条 shell 就会被当成 dsh 本身。
 * 真正的 dsh 一定由 node 拉起，或者是 dsh 垫片自己。
 */
function looksLikeLaunch(command) {
  const first = command.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, '') ?? ''
  const base = basename(first).replace(/\.(exe|cmd)$/i, '')
  return base === 'node' || base === 'dsh'
}

/** 找到正在运行的 dsh。内置候选覆盖源码运行与 npm 安装两种形态。 */
async function findDsh() {
  const explicit = process.env.DSH_PROCESS_PATTERN
  const processes = await listProcesses()
  const self = process.pid
  // 显式给了匹配串就完全照办 —— 用户比启发式更清楚自己怎么起的 dsh。
  if (typeof explicit === 'string' && explicit.length > 0) {
    const hit = processes.find((entry) => entry.pid !== self && entry.command.includes(explicit))
    return hit === undefined ? undefined : { ...hit, pattern: explicit }
  }
  for (const pattern of DSH_PATTERNS) {
    const hit = processes.find((entry) => entry.pid !== self
      && entry.command.includes(pattern)
      && looksLikeLaunch(entry.command))
    if (hit !== undefined) return { ...hit, pattern }
  }
  return undefined
}

/** 重启的日志。进程是 detached 的，没有终端可回显；不落盘就等于失败无声。 */
const RESTART_LOG = join(DSH_HOME, 'dsh-design-qa-restart.log')

/**
 * 列出另一个进程的环境变量**名**（不取值）。
 *
 * 只要名字：这里的用途是「提醒哪些变量会在重启中丢掉」，取值既没必要也不该做。
 * Linux 读 `/proc`，macOS 用 `ps eww`（它把环境接在命令行后面，含空格的值会被切碎 ——
 * 对取名字无妨）。Windows 两者都没有，返回空集，退化成不提醒。
 */
async function processEnvNames(pid) {
  const names = new Set()
  const harvest = (text, sep) => {
    for (const entry of text.split(sep)) {
      const eq = entry.indexOf('=')
      if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.slice(0, eq))) names.add(entry.slice(0, eq))
    }
  }
  if (platform() === 'linux') {
    try { harvest(await readFile(`/proc/${pid}/environ`, 'utf8'), '\0'); return names } catch { /* 权限不足 */ }
  }
  if (!WIN) {
    try { harvest((await run('ps', ['eww', '-p', String(pid)])).stdout, /\s+/) } catch { /* 没有 ps */ }
  }
  return names
}

/**
 * 重启会丢掉哪些密钥类环境变量。
 *
 * `--restart` 让新进程**继承调用方的环境**。跑在 dsh 里的 agent 调用时这天然正确，
 * 但从别的终端调用时，只 export 在原终端里的 `BAILIAN_API_KEY` 会就此消失 ——
 * 插件还在、路由还在、界面一切正常，只有识图调用 401。这种「装好了却用不了」最难查，
 * 所以宁可在重启前把名字列出来。
 *
 * 只比对 settings.yaml 里 `apiKeyEnv` 点名的变量，以及名字像密钥的那些；
 * 全量比对会把 TERM_SESSION_ID 之类的噪音一起报出来。**只报名字，不读值。**
 */
async function lostSecrets(pid) {
  const settings = existsSync(join(DSH_HOME, 'settings.yaml')) ? readFileSync(join(DSH_HOME, 'settings.yaml'), 'utf8') : ''
  const declared = new Set([...settings.matchAll(/^\s*apiKeyEnv:\s*(\S+)/gm)].map((match) => match[1]))
  const names = await processEnvNames(pid)
  return [...names].filter((name) => (declared.has(name) || /(_API_KEY|_TOKEN|_SECRET)$/.test(name))
    && process.env[name] === undefined).sort()
}

/**
 * 拉起时**实际会跑的那个 node**。
 *
 * 命令行第一个词是 node（可能带绝对路径）就用它自己那份；否则是 `dsh web` 这类
 * npm 垫片，垫片走 `#!/usr/bin/env node`，跑的就是 PATH 上那个。
 * 查错对象会两头出错：命令里写死了新 node 却去查旧的 PATH → 误拦；
 * 反过来命令里是旧 node 而 PATH 是新的 → 漏拦，杀完起不来。
 */
function relaunchNodeBin(command) {
  const first = command.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, '') ?? ''
  return basename(first).replace(/\.exe$/i, '') === 'node' ? first : 'node'
}

/**
 * 那个 node 能不能跑 DSH。**必须在杀掉旧进程之前问**。
 *
 * 本命令继承调用方的环境。跑在 dsh 里的 agent 调用时这天然正确（它看到的就是 dsh
 * 自己的环境），但从别处调用 —— 另一个终端、另一个 agent —— PATH 上的 node 可能是
 * 系统那份旧版本。DSH 要求 `^22.19 || >=24`，旧版起不来，而旧进程此时已经被杀了，
 * 结果是「DSH 没了，且没有任何地方说为什么」。
 * @returns `{ text, ok, bin }`；探测不到（跑不起来那个 node）返回 undefined，放行。
 */
async function relaunchNodeVersion(command) {
  const bin = relaunchNodeBin(command)
  try {
    const { stdout } = await run(bin, ['-v'])
    const [major, minor] = stdout.trim().replace(/^v/, '').split('.').map(Number)
    return { bin, text: stdout.trim(), ok: (major === 22 && minor >= 19) || major >= 24 }
  } catch { return undefined }
}

/**
 * 取被重启进程的**精确 argv**。
 *
 * `ps` 给的命令行是用空格拼起来的，引号全丢。参数里有空格时
 * （`--patch "/some dir/x.yml"`）按空格重新切分就会切错，而此时旧进程已经被杀。
 * Linux 的 `/proc/<pid>/cmdline` 是 NUL 分隔的、无损；别的平台拿不到，
 * 只能退化成「命令行字符串 + 一道可疑性检查」。
 */
async function processArgv(pid) {
  if (platform() === 'linux') {
    try {
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter((part) => part.length > 0)
      if (argv.length > 0) return argv
    } catch { /* 权限或已退出 */ }
  }
  return undefined
}

/**
 * 命令行按空格切开后，有没有「明确是路径、却并不存在」的碎片？
 * 那就是引号被 `ps` 丢掉、参数被切碎的信号 —— 照这条命令拉起必然失败。
 *
 * 只认绝对路径、显式相对路径（`./` `../`）和 Windows 盘符：
 * 含斜杠不等于是路径，`--import tsx/esm` 里的 `tsx/esm` 是模块说明符，
 * 按「含斜杠且不存在」去判会把它误报成切碎的碎片。
 */
function missplitTokens(command, cwd) {
  return command.split(/\s+/).filter((token) => {
    const bare = token.replace(/^["']|["']$/g, '')
    if (!/^(\/|\.\.?[/\\]|[A-Za-z]:[\\/]|\\\\)/.test(bare)) return false
    return !existsSync(bare) && !existsSync(resolve(cwd, bare))
  })
}

/**
 * 重启 dsh。**可以从 dsh 自己的进程内部调用** —— 这是本命令存在的理由：
 * 装完必须冷启动（HMR 关闭），而 agent 往往正跑在要被重启的那个进程里，
 * 直接杀等于自杀，调用方拿不到结果，只能猜自己成功了没有。
 *
 * 做法：把「杀 + 等 + 拉起」交给一个 `detached` 的子进程再 `unref()`，父进程立刻返回。
 * 这是 Node 的跨平台原语，省掉了 shell 版里 setsid + nohup + 临时脚本那一整套变通；
 * 按 pid 杀而不匹配命令行，helper 自己也就不会因为命令行含匹配串而杀掉自己。
 */
async function restart() {
  const target = await findDsh()
  if (target === undefined) {
    warn('找不到正在运行的 dsh 进程。')
    console.log('  若它确实在跑：DSH_PROCESS_PATTERN="<命令行里的唯一片段>" node install.mjs --restart')
    console.log('  若它没在跑：按你平时的方式启动即可，无需本命令。')
    return 1
  }

  // 新进程**继承调用方的环境**，这在主要场景下天然正确：
  // agent 跑在 dsh 进程里，它看到的环境就是 dsh 自己的环境，PATH 与当初启动时完全一致。
  //
  // 两条看似更聪明的路都不可行：
  //   1) 登录 shell（`$SHELL -lc`）—— 只加载 profile；若 Node 装在 profile 之外
  //      （如手动 export 的 ~/.local/node-24），拿到的是系统 Node，DSH 起不来；
  //   2) 从 `ps -E` 抠旧进程的 PATH —— macOS 上抠出坏值，连 pkill 都找不到。
  // 继承环境既简单又正好覆盖真实用法：人在终端里跑，用的也正是他启动 dsh 的那个环境。
  const cwd = await processCwd(target.pid)
  if (cwd === undefined) {
    warn('读不到该进程的工作目录，无法安全重启（命令里的相对路径会失效）。')
    console.log('  显式指定后重试：DSH_CWD="<dsh 的工作目录>" node install.mjs --restart')
    return 1
  }

  // 拿得到精确 argv 就按数组拉起（不经 shell，引号与空格无损）；
  // 拿不到就退化成命令行字符串，并检查它有没有被 `ps` 切碎。
  const argv = process.env.DSH_RESTART_CMD === undefined ? await processArgv(target.pid) : undefined
  const command = process.env.DSH_RESTART_CMD ?? target.command

  // 三道体检都在**杀进程之前**做，而且一次报全：分两次报的话，用户修好第一条、
  // 重跑、才发现还有第二条 —— 而这中间旧进程已经死了。
  const self = JSON.stringify(join(HERE, 'install.mjs'))
  const blockers = []
  const version = await relaunchNodeVersion(argv?.[0] ?? command)
  if (version !== undefined && !version.ok) {
    blockers.push([
      `拉起要用的 node（${version.bin}）是 ${version.text}，DSH 要求 ^22.19 || >=24 —— 现在重启会把 DSH 杀掉且起不来。`,
      '  本命令继承你当前 shell 的环境。先把够新的 node 放上 PATH：',
      `    PATH="<node24 目录>/bin:$PATH" node ${self} --restart`,
      '  跑在 dsh 里的 agent 一般碰不到这条：它继承的就是 dsh 自己的环境。',
    ])
  }
  const lost = await lostSecrets(target.pid)
  if (lost.length > 0) {
    blockers.push([
      `旧进程有这些密钥类环境变量，而当前 shell 没有 —— 重启后会丢：${lost.join('、')}`,
      '  后果是「装好了却用不了」：插件、路由、界面都正常，只有识图调用 401。',
      `    ${lost.map((name) => `${name}=<你的 key>`).join(' ')} node ${self} --restart`,
      '  或者把 key 存进 DSH 的凭据服务（设置 → 模型），从此不受重启影响。',
    ])
  }
  const missplit = argv === undefined ? missplitTokens(command, cwd) : []
  if (missplit.length > 0) {
    blockers.push([
      `读到的命令行里有这些不存在的路径碎片：${missplit.join('、')}`,
      '  说明原命令的参数里带空格，而系统只给得出用空格拼起来的命令行，切分已经错了。',
      '  照这条拉起必然失败，所以先停手。把完整命令显式给出即可：',
      `    DSH_RESTART_CMD='<dsh 的完整启动命令>' node ${self} --restart`,
    ])
  }
  if (blockers.length > 0 && !process.argv.includes('--force')) {
    warn(`重启前发现 ${blockers.length} 处问题，就此打住 —— 旧进程还活着。`)
    for (const lines of blockers) { console.log(''); warn(`  · ${lines[0]}`); for (const line of lines.slice(1)) console.log(`  ${line}`) }
    console.log(`\n  确认无妨、仍要继续：node ${self} --restart --force`)
    return 1
  }

  console.log(bold('将重启'))
  console.log(`  pid   = ${target.pid}（匹配 "${target.pattern}"）`)
  console.log(`  cmd   = ${argv === undefined ? command : argv.join(' ')}${argv === undefined ? '' : '（按精确 argv 拉起）'}`)
  console.log(`  cwd   = ${cwd}`)
  console.log(`  node  = ${version?.text ?? '（探测不到，未检查）'}`)
  console.log(`  日志  = ${RESTART_LOG}`)

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--relaunch-worker'], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DSH_RELAUNCH_PID: String(target.pid),
      DSH_RELAUNCH_CMD: command,
      DSH_RELAUNCH_CWD: cwd,
      ...argv === undefined ? {} : { DSH_RELAUNCH_ARGV: JSON.stringify(argv) },
    },
  })
  child.unref()

  console.log('\n已在后台安排重启，本命令立即返回（调用方不会被连带杀掉）。')
  console.log('约 2 秒后旧进程停止，随后新进程拉起；起不来的话原因写在上面那份日志里。')
  return 0
}

/** 后台工作进程：等父进程放手、杀旧的、等它真退出、再拉起新的。 */
async function relaunchWorker() {
  const pid = Number(process.env.DSH_RELAUNCH_PID)
  const command = process.env.DSH_RELAUNCH_CMD ?? ''
  const cwd = process.env.DSH_RELAUNCH_CWD

  await new Promise((done) => setTimeout(done, 2000))
  try { process.kill(pid) } catch { /* 已经退出了 */ }
  // 等它真的走：端口没释放就起，新进程会 EADDRINUSE。
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { process.kill(pid, 0) } catch { break }
    await new Promise((done) => setTimeout(done, 500))
  }
  // 新进程是 detached 的，没有终端可回显。stdio 若丢进 'ignore'，启动失败时
  // （比如 PATH 上的 node 太旧）DSH 会直接消失且**任何地方都没有原因**。
  // 追加写到日志文件，代价只有一个文件，换来失败时有据可查。
  mkdirSync(dirname(RESTART_LOG), { recursive: true })
  const argvJson = process.env.DSH_RELAUNCH_ARGV
  writeFileSync(RESTART_LOG, `\n===== ${new Date().toISOString()} 重启 =====\ncwd: ${cwd}\ncmd: ${argvJson ?? command}\n`, { flag: 'a' })
  const log = openSync(RESTART_LOG, 'a')
  const stdio = ['ignore', log, log]
  // 有精确 argv 就不经 shell 直接拉起 —— 参数里的空格与引号原样传过去。
  // 没有就只能把命令行整串交给 shell 重新解析；环境两种情况都由本进程继承而来。
  if (argvJson === undefined) spawn(command, { cwd, detached: true, stdio, shell: true }).unref()
  else {
    const argv = JSON.parse(argvJson)
    spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio, shell: false }).unref()
  }
}

/** 往 profile 的补丁层写 insert 块。新装的 profile 里这个文件是一句 `[]`。 */
function mountPlugin(profile) {
  // 本包已作为 bundle 装进这个 profile 时，插件行由包内 cordis.patch.yml 提供。
  // 此时再往 profile 补丁层写一条同 id 的行，Loader 会在启动时抛
  // `duplicate loader entry id: design-qa`，**整个 profile 起不来**
  // （不是「后层覆盖前层」，两条都在；也与有没有 tsx 无关）。
  // 报错来自 cordis loader 内部，既不提插件名也不给修复方式，所以在这里挡住。
  const manifest = join(DSH_HOME, 'profiles', profile, 'package.json')
  if (existsSync(manifest)) {
    const bundles = JSON.parse(readFileSync(manifest, 'utf8'))?.dsh?.profile?.bundles ?? []
    if (bundles.includes('dsh-design-qa')) {
      return '本包已作为 bundle 装在该 profile，跳过写入插件行（这正是 --route-only 要做的）'
    }
  }
  const patch = join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml')
  const text = existsSync(patch) ? readFileSync(patch, 'utf8') : ''
  if (text.includes('id: design-qa')) return '已存在，跳过'
  backup(patch)
  const entry = `# dsh-design-qa —— 纯文本模型的图像能力。\n`
    + `# 识图路由不在这里声明：补丁层的 config 是整体替换而非深合并，\n`
    + `# 在这里写 llm-pi-ai 会抹掉 settings.yaml 里已有的其它路由。\n`
    // 指构建产物而不是 src/index.ts：npm 发布的 dsh 入口是 `lib/bin.js`，plain node 跑，
    // **没有 tsx**（tsx 只在源码启动 `node --import tsx/esm` 时存在），加载 .ts 会直接失败。
    // lib/index.js 是入库的，两种形态下都在。
    + `- insert:\n    - id: design-qa\n      name: ${JSON.stringify(join(HERE, 'lib', 'index.js'))}\n`
    + `      config:\n        provider: bailian\n        model: qwen3.8-max\n`
  // 去掉注释与空行后只剩 `[]` 的话，必须**替换**而不是追加 ——
  // `[]` 后面再跟 `- item` 是非法 YAML，dsh 启动时直接 parse error。
  const body = text.split('\n').filter((line) => line.trim() && !line.trimStart().startsWith('#')).join('\n').trim()
  const next = body === '[]' || body === ''
    ? `${text.replace(/^\s*\[\s*\]\s*$\n?/m, '').trimEnd()}\n\n${entry}`
    : `${text.trimEnd()}\n\n${entry}`
  mkdirSync(dirname(patch), { recursive: true })
  writeFileSync(patch, next.trimStart(), 'utf8')
  return '已写入（原文件已备份）'
}

/** 往 settings.yaml 写识图路由。只写结构，不写密钥 —— apiKeyEnv 指向环境变量名。 */
function writeRoute() {
  const settings = join(DSH_HOME, 'settings.yaml')
  const text = existsSync(settings) ? readFileSync(settings, 'utf8') : ''
  // 与 6/6 自检同一条正则：严格按 4 空格判断的话，settings.yaml 被 DSH 的写入器
  // 重排过缩进就会漏判，于是写出第二个 bailian 键。
  if (ROUTE_PRESENT.test(text)) return '已存在，跳过'
  backup(settings)
  const route = [
    '    bailian:',
    '      displayName: 阿里百炼',
    '      apiKeyEnv: BAILIAN_API_KEY',
    '      api: openai-completions',
    '      baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1',
    '      compat:',
    '        thinkingFormat: qwen',
    '      models:',
    '        - id: qwen3.8-max',
    '          name: Qwen3.8-Max (识图)',
    '          input: [text, image]',
    '          contextWindow: 262144',
    '          maxTokens: 8192',
    '          reasoningEfforts:',
    '            off:',
    '            high: high',
    '',
  ].join('\n')
  // 已有 llm-pi-ai 段就挂进它的 providers 下，不动其它路由；没有就整段补上。
  const next = /^llm-pi-ai:/m.test(text)
    ? text.replace(/^llm-pi-ai:\n( *providers:\n)?/m, (all) => `${all.includes('providers:') ? all : `${all}  providers:\n`}${route}`)
    : `${text.trimEnd()}\n\nllm-pi-ai:\n  providers:\n${route}`
  writeFileSync(settings, next, 'utf8')
  return '已写入（密钥仍走 BAILIAN_API_KEY 环境变量）'
}

/* ────────────────────────── DSH 本体补丁 ────────────────────────── */

/**
 * 写进被改文件里的标记，用来判断「已经打过」。
 *
 * 比另存一份状态文件可靠：升级 DSH、重装依赖会覆盖掉被改的文件，标记随之消失，
 * 于是下次安装自然会重打。状态文件则会留下「以为打过、其实没有」的假象。
 */
const MARK = 'DSH-DESIGN-QA-PATCH'

/**
 * 改名前用过的标记与备份后缀。
 *
 * 认它们不是洁癖：旧版打过补丁的机器上，文件里留的是旧标记、备份叫旧名字。
 * 新版若不认，`planPatch` 会以为没打过而去找锚点（早被替换掉了）→ 报「锚点找不到」，
 * 而 `planRevert` 会找不到备份 → **那台机器的补丁再也还原不了**。
 */
const LEGACY_MARKS = ['DSH-DEEPSEEK-VISION-PATCH']
const ORIG_SUFFIX = '.dsh-design-qa-orig'
const LEGACY_ORIG_SUFFIXES = ['.dsh-vision-orig']

/** 这份文件是不是本插件（含旧名版本）改过的。 */
function isPatched(text) {
  return text.includes(MARK) || LEGACY_MARKS.some((mark) => text.includes(mark))
}

/** 该文件的原文备份在哪；优先本名，其次旧名。都没有返回 undefined。 */
function origPath(path) {
  for (const suffix of [ORIG_SUFFIX, ...LEGACY_ORIG_SUFFIXES]) {
    if (existsSync(`${path}${suffix}`)) return `${path}${suffix}`
  }
  return undefined
}

/** 还原命令，直接写进补丁注释里 —— 半年后读到这段代码的人不必去翻文档。 */
const REVERT_HINT = `node ${join(HERE, 'install.mjs')} --revert-patches`

/**
 * 落点一：消息准入检查。0.1.2 起从 `dsh-host-apiproxy` 搬到 `dsh-api-session-controller`。
 *
 * 原逻辑发现纯文本路由带图就直接拒绝，用户粘贴的图连会话都进不去。整块移除后，
 * 图片照常进持久消息与会话日志，界面气泡里显示的仍是一张图。
 *
 * 正则同时匹配 TS 源码与构建产物两种形态：以 `if (hasImage) {` 的缩进为锚
 * （`\1`），块尾必然是同缩进的 `}`。两种形态的中间内容不同（构建产物把 `return err(...)`
 * 提成了单行），所以中间用惰性匹配跨过去，只对两端做强约束。
 */
const ADMISSION = {
  id: 'image-admission',
  find: /^([ \t]*)if \(hasImage\) \{[\s\S]*?MODEL_DOES_NOT_SUPPORT_IMAGES[\s\S]*?\n\1\}/m,
  build: (_ts, match) => [
    `${match[1]}// ${MARK} (image-admission)`,
    `${match[1]}// 原处：纯文本路由在消息准入处直接拒绝图片。整块移除。`,
    `${match[1]}// 图片照常入库、界面仍显示图；纯文本适配器在序列化前的最后一刻把它换成`,
    `${match[1]}// 一行 attachment= 文字指针，模型据此调用 deepseek_vision 工具。`,
    `${match[1]}// 与 dsh-llm-deepseek 的 image-pointer 补丁成对：`,
    `${match[1]}// 只还原这一处，粘图回到被拒绝的原样（安全）；只还原那一处，图片会撞上`,
    `${match[1]}// UNSUPPORTED_CONTENT 而使整条会话无法继续。`,
    `${match[1]}// 还原：${REVERT_HINT}`,
  ].join('\n'),
}

/**
 * 落点二：`dsh-llm-deepseek` 的图片准入拦截点。
 *
 * **rc.8 起它搬家了。** 更早的版本在 `serialize.ts` 的 `assertTextOnly()` 抛错，
 * 本插件 0.1.3 及以前打的就是那里。rc.8 引入原生图片通路后，判断上移到了
 * `adapter.ts`：模型没声明 image 就在序列化之前抛错，`serialize.ts` 那处再也够不着。
 *
 * 所以这里替换的是整个 `if (hasImages)` 里的准入段：不支持图片就把图片块换成文字指针，
 * 支持的走 else 分支，**原生通路一个字节都不动**。
 *
 * 改写的是 `options` 本身 —— 它和后面 `this.request(options, …)` 用的是同一个变量，
 * 且 `attachments` 保持 undefined，于是自然走 `serializeRequest` 而不是
 * `serializeRequestWithImages`。指针在这一站才生成，此前每一站（持久化、会话日志、
 * 界面渲染）看到的都还是真正的图片块，用户气泡里仍是一张图，证据完整留档。
 */
const DS_POINTER = {
  id: 'deepseek-image-pointer',
  // 两种形态同一条正则：TS 有 `const model = …` 单独一行，构建产物把它内联进了 if。
  // 结尾兼容 TS 的多行 `)\n}` 与构建产物的单行 `);`。
  find: /^([ \t]*)(?:const model = connection\.models[^\n]*\n[ \t]*)?if \([^\n]*inputModalities\?\.includes\(["']image["']\) !== true\)[\s\S]*?durable attachment service[\s\S]*?UNSUPPORTED_CONTENT["'](?:\);|,?\s*\)\s*\})/m,
  build: (ts, match) => {
    const pad = match[1]
    const q = ts ? "'" : '"'
    const undef = ts ? 'undefined' : 'void 0'
    const semi = ts ? '' : ';'
    return [
      pad + '// ' + MARK + ' (deepseek-image-pointer)',
      pad + '// 原处：模型未声明 image 就抛 UNSUPPORTED_CONTENT。rc.8 起这里是图片准入的实际拦截点。',
      pad + '// 改成把图片块换成一行 attachment= 文字指针，模型据此调用 deepseek_vision 工具。',
      pad + '// 声明了 image 的模型走 else 分支，原生通路完全不受影响。',
      pad + '// 与 dsh-host-apiproxy 的 image-admission 补丁成对，须同时存在或同时还原。',
      pad + '// 还原：' + REVERT_HINT,
      pad + 'if (connection.models.find((entry) => entry.id === options.model)?.inputModalities?.includes(' + q + 'image' + q + ') !== true) {',
      pad + '  options = { ...options, messages: options.messages.map((message) => ({ ...message,',
      pad + '    content: message.content.map((block) => block.type !== ' + q + 'image' + q + ' ? block',
      pad + '      : ({ type: ' + q + 'text' + q + (ts ? ' as const' : '') + ', text: ' + '`[图片 ${block.attachment.mediaType} ${block.attachment.width}x${block.attachment.height} attachment=${block.attachment.attachmentId}]（本模型看不到图片内容。需要知道图上是什么，把这个 attachment= 值传给 deepseek_vision 工具。）`' + ' })) })) }' + semi,
      pad + '} else {',
      pad + '  attachments = this.config.resolveAttachments?.()' + semi,
      pad + '  if (attachments === ' + undef + ') {',
      pad + '    throw new LlmError(' + q + 'DeepSeek image conversion requires the durable attachment service.' + q + ', ' + q + 'UNSUPPORTED_CONTENT' + q + ')' + semi,
      pad + '  }',
      pad + '}',
    ].join('\n')
  },
}

/**
 * 两个落点各自的包名、源码仓库内路径，以及两种形态下的目标文件。
 * `ts` 是源码运行时真正被加载的那份（tsx 走 tsconfig paths → `src/`）；
 * `js` 是 npm 安装时被加载的那份（package.json 的 exports → `lib/index.js`）。
 */
/**
 * 落点三：`dsh-llm-pi-ai` —— 用户自己接的那些纯文本端点。
 *
 * `llm-pi-ai` 是 DSH 里配置任意 OpenAI 兼容端点的通用适配器，它有一句与 DeepSeek 那边
 * 一模一样的拦截：路由没声明 image 就抛 `UNSUPPORTED_CONTENT`。
 * 只打前两处的话，「粘贴图片」仅对 DeepSeek 路由成立；补上这处，**任何纯文本路由**都成立。
 *
 * 不能只是删掉抛错：删了之后图片会照常转成 pi-ai 的 image 块发给不收图的端点，
 * 换来一个供应商侧的报错，比原来那个清晰失败更糟。所以同样换成文字指针。
 */
const PI_POINTER = {
  id: 'pi-ai-image-pointer',
  find: /^([ \t]*)const containsImage = options\.messages\.some\(\(?message\)? => contentHasImage\(message\.content\)\);?\n[ \t]*if \(containsImage && !model\.input\.includes\(["']image["']\)\)[\s\S]*?UNSUPPORTED_CONTENT["']\);?(\n[ \t]*\})?/m,
  // 用拼接而不是模板字符串：注入的代码本身含反引号模板，套在模板里要满屏转义。
  build: (ts, match) => {
    const pad = match[1]
    const pointer = '`[图片 ${block.attachment.mediaType} ${block.attachment.width}x${block.attachment.height}'
      + ' attachment=${block.attachment.attachmentId}]（本模型看不到图片内容。'
      + '需要知道图上是什么，把这个 attachment= 值传给 deepseek_vision 工具。）`'
    return [
      pad + '// ' + MARK + ' (pi-ai-image-pointer)',
      pad + '// 原处：路由没声明 image 就抛 UNSUPPORTED_CONTENT。改成把图片块换成一行',
      pad + '// attachment= 文字指针，模型据此调用 deepseek_vision 工具。',
      pad + '// 与 dsh-host-apiproxy 的 image-admission 补丁成对，须同时存在或同时还原。',
      pad + "const dshQaOptions = model.input.includes('image')",
      pad + '  ? options',
      pad + '  : { ...options, messages: options.messages.map((message) => ({ ...message, content: message.content.map((block) => block.type !== ' + "'image'",
      pad + '    ? block',
      pad + "    : ({ type: 'text'" + (ts ? ' as const' : '') + ', text: ' + pointer + ' })) })) }',
      pad + 'const containsImage = dshQaOptions.messages.some((message) => contentHasImage(message.content))',
    ].join('\n')
  },
}

/**
 * 落点三之二：把改写过的 options 真的送进去，否则上面那步白做。
 *
 * 必须整条三元表达式一起匹配，不能只匹配 `toPiContext(options, attachments)` ——
 * 构建产物把 `toPiContext` 的**定义**也打进了同一个文件，那样会改到函数签名上去。
 */
const PI_CONTEXT = {
  id: 'pi-ai-context',
  // 锚住完整的 context 赋值，再只替换其中独立的 `options` 标识符。这样同时覆盖：
  // - 旧版的 `toPiContext(options, ...)`；
  // - 0.1.1-rc.2 起为 watchdog 注入 signal 的 `toPiContext({ ...options, signal: ... }, ...)`。
  // 结尾用下一句 `const events =`（源码）或 `const iterator =`（构建产物）限定，
  // 避免命中同一构建产物里的函数定义。
  find: /const context = attachments === (?:undefined|void 0)[\s\S]*?\btoPiContext\([\s\S]*?\boptions\b[\s\S]*?(?=\n[ \t]*const (?:events|iterator) =)/,
  build: (_ts, match) => match[0].replace(/\boptions\b/g, 'dshQaOptions'),
}

/**
 * 退休判据：这个包**自己**是不是已经声明支持图片输入了。
 *
 * 补丁的存在前提是「本体拒收图片」。上游哪天自己支持了，补丁就从「修复」变成「破坏」——
 * 它会把模型本来看得见的图换成一行文字指针，而 `deepseek_vision` 此时又正好会自我拒绝
 * （见 `src/index.ts` 的调用方能力判断），两头都不接，图就废了。
 *
 * 判据与运行时那处保持一致：`inputModalities` 的数组字面量里明确含 `image` 才算支持。
 * **只认字面量，不求值** —— `llm-pi-ai` 的 `[...model.input]` 取决于用户配置，
 * 那是「用户接了个能看图的端点」，不是「上游自己支持了」，不该被当成退休信号。
 * @returns 命中返回 `{ rel, text }` 供文案引用；未命中返回 undefined。
 */
const MODALITY_DECL = /inputModalities\s*:\s*\[([^\]]*)\]/g

function declaresImageInput(root, probes) {
  for (const rel of probes) {
    const path = join(root, rel)
    if (!existsSync(path)) continue
    for (const match of readFileSync(path, 'utf8').matchAll(MODALITY_DECL)) {
      if (/["\']image["\']/.test(match[1])) return { rel, text: match[0] }
    }
  }
  return undefined
}

const PATCH_TARGETS = [
  {
    // 同一个准入补丁在新旧 DSH 中的位置。至少找到一处；两处都在时都检查，
    // 也保留旧位置的还原能力，避免升级后遗留撤不掉的补丁。
    locations: [
      {
        pkg: '@deepseek-ai/dsh-api-session-controller',
        repoDir: 'packages/api/session-controller',
        forms: { ts: 'src/commands.ts', js: 'lib/index.js' },
      },
      {
        pkg: '@deepseek-ai/dsh-host-apiproxy',
        repoDir: 'packages/host/apiproxy',
        forms: { ts: 'src/api-proxy.ts', js: 'lib/index.js' },
      },
    ],
    edits: [ADMISSION],
  },
  {
    pkg: '@deepseek-ai/dsh-llm-deepseek',
    repoDir: 'packages/llm/llm-deepseek',
    // rc.8 起准入判断在 adapter.ts，补丁与能力声明落在同一个文件里。
    // 另外两处不设退休判据：`api-proxy` 的门禁对所有路由通用，只要还存在纯文本路由就需要；
    // `llm-pi-ai` 那处本就按 `model.input` 动态放行，能看图的端点自然走原生通路。
    forms: { ts: 'src/adapter.ts', js: 'lib/index.js' },
    nativeVision: ['src/adapter.ts', 'lib/index.js'],
    edits: [DS_POINTER],
  },
  {
    // **只还原，不打补丁。** 0.1.3 及更早把补丁打在 serialize.ts 的 assertTextOnly 上；
    // rc.8 把准入判断上移到 adapter.ts 之后那处彻底失效（只有「消息里没有图片」时才会
    // 走到，而那种情况它本来就不抛错）。从落点表里删掉它会留下一个撤不掉的改动 ——
    // 升级上来的用户那份 serialize.ts 仍是改过的，`--revert-patches` 认不出就永远清不掉。
    pkg: '@deepseek-ai/dsh-llm-deepseek',
    repoDir: 'packages/llm/llm-deepseek',
    forms: { ts: 'src/serialize.ts' },
    revertOnly: true,
  },
  {
    pkg: '@deepseek-ai/dsh-llm-pi-ai',
    repoDir: 'packages/llm/llm-pi-ai',
    forms: { ts: 'src/adapter.ts', js: 'lib/index.js' },
    edits: [PI_POINTER, PI_CONTEXT],
  },
]

/**
 * 定位 DSH 本体的包目录 —— **不需要用户知道 DSH 装在哪**，这是本次改动的要点。
 *
 * 按 profile 的 `node_modules` 去解析，拿到的正是运行中的 dsh 实际加载的那份：
 *   - npm 安装 → 解析到 `$DSH_HOME/profiles/node_modules/@deepseek-ai/...` 里的真实目录；
 *   - 源码运行 → 那里是指向仓库 workspace 的软链，`realpathSync` 一步到位。
 * `DSH_REPO` 退化成显式覆盖，只在自动定位不对时才需要。
 * @returns 去重后的包根目录数组；解析不到返回空数组（调用方据此硬报错，不静默跳过）。
 */
function findPackageRoots(pkg, repoDir, profile) {
  const roots = new Set()
  const repo = process.env.DSH_REPO
  if (repo !== undefined && existsSync(join(resolve(repo, repoDir), 'package.json'))) {
    roots.add(realpathSync(resolve(repo, repoDir)))
  }
  for (const base of [join(DSH_HOME, 'profiles', profile), join(DSH_HOME, 'profiles'), HERE, dirname(HERE), ...dshBinBases()]) {
    try {
      // createRequire 需要一个「文件」路径，从它所在目录逐级向上找 node_modules；
      // noop.js 不必存在。exports 里有 "./package.json"，所以这条一定解析得到。
      const found = createRequire(join(base, 'noop.js')).resolve(`${pkg}/package.json`)
      roots.add(dirname(realpathSync(found)))
    } catch { /* 这个 base 解析不到，换下一个 */ }
  }
  return [...roots]
}

/**
 * 从 PATH 上的 `dsh` 可执行文件反推出的解析基点。
 *
 * 兜底用：正常情况下 profile 的 node_modules 是扁平的，前面几个基点就够了；
 * 但包管理器若选择嵌套而不提升，本体依赖就只挂在 dsh 自己的包下面。
 * 两种布局各给一个基点，让 Node 自己去 node_modules 链上找：
 *   - Unix：`dsh` 是软链 → 包内 `lib/bin.js`，上溯两级即包根；
 *   - Windows：`dsh.cmd` 是垫片脚本不是软链，它所在目录就是 npm 前缀目录（其下有 node_modules）。
 */
function dshBinBases() {
  const names = WIN ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  for (const dir of (process.env.PATH ?? '').split(WIN ? ';' : ':')) {
    for (const name of names) {
      const bin = join(dir, name)
      if (!existsSync(bin)) continue
      try {
        const real = realpathSync(bin)
        return [dirname(real), dirname(dirname(real))]
      } catch { /* 悬空链，换下一个 */ }
    }
  }
  return []
}

/** 一个包下所有需要改的文件。两种形态都存在就都改 —— 无法可靠判断哪份是活的，半打状态正是要消灭的失败模式。 */
function formFiles(root, forms) {
  // 只还原的落点可能只给了 ts 一种形态，先滤掉未定义的再拼路径。
  return [forms.ts, forms.js].filter((rel) => rel !== undefined).map((rel) => join(root, rel)).filter((path) => existsSync(path))
}

/**
 * 算出一个文件改完是什么样，**不写盘**。写盘留到所有落点都算成功之后。
 *
 * 用 `exec` + 手工拼接而不是 `String.replace`：替换文本里含 `$` 与反引号，
 * 走 replace 会被当成 `$1` 之类的替换记号吃掉。
 */
function planPatch(path, edits) {
  const before = readFileSync(path, 'utf8')
  if (isPatched(before)) return { path, status: 'already' }
  const ts = path.endsWith('.ts')
  let text = before
  for (const edit of edits) {
    const match = edit.find.exec(text)
    if (match === null) return { path, status: 'no-anchor', edit: edit.id }
    text = text.slice(0, match.index) + edit.build(ts, match) + text.slice(match.index + match[0].length)
  }
  return { path, status: 'patch', before, after: text }
}

/**
 * 算出一个文件还原成什么样，**不写盘**。
 *
 * 关键是「当前这份确实是我们改过的」才还原。DSH 升级会把文件覆盖成新版，
 * 而 `.dsh-design-qa-orig` 还留着**升级前**的内容 —— 此时拷回去等于把 DSH 降级，
 * 且看起来是一次成功的还原。所以没有标记就只清掉这份过期备份。
 */
function planRevert(path) {
  if (!existsSync(path)) return { path, status: 'gone' }
  const patched = isPatched(readFileSync(path, 'utf8'))
  const orig = origPath(path)
  if (orig === undefined) return { path, status: patched ? 'orig-missing' : 'clean' }
  if (!patched) return { path, status: 'stale-orig', orig }
  return { path, status: 'revert', orig, before: readFileSync(path, 'utf8'), after: readFileSync(orig, 'utf8') }
}

/** 每种结果怎么说。`ok:false` 的会让整轮不写盘。 */
const OUTCOMES = {
  patch: { ok: true, write: true, text: (rel) => `✓ ${rel}` },
  revert: { ok: true, write: true, text: (rel) => `✓ ${rel} 已还原` },
  already: { ok: true, write: false, text: (rel) => `· ${rel} 已打过，跳过` },
  clean: { ok: true, write: false, text: (rel) => `· ${rel} 本来就没改过` },
  'stale-orig': { ok: true, write: false, text: (rel) => `· ${rel} 已不是本插件改过的那份（多半 DSH 升级覆盖了它），只清掉过期备份` },
  gone: { ok: false, write: false, text: (rel) => `✗ ${rel} 不存在` },
  'orig-missing': { ok: false, write: false, text: (rel) => `✗ ${rel} 改过但原文已丢，需手工还原，见 patches/README.md` },
  'no-anchor': { ok: false, write: false, text: (rel, plan) => `✗ ${rel} 找不到 ${plan.edit} 的锚点 —— DSH 版本可能已变，需手工重做，见 patches/README.md` },
}

/**
 * 打（或还原）本体补丁。**先把所有落点全算完，全部成功才写盘。**
 *
 * 三处改动是成对的：准入那处放行图片，两个适配器各自把图片换成文字指针。
 * 只打成前一处的话，图片进得了会话、却必定在序列化时抛 `UNSUPPORTED_CONTENT`，
 * 那条会话再也走不下去 —— 比一处都不打糟得多。所以宁可整轮不做。
 * @returns `{ lines, ok }` —— lines 逐条汇报，ok 为 false 时调用方应以非零码退出。
 */
export function patchBody(profile, { revert = false, dryRun = false } = {}) {
  const lines = []
  const plans = []
  let ok = true

  // 第一阶段：只算，不写。
  for (const target of PATCH_TARGETS) {
    const locations = target.locations ?? [target]
    const found = locations.flatMap((location) => findPackageRoots(location.pkg, location.repoDir, profile)
      .map((root) => ({ ...location, root })))
    if (found.length === 0) {
      ok = false
      // 报到「找不到」为止就停手，不去猜路径。这条信息要同时对两类用户成立：
      // npm 装的（没有源码仓库，问题多半出在 DSH_HOME）与源码跑的（需要 DSH_REPO）。
      lines.push(`✗ ${locations.map((location) => location.pkg).join(' / ')}：定位不到，本体补丁没打。`)
      lines.push(`  已在这些位置找过：${DSH_HOME}/profiles[/${profile}]、本包目录、PATH 上的 dsh`)
      lines.push('  npm 装的 DSH：多半是 DSH_HOME 指错了，确认后重跑；')
      lines.push('  源码跑的 DSH：DSH_REPO=<仓库根> node install.mjs --route-only')
      continue
    }
    let seen = 0
    for (const { root, pkg, forms } of found) {
      // 只还原不打补丁的落点：打补丁时必须查一眼，查到残留就硬停。
      // 那份 serialize.ts 若还带着旧补丁，说明用户是从 0.1.3 及更早升上来的 ——
      // 此时新旧两处会同时生效（旧的虽已失效，但 lib/index.js 的标记会让新补丁被判成
      // 「已打过」而跳过），必须先还原干净再装。
      if (target.revertOnly === true && !revert) {
        for (const file of formFiles(root, forms)) {
          if (!isPatched(readFileSync(file, 'utf8'))) continue
          ok = false
          lines.push(`✗ ${file} 仍带着旧版本的补丁（0.1.3 及更早打在这里）。`)
          lines.push('  rc.8 起该处已失效，新补丁改打 adapter.ts。请先还原再装：')
          lines.push(`    node ${join(HERE, 'install.mjs')} --revert-patches`)
        }
        seen += 1
        continue
      }

      // 上游自己支持图片了就别再打 —— 打上去反而会把它能看见的图换成文字指针。
      // **逐份判断**：机器上可能有多份 DSH，新的那份退休了不代表旧的那份也该跳过。
      // 还原路径不看这个判据：已经打过的补丁，无论上游变成什么样都必须能撤掉。
      const retired = revert || target.nativeVision === undefined
        ? undefined
        : declaresImageInput(root, target.nativeVision)
      if (retired !== undefined) {
        // 计入 seen：这一份是「查过且判定不需要」，不是「没找到」，不该触发下面的硬失败。
        seen += 1
        lines.push(`· ${pkg} @ ${root}`)
        lines.push(`  已自己声明支持图片输入，这处补丁不再需要，跳过。`)
        lines.push(`  依据 ${retired.rel}：${retired.text}`)
        lines.push('  若之前打过，先 node install.mjs --revert-patches 撤掉它。')
        continue
      }

      // 打到哪份 DSH 上必须显式打印：万一机器上有多份，用户要能一眼看出改错了没有。
      lines.push(`${revert ? '还原' : '改'} ${pkg} @ ${root}`)
      const files = formFiles(root, forms)
      if (files.length === 0) {
        // npm 包不带退休位置的 serialize.ts，没有它就没有旧补丁需要还原。
        if (target.revertOnly === true) { seen += 1; continue }
        lines.push(`  · 既无 ${forms.ts} 也无 ${forms.js}，跳过`)
        continue
      }
      for (const file of files) {
        const plan = revert ? planRevert(file) : planPatch(file, target.edits)
        const outcome = OUTCOMES[plan.status]
        seen += 1
        lines.push(`  ${outcome.text(file.slice(root.length + 1), plan)}`)
        if (!outcome.ok) ok = false
        if (outcome.write) plans.push(plan)
        if (plan.status === 'stale-orig') plans.push({ ...plan, dropOrig: true })
      }
    }
    if (seen === 0) ok = false
  }

  if (!ok) {
    lines.push('')
    lines.push('以上有失败项，本轮**一个字节都没写** —— 三处改动必须成套，半打的状态会让会话卡死。')
    return { lines, ok }
  }

  // 干跑到此为止：锚点都算得出来就是好的，不写盘。CI 用它盯上游漂移。
  //
  // 「已打过」要单独计数并在全是它时判失败：那种情况下**一个锚点都没被检验**，
  // 却会报成功 —— 一个能静默通过的 CI 比没有 CI 更糟。
  if (dryRun) {
    lines.push('')
    if (plans.length === 0) {
      lines.push('✗ 所有落点都是「已打过」，**没有任何锚点被真正检验**。')
      lines.push('  请对一份未打过补丁的 DSH 跑本命令（CI 里应每次装一份全新的）。')
      return { lines, ok: false }
    }
    lines.push(`${plans.length} 处落点算得出来，未写盘。`)
    return { lines, ok }
  }

  // 第二阶段：写盘。写到一半失败就把已经写过的退回去，绝不留下半打状态。
  const written = []
  try {
    for (const plan of plans) {
      if (plan.dropOrig === true) { rmSync(plan.orig, { force: true }); continue }
      if (plan.status === 'patch') writeFileSync(`${plan.path}${ORIG_SUFFIX}`, plan.before, 'utf8')
      writeFileSync(plan.path, plan.after, 'utf8')
      if (plan.status === 'revert') rmSync(plan.orig, { force: true })
      written.push(plan)
    }
  } catch (error) {
    for (const plan of written.reverse()) {
      writeFileSync(plan.path, plan.before, 'utf8')
      if (plan.status === 'patch') rmSync(`${plan.path}${ORIG_SUFFIX}`, { force: true })
      else writeFileSync(plan.orig, plan.after, 'utf8')
    }
    lines.push(`✗ 写盘失败，已回滚本轮所有改动：${error instanceof Error ? error.message : String(error)}`)
    return { lines, ok: false }
  }
  if (!revert && plans.some((plan) => plan.status === 'patch')) {
    lines.push(`（原文均已另存为 <原文件名>.dsh-design-qa-orig，还原：node ${join(HERE, 'install.mjs')} --revert-patches）`)
  }
  return { lines, ok }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--relaunch-worker')) return relaunchWorker().then(() => 0)
  if (argv.includes('--restart')) return restart()

  const profile = argv.find((arg) => !arg.startsWith('--')) ?? 'web'

  if (argv.includes('--check-patches')) {
    // 只算不写：三处锚点还认不认得出当前这份 DSH。
    // 上游改写了那几处的写法时，这里先红，而不是等用户装完粘图才发现。
    console.log(bold('检查本体补丁的锚点（不写盘）'))
    const { lines, ok } = patchBody(profile, { dryRun: true })
    for (const line of lines) console.log(`     ${line}`)
    if (!ok) {
      warn('\n检查未通过。若是锚点对不上，说明上游改写了那几处的写法，需按 patches/README.md 重做规则。')
      return 1
    }
    console.log('\n锚点都认得出来。')
    return 0
  }

  if (argv.includes('--revert-patches')) {
    console.log(bold('还原 DSH 本体补丁'))
    const { lines, ok } = patchBody(profile, { revert: true })
    for (const line of lines) console.log(`     ${line}`)
    console.log('\n还原后同样需要冷启动才生效：node install.mjs --restart')
    return ok ? 0 : 1
  }

  // 本体补丁默认就打：不打的话，用户装完在对话框里粘图仍会被拒 —— 那正是他要的功能。
  const patches = !argv.includes('--no-patches')
  // 从 GitHub 用 `dsh plugin add` 装的用户，插件行已由 bundle 层提供。
  // 此时不能再写 profile 的 cordis.patch.yml —— 两条同 id 的行会让 Loader 在启动时抛
  // `duplicate loader entry id`，整个 profile 起不来。
  const routeOnly = argv.includes('--route-only')
  if (!existsSync(join(DSH_HOME, 'profiles', profile))) {
    console.error(`找不到 profile：${join(DSH_HOME, 'profiles', profile)}`)
    console.error('用法：node install.mjs [profile] [--route-only] [--no-patches]')
    return 1
  }

  console.log(bold('1/6 解析依赖'))
  const how = linkOrCopy(join(DSH_HOME, 'profiles', 'node_modules'), join(HERE, 'node_modules'))
  console.log(`     node_modules ${how === 'link' ? '已软链' : '已复制（本平台不允许软链）'}`)

  console.log(bold('2/6 安装 skill'))
  mkdirSync(join(homedir(), '.agents', 'skills'), { recursive: true })
  const skill = linkOrCopy(join(HERE, 'skills', 'design-qa'), join(homedir(), '.agents', 'skills', 'design-qa'))
  console.log(`     ~/.agents/skills/design-qa ${skill === 'link' ? '已软链' : '已复制 —— 注意：改包内那份不会同步，需重跑本脚本'}`)

  console.log(bold('3/6 写入识图路由'))
  console.log(`     ${writeRoute()}`)

  console.log(bold(`4/6 挂到 profile：${profile}`))
  console.log(`     ${routeOnly ? '--route-only：跳过（插件行由 bundle 层提供）' : mountPlugin(profile)}`)

  console.log(bold('5/6 给 DSH 本体打补丁（让「粘贴图片」能用）'))
  let patchOk = true
  if (patches) {
    const result = patchBody(profile)
    patchOk = result.ok
    for (const line of result.lines) console.log(`     ${line}`)
  } else {
    warn('     --no-patches：已跳过。在对话框里粘贴图片仍会被拒绝，')
    warn('     只能用「文件路径 / 图片 URL / 附件 id + deepseek_vision」这条路。')
  }

  console.log(bold('6/6 自检'))
  const settings = existsSync(join(DSH_HOME, 'settings.yaml')) ? readFileSync(join(DSH_HOME, 'settings.yaml'), 'utf8') : ''
  const missing = []
  // settings.yaml 由 DSH 的设置写入器维护并会规范化格式（实测 `[text, image]` 被重写成
  // `[ text, image ]`），所以一律宽松匹配 —— 查的是「像不像配过」，不是「配得对不对」。
  if (!ROUTE_PRESENT.test(settings)) missing.push('settings.yaml 里没有 bailian 路由')
  if (!/input:.*\btext\b.*\bimage\b/.test(settings)) missing.push('路由没声明 input: [text, image] —— 这一行是打开图像门禁的开关')
  if (!/thinkingFormat: *qwen/.test(settings)) missing.push('路由没有 compat.thinkingFormat: qwen —— 不关思维会白烧 113 倍 token')
  if (!process.env.BAILIAN_API_KEY) missing.push('当前环境没有 BAILIAN_API_KEY（也可在 Web 的 设置→模型 页存进凭据服务）')
  if (patches && !patchOk) missing.push('本体补丁没打全 —— 粘贴图片会被拒绝，见上一步的 ✗ 行')
  if (missing.length === 0) console.log('     全部就绪')
  else {
    warn('     还差以下几项，见 README「三步装好」：')
    for (const item of missing) warn(`       - ${item}`)
  }

  console.log(`\n${bold('⚠️  必须冷启动才生效')}`)
  console.log('   HMR 是关闭的，插件、skill、profile 补丁、本体补丁都不热加载，刷新浏览器不算。执行：\n')
  console.log(`     node ${JSON.stringify(join(HERE, 'install.mjs'))} --restart\n`)
  console.log('   如果你是跑在 dsh 里的 agent，就用上面这条，不要自己杀进程 ——')
  console.log('   杀了你自己就拿不到结果，也无法确认是否成功。这条会立即返回，重启在你身后完成。')
  // 补丁没打成必须以非零码退出。静默成功的话，用户装完粘图被拒，
  // 却因为脚本显示「一切正常」而无从判断哪一步漏了。
  return patches && !patchOk ? 1 : 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
