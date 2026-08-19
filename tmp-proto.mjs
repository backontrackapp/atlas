import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const APP_ROOT = '/home/dcoulombe/dev/backontrack/app'
const sourceRoot = path.join(APP_ROOT, 'src')

function walk(dir, files=[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, files)
    else if (entry.isFile() && p.endsWith('.vue')) files.push(p)
  }
  return files
}

const asText = (node) => {
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return node.text
  if (ts.isIdentifier(node)) return node.text
  return undefined
}

const getProperty = (node, key) => {
  if (!ts.isObjectLiteralExpression(node)) return undefined
  const property = node.properties.find((prop) => {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) return false
    if (ts.isIdentifier(prop.name)) return prop.name.text === key
    if (ts.isStringLiteral(prop.name)) return prop.name.text === key
    return false
  })
  if (!property || ts.isShorthandPropertyAssignment(property)) return undefined
  return property.initializer
}

function parseRoutes(routerPath) {
  const source = fs.readFileSync(routerPath, 'utf8')
  const sourceFile = ts.createSourceFile('router.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let routesArray

  function visit(node) {
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

  ts.forEachChild(sourceFile, visit)
  if (!routesArray) throw new Error('No routes array')

  const routes = []
  function walkArray(arr, parentPath = '') {
    for (const element of arr.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue
      const rawPath = asText(getProperty(element, 'path'))
      if (!rawPath) continue
      const full = rawPath.startsWith('/') || parentPath === ''
        ? rawPath.startsWith('/') ? rawPath : `/${rawPath}`
        : `${parentPath}/${rawPath}`
      const name = asText(getProperty(element, 'name'))
      const redirectNode = getProperty(element, 'redirect')
      routes.push({
        path: full,
        name: name || full,
        redirect: redirectNode ? asText(redirectNode) : undefined,
      })
      const childrenNode = getProperty(element, 'children')
      if (childrenNode && ts.isArrayLiteralExpression(childrenNode)) {
        walkArray(childrenNode, full)
      }
    }
  }
  walkArray(routesArray, '')

  return {
    byName: Object.fromEntries(routes.map(route => [route.name, route.path]))
  }
}

function getSfcSection(source, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const match = source.match(re)
  return match?.[1] || ''
}

function collectSections(filePath) {
  const source = fs.readFileSync(filePath, 'utf8')
  const template = getSfcSection(source, 'template')
  const scriptMatches = [...source.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi)]

  let script = ''
  for (const match of scriptMatches) {
    const attrs = match[1] || ''
    if (/setup/.test(attrs) || !script) {
      script = match[2]
    }
  }

  return { template, script }
}

function collectFunctionMap(sf) {
  const map = new Map()
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      map.set(node.name.text, node)
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      map.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return map
}

function collectAliases(sf) {
  const routerAliases = new Set(['router', '$router'])
  const emitAliases = new Set(['emit'])
  const localImports = new Map()

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression
      if (ts.isIdentifier(callee) && callee.text === 'useRouter') {
        routerAliases.add(node.name.text)
      }
      if (ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
        const fn = node.initializer.expression.text
        if (fn === 'defineEmits') {
          emitAliases.add(node.name.text)
        }
      }
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const source = node.moduleSpecifier.text
      for (const p of node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        ? node.importClause.namedBindings.elements
        : []) {
        const local = p.name.text
        localImports.set(local, source)
      }
      if (node.importClause?.name) {
        localImports.set(node.importClause.name.text, source)
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sf, visit)
  return { routerAliases, emitAliases, localImports }
}

function expressionParser(source) {
  const sf = ts.createSourceFile('expr.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  return sf.statements[0] && 'expression' in sf.statements[0] ? sf.statements[0].expression : undefined
}

function splitNavArg(expr) {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const namedRoute = getProperty(expr, 'name')
    const pathRoute = getProperty(expr, 'path')
    if (ts.isStringLiteral(namedRoute) || ts.isNoSubstitutionTemplateLiteral(namedRoute)) return `/${namedRoute.text}`
    if (pathRoute && (ts.isStringLiteral(pathRoute) || ts.isNoSubstitutionTemplateLiteral(pathRoute))) return pathRoute.text
    if (ts.isPropertyAssignment)
      return null
  }
  return null
}

function buildEffectsAnalyzer(routeByName, functionMap) {
  const analyzerCache = new Map()

  function analyzeNode(node, state) {
    const key = `${node.pos}:${node.end}`
    if (analyzerCache.has(key)) return analyzerCache.get(key)
    const result = {
      navigations: new Set(),
      ui: new Set(),
      emits: new Set(),
      calls: new Set(),
      delegates: new Set(),
      notes: new Set(),
    }

    const walk = (current) => {
      if (!current) return

      if (ts.isCallExpression(current)) {
        const callee = current.expression

        if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && ts.isIdentifier(callee.expression)) {
          const receiver = callee.expression.text
          const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.argumentExpression.getText(sf)

          if (state.routerAliases.has(receiver) && ['push', 'replace', 'go', 'back', 'forward'].includes(method)) {
            const destination = splitNavArg(current.arguments[0]) || 'computed destination'
            if (destination) result.navigations.add(`navigate:${destination}`)
          } else if (state.emitAliases.has(receiver)) {
            const payload = current.arguments[0]
            result.emits.add(`emit:${payload?.getText(sf) || 'event'}`)
          } else if (state.storeAliases.has(receiver)) {
            result.calls.add(`store.${method}`)
          } else {
            result.calls.add(`${receiver}.${method}()`)
          }
        }

        if (ts.isIdentifier(callee)) {
          const fn = callee.text
          if (state.functionMap.has(fn) && !state.visited.has(fn)) {
            if (state.visited.size < 12) {
              state.visited.add(fn)
              const target = state.functionMap.get(fn)
              if (target) {
                analyzeNode(target.body || target, state)
                Object.values(effectByName(target) || {}).forEach((set) => {
                  for (const item of set) {
                    result[set[0]]?.add(item)
                  }
                })
              }
              state.visited.delete(fn)
            }
          } else {
            result.calls.add(`call:${fn}()`)
          }
        }

        ts.forEachChild(current, walk)
        return
      }

      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = current.left
        if (ts.isPropertyAccessExpression(left) && left.name && /open|visible|menu|dialog|sheet|panel|show/i.test(left.name.text)) {
          result.ui.add(`toggle ${left.getText(sf)}`)
        }
      }

      ts.forEachChild(current, walk)
    }

    walk(node)
    analyzerCache.set(key, result)
    return result
  }

  return analyzeNode
}

