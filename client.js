window.__ModuleLoader__.load({
  id: 'dsh-apifox-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useSyncExternalStore } = React
    const NS = 'dshApifoxSync'
    const PANEL_ID = 'dsh-apifox-sync'
    const PREFIX = '/plugins/dsh-apifox-sync'

    const en = {
      panel: 'Apifox', title: 'Apifox endpoint sync', refresh: 'Rescan', loading: 'Scanning endpoint changes…', loadingShort: 'Scanning…',
      empty: 'No affected endpoints in the current Git working tree.', emptySynced: 'All affected endpoints have been synced.',
      noDirectory: 'Open a project Session before using Apifox sync.', project: 'Target project', notConfigured: 'Apifox credentials are not configured.',
      configHint: 'Set APIFOX_ACCESS_TOKEN and APIFOX_PROJECT_ID, or check .spring-api-helper.json.',
      selectAll: 'Select all pending', upload: 'Upload selected', uploading: 'Uploading…', pending: 'pending',
      synced: 'Synced', showSynced: 'Show synced', warning: 'Upload overwrites matching endpoints and schemas in Apifox. Other endpoints are never deleted.',
      changedFiles: 'Changed files', uploadDone: 'Upload completed.', uploadFailed: 'Upload failed', scanFailed: 'Scan failed',
      endpointsAffected: 'affected endpoints', uploadAll: 'Upload all', dockHint: 'Review details in the Apifox sidebar panel.',
      source: 'Source', controller: 'Controller', lastScan: 'Last scan', automatic: 'Java changes are detected automatically.',
      confirm: 'Upload to Apifox project “{project}”?\n\n{count} endpoint(s) will be overwritten by Method + Path, together with their related data models. No other endpoint is deleted.\n\nContinue?',
      scanErrorShort: 'Scan failed', notConfiguredShort: 'Apifox not configured', viewDetails: 'Review in the Apifox panel',
    }
    const zh = {
      panel: 'Apifox', title: 'Apifox 接口同步', refresh: '重新检测', loading: '正在检测接口改动…', loadingShort: '检测中…',
      empty: '当前 Git 工作区没有接口相关改动。', emptySynced: '受影响的接口都已同步。',
      noDirectory: '请先打开一个项目会话，再使用 Apifox 同步。', project: '目标项目', notConfigured: '尚未配置 Apifox 凭据。',
      configHint: '请设置 APIFOX_ACCESS_TOKEN 和 APIFOX_PROJECT_ID，或检查 .spring-api-helper.json。',
      selectAll: '选择全部待同步', upload: '上传选中接口', uploading: '正在上传…', pending: '个待同步',
      synced: '已同步', showSynced: '显示已同步', warning: '上传会覆盖 Apifox 中相同 Method + Path 的接口及相关数据模型，不会删除其他接口。',
      changedFiles: '改动文件', uploadDone: '上传完成。', uploadFailed: '上传失败', scanFailed: '检测失败',
      endpointsAffected: '个接口受到影响', uploadAll: '全部上传', dockHint: '在左侧 Apifox 面板中核对详情。',
      source: '来源', controller: '控制器', lastScan: '最近检测', automatic: 'Java 文件保存后会自动重新检测。',
      confirm: '即将把 {count} 个接口覆盖同步到 Apifox 项目「{project}」。\n\n相同 Method + Path 的接口及相关数据模型会被覆盖；不会删除其他接口。\n\n确定继续上传吗？',
      scanErrorShort: '检测失败', notConfiguredShort: 'Apifox 未配置', viewDetails: '在左侧 Apifox 面板核对',
    }

    async function post(route, body, signal) {
      const response = await fetch(`${PREFIX}/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(body), signal: signal ?? null,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`)
      return payload
    }

    function currentDirectoryOf(state) {
      const directoryOf = id => {
        const cwd = state.byId[id]?.cwd
        return typeof cwd === 'string' && cwd ? cwd : undefined
      }
      for (const id of state.ids) {
        if ((state.byId[id]?.retainedBy?.mainView ?? 0) > 0) {
          const directory = directoryOf(id)
          if (directory) return directory
        }
      }
      for (const id of state.ids) {
        const directory = directoryOf(id)
        if (directory) return directory
      }
      return undefined
    }

    function emptyState() {
      return { directory: undefined, data: undefined, selected: new Set(), loading: false, uploading: false, error: '', message: '', selectionInitialized: false }
    }

    // One shared controller per plugin: the sidebar panel and the composer dock
    // read the same state and drive the same request, so an upload started in
    // either place immediately clears the pending badge in both.
    function createController() {
      let state = emptyState()
      const listeners = new Set()
      let requestSeq = 0
      let loadingRef = false
      let pollTimer
      const emit = next => {
        state = { ...state, ...next }
        for (const listener of [...listeners]) {
          try { listener() } catch { /* a broken subscriber must not block others */ }
        }
      }
      const subscribe = listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }
      const getSnapshot = () => state

      const load = async ({ quiet = false } = {}) => {
        const directory = state.directory
        if (!directory || loadingRef) return
        const seq = ++requestSeq
        loadingRef = true
        if (!quiet) emit({ loading: true, error: '' })
        else emit({ error: '' })
        try {
          const result = await post('scan', { dir: directory })
          if (seq !== requestSeq) return
          const pendingIds = result.endpoints.filter(endpoint => !endpoint.synced).map(endpoint => endpoint.id)
          const selected = new Set()
          if (!state.selectionInitialized) {
            for (const id of pendingIds) selected.add(id)
          } else {
            for (const id of pendingIds) if (state.selected.has(id)) selected.add(id)
          }
          emit({
            data: result,
            selected,
            selectionInitialized: true,
            loading: false,
            ...(quiet ? {} : { message: '' }),
          })
        } catch (cause) {
          if (seq === requestSeq) emit({ loading: false, error: `__SCAN__${cause.message}` })
        } finally {
          loadingRef = false
        }
      }

      const poll = async () => {
        if (!state.directory || loadingRef) return
        try {
          const status = await post('status', { dir: state.directory })
          if (status.revision !== state.data?.revision) await load({ quiet: true })
        } catch { /* the next explicit refresh surfaces connection failures */ }
      }

      const toggle = id => {
        const selected = new Set(state.selected)
        if (selected.has(id)) selected.delete(id); else selected.add(id)
        emit({ selected })
      }
      const setSelected = ids => emit({ selected: new Set(ids) })

      const upload = async ids => {
        if (!state.directory || !ids.length || state.uploading) return
        const project = state.data?.projectName ?? ''
        const projectId = state.data?.projectId ?? ''
        if (!state.data?.configured) {
          emit({ error: '__CONFIG__未配置 Apifox 凭据，无法上传。' })
          return
        }
        emit({ uploading: true, error: '', message: '' })
        try {
          const expectedFingerprints = {}
          for (const endpoint of state.data?.endpoints ?? []) {
            if (ids.includes(endpoint.id)) expectedFingerprints[endpoint.id] = endpoint.fingerprint
          }
          const result = await post('upload', { dir: state.directory, endpointIds: ids, expectedFingerprints })
          const counters = result.counters ?? {}
          const done = `__DONE__新增 ${counters.endpointCreated ?? 0}，更新 ${counters.endpointUpdated ?? 0}，模型更新 ${counters.schemaUpdated ?? 0}。`
          emit({ uploading: false, message: done })
          setTimeout(() => { if (state.message === done) emit({ message: '' }) }, 8000)
          await load({ quiet: true })
        } catch (cause) {
          emit({ uploading: false, error: `__UPLOAD__${cause.message}` })
        }
      }

      const setDirectory = directory => {
        if (directory === state.directory) return
        requestSeq += 1
        loadingRef = false
        emit({ ...emptyState(), directory })
        if (directory) void load()
      }
      const reload = () => { requestSeq += 1; loadingRef = false; void load() }

      return {
        subscribe, getSnapshot, load, reload, toggle, setSelected, upload, setDirectory,
        startPolling() { pollTimer = setInterval(poll, 4000) },
        dispose() { clearInterval(pollTimer); listeners.clear() },
      }
    }

    function Icon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M5 7h9a3 3 0 0 1 3 3v1m0 0-2-2m2 2 2-2M19 17h-9a3 3 0 0 1-3-3v-1m0 0 2 2m-2-2-2 2', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('rect', { x: 8, y: 8.5, width: 8, height: 7, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.4 }))
    }

    const styles = `
      .das-panel{height:100%;display:flex;flex-direction:column;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,transparent);font-size:13px;line-height:20px}
      .das-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
      .das-title{font-size:16px;font-weight:600;flex:1}.das-subtitle{color:var(--dsw-alias-label-secondary);font-size:12px}
      .das-body{padding:14px 18px;overflow:auto;min-height:0;flex:1}.das-notice{padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);margin-bottom:12px;white-space:pre-wrap}
      .das-error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));border-color:var(--dsw-alias-state-error-primary,var(--dsw-alias-border-l3))}
      .das-success{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-primary))}.das-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
      .das-spacer{flex:1}.das-button{border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-button-elevated-fill,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
      .das-button:hover{background:var(--dsw-alias-interactive-bg-hover)}.das-button:disabled{opacity:.5;cursor:default}.das-primary{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color,var(--dsw-alias-bg-base));border-color:transparent}
      .das-check{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}.das-check input{accent-color:var(--dsw-alias-state-business-primary)}
      .das-list{display:flex;flex-direction:column;gap:8px}.das-row{border:.5px solid var(--dsw-alias-border-l3);border-radius:9px;padding:10px 12px;display:flex;gap:10px;align-items:flex-start;background:var(--dsw-alias-bg-base,transparent)}
      .das-row[data-synced=true]{opacity:.65}.das-row input{margin-top:4px;accent-color:var(--dsw-alias-state-business-primary);flex:none}.das-row-main{min-width:0;flex:1}.das-endpoint{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .das-method{font-family:var(--ds-font-family-code,monospace);font-size:11px;font-weight:600;color:var(--dsw-alias-state-business-primary);min-width:42px}.das-path{font-family:var(--ds-font-family-code,monospace);font-size:12px;overflow-wrap:anywhere}
      .das-summary{margin-top:3px}.das-meta{margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:11px;overflow-wrap:anywhere}.das-reason{display:inline-block;margin-right:6px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px}
      .das-empty{padding:48px 16px;text-align:center;color:var(--dsw-alias-label-secondary)}.das-warnings{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:14px;white-space:pre-wrap}
      .das-dock{display:flex;align-items:center;gap:9px;min-width:0;padding:7px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:9px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
      .das-dock-text{min-width:0;flex:1;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow-wrap:anywhere}.das-dock-count{font-weight:600}.das-dock .das-button{padding:2px 9px;flex:none}
      .das-dock-result{flex:none;font-size:11px}.das-dock-error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}.das-dock-ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-primary))}
      .das-button:focus-visible,.das-check input:focus-visible,.das-row:focus-within{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
    `

    function useController(controller) {
      return useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    }

    function pendingOf(state) {
      return (state.data?.endpoints ?? []).filter(endpoint => !endpoint.synced)
    }

    function describeError(state, t) {
      if (!state.error) return ''
      if (state.error.startsWith('__SCAN__')) return `${t('scanFailed')}：${state.error.slice(8)}`
      if (state.error.startsWith('__UPLOAD__')) return `${t('uploadFailed')}：${state.error.slice(10)}`
      if (state.error.startsWith('__CONFIG__')) return state.error.slice(10)
      return state.error
    }

    function describeMessage(state) {
      return state.message.startsWith('__DONE__') ? state.message.slice(8) : state.message
    }

    function confirmUpload(state, ids, t) {
      const project = `${state.data?.projectName ?? ''}（${state.data?.projectId ?? ''}）`
      return window.confirm(t('confirm').replace('{count}', String(ids.length)).replace('{project}', project))
    }

    function EndpointRow({ endpoint, selected, syncedVisible, onToggle, t }) {
      if (endpoint.synced && !syncedVisible) return null
      return h('label', { className: 'das-row', 'data-synced': endpoint.synced },
        h('input', { type: 'checkbox', checked: selected, disabled: endpoint.synced, onChange: () => onToggle(endpoint.id), 'aria-label': `${endpoint.id}` }),
        h('div', { className: 'das-row-main' },
          h('div', { className: 'das-endpoint' },
            h('span', { className: 'das-method' }, endpoint.method),
            h('span', { className: 'das-path' }, endpoint.path),
            endpoint.synced && h('span', { className: 'das-reason' }, t('synced'))),
          h('div', { className: 'das-summary' }, endpoint.summary),
          h('div', { className: 'das-meta' }, endpoint.reasons.map(reason => h('span', { className: 'das-reason', key: reason }, reason))),
          h('div', { className: 'das-meta', title: endpoint.controller }, `${t('controller')}：${endpoint.controller}`),
          h('div', { className: 'das-meta' }, `${t('changedFiles')}：${endpoint.changedFiles.join('、')}`),
          endpoint.changedLines && endpoint.changedLines.length > 0 && h('div', { className: 'das-meta' }, `改动行：${endpoint.changedLines.join('、')}`)))
    }

    function Panel({ controller, t }) {
      const state = useController(controller)
      const [showSynced, setShowSynced] = useState(false)
      const endpoints = state.data?.endpoints ?? []
      const pending = pendingOf(state)
      const selectedPending = pending.filter(endpoint => state.selected.has(endpoint.id))
      const allSelected = pending.length > 0 && selectedPending.length === pending.length
      const someSelected = selectedPending.length > 0 && !allSelected
      const selectAllRef = React.useRef(null)
      useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected }, [someSelected])
      const error = describeError(state, t)
      const message = describeMessage(state)
      return h('section', { className: 'das-panel' },
        h('style', null, styles),
        h('header', { className: 'das-head' },
          h(Icon, { size: 20 }),
          h('div', { className: 'das-title' }, t('title'),
            state.data && h('div', { className: 'das-subtitle' }, `${t('project')}：${state.data.projectName}（${state.data.projectId || '-'}）`)),
          h('button', { className: 'das-button', type: 'button', disabled: state.loading || state.uploading || !state.directory, onClick: () => controller.reload() }, state.loading ? t('loadingShort') : t('refresh'))),
        h('div', { className: 'das-body' },
          !state.directory && h('div', { className: 'das-empty' }, t('noDirectory')),
          state.directory && h(React.Fragment, null,
            state.data?.configured === false && h('div', { className: 'das-notice das-error' }, `${t('notConfigured')}\n${t('configHint')}`),
            pending.length > 0 && h('div', { className: 'das-notice' }, t('warning')),
            error && h('div', { className: 'das-notice das-error', role: 'alert' }, error),
            message && h('div', { className: 'das-notice das-success', role: 'status' }, message),
            h('div', { className: 'das-toolbar' },
              h('strong', null, `${pending.length} ${t('pending')}`),
              h('span', { className: 'das-subtitle' }, t('automatic')),
              h('span', { className: 'das-spacer' }),
              h('label', { className: 'das-check' }, h('input', { type: 'checkbox', checked: showSynced, onChange: event => setShowSynced(event.target.checked) }), t('showSynced')),
              h('label', { className: 'das-check' }, h('input', {
                ref: selectAllRef, type: 'checkbox', checked: allSelected, disabled: !pending.length,
                onChange: () => controller.setSelected(allSelected ? [] : pending.map(endpoint => endpoint.id)),
              }), t('selectAll')),
              h('button', {
                className: 'das-button das-primary', type: 'button',
                disabled: !selectedPending.length || state.uploading || state.loading || state.data?.configured === false,
                onClick: () => {
                  const ids = selectedPending.map(endpoint => endpoint.id)
                  if (confirmUpload(state, ids, t)) void controller.upload(ids)
                },
              }, state.uploading ? t('uploading') : `${t('upload')}（${selectedPending.length}）`)),
            !state.data && state.loading && h('div', { className: 'das-empty' }, t('loading')),
            state.data && endpoints.length === 0 && h('div', { className: 'das-empty' }, t('empty')),
            state.data && endpoints.length > 0 && pending.length === 0 && !showSynced && h('div', { className: 'das-empty' }, t('emptySynced')),
            h('div', { className: 'das-list' }, endpoints.map(endpoint => h(EndpointRow, {
              key: endpoint.id, endpoint, selected: state.selected.has(endpoint.id), syncedVisible: showSynced, onToggle: controller.toggle, t,
            }))),
            state.data?.warnings?.length > 0 && h('div', { className: 'das-warnings' }, state.data.warnings.join('\n')),
            state.data && h('div', { className: 'das-warnings' }, `${t('lastScan')}：${new Date(state.data.scannedAt).toLocaleString()}`))))
    }

    function Dock({ controller, t }) {
      const state = useController(controller)
      const pending = pendingOf(state)
      const error = describeError(state, t)
      const message = describeMessage(state)
      const configured = state.data?.configured !== false
      if (!state.directory) return null
      if (!pending.length && !error && !message && !state.uploading) return null
      const list = pending.map(item => `${item.method} ${item.path}`)
      return h('div', { className: 'das-dock' },
        h('style', null, styles), h(Icon, { size: 15 }),
        h('span', { className: 'das-dock-text', title: pending.length ? `${t('project')}：${state.data?.projectName ?? '-'}\n${list.join('\n')}` : (error || message) },
          pending.length > 0
            ? h(React.Fragment, null,
              h('span', { className: 'das-dock-count' }, `Apifox：${pending.length} ${t('endpointsAffected')}`),
              ` · ${list.join('；')}`)
            : h('span', null, error || message || t('uploading'))),
        state.uploading && h('span', { className: 'das-dock-result' }, t('uploading')),
        error && h('span', { className: 'das-dock-result das-dock-error', role: 'alert' }, error),
        message && !error && h('span', { className: 'das-dock-result das-dock-ok', role: 'status' }, message),
        pending.length > 0 && h('button', {
          className: 'das-button das-primary', type: 'button', disabled: state.uploading || state.loading || !configured,
          onClick: () => {
            const ids = pending.map(endpoint => endpoint.id)
            if (confirmUpload(state, ids, t)) void controller.upload(ids)
          },
        }, state.uploading ? t('uploading') : `${t('uploadAll')}（${pending.length}）`))
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-apifox-sync: locale')
        const t = ctx.locale.bind(NS)
        const controller = createController()
        controller.setDirectory(currentDirectoryOf(ctx.sessions.list.getSnapshot()))
        ctx.effect(() => ctx.sessions.list.subscribe(() => {
          controller.setDirectory(currentDirectoryOf(ctx.sessions.list.getSnapshot()))
        }), 'dsh-apifox-sync: directory')
        ctx.effect(() => { controller.startPolling(); return () => controller.dispose() }, 'dsh-apifox-sync: polling')
        const panel = props => h(Panel, { ...props, controller, t })
        const dock = props => h(Dock, { ...props, controller, t })
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 42, label: () => t('panel'), locale: NS,
        }, Icon)), 'dsh-apifox-sync: sidebar')
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
        }, panel)), 'dsh-apifox-sync: panel')
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'dsh-apifox-sync', order: 8, locale: NS,
        }, dock)), 'dsh-apifox-sync: pending dock')
      },
    }
  },
})
