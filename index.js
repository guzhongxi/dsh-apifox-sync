import { defineTool } from '@deepseek-ai/dsh-tools'
import { ApifoxSyncService } from './lib/scanner.js'
import { registerRoutes } from './lib/routes.js'

export const name = 'dsh-apifox-sync'
export const inject = ['webServer', 'tools']

export { ApifoxSyncService } from './lib/scanner.js'
export { parseJavaSource, JavaProjectModel, readJavaProject } from './lib/java-model.js'
export { loadApifoxConfig, uploadOpenApi } from './lib/apifox.js'

export function apply(ctx) {
  const service = new ApifoxSyncService()
  ctx.effect(() => registerRoutes(ctx, service), 'dsh-apifox-sync: routes')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'apifox_sync',
    description: '检测 Java 项目中受源码改动影响的接口，或在用户明确要求时把指定接口覆盖同步到 Apifox。scan 只读；upload 会修改远程文档。',
    parameters: {
      action: { type: 'string', required: true, enum: ['scan', 'upload'], description: 'scan 检测改动；upload 上传指定接口。' },
      dir: { type: 'string', required: true, description: '项目工作目录的绝对路径。' },
      endpointIds: { type: 'array', items: { type: 'string' }, description: 'upload 时必填，使用 scan 返回的接口 id。' },
      expectedFingerprints: { type: 'object', additionalProperties: true, description: '可选的接口 id 到 scan 指纹映射，用于避免上传已过期内容。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value.uploaded
          ? `已同步 ${value.uploaded.length} 个接口到 Apifox。`
          : `检测到 ${value.endpoints?.length ?? 0} 个受影响接口。`,
      }],
    },
    async execute(args, exec) {
      if (args.action === 'scan') return service.scan(args.dir, { signal: exec.signal })
      return service.uploadSelected(args.dir, args.endpointIds, args.expectedFingerprints ?? {}, { signal: exec.signal })
    },
  })), 'dsh-apifox-sync: agent tool')
  ctx.effect(() => () => service.dispose(), 'dsh-apifox-sync: watchers')
}
