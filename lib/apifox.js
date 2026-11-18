import path from 'node:path'
import { readFile } from 'node:fs/promises'

const APIFOX_API = 'https://api.apifox.com'
const API_VERSION = '2024-03-28'

async function readJson(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`无法读取配置 ${path.basename(file)}：${error.message}`)
  }
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Load non-secret project settings and reuse the existing local Apifox token. */
export async function loadApifoxConfig(root, env = process.env) {
  const overrides = await readJson(path.join(root, '.apifox-sync.json'))
  const helper = await readJson(path.join(root, '.spring-api-helper.json'))
  const token = env.APIFOX_ACCESS_TOKEN || helper.apiKey || ''
  const projectId = String(env.APIFOX_PROJECT_ID || overrides.projectId || helper.projectId || '')
  return {
    configured: Boolean(token && projectId),
    accessToken: token,
    projectId,
    projectName: overrides.projectName || helper.projectName || projectId || '未配置',
    targetEndpointFolderId: numberOrUndefined(overrides.targetEndpointFolderId),
    targetSchemaFolderId: numberOrUndefined(overrides.targetSchemaFolderId),
    targetBranchId: numberOrUndefined(overrides.targetBranchId),
    moduleId: numberOrUndefined(overrides.moduleId),
  }
}

/** Import one bounded OpenAPI document, overwriting descriptions and schemas without deleting other resources. */
export async function uploadOpenApi(config, document, options = {}) {
  if (!config.configured) {
    throw new Error('未找到 Apifox 访问令牌或项目 ID，请配置 APIFOX_ACCESS_TOKEN / APIFOX_PROJECT_ID，或检查 .spring-api-helper.json。')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response
  try {
    response = await fetchImpl(`${APIFOX_API}/v1/projects/${encodeURIComponent(config.projectId)}/import-openapi?locale=zh-CN`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'X-Apifox-Api-Version': API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: JSON.stringify(document),
        options: {
          ...(config.targetEndpointFolderId === undefined ? {} : { targetEndpointFolderId: config.targetEndpointFolderId }),
          ...(config.targetSchemaFolderId === undefined ? {} : { targetSchemaFolderId: config.targetSchemaFolderId }),
          ...(config.targetBranchId === undefined ? {} : { targetBranchId: config.targetBranchId }),
          ...(config.moduleId === undefined ? {} : { moduleId: config.moduleId }),
          endpointOverwriteBehavior: 'OVERWRITE_EXISTING',
          schemaOverwriteBehavior: 'OVERWRITE_EXISTING',
          updateFolderOfChangedEndpoint: false,
          prependBasePath: false,
          deleteUnmatchedResources: false,
        },
      }),
      signal,
    })
  } catch (error) {
    throw new Error(`连接 Apifox 失败：${error.message}`)
  }
  const text = await response.text()
  let payload
  try { payload = text ? JSON.parse(text) : {} }
  catch { throw new Error(`Apifox 返回了无法解析的响应（HTTP ${response.status}）。`) }
  if (!response.ok) {
    throw new Error(payload.message || payload.error?.message || `Apifox 上传失败（HTTP ${response.status}）。`)
  }
  const data = payload.data ?? {}
  const counters = data.counters ?? {}
  const errors = Array.isArray(data.errors) ? data.errors : []
  const failed = ['endpointFailed', 'schemaFailed'].reduce((sum, key) => sum + (Number(counters[key]) || 0), 0)
  if (failed > 0 || errors.length > 0) {
    const detail = errors.map(item => item.message).filter(Boolean).join('；')
    throw new Error(`Apifox 部分导入失败：接口 ${Number(counters.endpointFailed) || 0} 个，模型 ${Number(counters.schemaFailed) || 0} 个。${detail}`)
  }
  return { counters, errors }
}
