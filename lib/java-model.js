import { parse } from 'java-parser'
import path from 'node:path'

const HTTP_MAPPINGS = new Map([
  ['Get', 'GET'], ['GetMapping', 'GET'],
  ['Post', 'POST'], ['PostMapping', 'POST'],
  ['Put', 'PUT'], ['PutMapping', 'PUT'],
  ['Delete', 'DELETE'], ['DeleteMapping', 'DELETE'],
  ['Patch', 'PATCH'], ['PatchMapping', 'PATCH'],
])
const CONTROLLER_ANNOTATIONS = new Set(['Controller', 'RestController'])
const IGNORED_PARAMETERS = new Set([
  'Context', 'HttpServletRequest', 'HttpServletResponse', 'ServerRequest', 'ServerResponse',
  'AuthUser', 'Principal', 'Authentication',
])
const VALIDATION_ANNOTATIONS = new Set(['NotNull', 'NotBlank', 'NotEmpty'])

function children(node, key) {
  return node?.children?.[key] ?? []
}

function first(node, key) {
  return children(node, key)[0]
}

function tokens(node, output = []) {
  if (node === null || node === undefined) return output
  if (Array.isArray(node)) {
    for (const item of node) tokens(item, output)
  } else if (typeof node.image === 'string') {
    output.push(node)
  } else if (node.children) {
    for (const value of Object.values(node.children)) tokens(value, output)
  }
  return output
}

function textOf(source, node) {
  const location = node?.location
  if (!location) return tokens(node).map(token => token.image).join('')
  return source.slice(location.startOffset, location.endOffset + 1).trim()
}

function compact(value) {
  return value.replace(/\s+/g, '')
}

function cleanDoc(comment) {
  if (!comment) return ''
  return comment
    .replace(/^\/\*\*|\*\/$/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\* ?/, '').trim())
    .filter(line => line && !line.startsWith('@'))
    .join('\n')
    .trim()
}

function parameterDocs(comment) {
  const result = new Map()
  if (!comment) return result
  const lines = comment.replace(/^\/\*\*|\*\/$/g, '').split(/\r?\n/)
    .map(line => line.replace(/^\s*\* ?/, '').trim())
  for (const line of lines) {
    const match = line.match(/^@param\s+(\S+)\s+(.+)$/)
    if (match) result.set(match[1], match[2])
  }
  return result
}

function precedingDocComment(source, comments, node) {
  const start = node?.location?.startOffset
  if (start === undefined) return undefined
  return [...comments].reverse().find(item =>
    item.startOffset < start && item.image.startsWith('/**') &&
    !/[;{}]/.test(source.slice(item.endOffset + 1, start)))
}

function documentationBefore(source, comments, node, raw = false) {
  const comment = precedingDocComment(source, comments, node)
  return raw ? (comment?.image ?? '') : cleanDoc(comment?.image)
}

function parseAnnotation(source, node) {
  const typeName = first(node, 'typeName')
  const names = children(typeName, 'Identifier').map(token => token.image)
  const name = names.at(-1) ?? ''
  const pairs = {}
  for (const pairList of children(node, 'elementValuePairList')) {
    for (const pair of children(pairList, 'elementValuePair')) {
      const key = first(pair, 'Identifier')?.image
      const value = first(pair, 'elementValue')
      if (key && value) pairs[key] = textOf(source, value)
    }
  }
  const defaultValue = first(node, 'elementValue')
  return {
    name,
    qualifiedName: names.join('.'),
    pairs,
    defaultValue: defaultValue ? textOf(source, defaultValue) : undefined,
    raw: textOf(source, node),
  }
}

function annotationsFrom(source, nodes) {
  const annotations = []
  for (const modifier of nodes ?? []) {
    for (const annotation of children(modifier, 'annotation')) {
      annotations.push(parseAnnotation(source, annotation))
    }
  }
  return annotations
}

function annotation(annotations, names) {
  const accepted = new Set(Array.isArray(names) ? names : [names])
  if (!Array.isArray(annotations)) {
    return annotations && (accepted.has(annotations.name) || accepted.has(annotations.qualifiedName)) ? annotations : undefined
  }
  return annotations.find(item => accepted.has(item.name) || accepted.has(item.qualifiedName))
}

