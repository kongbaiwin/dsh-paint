// dsh-paint · 浏览器一半
// 悬浮灯：拖动 / 缩成小圆点 / 关闭 / 出错标红 / 完成变绿并响一声 / 跑完自动缩起 / 点开看画
// 设置页：显示开关、画库目录、画库（多选批量删除 + 大图预览）、任务历史
window.__ModuleLoader__.load({
  id: 'dsh-paint',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/dsh-paint'
    const POS_KEY = 'dsh-paint-pos'
    const MINI_KEY = 'dsh-paint-mini'

    function fmtSec(s) {
      const n = Math.max(0, Math.round(Number(s) || 0))
      if (n < 60) return n + ' 秒'
      const m = Math.floor(n / 60)
      const r = n % 60
      return r ? m + ' 分 ' + r + ' 秒' : m + ' 分'
    }
    function isImage(name) {
      return /\.(png|jpe?g|webp|gif|bmp)$/i.test(String(name || ''))
    }

    function fmtTime(ms) {
      if (!ms) return ''
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    function fmtSize(b) {
      if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB'
      return Math.max(1, Math.round(b / 1024)) + ' KB'
    }

    // 完成 / 出错的提示音（WebAudio，不需要资源文件）
    function beep(kind) {
      try {
        if (localStorage.getItem('dsh-paint-sound') === '0') return
        const Ctx = window.AudioContext || window.webkitAudioContext
        if (!Ctx) return
        const ac = new Ctx()
        const notes = kind === 'error' ? [330, 220] : [660, 880]
        notes.forEach((f, i) => {
          const o = ac.createOscillator()
          const g = ac.createGain()
          o.type = 'sine'
          o.frequency.value = f
          const t0 = ac.currentTime + i * 0.14
          g.gain.setValueAtTime(0.0001, t0)
          g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02)
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16)
          o.connect(g)
          g.connect(ac.destination)
          o.start(t0)
          o.stop(t0 + 0.2)
        })
        setTimeout(() => { try { ac.close() } catch (e) {} }, 900)
      } catch (e) { /* 忽略 */ }
    }

    // ── 悬浮灯（支持多个任务）──
    function Lamp() {
      const [state, setState] = useState(null)
      const [doneIds, setDoneIds] = useState(() => new Set())
      const [busy, setBusy] = useState(false)
      const [mini, setMini] = useState(false)
      const [pos, setPos] = useState({ right: 26, bottom: 104 })
      const [hidden, setHidden] = useState(false)
      const [galOpen, setGalOpen] = useState(false)
      const [gal, setGal] = useState([])
      const [preview, setPreview] = useState(null)
      const [gone, setGone] = useState(() => {
        try { return new Set(JSON.parse(localStorage.getItem('dsh-paint-gone') || '[]')) } catch (e) { return new Set() }
      })
      const drag = useRef(null)
      const suppressClick = useRef(false)
      const runningMap = useRef(new Map())
      const dismissedSig = useRef(null)
      const reviveRev = useRef(null)

      useEffect(() => {
        try {
          const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
          if (p && typeof p.right === 'number') setPos(p)
          setMini(localStorage.getItem(MINI_KEY) === '1')
        } catch (e) { /* 忽略 */ }
      }, [])

      useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const j = await (await fetch(API + '/state')).json()
            if (!alive) return
            setState(j)
            try {
              const rev = localStorage.getItem('dsh-paint-revive')
              if (rev && rev !== reviveRev.current) { reviveRev.current = rev; setHidden(false); dismissedSig.current = null }
            } catch (e) { /* 忽略 */ }

            const tasks = (j && j.tasks) || []
            if (tasks.length) {
              const sig = tasks.map((t) => t.index + ':' + (t.updated || '') + ':' + t.done).join('|')
              if (dismissedSig.current && dismissedSig.current !== sig && tasks.some((t) => t.running)) {
                setHidden(false); dismissedSig.current = null
              }
            }

            let justFinished = false
            let hasError = false
            const nowDone = new Set()
            for (const t of tasks) {
              const was = runningMap.current.get(t.index) || false
              if (t.running) runningMap.current.set(t.index, true)
              else if (was) { runningMap.current.set(t.index, false); justFinished = true; if (t.error) hasError = true; nowDone.add(t.index) }
              if (t.error) hasError = true
            }
            if (justFinished) {
              beep(hasError ? 'error' : 'done')
              setDoneIds((prev) => new Set([...prev, ...nowDone]))
              setTimeout(() => {
                if (!alive) return
                if (!tasks.some((t) => t.running)) {
                  try { localStorage.setItem(MINI_KEY, '1') } catch (e) {}
                  setMini(true)
                }
              }, j.doneHoldMs || 2500)
            }
          } catch (e) { /* 忽略 */ }
        }
        tick()
        const id = setInterval(tick, 700)
        return () => { alive = false; clearInterval(id) }
      }, [])

      useEffect(() => {
        const move = (e) => {
          if (!drag.current) return
          const { sx, sy, startRight, startBottom } = drag.current
          if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 4) drag.current.moved = true
          const right = Math.max(8, Math.min(window.innerWidth - 90, startRight - (e.clientX - sx)))
          const bottom = Math.max(8, Math.min(window.innerHeight - 90, startBottom - (e.clientY - sy)))
          setPos({ right, bottom })
        }
        const up = () => {
          if (!drag.current) return
          suppressClick.current = !!drag.current.moved
          drag.current = null
          setPos((p) => { try { localStorage.setItem(POS_KEY, JSON.stringify(p)) } catch (e) {} return p })
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
      }, [])

      const startDrag = (e) => { drag.current = { sx: e.clientX, sy: e.clientY, startRight: pos.right, startBottom: pos.bottom } }
      const toggleMini = () => {
        setMini((m) => {
          const v = !m
          try { localStorage.setItem(MINI_KEY, v ? '1' : '0') } catch (e) {}
          return v
        })
      }
      const openFolder = async () => {
        try {
          const r = await (await fetch(API + '/open-folder', { method: 'POST' })).json()
          if (!r.ok) console.warn('[dsh-paint] ' + (r.error || '打不开'))
        } catch (e) { /* 忽略 */ }
      }

      const openGallery = async () => {
        setGalOpen(true)
        try {
          const g = await (await fetch(API + '/gallery')).json()
          if (g.ok) setGal(g.files || [])
        } catch (e) { /* 忽略 */ }
      }
      const send = async (action, index) => {
        if (busy) return
        setBusy(true)
        try {
          await fetch(API + '/control', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, index }),
          })
        } catch (e) { /* 忽略 */ }
        setTimeout(() => setBusy(false), 300)
      }
      const dismiss = () => {
        setHidden(true)
        setGalOpen(false)
        const tasks = (state && state.tasks) || []
        dismissedSig.current = tasks.map((t) => t.index + ':' + (t.updated || '') + ':' + t.done).join('|')
      }

      const base = { position: 'fixed', right: pos.right, bottom: pos.bottom, zIndex: 60, fontFamily: 'inherit', userSelect: 'none' }
      const allTasks = (state && state.tasks) || []
      const sigOf = (t) => t.index + '|' + (t.updated || '') + '|' + t.done
      const tasks = allTasks.filter((t) => !gone.has(sigOf(t)))
      const drop = (t) => {
        setGone((prev) => {
          const next = new Set(prev)
          next.add(sigOf(t))
          try { localStorage.setItem('dsh-paint-gone', JSON.stringify([...next])) } catch (e) {}
          return next
        })
      }

      const galleryPanel = galOpen ? h('div', {
        style: {
          width: '100%', boxSizing: 'border-box', maxHeight: 260, overflowY: 'auto', padding: 10, borderRadius: 14,
          background: 'var(--dsw-alias-bg-overlay, rgba(24,26,32,.96))',
          border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))',
          boxShadow: '0 10px 30px rgba(0,0,0,.35)', color: 'var(--dsw-alias-label-primary)',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 8 } },
          h('span', { style: { fontSize: 12, fontWeight: 600 } }, '画库（' + gal.length + '）'),
          h('button', {
            type: 'button', onClick: () => setGalOpen(false),
            style: { marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 14 },
          }, '×'),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 } },
          [...gal].sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 12).map((f) => isImage(f.name)
            ? h('img', {
              key: f.name, src: API + '/file?name=' + encodeURIComponent(f.name), title: f.name,
              onClick: () => setPreview(f.name),
              style: { width: '100%', height: 62, objectFit: 'cover', borderRadius: 6, cursor: 'pointer', background: 'rgba(127,127,127,.1)' },
            })
            : h('div', {
              key: f.name, title: f.name,
              style: { height: 62, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, background: 'rgba(127,127,127,.1)', fontSize: 10, color: 'var(--dsw-alias-label-secondary)' },
            }, '音频')),
        ),
        preview ? h('div', {
          onClick: () => setPreview(null),
          style: { position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' },
        }, h('img', { src: API + '/file?name=' + encodeURIComponent(preview), style: { maxWidth: '80vw', maxHeight: '80vh', borderRadius: 10 } })) : null,
      ) : null

      if (hidden) return null
      if (!state || !state.present || state.hidden) return null
      if (!allTasks.length) return null

      // 小窗：多任务时显示数量 + 平均进度
      if (mini) {
        const runningTasks = tasks.filter((t) => t.running)
        const avg = Math.round(tasks.reduce((n, t) => n + (t.pct || 0), 0) / Math.max(1, tasks.length))
        const anyErr = tasks.some((t) => t.error)
        const allDone = tasks.every((t) => t.pct >= 100 && !t.error) && !runningTasks.length
        const anyStopped = tasks.some((t) => t.stopped)
        const paused = runningTasks.some((t) => t.paused)
        const anyStale = tasks.some((t) => t.stale) && !anyErr
        const symbol = anyErr ? '!' : allDone ? '✓' : anyStale ? '…' : anyStopped ? '■' : paused ? '⏸' : (tasks.length > 1 ? tasks.length + '·' + avg + '%' : avg + '%')
        const color = anyErr ? 'var(--dsw-alias-state-error-primary)'
          : allDone ? 'var(--dsw-alias-state-success-primary)'
          : anyStopped ? 'var(--dsw-alias-label-primary)'
              : paused ? 'var(--dsw-alias-state-warn-primary)'
                : 'var(--dsw-alias-label-primary)'
        return h('div', {
          style: {
            ...base, width: tasks.length > 1 ? 62 : 54, height: 54, borderRadius: 27,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            background: 'var(--dsw-alias-bg-overlay, rgba(24,26,32,.92))',
            border: '1px solid ' + (anyErr ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l1, rgba(255,255,255,.12))'),
            boxShadow: '0 6px 24px rgba(0,0,0,.3)',
          },
          title: anyErr ? '出错' : allDone ? '已完成' : anyStopped ? '已停止' : paused ? '已暂停' : '点开',
          onMouseDown: startDrag,
          onClick: () => { if (suppressClick.current) { suppressClick.current = false; return } toggleMini() },
        }, h('span', { style: { fontSize: tasks.length > 1 ? 13 : 16, fontWeight: 700, color } }, symbol))
      }

      const btn = (label, action, index, primary) => h('button', {
        type: 'button',
        onClick: (e) => { e.preventDefault(); e.stopPropagation(); send(action, index) },
        style: {
          marginLeft: 6, padding: '1px 7px', fontSize: 10, lineHeight: '15px', borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.16))',
          background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
          color: primary ? '#fff' : 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer', fontFamily: 'inherit', opacity: busy ? 0.5 : 1,
        },
      }, label)

      const iconBtn = (label, title, onClick, active) => h('button', {
        type: 'button', title,
        onClick: (e) => { e.preventDefault(); e.stopPropagation(); onClick() },
        style: {
          width: 18, height: 18, lineHeight: '16px', padding: 0, marginLeft: 4,
          borderRadius: 6, border: 'none', background: 'transparent',
          color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
          background: active ? 'rgba(120,160,255,.14)' : 'transparent',
          cursor: 'pointer', fontSize: 12,
        },
      }, label)

      const rows = tasks.map((t) => {
        const errored = !!t.error
        const stale = !!t.stale && !errored
        const live = !!t.running && !stale
        const stopped = !!t.stopped
        const paused = !!t.paused
        const finished = doneIds.has(t.index) && !t.running
        const full = finished || (!t.running && t.pct >= 100 && !errored && !stopped)
        const barColor = errored ? 'var(--dsw-alias-state-error-primary)'
          : full ? 'var(--dsw-alias-state-success-primary)'
            : stopped ? 'var(--dsw-alias-state-idle-primary)' : 'var(--dsw-alias-brand-primary)'
        return h('div', { key: t.index, style: { marginTop: t.index ? 9 : 0 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline' } },
            h('span', {
              style: {
                fontWeight: 600, fontSize: 12,
                color: errored ? 'var(--dsw-alias-state-error-primary)'
                  : stale ? 'var(--dsw-alias-state-warn-primary)' : 'inherit',
              },
            },
              (t.label || '任务') + (errored ? ' 出错' : stale ? ' 无响应' : paused ? ' 已暂停' : stopped ? ' 已停止' : full ? ' 完成' : '')),
            h('span', { style: { marginLeft: 'auto', fontSize: 11, color: full ? 'var(--dsw-alias-state-success-primary)' : 'inherit', opacity: .8 } },
              full ? '100%' : (t.pct || 0) + '%'),
            live ? btn(paused ? '继续' : '暂停', paused ? 'resume' : 'pause', t.index === undefined ? 0 : t.index) : null,
            live ? btn('停', 'stop', t.index === undefined ? 0 : t.index, true) : null,
            (!live && (full || stopped || errored || stale))
              ? h('button', {
                type: 'button', title: '从列表里去掉这一条',
                onClick: (e) => { e.preventDefault(); e.stopPropagation(); drop(t) },
                style: {
                  marginLeft: 6, width: 18, height: 16, lineHeight: '14px', padding: 0,
                  borderRadius: 5, border: '1px solid rgba(220,80,80,.45)',
                  background: 'transparent', color: '#e06c6c', cursor: 'pointer', fontSize: 11,
                },
              }, '×')
              : null,
          ),
          h('div', { style: { height: 3, marginTop: 5, borderRadius: 2, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.10))' } },
            h('div', { style: { width: Math.max(2, full ? 100 : (t.pct || 0)) + '%', height: '100%', background: barColor, borderRadius: 2, transition: 'width .35s ease' } }),
          ),
          h('div', { style: { marginTop: 3, fontSize: 10, opacity: .6 } },
            errored ? ('出错：' + String(t.error).slice(0, 50))
              : stale ? ('超过 30 秒没更新，进程可能已经没了（' + (t.done || 0) + ' / ' + (t.total || '?') + '）')
                : [
                // total=100 表示“按百分比报进度”，不必再显示成 62/100
                (t.total && t.total !== 100) ? t.done + ' / ' + t.total : '',
                t.eta && !paused ? '还剩 ' + fmtSec(t.eta) : '',
              ].filter(Boolean).join(' · ') || ((t.pct || 0) + '%')),
        )
      })

      return h('div', {
        key: 'wrap',
        style: {
          ...base, width: 300,
          display: 'flex', flexDirection: 'column', gap: 8,
          alignItems: 'stretch',
        },
      },
        galleryPanel,
        h('div', {
          key: 'lamp',
          style: {
            width: '100%', boxSizing: 'border-box', padding: '9px 12px 10px', borderRadius: 14,
            background: 'var(--dsw-alias-bg-overlay, rgba(24,26,32,.92))',
            border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))',
            boxShadow: '0 6px 24px rgba(0,0,0,.28)',
            color: 'var(--dsw-alias-label-primary)', fontSize: 12, lineHeight: 1.5,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', cursor: 'grab', marginBottom: 6 }, onMouseDown: startDrag },
            h('span', { style: { fontSize: 11, opacity: .55 } }, tasks.length > 1 ? tasks.length + ' 个任务' : '任务'),
            h('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center' } },
              iconBtn('⊞', '打开画库文件夹', openFolder),
              iconBtn('▣', galOpen ? '收起画库' : '看画', () => { if (galOpen) setGalOpen(false); else openGallery() }, galOpen),
              iconBtn('–', '缩成小窗', toggleMini),
              iconBtn('×', '关掉这个灯', dismiss),
            ),
          ),
          tasks.length ? rows : h('div', { style: { fontSize: 12, opacity: .55, padding: '6px 0 2px' } }, '无任务'),
        ),
      )
    }

    // ── 设置卡（两个页签：设置 / 画库）──
    function SettingsCard() {
      const [cfg, setCfg] = useState(null)
      const [files, setFiles] = useState([])
      const [dir, setDir] = useState('')
      const [sel, setSel] = useState(() => new Set())
      const [history, setHistory] = useState([])
      const [preview, setPreview] = useState(null)
      const [msg, setMsg] = useState('')
      const [tab, setTab] = useState('settings')
      const [mods, setMods] = useState([])
      const [paintDir, setPaintDir] = useState('')

      const load = useCallback(async () => {
        try {
          const c = await (await fetch(API + '/config')).json()
          if (c.ok) {
            setCfg(c.config)
            setDir(c.config.galleryDir || '')
            setMods(c.modules || [])
            setPaintDir((c.config.modules && c.config.modules.paint && c.config.modules.paint.outputDir) || '')
          }
          const g = await (await fetch(API + '/gallery')).json()
          if (g.ok) setFiles(g.files || [])
          const hi = await (await fetch(API + '/history')).json()
          if (hi.ok) setHistory(hi.items || [])
        } catch (e) { setMsg(String((e && e.message) || e)) }
      }, [])
      useEffect(() => { load() }, [load])

      const save = async (patch) => {
        try {
          const r = await (await fetch(API + '/config', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
          })).json()
          if (r.ok) { setCfg(r.config); setMsg('已保存') } else setMsg(r.error || '保存失败')
          return r
        } catch (e) { setMsg(String((e && e.message) || e)) }
      }
      const toggle = (name) => setSel((prev) => {
        const next = new Set(prev)
        if (next.has(name)) next.delete(name); else next.add(name)
        return next
      })
      const del = async (names, confirmText) => {
        if (!names.length || !window.confirm(confirmText)) return
        try {
          const r = await (await fetch(API + '/gallery/delete', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names }),
          })).json()
          if (r.files) setFiles(r.files)
          setSel(new Set())
          setMsg(r.ok ? ('删掉 ' + r.removed.length + ' 个' + (r.rejected && r.rejected.length ? '，' + r.rejected.length + ' 个没删成' : '')) : (r.error || '删除失败'))
        } catch (e) { setMsg(String((e && e.message) || e)) }
      }

      const dim = { color: 'var(--dsw-alias-label-secondary)' }
      const inputStyle = {
        width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 9,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit', fontSize: 13, fontFamily: 'inherit', outline: 'none',
      }
      const labelStyle = { display: 'block', fontSize: 12, marginTop: 12, marginBottom: 5, ...dim }
      const smallBtn = (label, onClick, danger) => h('button', {
        type: 'button', onClick,
        style: {
          fontSize: 11, padding: '3px 9px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
          border: '1px solid ' + (danger ? 'rgba(220,80,80,.55)' : 'var(--dsw-alias-border-l1, rgba(127,127,127,.3))'),
          background: danger ? 'rgba(220,80,80,.10)' : 'transparent',
          color: danger ? '#e06c6c' : 'var(--dsw-alias-label-secondary)',
        },
      }, label)

      const tabBtn = (key, label) => h('button', {
        type: 'button',
        onClick: () => setTab(key),
        style: {
          padding: '5px 14px', borderRadius: 9, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
          border: '1px solid ' + (tab === key ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1, rgba(127,127,127,.28))'),
          background: tab === key ? 'rgba(120,160,255,.14)' : 'transparent',
          color: tab === key ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
          fontWeight: tab === key ? 600 : 400,
        },
      }, label)

      // ── 设置页签 ──
      const settingsTab = h('div', null,
        h('div', { style: { fontSize: 13, lineHeight: 1.8, ...dim } },
          '长任务的指示灯：显示进度与剩余时间，可暂停 / 继续 / 停止。灯能拖动、点「–」缩成小圆点、点「×」关掉；跑完会缩成小圆点、响一声、变绿。'),

        h('label', { style: { ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'inherit', marginTop: 14 } },
          h('input', {
            type: 'checkbox', checked: cfg ? cfg.showHud !== false : true,
            onChange: (e) => save({ showHud: e.target.checked }),
            style: { width: 17, height: 17, margin: 0, cursor: 'pointer', accentColor: 'var(--dsw-alias-brand-primary)' },
          }),
          '显示悬浮灯'),

        h('label', { style: { ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'inherit', marginTop: 10 } },
          h('input', {
            type: 'checkbox',
            style: { width: 17, height: 17, margin: 0, cursor: 'pointer', accentColor: 'var(--dsw-alias-brand-primary)' },
            defaultChecked: (() => { try { return localStorage.getItem('dsh-paint-sound') !== '0' } catch (e) { return true } })(),
            onChange: (e) => { try { localStorage.setItem('dsh-paint-sound', e.target.checked ? '1' : '0') } catch (err) {} setMsg(e.target.checked ? '完成时会响一声' : '已静音') },
          }),
          '任务完成 / 出错时响一声'),

        h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
          h('button', {
            type: 'button',
            onClick: () => { try { localStorage.setItem('dsh-paint-revive', String(Date.now())) } catch (e) {} setMsg('已叫出悬浮灯') },
            style: { padding: '6px 14px', borderRadius: 9, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))', background: 'transparent', color: 'var(--dsw-alias-label-primary)' },
          }, '叫出悬浮灯'),
          h('span', { style: { fontSize: 11, alignSelf: 'center', ...dim } }, '点过「×」关掉之后用这个'),
        ),

        h('div', { style: { ...labelStyle, marginTop: 18 } }, '任务历史（最近 10 次）'),
        history.length === 0
          ? h('div', { style: { fontSize: 12, ...dim } }, '还没有记录。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            history.slice(0, 10).map((it, i) => h('div', {
              key: i,
              style: { display: 'flex', gap: 8, fontSize: 11, ...dim, padding: '3px 0', borderBottom: '1px dashed rgba(127,127,127,.18)' },
            },
              h('span', { style: { minWidth: 130 } }, it.started || '—'),
              h('span', { style: { minWidth: 40 } }, (it.label || '任务')),
              h('span', { style: { minWidth: 64 } }, it.done + '/' + it.total),
              h('span', { style: { minWidth: 46 } }, (it.seconds || 0) + 's'),
              h('span', { style: { color: it.error ? '#e06c6c' : (it.stopped ? 'inherit' : 'var(--dsw-alias-state-success-primary)') } },
                it.error ? '出错' : it.stopped ? '停止' : '完成'),
            )),
          ),
      )

      // ── 画库页签 ──
      const galleryTab = h('div', null,
        h('label', { style: labelStyle }, '画库目录（显示与删除都只在这个目录内）'),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('input', { style: inputStyle, value: dir, onChange: (e) => setDir(e.target.value), spellCheck: false }),
          h('button', {
            type: 'button',
            onClick: () => save({ galleryDir: dir }).then(load),
            style: { padding: '7px 14px', borderRadius: 9, border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))', background: 'var(--dsw-alias-brand-primary)', color: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 },
          }, '保存'),
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 8 } },
          h('span', { style: { fontSize: 12, ...dim } }, files.length + ' 个文件' + (sel.size ? '，已选 ' + sel.size : '')),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
            smallBtn('复制路径', async () => {
              try {
                await navigator.clipboard.writeText(dir || '')
                setMsg('路径已复制：' + dir)
              } catch (e) { setMsg('复制失败：' + ((e && e.message) || e)) }
            }),
            smallBtn('打开文件夹', async () => {
              try {
                const r = await (await fetch(API + '/open-folder', { method: 'POST' })).json()
                if (!r.ok) setMsg(r.error || '打不开文件夹')
                else setMsg('已打开：' + r.dir)
              } catch (e) { setMsg(String((e && e.message) || e)) }
            }),
            files.length ? smallBtn(sel.size === files.length ? '取消全选' : '全选', () => setSel((prev) => prev.size === files.length ? new Set() : new Set(files.map((f) => f.name)))) : null,
            sel.size ? smallBtn('删除选中（' + sel.size + '）', () => del(Array.from(sel), '删掉选中的 ' + sel.size + ' 个文件？删了就回不来了。'), true) : null,
          ),
        ),

        files.length === 0
          ? h('div', { style: { fontSize: 12, ...dim } }, '这个目录里还没有文件。')
          : h('div', {
            style: {
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(124px, 1fr))',
              gap: 10, maxHeight: '52vh', overflowY: 'auto', paddingRight: 4,
            },
          },
            [...files].sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).map((f) => {
              const picked = sel.has(f.name)
              return h('div', {
                key: f.name,
                style: {
                  border: '1px solid ' + (picked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1, rgba(127,127,127,.25))'),
                  borderRadius: 10, overflow: 'hidden', position: 'relative',
                  background: picked ? 'rgba(120,160,255,.10)' : 'var(--dsw-alias-bg-layer-1, transparent)',
                },
              },
                h('div', { onClick: () => toggle(f.name), title: '点一下选中 / 取消', style: { cursor: 'pointer', position: 'relative' } },
                  isImage(f.name)
                    ? h('img', { src: API + '/file?name=' + encodeURIComponent(f.name), style: { width: '100%', height: 86, objectFit: 'cover', display: 'block', background: 'rgba(127,127,127,.08)' }, alt: f.name })
                    : h('div', { style: { height: 86, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(127,127,127,.10)', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '音频/文件'),
                  picked ? h('div', { style: { position: 'absolute', inset: 0, border: '2px solid var(--dsw-alias-brand-primary)', pointerEvents: 'none' } }) : null,
                  picked ? h('div', {
                    style: {
                      position: 'absolute', top: 4, left: 4, width: 18, height: 18, borderRadius: 9,
                      background: 'var(--dsw-alias-brand-primary)', color: '#fff', fontSize: 12,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
                    },
                  }, '✓') : null,
                ),
                h('div', { style: { padding: '5px 7px' } },
                  h('div', { style: { fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: f.name }, f.name),
                  h('div', { style: { fontSize: 10, ...dim, marginTop: 1 } }, fmtTime(f.mtime)),
                  h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 3 } },
                    h('span', { style: { fontSize: 10, ...dim } }, fmtSize(f.size)),
                    h('span', { style: { display: 'flex', gap: 4 } },
                      isImage(f.name)
                        ? h('button', {
                          type: 'button',
                          onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); setPreview(f.name) },
                          style: {
                            fontSize: 11, padding: '2px 9px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
                            border: '1px solid var(--dsw-alias-label-primary)',
                            background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontWeight: 600,
                          },
                        }, '查')
                        : null,
                      smallBtn('删', () => del([f.name], '删掉「' + f.name + '」？删了就回不来了。'), true),
                    ),
                  ),
                ),
              )
            }),
          ),
      )


      // ── 模块页签 ──
      const moduleRow = (m) => h('div', {
        key: m.id,
        style: {
          border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))',
          borderRadius: 10, padding: '10px 12px', marginBottom: 8,
          display: 'flex', flexDirection: 'column', gap: 6,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('input', {
            type: 'checkbox', checked: m.enabled, disabled: m.removable === false,
            onChange: (e) => setModuleEnabled(m.id, e.target.checked),
            style: { width: 17, height: 17, margin: 0, cursor: 'pointer', accentColor: 'var(--dsw-alias-brand-primary)' },
          }),
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, m.label),
          m.tools && m.tools.length ? h('span', { style: { fontSize: 10, ...dim } }, '工具：' + m.tools.join(', ')) : null,
        ),
        h('div', { style: { fontSize: 11, ...dim, lineHeight: 1.7 } }, m.desc),
        m.id === 'paint' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
          h('div', { style: { display: 'flex', gap: 8 } },
            h('input', {
              style: inputStyle, value: paintDir, spellCheck: false,
              placeholder: '绘画输出目录',
              onChange: (e) => setPaintDir(e.target.value),
            }),
            h('button', {
              type: 'button',
              onClick: () => save({ modules: { paint: { outputDir: paintDir } } }).then(load),
              style: { padding: '7px 12px', borderRadius: 9, border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 },
            }, '保存目录'),
            h('button', {
              type: 'button',
              onClick: async () => {
                try {
                  const r = await (await fetch(API + '/open-folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: 'paint' }) })).json()
                  setMsg(r.ok ? '已打开：' + r.dir : (r.error || '打不开'))
                } catch (e) { setMsg(String((e && e.message) || e)) }
              },
              style: { padding: '7px 12px', borderRadius: 9, border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 },
            }, '打开'),
          ),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 11, ...dim } }, '默认尺寸'),
            ...[1024, 2048, 4096, 8192].map((v) => smallBtn(
              (cfg && cfg.modules && cfg.modules.paint && cfg.modules.paint.defaultSize === v ? '✓ ' : '') + (v >= 1024 ? (v / 1024) + 'K' : v),
              () => save({ modules: { paint: { defaultSize: v } } }).then(load),
            )),
          ),
          h('div', { style: { fontSize: 11, ...dim } }, 'Python：' + (cfg && cfg.modules && cfg.modules.paint && cfg.modules.paint.pythonPath ? cfg.modules.paint.pythonPath : '自动（DSH 自带运行时）')),
        ) : null,
      )

      const setModuleEnabled = async (id, enabled) => {
        try {
          const r = await (await fetch(API + '/modules', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, enabled }),
          })).json()
          if (r.ok) { setMods(r.modules || []); setMsg(id + ' 已' + (enabled ? '打开' : '关闭')) }
          else setMsg(r.error || '改不动')
        } catch (e) { setMsg(String((e && e.message) || e)) }
      }

      const modulesTab = h('div', null,
        h('div', { style: { fontSize: 13, lineHeight: 1.8, ...dim } },
          '这个插件是外壳，能力靠模块插进来：灯负责看进度，绘画负责画面。拔掉绘画，灯照样能看别的任务。'),
        h('div', { style: { marginTop: 12 } },
          mods.length === 0
            ? h('div', { style: { fontSize: 12, ...dim } }, '读取中…')
            : mods.map((m) => moduleRow(m)),
        ),
      )

      return h('div', { style: { padding: '2px 0 8px' } },
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 14 } },
          tabBtn('settings', '设置'),
          tabBtn('gallery', '画库' + (files.length ? '（' + files.length + '）' : '')),
          tabBtn('modules', '模块'),
        ),
        tab === 'settings' ? settingsTab : (tab === 'gallery' ? galleryTab : modulesTab),
        msg ? h('div', { style: { fontSize: 11, marginTop: 10, ...dim } }, msg) : null,

        preview ? h('div', {
          onClick: () => setPreview(null),
          style: { position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' },
        }, h('img', { src: API + '/file?name=' + encodeURIComponent(preview), style: { maxWidth: '80vw', maxHeight: '80vh', borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,.5)' } })) : null,
      )
    }

    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { dead: false } }
      static getDerivedStateFromError() { return { dead: true } }
      render() { return this.state.dead ? null : this.props.children }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-paint', order: 40 },
          () => h(Boundary, null, h(Lamp)),
        ))
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'dsh-paint', order: 63, label: '绘画' },
          () => h(Boundary, null, h(SettingsCard)),
        ))
      },
    }
  },
})