const eventRegex = /(?:^|[\s\"'])((?:@|v-on:)([a-zA-Z0-9_:\-.]+)(?:\.[^\s=]+)*)(?:\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|`([^`]*)`|\{([^}]*)\}))/g

function parseTemplateActions(template, file) {
  const entries = []
  let m
  while ((m = eventRegex.exec(template)) !== null) {
    const expression = (m[3] || m[4] || m[5] || m[6] || '').trim()
    if (!expression) continue
    const fullEvent = m[2]
    const event = fullEvent.split('.')[0]
    entries.push({ event, expression, key: `${fullEvent}:${expression}` })
  }
  return entries
}

const { byName } = parseRoutes(path.join(APP_ROOT,'src/router/index.ts'))
const files = walk(sourceRoot)
const actionSummaries = []

for (const file of files) {
  const { template, script } = collectSections(file)
  if (!template || !script) continue

  const sf = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const functionMap = collectFunctionMap(sf)
  const { routerAliases, emitAliases, localImports } = collectAliases(sf)

  const storeAliases = new Set()
  for (const [name, source] of localImports) {
    if (source.startsWith('@/stores/')) {
      storeAliases.add(name)
    }
  }
  const callState = {
    routerAliases,
    emitAliases,
    storeAliases,
    functionMap,
    visited: new Set(),
  }

  const analyzeNode = (node) => {
    const result = {
      navigations: new Set(),
      ui: new Set(),
      emits: new Set(),
      calls: new Set(),
      delegates: new Set(),
      notes: new Set(),
    }

    const walk = (n) => {
      if (!n) return

      if (ts.isCallExpression(n)) {
        const callee = n.expression

        const isRouterMethod = (receiver, method) => {
          return callState.routerAliases.has(receiver) && ['push', 'replace', 'go', 'back', 'forward'].includes(method)
        }

        const pushNavigation = (arg0) => {
          const destination = splitNavArg(arg0)
          if (destination) result.navigations.add(destination)
          else result.navigations.add('computed destination')
        }

        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
          const receiver = callee.expression.text
          const method = callee.name.text
          if (isRouterMethod(receiver, method)) {
            pushNavigation(n.arguments[0])
          } else if (callState.storeAliases.has(receiver)) {
            result.calls.add(`${receiver}.${method}`)
          } else if (callState.emitAliases.has(receiver)) {
            result.emits.add(`emit:${(n.arguments[0]?.getText(sf) || 'event')}`)
          } else {
            result.calls.add(`${receiver}.${method}`)
          }
        }

        if (ts.isIdentifier(callee) && callState.functionMap.has(callee.text) && !callState.visited.has(callee.text)) {
          callState.visited.add(callee.text)
          const fn = callState.functionMap.get(callee.text)
          if (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) {
            if (fn.body) walk(fn.body)
          }
          callState.visited.delete(callee.text)
        } else if (ts.isIdentifier(callee)) {
          result.calls.add(`call:${callee.text}()`)
        }

        ts.forEachChild(n, walk)
        return
      }

      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = n.left
        if (ts.isPropertyAccessExpression(left) && /open|show|menu|dialog|sheet|visible|active/i.test(left.getText(sf))) {
          result.ui.add(`state:${left.getText(sf)}`)
        }
      }

      ts.forEachChild(n, walk)
    }

    walk(node)
    return result
  }

  const events = parseTemplateActions(template, file)
  const fileRel = path.relative(sourceRoot, file).replace(/\\/g,'/')
  for (const event of events) {
    const expr = event.expression
    let target = new Set()
    let expressionNode
    try {
      const exprSf = ts.createSourceFile('expr.ts', expr, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      expressionNode = exprSf.statements[0] && 'expression' in exprSf.statements[0] ? exprSf.statements[0].expression : undefined
    } catch {}

    if (expressionNode) {
      const effects = analyzeNode(expressionNode)
      const lines = [
        ...[...effects.navigations].map(n => `→ ${n}`),
        ...[...effects.calls].map(n => `→ ${n}`),
        ...[...effects.emits].map(n => `→ ${n}`),
        ...[...effects.ui].map(n => `→ ${n}`),
      ]
      target = new Set(lines)
    }

    actionSummaries.push({ file: fileRel, event: event.event, expr: expr, effects: [...target] })
  }
}

console.log('actionCount', actionSummaries.length)
console.log(actionSummaries.slice(0, 25))