function literalValue(expression) {
  if (!expression) return undefined
  const match = expression.match(/"(?:\\.|[^"\\])*"/s)
  if (!match) return undefined
  try { return JSON.parse(match[0]) } catch { return match[0].slice(1, -1) }
}

function annotationValue(annotationValueNode, names, classInfo) {
  if (!annotationValueNode) return undefined
  for (const name of names) {
    const expression = annotationValueNode.pairs[name]
    const literal = literalValue(expression)
    if (literal !== undefined) return literal
    if (expression) {
      const constant = classInfo?.constants.get(compact(expression))
      if (constant !== undefined) return constant
    }
  }
  const literal = literalValue(annotationValueNode.defaultValue)
  if (literal !== undefined) return literal
  const expression = annotationValueNode.defaultValue
  return expression ? classInfo?.constants.get(compact(expression)) : undefined
}

function splitTypeArguments(value) {
  const result = []
  let start = 0
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '<') depth += 1
    if (character === '>') depth -= 1
    if (character === ',' && depth === 0) {
      result.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  if (start < value.length) result.push(value.slice(start).trim())
  return result.filter(Boolean)
}

function parseType(value) {
  const compactType = compact(value ?? 'Object')
    .replace(/\[\]$/g, '')
    .replace(/\.\.\.$/g, '')
  const array = /(?:\[\]|\.\.\.)\s*$/.test(value ?? '') || compact(value ?? '').endsWith('[]')
  const wildcard = compactType.match(/^\?(?:extends|super)(.+)$/)
  const normalized = wildcard ? wildcard[1] : compactType
  const genericAt = normalized.indexOf('<')
  const base = genericAt === -1 ? normalized : normalized.slice(0, genericAt)
  const args = genericAt === -1 ? [] : splitTypeArguments(normalized.slice(genericAt + 1, normalized.lastIndexOf('>')))
  return { base, args: args.map(parseType), array, raw: value }
}

function typeParametersOf(source, declaration) {
  const parameters = first(declaration, 'typeParameters')
  if (!parameters) return []
  const raw = textOf(source, parameters)
  return splitTypeArguments(raw.slice(raw.indexOf('<') + 1, raw.lastIndexOf('>')))
    .map(item => item.trim().split(/\s+/)[0])
}

function parseMethod(source, comments, node) {
  const header = first(node, 'methodHeader')
  const declarator = first(header, 'methodDeclarator')
  if (!declarator) return undefined
  const modifiers = children(node, 'methodModifier')
  const annotations = annotationsFrom(source, modifiers)
  const parameters = []
  const methodComment = documentationBefore(source, comments, node, true)
  const methodDescription = cleanDoc(methodComment)
  const parameterList = first(declarator, 'formalParameterList')
  for (const formal of children(parameterList, 'formalParameter')) {
    const regular = first(formal, 'variableParaRegularParameter') ?? first(formal, 'variableArityParameter')
    if (!regular) continue
    const typeNode = first(regular, 'unannType')
    const id = first(regular, 'variableDeclaratorId')
    const name = first(id, 'Identifier')?.image
    if (!name) continue
    parameters.push({
      name,
      type: textOf(source, typeNode),
      annotations: annotationsFrom(source, children(regular, 'variableModifier')),
      description: parameterDocs(methodComment).get(name) ?? '',
    })
  }
  return {
    name: first(declarator, 'Identifier')?.image ?? '',
    returnType: textOf(source, first(header, 'result')),
    annotations,
    parameters,
    description: methodDescription,
    span: methodSpan(source, comments, node),
    location: node.location,
  }
}

/** Line span of one method declaration, widened upward to include its Javadoc. */
function methodSpan(source, comments, node) {
  const startLine = node.location?.startLine ?? 0
  const endLine = node.location?.endLine ?? 0
  const doc = precedingDocComment(source, comments, node)
  return { startLine: doc ? Math.min(doc.startLine, startLine) : startLine, endLine }
}

function parseField(source, comments, node) {
  const modifiers = children(node, 'fieldModifier')
  const annotations = annotationsFrom(source, modifiers)
  const modifierText = modifiers.map(item => textOf(source, item)).join(' ')
  const type = textOf(source, first(node, 'unannType'))
  const description = documentationBefore(source, comments, node)
  const fields = []
  for (const declarator of children(first(node, 'variableDeclaratorList'), 'variableDeclarator')) {
    const id = first(declarator, 'variableDeclaratorId')
    const name = first(id, 'Identifier')?.image
    if (!name) continue
    const initializerNode = first(declarator, 'variableInitializer')
    const initializer = initializerNode ? textOf(source, initializerNode) : undefined
    fields.push({ name, type, annotations, description, static: /\bstatic\b/.test(modifierText), initializer })
  }
  return fields
}

