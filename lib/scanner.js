import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { watch } from 'node:fs'
import { access } from 'node:fs/promises'
import { readJavaProject } from './java-model.js'
import { loadApifoxConfig, uploadOpenApi } from './apifox.js'

const execFileAsync = promisify(execFile)
const normalize = file => path.resolve(file).replace(/\\/g, '/').toLowerCase()

async function git(root, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return stdout
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('未找到 git，无法检测接口改动。')
    throw new Error(error?.stderr?.trim() || error.message)
  }
}

async function repositoryRoot(directory) {
  const resolved = path.resolve(directory)
  await access(resolved)
  return (await git(resolved, ['rev-parse', '--show-toplevel'])).trim()
}

async function changedJavaFiles(root) {
  const output = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const entries = output.split('\0').filter(Boolean)
  const files = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const relative = entry.slice(3)
    if (status.includes('R') || status.includes('C')) index += 1
    if (!relative.endsWith('.java')) continue
    const absolute = path.resolve(root, relative)
    const entryInfo = { path: absolute, relativePath: relative.replace(/\\/g, '/'), status, whole: false, ranges: [] }
    if (status.includes('??')) {
      entryInfo.whole = true
    } else {
      entryInfo.ranges = await diffNewRanges(root, relative)
      if (entryInfo.ranges.length === 0) entryInfo.whole = true
    }
    files.push(entryInfo)
  }
  return files
}

/** New-side line ranges touched by working tree + staged changes relative to HEAD. */
async function diffNewRanges(root, relative) {
  const output = await git(root, ['diff', '-U0', '--no-color', 'HEAD', '--', relative])
  const ranges = []
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (!match) continue
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    ranges.push(count === 0 ? [start, start] : [start, start + count - 1])
  }
  return ranges
}

function fingerprint(endpoint) {
  return createHash('sha256').update(JSON.stringify({ operation: endpoint.operation, components: endpoint.components })).digest('hex')
}

/**
 * Attribute a change inside a Controller file to one endpoint.
 * Only the endpoint whose own method span (Javadoc + annotations + body) is
 * touched counts as "definition/description"; a class-level edit (class
 * annotation, base path constant, imports) widens to the whole controller;
 * a change confined to a non-endpoint helper method returns undefined.
 */
function controllerChangeReason(model, endpoint, file) {
  if (file.whole) return '接口定义或说明'
  const span = endpoint.sourceSpan
  const spans = model.methodSpans(file.path)
  let endpointHit = false
  let classLevel = false
  for (const [start, end] of file.ranges) {
    if (span && start <= span.endLine && end >= span.startLine) endpointHit = true
    else if (!spans.some(item => start <= item.endLine && end >= item.startLine)) classLevel = true
  }
  if (endpointHit) return '接口定义或说明'
  if (classLevel) return '接口类或公共定义'
  return undefined
}

function publicEndpoint(endpoint, synced) {
  return {
    id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    summary: endpoint.summary,
    controller: endpoint.controller,
    sourcePath: endpoint.sourcePath,
    reasons: endpoint.reasons,
    changedFiles: endpoint.changedFiles,
    changedLines: endpoint.changedLines ?? [],
    fingerprint: endpoint.fingerprint,
    synced,
  }
}

function documentFor(endpoints, projectName) {
  const document = {
    openapi: '3.0.1',
    info: { title: `${projectName} - DSH 增量同步`, version: '1.0.0' },
    paths: {},
    components: { schemas: {} },
  }
  for (const endpoint of endpoints) {
    document.paths[endpoint.path] ??= {}
    document.paths[endpoint.path][endpoint.method.toLowerCase()] = endpoint.operation
    Object.assign(document.components.schemas, endpoint.components)
  }
  return document
}

export class ApifoxSyncService {
  constructor(options = {}) {
    this.states = new Map()
    this.loadConfig = options.loadConfig ?? loadApifoxConfig
    this.upload = options.upload ?? uploadOpenApi
    this.readProject = options.readProject ?? readJavaProject
  }

  async stateFor(directory) {
    const root = await repositoryRoot(directory)
    let state = this.states.get(root)
    if (!state) {
      state = { root, revision: 0, cacheRevision: -1, cache: undefined, synced: new Map(), watcher: undefined, timer: undefined }
      this.states.set(root, state)
      try {
        state.watcher = watch(root, { recursive: true }, (_event, filename) => {
          if (filename && !filename.toString().endsWith('.java')) return
          clearTimeout(state.timer)
          state.timer = setTimeout(() => {
            state.revision += 1
            state.cache = undefined
          }, 250)
        })
      } catch {
        // Polling the status route still permits manual refresh where recursive watch is unavailable.
      }
    }
    return state
  }

