import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const installer = fileURLToPath(new URL('../install.mjs', import.meta.url))
const admissionLocations = {
  current: ['dsh-api-session-controller', 'src/commands.ts'],
  legacy: ['dsh-host-apiproxy', 'src/api-proxy.ts'],
}
const admission = `async function admit(hasImage) {
  if (hasImage) {
    const model = await resolveModelInfo()
    if (!model.inputModalities.includes('image')) {
      throw new Error('MODEL_DOES_NOT_SUPPORT_IMAGES')
    }
  }
  return await admitPromptContent()
}
`

function piAdapter(next, contextInput = 'options') {
  const prepared = contextInput === 'request' ? `  const request = options.needsPlaceholder
    ? { ...options, tools: [{ name: 'DeferredToolPlaceholder' }, ...(options.tools ?? [])] }
    : options
` : ''
  return `async function route(options, model) {
${prepared}  const containsImage = options.messages.some(message => contentHasImage(message.content))
  if (containsImage && !model.input.includes('image')) {
    throw new LlmError('model does not support image input', 'UNSUPPORTED_CONTENT')
  }
  const attachments = containsImage ? attachmentService : undefined
  const context = attachments === undefined
    ? toPiContext(${contextInput}, undefined)
    : await toPiContext({ ...${contextInput}, signal: watchdog.signal }, attachments)
  const ${next} = context
  return ${next}
}
`
}

function fixture(t, layouts = ['current'], forms = ['ts', 'js'], contextInput = 'options') {
  const root = mkdtempSync(join(tmpdir(), 'dshqa-install-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const copiedInstaller = join(root, 'install.mjs')
  copyFileSync(installer, copiedInstaller)
  const originals = new Map()
  const admissionFiles = []
  let piJs
  function pkg(name, files) {
    const dir = join(home, 'profiles/node_modules/@deepseek-ai', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, type: 'module', exports: { './package.json': './package.json' } }))
    for (const [rel, text] of Object.entries(files)) {
      const path = join(dir, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
      originals.set(path, text)
    }
    return dir
  }
  for (const layout of layouts) {
    const [name, source] = admissionLocations[layout]
    const files = Object.fromEntries(forms.map(form => [form === 'ts' ? source : 'lib/index.js', admission]))
    const dir = pkg(name, files)
    admissionFiles.push(...Object.keys(files).map(rel => join(dir, rel)))
  }
  pkg('dsh-llm-deepseek', { 'lib/index.js': 'const model = { inputModalities: ["text", "image"] }\n' })
  const pi = pkg('dsh-llm-pi-ai', Object.fromEntries(forms.map(form => [
    form === 'ts' ? 'src/adapter.ts' : 'lib/index.js', piAdapter(form === 'ts' ? 'events' : 'iterator', contextInput),
  ])))
  if (forms.includes('js')) piJs = join(pi, 'lib/index.js')
  function run(options = {}) {
    const code = `import { patchBody } from ${JSON.stringify(pathToFileURL(copiedInstaller).href)}; console.log(JSON.stringify(patchBody('web', ${JSON.stringify(options)})))`
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root,
      env: { ...process.env, DSH_HOME: home, DSH_REPO: join(root, 'no-repo'), PATH: dirname(process.execPath) },
      encoding: 'utf8',
    }))
  }
  function unchanged() {
    for (const [path, text] of originals) {
      assert.equal(readFileSync(path, 'utf8'), text)
      assert.equal(existsSync(`${path}.dsh-design-qa-orig`), false)
    }
  }
  return { originals, admissionFiles, piJs, run, unchanged }
}