function parseClass(source, comments, node, file, parent) {
  const declaration = first(node, 'normalClassDeclaration')
  if (!declaration) return []
  const name = first(first(declaration, 'typeIdentifier'), 'Identifier')?.image
  if (!name) return []
  const qualifiedName = `${file.packageName ? `${file.packageName}.` : ''}${parent ? `${parent.name}.` : ''}${name}`
  const annotations = annotationsFrom(source, children(node, 'classModifier'))
  const classInfo = {
    name,
    simpleName: name,
    qualifiedName,
    annotations,
    description: documentationBefore(source, comments, node),
    file,
    parent,
    fields: [],
    methods: [],
    constants: new Map(),
    typeParameters: typeParametersOf(source, declaration),
    superclass: textOf(source, first(declaration, 'superclass')).replace(/^extends\s*/, ''),
    nested: [],
  }
  file.classes.push(classInfo)
  const body = first(declaration, 'classBody')
  for (const bodyDeclaration of children(body, 'classBodyDeclaration')) {
    const member = first(bodyDeclaration, 'classMemberDeclaration')
    if (!member) continue
    for (const fieldNode of children(member, 'fieldDeclaration')) {
      classInfo.fields.push(...parseField(source, comments, fieldNode))
    }
    for (const methodNode of children(member, 'methodDeclaration')) {
      const method = parseMethod(source, comments, methodNode)
      if (method) classInfo.methods.push(method)
    }
    for (const nestedNode of children(member, 'classDeclaration')) {
      classInfo.nested.push(...parseClass(source, comments, nestedNode, file, classInfo))
    }
  }
  for (const field of classInfo.fields) {
    if (field.static) {
      const value = literalValue(field.initializer)
      if (value !== undefined) classInfo.constants.set(field.name, value)
    }
  }
  return [classInfo]
}

/** Parse one Java source file into the small model needed for API documentation. */
export function parseJavaSource(source, filePath = '') {
  const cst = parse(source)
  const unit = first(cst, 'ordinaryCompilationUnit')
  const packageName = children(first(unit, 'packageDeclaration'), 'Identifier').map(token => token.image).join('.')
  const file = {
    path: filePath,
    packageName,
    imports: new Map(),
    wildcardImports: [],
    classes: [],
    source,
  }
  for (const importNode of children(unit, 'importDeclaration')) {
    const identifiers = children(first(importNode, 'packageOrTypeName'), 'Identifier').map(token => token.image)
    const name = identifiers.join('.')
    if (tokens(importNode).some(token => token.image === '*')) file.wildcardImports.push(name)
    else if (identifiers.length) file.imports.set(identifiers.at(-1), name)
  }
  for (const typeDeclaration of children(unit, 'typeDeclaration')) {
    for (const classNode of children(typeDeclaration, 'classDeclaration')) {
      parseClass(source, cst.comments ?? [], classNode, file)
    }
  }
  return file
}

function schemaName(type) {
  const args = type.args.map(schemaName).join('_')
  return `${type.base.replace(/[^A-Za-z0-9_]/g, '_')}${args ? `_${args}` : ''}`
}

function primitiveSchema(base) {
  if (['String', 'Character', 'char', 'UUID', 'URI', 'URL'].includes(base)) return { type: 'string' }
  if (['Integer', 'int', 'Short', 'short', 'Byte', 'byte'].includes(base)) return { type: 'integer', format: 'int32' }
  if (['Long', 'long', 'BigInteger'].includes(base)) return { type: 'integer', format: 'int64' }
  if (['Float', 'float', 'Double', 'double', 'BigDecimal', 'Number'].includes(base)) return { type: 'number' }
  if (['Boolean', 'boolean'].includes(base)) return { type: 'boolean' }
  if (['LocalDateTime', 'Date', 'Instant', 'OffsetDateTime', 'ZonedDateTime'].includes(base)) return { type: 'string', format: 'date-time' }
  if (['LocalDate'].includes(base)) return { type: 'string', format: 'date' }
  if (['LocalTime'].includes(base)) return { type: 'string', format: 'time' }
  if (['byte[]'].includes(base)) return { type: 'string', format: 'byte' }
  if (['UploadedFile', 'MultipartFile', 'File'].includes(base)) return { type: 'string', format: 'binary' }
  if (['DownloadedFile'].includes(base)) return { type: 'string', format: 'binary' }
  if (['Object', 'T', 'JsonObject', 'JSONObject', 'Map'].includes(base)) return { type: 'object' }
  return undefined
}

