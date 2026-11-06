// dsh-paint · 宿主一半
//
// 架构：核心 + 模块。
//   核心负责「看进度 / 画库 / 悬浮窗数据」——和具体在画什么无关。
//   模块负责「产生进度」：lamp（任何 progress.json）、paint（绘画工具 + 自己的进度文件）。
//   模块通过同一份接口接入：{ id, label, desc, tools, progressFile, controlFile, routes }
//   拔掉 paint 模块，灯照样能看别的任务。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname, resolve, extname, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAINT_SCRIPT = join(HERE, 'lib', 'paint.py')
const text = (v) => [{ type: 'text', text: String(v) }]

// 正在运行的算法进程：模块 id → { pid, startedAt }
const LIVE = new Map()

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'dsh-paint')
const CONFIG_FILE = join(DATA_DIR, 'config.json')

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const MEDIA_EXT = new Set([...IMG_EXT, '.m4a', '.mp3', '.wav', '.mp4'])

const DEFAULTS = {
  // ── 核心 ──
  file: '',
  files: [],
  controlFile: '',
  label: '任务',
  doneHoldMs: 2500,
  galleryDir: join(DATA_DIR, '画'),
  historyFile: join(DATA_DIR, 'history.json'),
  showHud: true,
  staleMs: 45000,
  // ── 模块开关与各自的设置 ──
  modules: {
    lamp: { enabled: true },
    paint: {
      enabled: true,
      outputDir: join(DATA_DIR, '画'),
      defaultSize: 2048,
      pythonPath: '',
    },
  },
}

/** 模块接口：每个模块声明自己怎么接进来 */
function listModules (cfg) {
  const paintCfg = cfg.modules?.paint || {}
  return [
    {
      id: 'lamp',
      label: '通用进度灯',
      desc: '盯任意 progress.json，显示进度、可暂停/停止。不画画也能用。',
      enabled: cfg.modules?.lamp?.enabled !== false,
      removable: false, // 摘掉它悬浮窗就没内容可看了，所以标明不可摘
      progressFile: '',
      controlFile: '',
      tools: [],
    },
    {
      id: 'paint',
      label: '绘画（矢量化）',
      desc: '让 AI 把图片重画成矢量画：本地算法，纯 CPU，不联网。摘下它，灯的其它功能照旧。',
      enabled: paintCfg.enabled !== false,
      removable: true,
      progressFile: join(DATA_DIR, 'paint-progress.json'),
      controlFile: join(DATA_DIR, 'paint-control.json'),
      tools: ['draw_vectorize'],
    },
  ]
}

function readConfig () {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
    cfg.modules = {
      lamp: { ...DEFAULTS.modules.lamp, ...(raw?.modules?.lamp || {}) },
      paint: { ...DEFAULTS.modules.paint, ...(raw?.modules?.paint || {}) },
    }
    return cfg
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS))
  }
}