  async status(directory) {
    const state = await this.stateFor(directory)
    const config = await this.loadConfig(state.root)
    return {
      root: state.root,
      revision: state.revision,
      configured: config.configured,
      projectId: config.projectId,
      projectName: config.projectName,
    }
  }

  async scanInternal(directory, { signal } = {}) {
    const state = await this.stateFor(directory)
    if (state.cache && state.cacheRevision === state.revision) return state.cache
    if (signal?.aborted) throw new Error('扫描已取消。')
    const revision = state.revision
    const changedFiles = await changedJavaFiles(state.root)
    const sourceRoot = path.join(state.root, 'src', 'main', 'java')
    const { model, errors } = await this.readProject(sourceRoot)
    const endpoints = model.endpoints()
    const changed = []
    for (const endpoint of endpoints) {
      const dependencies = new Set(endpoint.dependencyFiles.map(normalize))
      const sourceNorm = normalize(endpoint.sourcePath)
      const requestFiles = new Set(endpoint.requestFiles.map(normalize))
      const responseFiles = new Set(endpoint.responseFiles.map(normalize))
      const reasons = new Set()
      const touched = []
      for (const file of changedFiles) {
        const norm = normalize(file.path)
        if (!dependencies.has(norm)) continue
        if (norm === sourceNorm) {
          const reason = controllerChangeReason(model, endpoint, file)
          if (reason === undefined) continue
          reasons.add(reason)
          touched.push(file)
          continue
        }
        if (requestFiles.has(norm)) reasons.add('请求参数或字段')
        if (responseFiles.has(norm)) reasons.add('响应字段')
        if (!requestFiles.has(norm) && !responseFiles.has(norm)) reasons.add('依赖模型')
        touched.push(file)
      }
      if (!reasons.size) continue
      const enriched = {
        ...endpoint,
        reasons: [...reasons],
        changedFiles: touched.map(file => file.relativePath),
        changedLines: touched.flatMap(file => file.whole ? [] : file.ranges.map(([start, end]) => start === end ? `${file.relativePath}:${start}` : `${file.relativePath}:${start}-${end}`)),
        fingerprint: fingerprint(endpoint),
      }
      changed.push(enriched)
    }
    const config = await this.loadConfig(state.root)
    const result = {
      root: state.root,
      revision: state.revision,
      scannedAt: new Date().toISOString(),
      endpoints: changed,
      changedFiles,
      warnings: errors.map(error => `${path.relative(state.root, error.path)}：${error.message}`).slice(0, 20),
      config,
      internalEndpoints: endpoints,
    }
    if (revision !== state.revision) {
      state.cache = undefined
      return this.scanInternal(state.root, { signal })
    }
    state.cache = result
    state.cacheRevision = revision
    return result
  }

  async scan(directory, options = {}) {
    const result = await this.scanInternal(directory, options)
    return {
      root: result.root,
      revision: result.revision,
      scannedAt: result.scannedAt,
      endpoints: result.endpoints.map(endpoint => publicEndpoint(endpoint, this.states.get(result.root).synced.get(endpoint.id) === endpoint.fingerprint)),
      changedFiles: result.changedFiles,
      warnings: result.warnings,
      configured: result.config.configured,
      projectId: result.config.projectId,
      projectName: result.config.projectName,
    }
  }

  async uploadSelected(directory, endpointIds, expectedFingerprints = {}, options = {}) {
    if (!Array.isArray(endpointIds) || endpointIds.length === 0 || endpointIds.length > 200) {
      throw new Error('请选择 1 到 200 个需要上传的接口。')
    }
    const ids = [...new Set(endpointIds)]
    const state = await this.stateFor(directory)
    state.cache = undefined
    const result = await this.scanInternal(state.root, options)
    const selected = []
    for (const id of ids) {
      const endpoint = result.endpoints.find(item => item.id === id)
      if (!endpoint) throw new Error(`接口 ${id} 已不在当前改动清单中，请重新扫描。`)
      if (expectedFingerprints[id] && expectedFingerprints[id] !== endpoint.fingerprint) {
        throw new Error(`接口 ${id} 的源码在扫描后又发生了变化，请重新扫描后再上传。`)
      }
      selected.push(endpoint)
    }
    const document = documentFor(selected, result.config.projectName)
    const uploadResult = await this.upload(result.config, document, options)
    for (const endpoint of selected) state.synced.set(endpoint.id, endpoint.fingerprint)
    return {
      ...uploadResult,
      uploaded: selected.map(endpoint => publicEndpoint(endpoint, true)),
      revision: state.revision,
    }
  }

  async dispose() {
    for (const state of this.states.values()) {
      clearTimeout(state.timer)
      state.watcher?.close()
    }
    this.states.clear()
  }
}

export { changedJavaFiles, documentFor, fingerprint }
