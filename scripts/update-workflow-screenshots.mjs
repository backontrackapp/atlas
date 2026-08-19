import childProcess from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'

import { chromium } from 'playwright'

const cwd = process.cwd()
const appRoot = path.resolve(cwd, '../app')
const manifestPath = path.resolve(cwd, 'src/data/workflow-manifest.generated.json')
const screenshotDir = path.resolve(cwd, 'public/screenshots')
const workflowScript = path.resolve(cwd, 'scripts', 'generate-workflow-graph.mjs')
const envPath = path.resolve(cwd, '.env')
const envExamplePath = path.resolve(cwd, '.env.example')

const options = parseArgs(process.argv.slice(2))
ensureEnvFile(envPath, envExamplePath)
loadDotEnv(envPath)

const baseUrl = options.baseUrl ?? process.env.ATLAS_APP_URL ?? 'http://127.0.0.1:5183'
const apiUrl = options.apiUrl ?? process.env.ATLAS_API_URL ?? 'http://127.0.0.1:8090'
const username = options.username ?? process.env.ATLAS_APP_USERNAME
const password = options.password ?? process.env.ATLAS_APP_PASSWORD
const startServers = parseBool(options.startServers ?? process.env.ATLAS_START_SERVERS, true)
const waitForApi = parseBool(options.waitForApi ?? process.env.ATLAS_WAIT_FOR_API, true)
const fullPage = parseBool(options.fullPage ?? process.env.ATLAS_SCREENSHOT_FULLPAGE, true)
const parsedWaitTimeout = Number.parseInt(String(options.waitTimeoutMs ?? process.env.ATLAS_WAIT_TIMEOUT_MS ?? '120000'), 10)
const waitTimeoutMs = Number.isFinite(parsedWaitTimeout) && parsedWaitTimeout > 0 ? parsedWaitTimeout : 120000
const showProgress = parseBool(options.progress ?? process.env.ATLAS_PROGRESS, true)

if (!username || !password) {
  throw new Error('Missing ATLAS_APP_USERNAME or ATLAS_APP_PASSWORD. Add them to .env or pass --username/--password.')
}

function log(...args) {
  if (showProgress) {
    console.log(...args)
  }
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    if (i + 1 >= argv.length || argv[i + 1]?.startsWith('--')) {
      options[key] = true
      continue
    }
    options[key] = argv[i + 1]
    i += 1
  }
  return options
}

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue
  const normalized = String(value).toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  return defaultValue
}