for (const layout of Object.keys(admissionLocations)) {
  for (const forms of [['js'], ['ts', 'js']]) {
    test(`${layout}, ${forms.join('+')}: dry run, patch, idempotence, and byte-exact revert`, async (t) => {
      const f = fixture(t, [layout], forms)
      assert.equal(f.run({ dryRun: true }).ok, true)
      f.unchanged()
      assert.equal(f.run().ok, true)
      const patched = new Map([...f.originals.keys()].map(path => [path, readFileSync(path, 'utf8')]))
      for (const path of f.admissionFiles) {
        assert.match(patched.get(path), /DSH-DESIGN-QA-PATCH/)
        assert.doesNotMatch(patched.get(path), /MODEL_DOES_NOT_SUPPORT_IMAGES/)
        const result = await runInNewContext(`${patched.get(path)}; admit(true)`, {
          admitPromptContent: async () => 'attachment validation preserved',
        })
        assert.equal(result, 'attachment validation preserved')
      }
      execFileSync(process.execPath, ['--check', f.piJs])
      const route = runInNewContext(`${patched.get(f.piJs)}; route`, {
        contentHasImage: blocks => blocks.some(block => block.type === 'image'),
        attachmentService: {}, watchdog: { signal: 'watchdog-signal' },
        toPiContext: options => options,
      })
      const options = { messages: [{ content: [{ type: 'image', attachment: {
        attachmentId: 'sha256:fixture', mediaType: 'image/png', width: 2, height: 3,
      } }] }] }
      const textOnly = await route(options, { input: ['text'] })
      assert.match(textOnly.messages[0].content[0].text, /attachment=sha256:fixture/)
      assert.equal(options.messages[0].content[0].type, 'image')
      const vision = await route(options, { input: ['text', 'image'] })
      assert.equal(vision.messages[0].content[0].type, 'image')
      assert.equal(vision.signal, 'watchdog-signal')
      assert.equal(f.run().ok, true)
      for (const [path, text] of patched) assert.equal(readFileSync(path, 'utf8'), text)
      assert.equal(f.run({ dryRun: true }).ok, false, 'already-patched files must not produce a false CI pass')
      assert.equal(f.run({ revert: true }).ok, true)
      f.unchanged()
    })
  }
}

for (const forms of [['js'], ['ts', 'js']]) {
  test(`prepared request, ${forms.join('+')}: preserve upstream tools while converting only text-model images`, async (t) => {
    const f = fixture(t, ['current'], forms, 'request')
    const result = f.run()
    assert.ok(result.ok, result.lines.join('\n'))
    execFileSync(process.execPath, ['--check', f.piJs])
    const route = runInNewContext(`${readFileSync(f.piJs, 'utf8')}; route`, {
      contentHasImage: blocks => blocks.some(block => block.type === 'image'),
      attachmentService: {}, watchdog: { signal: 'watchdog-signal' },
      toPiContext: options => options,
    })
    for (const needsPlaceholder of [true, false]) {
      const options = { needsPlaceholder, tools: [{ name: 'deferred', deferLoading: true }], messages: [{ content: [
        { type: 'image', attachment: { attachmentId: 'sha256:prepared', mediaType: 'image/png', width: 2, height: 3 } },
      ] }] }
      const original = JSON.stringify(options)
      for (const input of [['text'], ['text', 'image']]) {
        const context = await route(options, { input })
        assert.equal(JSON.stringify(context.tools), JSON.stringify(needsPlaceholder
          ? [{ name: 'DeferredToolPlaceholder' }, ...options.tools] : options.tools))
        if (input.includes('image')) {
          assert.equal(context.messages[0].content[0].type, 'image')
          assert.equal(context.signal, 'watchdog-signal')
        } else {
          assert.equal(context.messages[0].content[0].type, 'text')
          assert.match(context.messages[0].content[0].text, /attachment=sha256:prepared/)
        }
        assert.equal(JSON.stringify(options), original)
      }
      const textOptions = { ...options, messages: [{ content: [{ type: 'text', text: 'hello' }] }] }
      const textContext = await route(textOptions, { input: ['text'] })
      assert.equal(textContext.messages[0].content[0].text, 'hello')
      assert.equal(textContext.tools.length, needsPlaceholder ? 2 : 1)
    }
    assert.ok(f.run({ revert: true }).ok)
    f.unchanged()
  })
}

test('both admission locations are patched and reverted when present', (t) => {
  const f = fixture(t, ['current', 'legacy'])
  assert.equal(f.run().ok, true)
  for (const path of f.admissionFiles) assert.match(readFileSync(path, 'utf8'), /DSH-DESIGN-QA-PATCH/)
  assert.equal(f.run({ revert: true }).ok, true)
  f.unchanged()
})

test('missing admission packages fail without writing any adapter', (t) => {
  const f = fixture(t, [])
  assert.equal(f.run().ok, false)
  f.unchanged()
})

test('a broken anchor at either admission location prevents all writes', (t) => {
  const f = fixture(t, ['current', 'legacy'])
  const path = f.admissionFiles.at(-1)
  writeFileSync(path, 'const movedElsewhere = true\n')
  f.originals.set(path, readFileSync(path, 'utf8'))
  const result = f.run()
  assert.equal(result.ok, false)
  assert.match(result.lines.join('\n'), /image-admission/)
  f.unchanged()
})

test('an adapter anchor failure also leaves admission unchanged', (t) => {
  const f = fixture(t)
  const text = readFileSync(f.piJs, 'utf8').replace('const context =', 'const movedContext =')
  writeFileSync(f.piJs, text)
  f.originals.set(f.piJs, text)
  assert.equal(f.run().ok, false)
  f.unchanged()
})