export class JavaProjectModel {
  constructor(files) {
    this.files = files
    this.byQualifiedName = new Map()
    this.bySimpleName = new Map()
    for (const file of files) {
      for (const classInfo of file.classes) {
        this.byQualifiedName.set(classInfo.qualifiedName, classInfo)
        const rows = this.bySimpleName.get(classInfo.simpleName) ?? []
        rows.push(classInfo)
        this.bySimpleName.set(classInfo.simpleName, rows)
      }
    }
  }

  resolveClass(type, usageFile) {
    const base = type.base
    if (this.byQualifiedName.has(base)) return this.byQualifiedName.get(base)
    const samePackage = `${usageFile.packageName}.${base}`
    if (this.byQualifiedName.has(samePackage)) return this.byQualifiedName.get(samePackage)
    const firstSegment = base.split('.')[0]
    const importedOuter = usageFile.imports.get(firstSegment)
    if (importedOuter) {
      const nested = `${importedOuter}${base.slice(firstSegment.length)}`
      if (this.byQualifiedName.has(nested)) return this.byQualifiedName.get(nested)
    }
    const imported = usageFile.imports.get(base)
    if (imported && this.byQualifiedName.has(imported)) return this.byQualifiedName.get(imported)
    for (const wildcard of usageFile.wildcardImports) {
      const candidate = `${wildcard}.${base}`
      if (this.byQualifiedName.has(candidate)) return this.byQualifiedName.get(candidate)
    }
    const matches = this.bySimpleName.get(base) ?? []
    return matches.length === 1 ? matches[0] : undefined
  }

  /** All method declaration spans in one file, used for line-level change attribution. */
  methodSpans(filePath) {
    const target = String(filePath).replace(/\\/g, '/').toLowerCase()
    const file = this.files.find(item => item.path.replace(/\\/g, '/').toLowerCase() === target)
    if (!file) return []
    const spans = []
    for (const classInfo of file.classes) {
      for (const method of classInfo.methods) if (method.span) spans.push(method.span)
    }
    return spans
  }

  schemaFor(typeValue, usageFile, context, environment = {}, stack = new Set()) {
    const type = typeof typeValue === 'string' ? parseType(typeValue) : typeValue
    if (environment[type.base]) return this.schemaFor(environment[type.base], usageFile, context, environment, stack)
    if (type.array || ['List', 'Set', 'Collection', 'Iterable', 'ArrayList'].includes(type.base)) {
      const item = type.args[0] ?? 'Object'
      return { type: 'array', items: this.schemaFor(item, usageFile, context, environment, stack) }
    }
    if (['Map', 'HashMap', 'LinkedHashMap'].includes(type.base)) {
      return { type: 'object', additionalProperties: type.args[1] ? this.schemaFor(type.args[1], usageFile, context, environment, stack) : {} }
    }
    const primitive = primitiveSchema(type.base)
    if (primitive) return primitive
    const classInfo = this.resolveClass(type, usageFile)
    if (!classInfo) return {}
    const key = schemaName(type)
    context.components[key] ??= {}
    context.dependencyFiles.add(classInfo.file.path)
    if (stack.has(key)) return { $ref: `#/components/schemas/${key}` }
    stack.add(key)
    const nextEnvironment = { ...environment }
    classInfo.typeParameters.forEach((parameter, index) => {
      if (type.args[index]) nextEnvironment[parameter] = type.args[index]
    })
    const schema = {
      type: 'object',
      ...(classInfo.description ? { description: classInfo.description } : {}),
      properties: {},
    }
    context.components[key] = schema
    const required = []
    const appendFields = (info, env) => {
      if (info.superclass) {
        const parentType = parseType(info.superclass)
        const parent = this.resolveClass(parentType, info.file)
        if (parent) {
          context.dependencyFiles.add(parent.file.path)
          const parentEnv = { ...env }
          parent.typeParameters.forEach((parameter, index) => {
            if (parentType.args[index]) parentEnv[parameter] = parentType.args[index]
          })
          appendFields(parent, parentEnv)
        }
      }
      for (const field of info.fields) {
        if (field.static) continue
        const propertyAnnotation = annotation(field.annotations, ['ApiModelProperty', 'Schema'])
        const description = annotationValue(propertyAnnotation, ['value', 'description'], info) || field.description
        schema.properties[field.name] = {
          ...this.schemaFor(field.type, info.file, context, env, stack),
          ...(description ? { description } : {}),
        }
        if (field.annotations.some(item => VALIDATION_ANNOTATIONS.has(item.name))) required.push(field.name)
      }
    }
    appendFields(classInfo, nextEnvironment)
    if (required.length) schema.required = [...new Set(required)]
    stack.delete(key)
    return { $ref: `#/components/schemas/${key}` }
  }

