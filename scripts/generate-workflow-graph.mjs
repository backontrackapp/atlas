import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const atRoot = process.cwd()
const debugNavigation = process.env.ATLAS_WORKFLOW_DEBUG === '1'
const appRoot = path.resolve(atRoot, '../app')
const appSourceRoot = path.resolve(appRoot, 'src')
const appThemePath = path.resolve(appRoot, 'src/plugins/vuetify.ts')
const appRouterPath = path.resolve(appRoot, 'src/router/index.ts')
const mainNavViewsPath = path.resolve(appRoot, 'src/services/mainNavigationViews.ts')
const outputPath = path.resolve(atRoot, 'src/data/workflow-manifest.generated.json')

const appThemeSource = fs.readFileSync(appThemePath, 'utf8')
const appRouterSource = fs.readFileSync(appRouterPath, 'utf8')
const appThemeFile = ts.createSourceFile('app-vuetify.ts', appThemeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const appRouterFile = ts.createSourceFile('app-router.ts', appRouterSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const moduleOrder = [
  'landing',
  'auth',
  'tasks',
  'intervals',
  'flashcards',
  'tracking',
  'journal',
  'account',
  'settings',
  'other',
]

const ROUTER_METHODS = new Set(['push', 'replace', 'go', 'back', 'forward'])

function asText(node) {
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return node.text
  if (ts.isIdentifier(node)) return node.text
  return undefined
}

function asNumber(node) {
  if (!node) return undefined
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text)
  }
  return undefined
}

function getObjectProperty(node, key) {
  if (!node) return undefined
  if (!ts.isObjectLiteralExpression(node)) return undefined
  const entry = node.properties.find((prop) => {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) return false
    if (ts.isIdentifier(prop.name)) return prop.name.text === key
    if (ts.isStringLiteral(prop.name)) return prop.name.text === key
    return false
  })
  if (!entry) return undefined
  if (ts.isShorthandPropertyAssignment(entry)) return undefined
  return entry.initializer
}