function ensureEnvFile(envFilePath, exampleFilePath) {
  if (fs.existsSync(envFilePath)) return
  if (!fs.existsSync(exampleFilePath)) {
    throw new Error(`Missing .env file at ${envFilePath} and no .env.example found at ${exampleFilePath}.`)
  }

  fs.copyFileSync(exampleFilePath, envFilePath)
  console.log(`Generated ${envFilePath} from ${exampleFilePath}. Edit credentials before running screenshots.`)
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return
  const raw = fs.readFileSync(filePath, 'utf8')
  const lines = raw.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const equalIndex = trimmed.indexOf('=')
    if (equalIndex === -1) continue

    const key = trimmed.slice(0, equalIndex).trim()
    let value = trimmed.slice(equalIndex + 1).trim()

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function safeNodeId(value) {
  return value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'node'
}

function materializePath(pathTemplate) {
  const templateValues = {
    id: 'sample-id',
    reviewSetId: 'sample-review-set',
    sessionId: 'sample-session',
    templateId: 'sample-template',
  }

  return pathTemplate.replace(/:([a-zA-Z0-9_]+)/g, (_, param) => templateValues[param] ?? 'sample')
}

function normalizeNodeId(routePath) {
  return `route_${safeNodeId(routePath)}`
}

function normalizeRoutePath(pathTemplate) {
  return materializePath(pathTemplate)
}

async function isUrlReachable(url) {
  try {
    const parsed = new URL(url)
    const request = parsed.protocol === 'https:' ? https : http

    return await new Promise((resolve) => {
      const req = request.request(
        {
          method: 'GET',
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80,
          path: parsed.pathname || '/',
          timeout: 1000,
          headers: {
            'user-agent': 'atlas-screenshot-watcher',
          },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 600)
        },
      )

      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  } catch {
    return false
  }
}

function getUrlAlternatives(urlString) {
  try {
    const parsed = new URL(urlString)
    const host = parsed.hostname

    if (host === '127.0.0.1') {
      return [urlString, urlString.replace('127.0.0.1', 'localhost')]
    }
    if (host === 'localhost') {
      return [urlString, urlString.replace('localhost', '127.0.0.1')]
    }
    return [urlString]
  } catch {
    return [urlString]
  }
}

async function isUrlReachableWithAlternatives(urlString) {
  for (const candidate of getUrlAlternatives(urlString)) {
    if (await isUrlReachable(candidate)) {
      if (candidate !== urlString) {
        log(`Ready via alternate host: ${candidate}`)
      }
      return true
    }
  }
  return false
}

async function getReachableUrl(urlString) {
  for (const candidate of getUrlAlternatives(urlString)) {
    if (await isUrlReachable(candidate)) {
      if (candidate !== urlString) {
        log(`Resolved via alternate host: ${candidate}`)
      }
      return candidate
    }
  }
  return null
}

async function waitForUrl(url, timeoutMs = 120000) {
  const startedAt = Date.now()
  let lastLogAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const readyUrl = await getReachableUrl(url)
    if (readyUrl) {
      log(`Ready: ${readyUrl}`)
      return readyUrl
    }

    const now = Date.now()
    if (now - lastLogAt >= 5000) {
      const elapsed = Math.floor((now - startedAt) / 1000)
      const remaining = Math.max(0, Math.floor((timeoutMs - (now - startedAt)) / 1000))
      log(`Still waiting for ${url} (${elapsed}s elapsed, ${remaining}s remaining)`)
      lastLogAt = now
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function parseRootUrl(urlString) {
  const parsed = new URL(urlString)
  return `${parsed.protocol}//${parsed.host}`
}

function runWorkflowSyncScript() {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(process.execPath, [workflowScript], {
      cwd,
      stdio: 'inherit',
      shell: false,
    })

    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Unable to regenerate workflow manifest (exit ${code})`))
    })
  })
}

function startProcess(command, args, env = {}) {
  return childProcess.spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: false,
  })
}

function stopProcess(child) {
  if (!child || child.killed || child.exitCode !== null) return
  child.kill('SIGINT')
}

async function clearBrowserState(page, baseUrl) {
  const context = page.context()
  await context.clearCookies()
  const cleanupFailed = (error) => log(`Storage clear fallback triggered: ${error.message}`)

  try {
    await page.goto(`${baseUrl}/auth`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    })
    return
  } catch (error) {
    cleanupFailed(error)
  }

  try {
    await page.goto('about:blank')
    await page.evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    })
  } catch {
    // Ignore: at least cookies are already cleared and /auth localStorage clear is best-effort.
  }
}

function readManifest() {
  const raw = fs.readFileSync(manifestPath, 'utf8')
  return JSON.parse(raw)
}

async function login(page, baseUrl, usernameInput, passwordInput) {
  await page.goto(`${baseUrl}/auth`, { waitUntil: 'networkidle' })

  await page.locator('input[type="email"]').first().fill(usernameInput)
  await page.locator('input[type="password"]').first().fill(passwordInput)
  await page.getByRole('button', { name: /open your day/i }).click()

  const redirectedToAuth = async () => {
    try {
      const pathname = new URL(page.url()).pathname
      return pathname === '/auth' || pathname === '/forgot-password' || pathname === '/reset-password' || pathname === '/verify-email'
    } catch {
      return false
    }
  }

  const startedAt = Date.now()
  let lastLogAt = Date.now()
  log('Logging in...')

  while (Date.now() - startedAt < 120000) {
    if (!(await redirectedToAuth())) return
    const now = Date.now()
    if (now - lastLogAt >= 5000) {
      log(`Still on auth flow. url=${page.url()}`)
      lastLogAt = now
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  throw new Error('Login did not complete or credentials were rejected.')
}

async function navigateToRoute(page, baseUrl, targetUrl, resolvedPath) {
  try {
    const currentUrl = page.url()
    if (!currentUrl.startsWith(baseUrl)) {
      await page.goto(targetUrl, { waitUntil: 'networkidle' })
      return
    }

    const appPath = resolvedPath.startsWith('http') ? new URL(resolvedPath).pathname + new URL(resolvedPath).search : resolvedPath

    await page.evaluate((path) => {
      window.history.pushState({}, '', path)
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
    }, appPath)

    await page.waitForLoadState('domcontentloaded')
  } catch (error) {
    log(`SPA navigation failed, falling back to full navigation: ${error.message}`)
    await page.goto(targetUrl, { waitUntil: 'networkidle' })
  }
}

async function captureScreenshots(manifest, baseUrl) {
  log(`Capturing ${manifest.nodes.length} routes ...`)
  log(`Screenshot mode: ${fullPage ? 'fullPage' : 'viewport'} (viewport=${manifest.capture.width}x${manifest.capture.height})`)
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: {
      width: manifest.capture.width,
      height: manifest.capture.height,
    },
  })

  await clearBrowserState(page, baseUrl)
  await login(page, baseUrl, username, password)

  const capturedNodes = []
  await fs.promises.mkdir(screenshotDir, { recursive: true })

  let successCount = 0
  let failureCount = 0

  for (const [index, node] of manifest.nodes.entries()) {
    const resolvedPath = normalizeRoutePath(node.statePath || node.path)
    const fileName = `${normalizeNodeId(node.path)}.png`
    const filePath = path.resolve(screenshotDir, fileName)
    const targetUrl = `${baseUrl}${resolvedPath.startsWith('http') ? '' : resolvedPath}`

    log(`[${index + 1}/${manifest.nodes.length}] ${node.path} → ${targetUrl}`)

    try {
      await navigateToRoute(page, baseUrl, targetUrl, resolvedPath)
      await page.waitForTimeout(300)
      await page.screenshot({ path: filePath, fullPage })

      successCount += 1

      capturedNodes.push({
        ...node,
        screenshotPath: `/screenshots/${fileName}`,
        screenshotUpdatedAt: new Date().toISOString(),
        status: 'captured',
      })
    } catch (error) {
      failureCount += 1
      capturedNodes.push({
        ...node,
        status: 'failed',
        captureError: String(error),
      })
    }
  }

  log(`Screenshot capture complete. ok=${successCount}, failed=${failureCount}`)

  await browser.close()
  return capturedNodes
}

async function main() {
  log('Starting screenshot pipeline...')
  await runWorkflowSyncScript()
  const manifest = readManifest()
  log(`Manifest loaded: ${manifest.nodes.length} nodes, ${manifest.routes?.length ?? 0} routes.`)

  const rootUrl = parseRootUrl(baseUrl)
  const preExistingRootUrl = await getReachableUrl(rootUrl)
  const shouldStartServers = startServers && !preExistingRootUrl
  const processes = []
  let workingBaseUrl = preExistingRootUrl || rootUrl

  if (shouldStartServers) {
    log(`Starting app server on ${baseUrl}`)
    const apiProc = startProcess('pnpm', ['--dir', appRoot, 'api:serve'])
    const webProc = startProcess('pnpm', ['--dir', appRoot, 'dev', '--', '--host', '127.0.0.1', '--port', '5183', '--strictPort'], {
      VITE_API_URL: apiUrl,
    })

    processes.push(apiProc, webProc)

    const shutdown = () => {
      for (const child of processes) stopProcess(child)
    }

    process.once('exit', shutdown)
    process.once('SIGINT', () => {
      shutdown()
      process.exit(0)
    })
    process.once('SIGTERM', () => {
      shutdown()
      process.exit(0)
    })

    log(`Waiting for ${rootUrl}`)
    workingBaseUrl = await waitForUrl(rootUrl, waitTimeoutMs)
    if (waitForApi) {
      log(`Waiting for ${apiUrl}`)
      await waitForUrl(apiUrl, waitTimeoutMs)
    } else {
      log(`Skipping API wait for ${apiUrl}`)
    }
  } else if (!preExistingRootUrl) {
    log(`App server not reachable at ${baseUrl} and auto-start disabled.`)
    throw new Error(`Could not reach ${rootUrl}. Start the web server first or pass --startServers false and run it separately.`)
  }

  if (!shouldStartServers) {
    log(`Using existing app server at ${workingBaseUrl}`)
  }

  log('Logging in and capturing screenshots...')
  const captured = await captureScreenshots(manifest, workingBaseUrl)
  log('Updating manifest...')
  const updatedManifest = {
    ...manifest,
    capturedAt: new Date().toISOString(),
    nodes: manifest.nodes.map((node) => {
      const capturedNode = captured.find((item) => item.id === node.id)
      return capturedNode || node
    }),
  }

  await fs.promises.writeFile(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`)
  log(`Wrote manifest: ${manifestPath}`)

  for (const child of processes) stopProcess(child)
  log('Done.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