  fieldsFor(typeValue, usageFile, context, environment = {}) {
    const type = typeof typeValue === 'string' ? parseType(typeValue) : typeValue
    const classInfo = this.resolveClass(type, usageFile)
    if (!classInfo) return []
    context.dependencyFiles.add(classInfo.file.path)
    const env = { ...environment }
    classInfo.typeParameters.forEach((parameter, index) => {
      if (type.args[index]) env[parameter] = type.args[index]
    })
    const fields = []
    if (classInfo.superclass) {
      fields.push(...this.fieldsFor(classInfo.superclass, classInfo.file, context, env))
    }
    for (const field of classInfo.fields) {
      if (!field.static) fields.push({ field, file: classInfo.file, environment: env })
    }
    return fields
  }

  endpoints() {
    const endpoints = []
    for (const file of this.files) {
      for (const classInfo of file.classes) {
        if (!annotation(classInfo.annotations, [...CONTROLLER_ANNOTATIONS])) continue
        const classMapping = annotation(classInfo.annotations, ['Mapping', 'RequestMapping'])
        const basePath = annotationValue(classMapping, ['value', 'path'], classInfo) ?? ''
        const apiAnnotation = annotation(classInfo.annotations, 'Api')
        const tag = annotationValue(apiAnnotation, ['tags', 'value'], classInfo) || classInfo.description || classInfo.simpleName
        for (const method of classInfo.methods) {
          const mapping = annotation(method.annotations, ['Mapping', 'RequestMapping', ...HTTP_MAPPINGS.keys()])
          if (!mapping) continue
          let httpMethod = HTTP_MAPPINGS.get(mapping.name)
          if (!httpMethod) {
            const methodExpression = mapping.pairs.method ?? mapping.defaultValue
            httpMethod = methodExpression?.match(/(?:MethodType|RequestMethod)\.([A-Z]+)/)?.[1]
          }
          if (!httpMethod || httpMethod === 'ALL') httpMethod = 'GET'
          const methodPath = annotationValue(mapping, ['value', 'path'], classInfo) ?? ''
          const apiPath = normalizePath(basePath, methodPath)
          const context = {
            components: {},
            dependencyFiles: new Set([file.path]),
            requestFiles: new Set(),
            responseFiles: new Set(),
          }
          const operation = {
            summary: annotationValue(annotation(method.annotations, ['ApiOperation', 'Operation']), ['value', 'summary'], classInfo)
              || method.description.split('\n')[0] || method.name,
            description: method.description,
            operationId: `${classInfo.simpleName}_${method.name}`,
            tags: [tag],
            parameters: [],
            responses: {},
          }
          const multipart = Boolean(annotation(method.annotations, 'Multipart'))
          const bodyProperties = {}
          const bodyRequired = []
          for (const parameter of method.parameters) {
            const type = parseType(parameter.type)
            if (IGNORED_PARAMETERS.has(type.base)) continue
            const parameterContext = { ...context, dependencyFiles: context.requestFiles }
            const body = annotation(parameter.annotations, ['Body', 'RequestBody'])
            const paramAnnotation = annotation(parameter.annotations, ['Param', 'RequestParam', 'PathVariable', 'Path', 'Header', 'RequestHeader'])
            const name = annotationValue(paramAnnotation, ['value', 'name'], classInfo) || parameter.name
            const parameterSchema = this.schemaFor(type, file, parameterContext)
            const parameterDescription = annotationValue(annotation(parameter.annotations, 'ApiParam'), ['value', 'description'], classInfo) || parameter.description
            if (body) {
              operation.requestBody = {
                required: true,
                ...(parameterDescription ? { description: parameterDescription } : {}),
                content: { 'application/json': { schema: parameterSchema } },
              }
              continue
            }
            if (multipart) {
              bodyProperties[name] = { ...parameterSchema, ...(parameterDescription ? { description: parameterDescription } : {}) }
              if (annotation(parameter.annotations, [...VALIDATION_ANNOTATIONS])) bodyRequired.push(name)
              continue
            }
            if (!paramAnnotation && !primitiveSchema(type.base) && !type.array && !['List', 'Set', 'Collection'].includes(type.base)) {
              for (const item of this.fieldsFor(type, file, parameterContext)) {
                const propertyAnnotation = annotation(item.field.annotations, ['ApiModelProperty', 'Schema'])
                operation.parameters.push({
                  name: item.field.name,
                  in: 'query',
                  required: item.field.annotations.some(value => VALIDATION_ANNOTATIONS.has(value.name)),
                  description: annotationValue(propertyAnnotation, ['value', 'description'], classInfo) || item.field.description,
                  schema: this.schemaFor(item.field.type, item.file, parameterContext, item.environment),
                })
              }
              continue
            }
            operation.parameters.push({
              name,
              in: annotation(paramAnnotation, ['PathVariable', 'Path']) || apiPath.includes(`{${name}}`) ? 'path'
                : annotation(paramAnnotation, ['Header', 'RequestHeader']) ? 'header' : 'query',
              required: apiPath.includes(`{${name}}`) || Boolean(annotation(parameter.annotations, [...VALIDATION_ANNOTATIONS])),
              ...(parameterDescription ? { description: parameterDescription } : {}),
              schema: parameterSchema,
            })
          }
          if (multipart) {
            operation.requestBody = {
              content: { 'multipart/form-data': { schema: { type: 'object', properties: bodyProperties, ...(bodyRequired.length ? { required: bodyRequired } : {}) } } },
            }
          }
          const responseContext = { ...context, dependencyFiles: context.responseFiles }
          const returnType = parseType(method.returnType)
          if (['void', 'Void'].includes(returnType.base)) {
            operation.responses['200'] = { description: '成功' }
          } else {
            const responseSchema = this.schemaFor(returnType, file, responseContext)
            operation.responses['200'] = {
              description: '成功',
              content: { 'application/json': { schema: responseSchema } },
            }
          }
          for (const dependency of context.requestFiles) context.dependencyFiles.add(dependency)
          for (const dependency of context.responseFiles) context.dependencyFiles.add(dependency)
          context.dependencyFiles.add(file.path)
          const id = `${httpMethod} ${apiPath}`
          endpoints.push({
            id,
            method: httpMethod,
            path: apiPath,
            summary: operation.summary,
            description: operation.description,
            controller: classInfo.qualifiedName,
            sourcePath: file.path,
            sourceSpan: method.span,
            operation,
            components: context.components,
            dependencyFiles: [...context.dependencyFiles],
            requestFiles: [...context.requestFiles],
            responseFiles: [...context.responseFiles],
          })
        }
      }
    }
    return endpoints
  }
}

function normalizePath(base, method) {
  const joined = `${base || ''}/${method || ''}`.replace(/\\/g, '/').replace(/\/+/g, '/')
  const withLeadingSlash = joined.startsWith('/') ? joined : `/${joined}`
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/$/, '') : withLeadingSlash
}

export async function readJavaProject(root, readFile = async file => (await import('node:fs/promises')).readFile(file, 'utf8')) {
  const { readdir } = await import('node:fs/promises')
  const files = []
  const errors = []
  const walk = async directory => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile() && entry.name.endsWith('.java')) {
        try { files.push(parseJavaSource(await readFile(absolute), path.resolve(absolute))) }
        catch (error) { errors.push({ path: path.resolve(absolute), message: error.message }) }
      }
    }
  }
  await walk(root)
  return { model: new JavaProjectModel(files), files, errors }
}