function normalizeThemeColor(value) {
  if (!value) return null
  if (/^#[0-9a-fA-F]{3,6}$/.test(value)) return value.toUpperCase()
  return null
}

function extractThemePalette() {
  const defaults = {
    stroke: '#C7F464',
    color: '#F1F4EC',
  }

  let themeColors = defaults

  const visit = (node) => {
    if (!ts.isObjectLiteralExpression(node)) return

    const themesNode = getObjectProperty(node, 'themes')
    if (!themesNode || !ts.isObjectLiteralExpression(themesNode)) return

    const forgeDarkNode = getObjectProperty(themesNode, 'forgeDark')
    if (!forgeDarkNode || !ts.isObjectLiteralExpression(forgeDarkNode)) return

    const colorsNode = getObjectProperty(forgeDarkNode, 'colors')
    if (!colorsNode || !ts.isObjectLiteralExpression(colorsNode)) return

    const secondary = normalizeThemeColor(asText(getObjectProperty(colorsNode, 'secondary')))
    const color = normalizeThemeColor(asText(getObjectProperty(colorsNode, 'on-surface')))

    if (secondary || color) {
      themeColors = {
        stroke: secondary || defaults.stroke,
        color: color || defaults.color,
      }
    }
  }

  ts.forEachChild(appThemeFile, visit)
  return themeColors
}

function normalizePath(pathValue, parentPath) {
  if (pathValue === '/') return '/'
  if (pathValue.startsWith('/')) return pathValue
  if (!parentPath || parentPath === '/') return `/${pathValue}`
  if (parentPath.endsWith('/')) return `${parentPath}${pathValue}`
  return `${parentPath}/${pathValue}`
}

function parseMainNavigationViewLoaders() {
  const file = ts.createSourceFile('main-navigation-views.ts', fs.readFileSync(mainNavViewsPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const loaders = new Map()
  let found = false

  const visit = (node) => {
    if (!ts.isVariableStatement(node)) return
    const declaration = node.declarationList.declarations[0]
    if (!declaration || !ts.isIdentifier(declaration.name)) return
    if (declaration.name.text !== 'MAIN_NAVIGATION_VIEW_LOADERS') return
    const init = declaration.initializer
    if (!init || !ts.isAsExpression(init) || !ts.isObjectLiteralExpression(init.expression)) return

    const objectLiteral = init.expression
    for (const property of objectLiteral.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const keyText = asText(property.name)
      if (!keyText) continue
      if (!ts.isArrowFunction(property.initializer)) continue
      const value = parseImportFromNode(property.initializer.body)
      if (value) loaders.set(keyText, value)
    }
    found = true
  }

  ts.forEachChild(file, visit)
  if (!found) return new Map()
  return loaders
}

function parseImportFromNode(node) {
  if (!node) return undefined
  let expression = node
  if (ts.isParenthesizedExpression(expression)) expression = expression.expression
  if (!ts.isCallExpression(expression)) return undefined
  if (expression.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined
  const sourceNode = expression.arguments[0]
  return asText(sourceNode) || undefined
}

function normalizeVuePath(rawPath) {
  if (!rawPath) return undefined
  if (rawPath.startsWith('@/')) return rawPath
  if (rawPath.startsWith('./') || rawPath.startsWith('../')) return rawPath
  if (rawPath.startsWith('/')) return rawPath
  return `@/${rawPath}`
}

function resolveAppPath(sourcePath) {
  const normalized = normalizeVuePath(sourcePath)
  if (!normalized) return undefined
  return path.resolve(appSourceRoot, normalized.replace(/^@\//, ''))
}

function parseRouterRoutes(mainNavLoaders, mainNavAliases) {
  let routesArray
  const importAliasMap = {
    loaderAliases: new Set(mainNavAliases),
  }

  const visitImports = (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return
    if (node.moduleSpecifier.text !== '@/services/mainNavigationViews') return
    if (!node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) return
    for (const specifier of node.importClause.namedBindings.elements) {
      importAliasMap.loaderAliases.add(specifier.name.text)
    }
  }

  const parseRedirect = (node) => {
    if (!node) return undefined
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isTemplateExpression(node) && node.templateSpans.length === 0) return node.head.text
    if (ts.isIdentifier(node)) return node.text
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parameters.length === 1) {
      const body = ts.isParenthesizedExpression(node.body) ? node.body.expression : node.body
      if (ts.isTemplateExpression(body) && body.templateSpans.length === 0) return body.head.text
      if (ts.isStringLiteral(body) || ts.isNoSubstitutionTemplateLiteral(body)) return body.text
    }
    return undefined
  }

  const parseMetaValue = (node, key) => {
    if (!node || !ts.isObjectLiteralExpression(node)) return undefined
    const valueNode = getObjectProperty(node, key)
    return asText(valueNode)
  }

  const parseComponentPath = (node) => {
    if (!node) return undefined

    if (ts.isArrowFunction(node)) {
      return parseImportFromNode(node.body)
    }

    if (ts.isCallExpression(node)) {
      return parseImportFromNode(node)
    }

    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const objectName = node.expression.getText(appRouterFile)
      if (!importAliasMap.loaderAliases.has(objectName)) return undefined
      const key = asText(node.argumentExpression)
      if (!key) return undefined
      return mainNavLoaders.get(key)
    }

    if (ts.isIdentifier(node)) {
      return mainNavLoaders.get(node.text)
    }

    return undefined
  }

  const collect = (routeNodes, parentPath = '') => {
    const routes = []
    for (const routeNode of routeNodes.elements) {
      if (!ts.isObjectLiteralExpression(routeNode)) continue
      const rawPath = asText(getObjectProperty(routeNode, 'path'))
      if (rawPath === undefined) continue
      const fullPath = normalizePath(rawPath, parentPath)
      const name = asText(getObjectProperty(routeNode, 'name'))
      const redirectNode = getObjectProperty(routeNode, 'redirect')
      const metaNode = getObjectProperty(routeNode, 'meta')
      const titleNode = parseMetaValue(metaNode, 'title')
      const backToNode = parseMetaValue(metaNode, 'backTo')
      const pageOrderNode = getObjectProperty(metaNode, 'pageOrder')
      const componentNode = getObjectProperty(routeNode, 'component')

      const pageOrder = asNumber(pageOrderNode)
      const redirect = parseRedirect(redirectNode)
      const componentSource = parseComponentPath(componentNode)
      const componentPath = componentSource ? resolveAppPath(componentSource) : undefined
      const isRouteRedirect = Boolean(redirectNode)
      const isLayout = componentPath
        ? componentPath.includes(`${path.sep}layouts${path.sep}`)
        : false

      routes.push({
        path: fullPath,
        name: name || fullPath,
        redirect,
        title: titleNode || name || fullPath,
        backTo: backToNode,
        pageOrder,
        componentPath,
        isLayout,
        isRedirect: isRouteRedirect,
      })

      const childrenNode = getObjectProperty(routeNode, 'children')
      if (childrenNode && ts.isArrayLiteralExpression(childrenNode)) {
        routes.push(...collect(childrenNode, fullPath))
      }
    }

    return routes
  }

  const visit = (node) => {
    if (routesArray) return
    if (
      ts.isArrayLiteralExpression(node)
      && ts.isPropertyAssignment(node.parent)
      && ts.isIdentifier(node.parent.name)
      && node.parent.name.text === 'routes'
    ) {
      routesArray = node
      return
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(appRouterFile, visitImports)
  ts.forEachChild(appRouterFile, visit)
  if (!routesArray) throw new Error('Unable to locate routes array in app router.')

  const routes = collect(routesArray, '')

  return {
    routes,
    byName: new Map(routes.filter((route) => route.name).map((route) => [route.name, route.path])),
    byPath: new Map(routes.map((route) => [route.path, route.path])),
  }
}

function parseSfcSections(sourceFilePath) {
  const source = fs.readFileSync(sourceFilePath, 'utf8')
  const template = extractTagBlock(source, 'template') || ''
  const scriptBlocks = extractTagBlocks(source, 'script')
  let script = ''
  for (const block of scriptBlocks) {
    if (/\\bsetup\\b/i.test(block.openTag) || !script) {
      script = block.content
    }
  }

  return { template, script }
}

function extractTagBlocks(source, tagName) {
  const normalizedTag = tagName.toLowerCase()
  const blocks = []
  let searchIndex = 0
  const lowerSource = source.toLowerCase()

  while (searchIndex < source.length) {
    const firstOpen = findOpeningTag(source, normalizedTag, searchIndex)
    if (!firstOpen) break

    let depth = 1
    let cursor = firstOpen.openTagEnd
    let closeStart = -1
    let closeEnd = -1
    const closeMarker = `</${normalizedTag}`
    const contentStart = firstOpen.openTagEnd

    while (cursor < source.length && depth > 0) {
      const nextOpen = findOpeningTag(source, normalizedTag, cursor)
      const nextClose = lowerSource.indexOf(closeMarker, cursor)

      if (nextClose === -1) break

      if (!nextOpen || nextClose <= nextOpen.openTagStart) {
        const closeTagEnd = source.indexOf('>', nextClose)
        if (closeTagEnd === -1) break
        depth -= 1
        cursor = closeTagEnd + 1
        if (depth === 0) {
          closeStart = nextClose
          closeEnd = closeTagEnd + 1
        }
        continue
      }

      if (!nextOpen.selfClosing) depth += 1
      cursor = nextOpen.openTagEnd
    }

    if (closeStart === -1 || closeEnd === -1) break

    blocks.push({
      openTag: firstOpen.openTag,
      content: source.slice(contentStart, closeStart),
    })

    searchIndex = closeEnd
  }

  return blocks
}

function findOpeningTag(source, tagName, startIndex) {
  const lowerSource = source.toLowerCase()
  const needle = `<${tagName}`
  let searchFrom = startIndex

  while (searchFrom < source.length) {
    const openTagStart = lowerSource.indexOf(needle, searchFrom)
    if (openTagStart === -1) return null

    const afterTagNameIndex = openTagStart + needle.length
    const afterTagName = source.charAt(afterTagNameIndex)
    if (!/[\s>/]/.test(afterTagName)) {
      searchFrom = openTagStart + needle.length
      continue
    }

    const openTagEnd = source.indexOf('>', openTagStart)
    if (openTagEnd === -1) return null
    const openTag = source.slice(openTagStart, openTagEnd + 1)

    return {
      openTagStart,
      openTagEnd: openTagEnd + 1,
      openTag,
      selfClosing: /\/\s*>$/.test(openTag),
    }
  }
  return null
}

function extractTagBlock(source, tagName) {
  return extractTagBlocks(source, tagName)[0]?.content || ''
}

function extractTemplateActions(templateText) {
  const templateActions = []
  const eventRegex = new RegExp('(?:^|[\\s\"\\\'])' +
    '((?:@[a-zA-Z0-9_:.\\-]+|v-on:[a-zA-Z0-9_:.\\-]+))(?:\\.[^\\s=]+)*' +
    '\\s*=\\s*(?:' +
    '\"([^\"]*)\"|' +
    '\'([^\']*)\'|' +
    '`([^`]*)`|' +
    '\\{([^}]*)\\}' +
    ')', 'g')
  const navAttrRegex = new RegExp('(?:^|[\\s\"\\\'])' +
    '(?:\\:to|to|:href|href)\\s*=\\s*', 'g')

  let match
  while ((match = eventRegex.exec(templateText)) !== null) {
    const directive = match[1]
    const expression = (match[2] || match[3] || match[4] || match[5] || '').trim()
    if (!expression) continue
    const normalizedDirective = directive.startsWith('v-on:')
      ? directive.slice(5)
      : directive.startsWith('@')
        ? directive.slice(1)
        : directive
    const eventName = normalizedDirective.split('.')[0]
    templateActions.push({
      kind: 'event',
      eventType: eventName,
      expression,
    })
  }

  while ((match = navAttrRegex.exec(templateText)) !== null) {
    const value = parseAttributeValue(templateText, navAttrRegex.lastIndex)
    if (!value) continue
    templateActions.push({
      kind: 'navigation',
      eventType: 'tap',
      expression: value,
    })
  }

  return templateActions
}

function parseAttributeValue(source, startIndex) {
  let i = startIndex
  while (i < source.length && /\s/.test(source[i])) i += 1
  if (i >= source.length) return undefined

  const first = source[i]
  if (first === '"' || first === "'" || first === '`') {
    const quote = first
    const valueStart = i
    i += 1
    while (i < source.length) {
      const ch = source[i]
      if (ch === quote) {
        return source.slice(valueStart, i + 1)
      }
      if (ch === '\\\\' && i + 1 < source.length) {
        i += 2
      } else {
        i += 1
      }
    }
    return undefined
  }

  if (first === '{') {
    let depth = 0
    while (i < source.length) {
      const ch = source[i]
      if (ch === '{') depth += 1
      if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          return source.slice(valueStart, i + 1)
        }
      }
      i += 1
    }
    return undefined
  }

  const valueStart = i
  while (i < source.length && !/\s|>/.test(source[i])) i += 1
  return source.slice(valueStart, i)
}

function compactExpression(expression) {
  return expression.replaceAll(/\s+/gu, ' ').replaceAll('\n', ' ').slice(0, 140)
}

function compactForMermaid(value) {
  return value.replaceAll('\n', ' ').replaceAll('\r', '').slice(0, 160)
}

function sanitizeText(value) {
  return value
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('\n', '<br/>')
}

function parseExpression(expressionText, scriptFile) {
  if (!expressionText) return null
  try {
    const normalizedExpression = expressionText.trim().startsWith('{')
      ? `(${expressionText})`
      : expressionText
    const expressionSource = ts.createSourceFile(`${scriptFile}.expr`, normalizedExpression, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const first = expressionSource.statements[0]
    if (!first) return null
    if (ts.isExpressionStatement(first)) return first.expression
    if ('expression' in first) return first.expression
    return null
  } catch {
    return null
  }
}

function collectScriptContext(filePath, scriptSource) {
  const sourceFile = ts.createSourceFile(filePath, scriptSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const routerAliases = new Set(['router', '$router'])
  const functionMap = new Map()
  const useRouterAliases = new Set()

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (statement.moduleSpecifier.text !== 'vue-router') continue
      const importClause = statement.importClause
      if (!importClause?.namedBindings || !ts.isNamedImports(importClause.namedBindings)) continue
      for (const specifier of importClause.namedBindings.elements) {
        const importedName = specifier.propertyName?.text || specifier.name.text
        const localName = specifier.name.text
        if (importedName === 'useRouter') useRouterAliases.add(localName)
      }
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functionMap.set(statement.name.text, statement)
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        if (!ts.isCallExpression(declaration.initializer)) continue
        const callee = declaration.initializer.expression
        if (ts.isIdentifier(callee) && useRouterAliases.has(callee.text)) {
          routerAliases.add(declaration.name.text)
        }
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
        functionMap.set(declaration.name.text, declaration.initializer)
      }
    }
  }

  return {
    sourceFile,
    routerAliases,
    functionMap,
  }
}

function parseNavigationTarget(argNode, routeMapByName, routeMapByPath) {
  if (!argNode) return 'computed destination'
  if (ts.isParenthesizedExpression(argNode)) return parseNavigationTarget(argNode.expression, routeMapByName, routeMapByPath)
  if (debugNavigation) {
    console.log('[parseTarget kind]', ts.SyntaxKind[argNode.kind], argNode.kind, 'text=', argNode.getText())
  }
  const object = argNode

  if (ts.isStringLiteral(object) || ts.isNoSubstitutionTemplateLiteral(object)) {
    const value = object.text
    const parsed = parseNavigationFromText(value, routeMapByName, routeMapByPath)
    if (parsed) return parsed
    if (routeMapByPath.has(value)) return routeMapByPath.get(value)
    return value
  }

  if (ts.isTemplateExpression(object)) {
    if (object.templateSpans.length === 0) {
      const value = object.head.text
      if (routeMapByPath.has(value)) return routeMapByPath.get(value)
      return value
    }
    return 'computed destination'
  }

  if (ts.isIdentifier(object)) {
    return routeMapByName.get(object.text) || object.text
  }

  if (ts.isPropertyAccessExpression(object) && object.name.text === 'path') {
    const maybe = routeMapByName.get(object.expression.getText())
    if (maybe) return maybe
  }

  if (ts.isObjectLiteralExpression(object)) {
    const nameNode = getObjectProperty(object, 'name')
    const pathNode = getObjectProperty(object, 'path')
    const nameText = asText(nameNode)
    const pathText = asText(pathNode)
    if (debugNavigation) {
      console.log('[parseTarget object]', object.getText(), 'nameText=', nameText, 'pathText=', pathText)
    }
    if (nameText) return routeMapByName.get(nameText) || `/${nameText}`
    if (pathText) return routeMapByPath.has(pathText) ? routeMapByPath.get(pathText) : pathText
  }

  if (argNode.getText) {
    const text = argNode.getText()
    const parsed = parseNavigationFromText(text, routeMapByName, routeMapByPath)
    if (parsed) return parsed
  }

  return 'computed destination'
}

function parseNavigationFromText(text, routeMapByName, routeMapByPath) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined

  const pathMatch = trimmed.match(/(?:^|[\s,{])path\s*:\s*(['\"])([^'\"`]+)\1/)
  if (pathMatch) {
    const pathText = pathMatch[2]
    if (routeMapByPath.has(pathText)) return routeMapByPath.get(pathText)
    return pathText
  }

  const nameMatch = trimmed.match(/(?:^|[\s,{])name\s*:\s*(['\"])([^'\"`]+)\1/)
  if (nameMatch) {
    const nameText = nameMatch[2]
    return routeMapByName.get(nameText) || `/${nameText}`
  }

  return undefined
}

function collectRouteNavigations(expressionNode, context, routeMapByName, routeMapByPath, visited = new Set()) {
  const destinations = new Set()

  const isNavigationReceiver = (expression) => {
    if (!ts.isPropertyAccessExpression(expression) && !ts.isPropertyAccessChain(expression)) return false
    const receiver = expression.expression
    if (!ts.isIdentifier(receiver)) return false
    const method = expression.name.text
    if (!ROUTER_METHODS.has(method)) return false
    return context.routerAliases.has(receiver.text)
  }

  const walk = (node) => {
    if (!node) return

    if (ts.isCallExpression(node)) {
      if (isNavigationReceiver(node.expression)) {
        const destination = parseNavigationTarget(node.arguments[0], routeMapByName, routeMapByPath)
        destinations.add(destination)
        return
      }

      const callee = node.expression
      if (ts.isIdentifier(callee)) {
        const functionName = callee.text
        const functionNode = context.functionMap.get(functionName)
        if (functionNode && !visited.has(functionName)) {
          visited.add(functionName)
          walk(functionNode.body || functionNode)
          visited.delete(functionName)
        }
      }
    }

    if (ts.isIdentifier(node)) {
      const functionName = node.text
      const functionNode = context.functionMap.get(functionName)
      if (functionNode && !visited.has(functionName)) {
        visited.add(functionName)
        walk(functionNode.body || functionNode)
        visited.delete(functionName)
      }
    }

    ts.forEachChild(node, walk)
  }

  walk(expressionNode)
  return [...destinations]
}

function normalizeRouteTarget(target, routeMapByPath, routeMapByName) {
  if (!target) return undefined
  if (target === 'computed destination') return undefined
  if (typeof target !== 'string') return undefined
  const trimmed = target.trim()
  if (!trimmed) return undefined
  if (/^(https?:)?\/\//i.test(trimmed)) return undefined
  const [pathOnly] = trimmed.split(/[?#]/)
  if (!pathOnly) return undefined

  if (routeMapByPath.has(pathOnly)) return routeMapByPath.get(pathOnly)
  if (routeMapByName.has(pathOnly)) return routeMapByName.get(pathOnly)

  return routeMapByPath.has(trimmed) ? routeMapByPath.get(trimmed) : pathOnly
}

function routeModuleFromPath(route) {
  const pathPart = route.path.split('/').filter(Boolean)[0] || ''
  if (route.path === '/') return 'landing'
  if (route.path.startsWith('/forgot-password')) return 'auth'
  if (route.path.startsWith('/reset-password')) return 'auth'
  if (route.path.startsWith('/verify-email')) return 'auth'

  if (pathPart === 'landing' || pathPart === 'auth' || pathPart === 'tasks' || pathPart === 'intervals'
    || pathPart === 'flashcards' || pathPart === 'tracking' || pathPart === 'journal'
    || pathPart === 'account' || pathPart === 'settings') {
    return pathPart
  }
  if (route.name && route.name.includes('task')) return 'tasks'
  if (route.name && route.name.includes('interval')) return 'intervals'
  if (route.name && route.name.includes('flashcard')) return 'flashcards'
  if (route.name && route.name.includes('tracking')) return 'tracking'
  if (route.name && route.name.includes('journal')) return 'journal'
  if (route.name && route.name.includes('account')) return 'account'
  if (route.name && route.name.includes('setting')) return 'settings'
  return 'other'
}

function routeLabel(route) {
  return `${route.title}<br/>${route.path}`
}

function safeNodeId(value) {
  const normalized = value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || 'node'
}

function toMermaid(routes, transitions, palette) {
  const viewRoutes = routes.filter((route) => route.componentPath && !route.isLayout && !route.path.includes('*'))
  const routeByPath = new Map(viewRoutes.map((route) => [route.path, route]))
  const routeNodeIds = new Map()
  const grouped = new Map()

  for (const route of viewRoutes) {
    const module = routeModuleFromPath(route)
    const list = grouped.get(module) || []
    grouped.set(module, list)
    list.push(route)
    routeNodeIds.set(route.path, `route_${safeNodeId(route.path)}_${safeNodeId(route.title)}`)
  }

  for (const group of grouped.values()) {
    group.sort((a, b) => {
      if (a.pageOrder !== undefined || b.pageOrder !== undefined) {
        const ai = a.pageOrder ?? Number.MAX_SAFE_INTEGER
        const bi = b.pageOrder ?? Number.MAX_SAFE_INTEGER
        if (ai !== bi) return ai - bi
      }
      return a.path.localeCompare(b.path)
    })
  }

  const orderedModules = moduleOrder.filter((moduleName) => grouped.has(moduleName))
  const edgeBuckets = new Map()

  const addEdge = (fromPath, toPath, kind, label = '') => {
    if (!routeNodeIds.has(fromPath)) return
    if (!routeNodeIds.has(toPath)) return
    if (fromPath === toPath) return
    const key = `${fromPath}|${toPath}|${kind}`
    const bucket = edgeBuckets.get(key) || new Set()
    if (label) bucket.add(label)
    edgeBuckets.set(key, bucket)
  }

  for (const transition of transitions) {
    addEdge(transition.from, transition.to, transition.kind, transition.label)
  }

  const lines = [
    'flowchart TB',
    `classDef routeNode fill:transparent,stroke:${palette.stroke},color:${palette.color}`,
  ]

  for (const moduleName of orderedModules) {
    const moduleRoutes = grouped.get(moduleName) || []
    if (!moduleRoutes.length) continue

    const moduleLabel = `${moduleName[0].toUpperCase()}${moduleName.slice(1)} views`
    lines.push(`subgraph ${safeNodeId(`${moduleName}_views`)}["${moduleLabel}"]`)
    for (const route of moduleRoutes) {
      const nodeId = routeNodeIds.get(route.path)
      const title = sanitizeText(compactForMermaid(routeLabel(route)))
      lines.push(`  ${nodeId}["${title}"]:::routeNode`)
    }
    lines.push('end')
  }

  if (edgeBuckets.size > 0) {
    lines.push('%% Navigation transitions')
    for (const [key, labels] of edgeBuckets) {
      const [from, to, kind] = key.split('|')
      const fromId = routeNodeIds.get(from)
      const toId = routeNodeIds.get(to)
      if (!fromId || !toId) continue

      const labelText = [...labels].sort().join(', ')
      const escapedLabel = sanitizeText(compactForMermaid(labelText || kind))
      if (kind === 'redirect') {
        lines.push(`${fromId} -.->|${escapedLabel}| ${toId}`)
      } else if (kind === 'backTo') {
        lines.push(`${fromId} -.->|${escapedLabel}| ${toId}`)
      } else {
        lines.push(`${fromId} -->|${escapedLabel}| ${toId}`)
      }
    }
  }

  return lines.join('\n')
}

const mainNavLoaders = parseMainNavigationViewLoaders()
const routeData = parseRouterRoutes(mainNavLoaders, mainNavLoaders.keys())
const routeMapByName = routeData.byName
const routeMapByPath = routeData.byPath

const viewRoutes = routeData.routes.filter((route) => route.componentPath && !route.isLayout && !route.path.includes('*'))
const routesByViewFile = new Map()
for (const route of viewRoutes) {
  if (!route.componentPath) continue
  if (!routesByViewFile.has(route.componentPath)) routesByViewFile.set(route.componentPath, [])
  routesByViewFile.get(route.componentPath).push(route.path)
}

const fileTransitions = new Map()
for (const filePath of routesByViewFile.keys()) {
  const { template, script } = parseSfcSections(filePath)
  const templateActions = extractTemplateActions(template)
  const context = script ? collectScriptContext(filePath, script) : null
  const fileTransitionTargets = []

  for (const action of templateActions) {
    if (action.kind === 'navigation') {
      const navNode = parseExpression(action.expression, filePath)
      if (debugNavigation) {
        console.log(`[nav expr] ${path.relative(atRoot, filePath)} exprText`, navNode?.getText())
      }
      const destination = parseNavigationTarget(
        navNode,
        routeMapByName,
        routeMapByPath,
      )
      if (debugNavigation) {
        console.log(`[nav expr] ${path.relative(atRoot, filePath)} => ${action.expression} =>`, destination)
      }
      const normalizedDestination = normalizeRouteTarget(destination, routeMapByPath, routeMapByName)
      if (normalizedDestination) {
        fileTransitionTargets.push({
          to: normalizedDestination,
          label: `to: ${compactForMermaid(action.expression)}`,
        })
      }
      continue
    }

    if (!context || !action.expression) continue
    const expressionNode = parseExpression(action.expression, filePath)
    if (!expressionNode) continue
    const targets = collectRouteNavigations(
      expressionNode,
      context,
      routeMapByName,
      routeMapByPath,
    )
    for (const target of targets) {
      const normalizedDestination = normalizeRouteTarget(target, routeMapByPath, routeMapByName)
      if (normalizedDestination) {
        fileTransitionTargets.push({
          to: normalizedDestination,
          label: `${action.eventType}: ${compactExpression(action.expression)}`,
        })
      }
    }
  }

  fileTransitions.set(filePath, fileTransitionTargets)
}

const routeTransitions = []
for (const route of routeData.routes) {
  if (!route.path || route.path.includes('*')) continue
  if (route.redirect && route.path !== route.redirect) {
    const normalized = normalizeRouteTarget(route.redirect, routeMapByPath, routeMapByName)
    if (normalized) {
      routeTransitions.push({
        from: route.path,
        to: normalized,
        kind: 'redirect',
        label: route.redirect === 'computed destination' ? 'redirect' : `redirect (${route.redirect})`,
      })
    }
  }
  if (route.backTo) {
    const normalized = normalizeRouteTarget(route.backTo, routeMapByPath, routeMapByName)
    if (normalized) {
      routeTransitions.push({
        from: route.path,
        to: normalized,
        kind: 'backTo',
        label: 'back',
      })
    }
  }

  if (!route.componentPath || route.isLayout) continue

  const fileTransitionTargets = fileTransitions.get(route.componentPath) || []
  for (const transition of fileTransitionTargets) {
    if (!route.path || !transition.to) continue
    routeTransitions.push({
      from: route.path,
      to: transition.to,
      kind: 'navigation',
      label: compactForMermaid(transition.label),
    })
  }
}

const uniqueTransitions = []
const transitionSeen = new Set()
for (const transition of routeTransitions) {
  const key = `${transition.from}|${transition.to}|${transition.kind}|${transition.label}`
  if (transitionSeen.has(key)) continue
  transitionSeen.add(key)
  uniqueTransitions.push(transition)
}

const renderRoutes = routeData.routes.filter((route) =>
  route.componentPath
  && !route.isLayout
  && !route.path.includes('*')
)

const routeByPath = new Map(renderRoutes.map((route) => [route.path, route]))
const transitionBuckets = new Map()

for (const transition of uniqueTransitions) {
  if (!routeByPath.has(transition.from) || !routeByPath.has(transition.to)) continue
  const key = `${transition.from}|${transition.to}`
  const bucket = transitionBuckets.get(key) || { from: transition.from, to: transition.to, labels: new Set(), kinds: new Set() }
  if (transition.label) bucket.labels.add(transition.label)
  if (transition.kind) bucket.kinds.add(transition.kind)
  transitionBuckets.set(key, bucket)
}

const captureWidth = 1366
const captureHeight = 768

const screenshotManifestNodes = renderRoutes.map((route) => {
  const nodeId = `route_${safeNodeId(route.path)}`
  return {
    id: nodeId,
    title: route.title,
    path: route.path,
    screenshotPath: `/screenshots/${nodeId}.png`,
    statePath: route.path,
    width: captureWidth,
    height: captureHeight,
    capturedAt: null,
    captureVersion: null,
  }
})

const screenshotManifestEdges = [...transitionBuckets.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, bucket], index) => {
    const [from, to] = key.split('|')
    return {
      id: `edge_${index}_${safeNodeId(from)}_${safeNodeId(to)}`,
      source: `route_${safeNodeId(from)}`,
      target: `route_${safeNodeId(to)}`,
      kinds: [...bucket.kinds].sort(),
      labels: [...bucket.labels].sort(),
    }
  })

const nodeIds = new Set(screenshotManifestNodes.map((node) => node.id))
const manifestEdges = screenshotManifestEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))

const output = {
  generatedAt: new Date().toISOString(),
  appRoot: path.relative(atRoot, appRoot),
  capture: {
    width: captureWidth,
    height: captureHeight,
  },
  routes: routeData.routes,
  transitions: uniqueTransitions,
  nodes: screenshotManifestNodes,
  edges: manifestEdges,
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)
console.log(`workflow diagram generated: ${outputPath}`)