function writeConfig (patch) {
  const next = readConfig()
  for (const k of Object.keys(DEFAULTS)) {
    if (k === 'modules') continue
    if (patch && patch[k] !== undefined) next[k] = patch[k]
  }
  if (patch && patch.modules && typeof patch.modules === 'object') {
    for (const id of ['lamp', 'paint']) {
      if (patch.modules[id] && typeof patch.modules[id] === 'object') {
        next.modules[id] = { ...next.modules[id], ...patch.modules[id] }
      }
    }
  }
  next.doneHoldMs = Math.max(500, Math.min(10000, Number(next.doneHoldMs) || 2500))
  next.staleMs = Math.max(5000, Math.min(300000, Number(next.staleMs) || 45000))
  next.showHud = next.showHud !== false
  if (Number.isFinite(Number(next.modules.paint.defaultSize))) {
    next.modules.paint.defaultSize = Number(next.modules.paint.defaultSize)
  }
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

function readJson (file) {
  try {
    if (!file || !existsSync(file)) return null
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}

/** 核心要盯的所有进度来源：通用灯的 slots + 已启用的模块 */
function taskSources (cfg) {
  const out = []
  const lampFiles = Array.isArray(cfg.files) && cfg.files.length ? cfg.files : (cfg.file ? [cfg.file] : [])
  lampFiles.filter(Boolean).forEach((f, i) => {
    out.push({ module: 'lamp', index: out.length, file: f, control: join(DATA_DIR, 'control-' + i + '.json'), label: cfg.label })
  })
  for (const m of listModules(cfg)) {
    if (!m.enabled || !m.progressFile) continue
    out.push({ module: m.id, index: out.length, file: m.progressFile, control: m.controlFile, label: m.label })
  }
  return out
}

function safeResolve (dir, name) {
  const base = resolve(dir)
  const target = resolve(base, name)
  if (target !== base && !target.startsWith(base + sep)) return null
  if (!MEDIA_EXT.has(extname(target).toLowerCase())) return null
  try { if (!statSync(target).isFile()) return null } catch { return null }
  return target
}

function listGallery (dir) {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && MEDIA_EXT.has(extname(e.name).toLowerCase()))
      .map((e) => {
        const full = join(dir, e.name)
        const st = statSync(full)
        return { name: e.name, size: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch { return [] }
}

function sendJson (res, obj, code = 200) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(obj))
}

async function readBody (req) {
  let s = ''
  for await (const c of req) s += c
  try { return s ? JSON.parse(s) : {} } catch { return {} }
}

// ── 绘画模块：找 Python、跑脚本 ──
function resolvePython (paintCfg) {
  if (paintCfg.pythonPath && existsSync(paintCfg.pythonPath)) return paintCfg.pythonPath
  const runtimes = join(DSH_HOME, 'dsh-runtimes')
  if (existsSync(runtimes)) {
    for (const d of readdirSync(runtimes)) {
      const p = join(runtimes, d, 'dependencies', 'python', 'python.exe')
      if (existsSync(p)) return p
    }
    for (const d of readdirSync(runtimes)) {
      const p = join(runtimes, d, 'dependencies', 'python', 'bin', 'python3')
      if (existsSync(p)) return p
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

function stamp () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function runPaint (opts) {
  const cfg = readConfig()
  const paintCfg = cfg.modules.paint
  const mod = listModules(cfg).find((m) => m.id === 'paint')
  const py = resolvePython(paintCfg)
  const outDir = resolve(opts.outputDir || paintCfg.outputDir)
  mkdirSync(outDir, { recursive: true })
  const base = join(outDir, `画-${stamp()}`)
  const png = opts.out ? resolve(opts.out) : `${base}.png`
  const svg = opts.svg ? resolve(opts.svg) : `${base}.svg`
  const size = Number(opts.size) || paintCfg.defaultSize || 2048

  const args = [
    PAINT_SCRIPT,
    '--src', resolve(opts.src),
    '--out', png,
    '--svg', svg,
    '--size', String(size),
    '--label', String(opts.label || '绘画'),
    '--prog', mod.progressFile,
    '--ctl', mod.controlFile,
  ]
  if (opts.trace) args.push('--trace', String(opts.trace))
  if (opts.crop) args.push('--crop')

  return new Promise((done) => {
    // 用 spawn 而不是 execFile：拿到 pid，才能做「进程还活着吗」的判定
    const child = spawn(py, args, { windowsHide: true })
    LIVE.set('paint', { pid: child.pid, startedAt: Date.now() })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    const finish = (code) => {
      LIVE.delete('paint')
      let parsed = null
      const line = out.trim().split('\n').filter(Boolean).pop() || ''
      try { parsed = JSON.parse(line) } catch { /* 不是 JSON */ }
      done({ ok: code === 0 && !!parsed, stderr: err, result: parsed, png, svg, size })
    }
    child.on('close', (code) => finish(code))
    child.on('error', (e) => { err += String(e && e.message || e); finish(-1) })
    setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } }, 30 * 60 * 1000)
  })
}

export const inject = ['webServer', 'tools']

export function apply (ctx) {
  mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(CONFIG_FILE)) writeConfig({})
  for (const dir of [readConfig().galleryDir, readConfig().modules.paint.outputDir]) {
    try { if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
  }

  const log = (m) => { try { ctx.logger?.info?.('[dsh-paint] ' + m) } catch { /* 忽略 */ } }

  const route = (path, tag, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      try { await handler(req, res) } catch (e) { sendJson(res, { ok: false, error: String(e?.message ?? e) }, 500) }
    },
  }), 'dsh-paint: ' + tag)

  // ── 核心：进度 ──
  route('/dsh-paint/state', 'state', async (req, res) => {
    const cfg = readConfig()
    if (!cfg.showHud) return sendJson(res, { ok: true, hidden: true, present: false })
    const tasks = []
    for (const t of taskSources(cfg)) {
      const p = readJson(t.file)
      if (!p) continue
      let ageMs = 0
      try { ageMs = Date.now() - statSync(t.file).mtimeMs } catch { ageMs = 0 }
      const total = Number(p.total) || 0
      const done = Number(p.done) || 0
      tasks.push({
        index: t.index,
        module: t.module,
        label: p.label || t.label,
        running: !!p.running,
        paused: !!p.paused,
        stopped: !!p.stopped,
        done,
        total,
        pct: total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0,
        elapsed: p.elapsed,
        eta: p.eta,
        note: p.note,
        updated: p.updated,
        error: p.error ? String(p.error) : null,
        ageMs,
        // paint 模块用进程存活判定；其余（灯盯的任意文件）仍按 mtime 推测
        alive: t.module === 'paint' ? LIVE.has('paint') : undefined,
        stale: (() => {
          if (!p.running) return false
          if (t.module === 'paint') {
            // 进程还在 → 永远不是无响应（哪怕很久没写进度）
            if (LIVE.has('paint')) return false
            // 进程没了却还标 running → 确实已经死了
            return true
          }
          return ageMs > (cfg.staleMs || 45000)
        })(),
      })
    }
    if (!tasks.length) return sendJson(res, { ok: true, present: false, label: cfg.label, doneHoldMs: cfg.doneHoldMs })
    sendJson(res, { ok: true, present: true, tasks, doneHoldMs: cfg.doneHoldMs, modules: listModules(cfg) })
  })

  route('/dsh-paint/control', 'control', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'POST only' }, 405)
    const body = await readBody(req)
    const action = String(body.action || '')
    if (!['pause', 'resume', 'stop'].includes(action)) {
      return sendJson(res, { ok: false, error: 'action 只能是 pause / resume / stop' }, 400)
    }
    const cfg = readConfig()
    const idx = Number.isInteger(body.index) ? body.index : 0
    const t = taskSources(cfg).find((x) => x.index === idx) || taskSources(cfg)[0]
    if (!t) return sendJson(res, { ok: false, error: '没有可控制的任务' }, 400)
    const payload = { action, at: Date.now(), iso: new Date().toISOString() }
    mkdirSync(dirname(t.control), { recursive: true })
    writeFileSync(t.control, JSON.stringify(payload, null, 2), 'utf8')
    sendJson(res, { ok: true, control: payload, file: t.control, module: t.module })
  })

  // ── 核心：配置 ──
  route('/dsh-paint/config', 'config', async (req, res) => {
    if (req.method === 'GET') {
      const cfg = readConfig()
      const py = resolvePython(cfg.modules.paint)
      return sendJson(res, {
        ok: true,
        config: cfg,
        modules: listModules(cfg),
        python: py,
        pythonExists: existsSync(py),
        scriptExists: existsSync(PAINT_SCRIPT),
      })
    }
    const body = await readBody(req)
    sendJson(res, { ok: true, config: writeConfig(body), modules: listModules(writeConfig(body)) })
  })

  // ── 核心：模块开关 ──
  route('/dsh-paint/modules', 'modules', async (req, res) => {
    if (req.method === 'GET') {
      const cfg = readConfig()
      return sendJson(res, { ok: true, modules: listModules(cfg) })
    }
    const body = await readBody(req)
    const id = String(body.id || '')
    if (!['lamp', 'paint'].includes(id)) return sendJson(res, { ok: false, error: '未知模块：' + id }, 400)
    const cfg = writeConfig({ modules: { [id]: { enabled: body.enabled !== false } } })
    log(`模块 ${id} → ${body.enabled !== false ? '开' : '关'}`)
    sendJson(res, { ok: true, modules: listModules(cfg) })
  })

  // ── 核心：画库 / 历史 / 打开文件夹 ──
  route('/dsh-paint/gallery', 'gallery', async (req, res) => {
    const cfg = readConfig()
    sendJson(res, { ok: true, dir: cfg.galleryDir, files: listGallery(cfg.galleryDir) })
  })

  route('/dsh-paint/gallery/delete', 'gallery-delete', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'POST only' }, 405)
    const body = await readBody(req)
    const cfg = readConfig()
    const names = Array.isArray(body.names) ? body.names : (body.name ? [body.name] : [])
    if (!names.length) return sendJson(res, { ok: false, error: '没指定要删哪个' }, 400)
    const removed = []
    const rejected = []
    for (const n of names) {
      const target = safeResolve(cfg.galleryDir, String(n || ''))
      if (!target) { rejected.push(String(n)); continue }
      try { unlinkSync(target); removed.push(basename(target)) } catch { rejected.push(String(n)) }
    }
    sendJson(res, {
      ok: removed.length > 0,
      removed,
      rejected,
      error: removed.length ? undefined : '一个都没删掉（不在画库目录或类型不允许）',
      files: listGallery(cfg.galleryDir),
    })
  })

  route('/dsh-paint/file', 'file', async (req, res) => {
    const url = new URL(req.url, 'http://local')
    const cfg = readConfig()
    const target = safeResolve(cfg.galleryDir, url.searchParams.get('name') || '')
    if (!target) { res.statusCode = 404; return res.end('not found') }
    const ext = extname(target).toLowerCase()
    const type = ext === '.png' ? 'image/png'
      : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif'
            : ext === '.bmp' ? 'image/bmp'
              : ext === '.mp3' ? 'audio/mpeg'
                : ext === '.m4a' ? 'audio/mp4'
                  : ext === '.wav' ? 'audio/wav' : 'application/octet-stream'
    res.statusCode = 200
    res.setHeader('content-type', type)
    res.setHeader('cache-control', 'max-age=60')
    res.end(readFileSync(target))
  })

  route('/dsh-paint/history', 'history', async (req, res) => {
    const cfg = readConfig()
    let arr = []
    if (existsSync(cfg.historyFile)) {
      const j = JSON.parse(readFileSync(cfg.historyFile, 'utf8'))
      if (Array.isArray(j)) arr = j
    }
    sendJson(res, { ok: true, file: cfg.historyFile, items: arr.slice(-20).reverse() })
  })

  route('/dsh-paint/open-folder', 'open-folder', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'POST only' }, 405)
    const body = await readBody(req)
    const cfg = readConfig()
    const dir = body.dir === 'paint' ? cfg.modules.paint.outputDir : cfg.galleryDir
    if (!dir || !existsSync(dir)) return sendJson(res, { ok: false, error: '目录不存在：' + (dir || '(未设置)') }, 400)
    // windowsHide 会连带把资源管理器窗口藏起来，所以交给 cmd start 且不隐藏
    execFile('cmd.exe', ['/c', 'start', '', dir], { timeout: 8000, windowsHide: false }, (err, so, se) => {
      try {
        const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' +
          (err ? ('失败: ' + err.message + ' ' + String(se || '')) : '已请求打开') + ' → ' + dir + '\n'
        writeFileSync(join(DATA_DIR, 'open.log'), line, { flag: 'a' })
      } catch { /* 忽略 */ }
    })
    sendJson(res, { ok: true, dir })
  })

  // ── 模块 paint：工具 ──
  ctx.effect(() => ctx.tools.register({
    name: 'draw_vectorize',
    description: '把一张本地图片「重画」成矢量画：输出可无限放大的 SVG + 一张 PNG。纯本地 CPU 算法（色块描摹 + 自写渲染器），不联网、不训练、不用显卡。适合把插画/图标/截图转成矢量，或做高清重绘。',
    parameters: {
      type: 'object',
      properties: {
        src: { type: 'string', description: '输入图片的绝对路径（png/jpg/webp）' },
        size: { type: 'integer', description: '输出长边像素，常用 1024/2048/4096/8192' },
        trace: { type: 'integer', description: '描摹分辨率，默认等于 size；调低会明显变糊' },
        out: { type: 'string', description: 'PNG 输出路径（默认放进画库，文件名带时间戳）' },
        svg: { type: 'string', description: 'SVG 输出路径' },
        crop: { type: 'boolean', description: '居中裁成正方形（默认保留原始比例）' },
        label: { type: 'string', description: '任务名，显示在进度条上' },
      },
      required: ['src'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => text(v?.summary || JSON.stringify(v, null, 2)),
    },
    async execute (args) {
      const a = args || {}
      const cfg = readConfig()
      if (cfg.modules.paint.enabled === false) {
        return { ok: false, summary: '绘画模块被关掉了：设置 → 绘画 → 模块 里打开它。' }
      }
      if (!a.src || !existsSync(resolve(a.src))) {
        return { ok: false, summary: `失败：输入图片不存在（${a.src || '(空)'}）` }
      }
      log(`开始绘制：${a.src} @ ${a.size || cfg.modules.paint.defaultSize}`)
      const r = await runPaint(a)
      if (!r.ok) {
        const msg = (r.stderr || '').trim().split('\n').slice(-3).join(' | ') || (r.err && r.err.message) || '未知错误'
        log(`失败：${msg}`)
        return { ok: false, error: msg, summary: `失败：${msg}` }
      }
      const res2 = r.result
      log(`完成：${res2.shapes} 形状 / ${res2.width}x${res2.height} / ${res2.seconds}s`)
      return {
        ok: true,
        stopped: res2.stopped,
        shapes: res2.shapes,
        width: res2.width,
        height: res2.height,
        seconds: res2.seconds,
        png: res2.png,
        svg: res2.svg,
        summary: `${res2.stopped ? '已停止' : '完成'}：${res2.shapes} 个形状，${res2.width}×${res2.height}，用时 ${res2.seconds} 秒\nPNG：${res2.png}\nSVG：${res2.svg}`,
      }
    },
  }), 'dsh-paint: draw_vectorize')
}
