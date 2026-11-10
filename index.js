/**
 * Host half of the AI image-generation bundle.
 *
 * The browser half never sees the API key: it calls the small JSON routes
 * below, and this half performs the real calls against an OpenAI-compatible
 * image endpoint (api.openai.com directly or any relay). Generated images are
 * written to a local folder so they land in the project, not in page memory.
 */
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const BASE = '/imagegen'
const MAX_JSON = 1 << 25 // 32 MiB: four reference images arrive as base64 JSON
const MAX_INPUT_IMAGES = 6
const MAX_OUTPUT_IMAGES = 4
const REQUEST_TIMEOUT = 240000
const METHODS = new Set(['GET', 'POST'])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

const DEFAULT_SETTINGS = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-image-1',
  size: '1024x1024',
  quality: 'high',
  background: 'auto',
  outputDir: '',
}

export const inject = ['webServer']

export function apply(ctx, config) {
  // A third-party plugin must never take the application down with it: a defect
  // here leaves only this panel inactive instead of failing the whole startup.
  try {
    setup(ctx, config && typeof config === 'object' ? config : {})
  } catch (error) {
    try {
      console.error('[imagegen-panel] activation failed:', error)
    } catch {
      /* no console available */
    }
  }
}

function setup(ctx, config) {
  const webServer = ctx.webServer
  const planned = []

  /* --------------------------------------------------------------- settings */

  function dshHome() {
    return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  }

  function settingsFile() {
    return path.join(dshHome(), 'plugin-data', 'imagegen-panel.json')
  }

  function defaultOutputDir() {
    if (typeof config.outputDir === 'string' && config.outputDir.trim()) return config.outputDir.trim()
    return path.join(os.homedir(), 'Documents', 'dsh-imagegen')
  }

  function sanitizeSettings(raw) {
    const next = {}
    const text = (value) => (typeof value === 'string' ? value.trim() : '')
    if (raw && typeof raw === 'object') {
      if ('baseUrl' in raw) next.baseUrl = text(raw.baseUrl)
      if ('apiKey' in raw) next.apiKey = text(raw.apiKey)
      if ('model' in raw) next.model = text(raw.model)
      if ('outputDir' in raw) next.outputDir = text(raw.outputDir)
      if ('size' in raw) next.size = text(raw.size)
      if ('quality' in raw) next.quality = text(raw.quality)
      if ('background' in raw) next.background = text(raw.background)
      if ('provider' in raw) next.provider = text(raw.provider)
    }
    return next
  }

  /* Two request dialects share this panel: the OpenAI Images API (and the
     OpenAI-compatible relays that copy it) and Volcengine Ark's Seedream, which
     is reachable from mainland China without any proxy. The provider is stored
     rather than sniffed, but an Ark host in the base URL still wins, so a user
     who only pastes a base URL never ends up posting OpenAI JSON to Ark. */
  function providerOf(settings) {
    if (/volces\.com|ark\.cn/i.test(String(settings.baseUrl || ''))) return 'ark'
    return String(settings.provider || 'openai').toLowerCase() === 'ark' ? 'ark' : 'openai'
  }

  function buildArkBody(model, prompt, size, quality, decoded, count) {
    const body = {
      model,
      prompt,
      size: !size || size === 'auto' ? '2K' : size,
      response_format: 'b64_json',
      watermark: false,
    }
    // Seedream emits a group of related images in one call; asking for a single
    // image keeps the "disabled" default and avoids surprise multi-image bills.
    if (count > 1) {
      body.sequential_image_generation = 'auto'
      body.max_images = count
    }
    if (decoded.length) {
      body.image = decoded.map((image) => 'data:' + image.mime + ';base64,' + image.buffer.toString('base64'))
    }
    return body
  }

  function normalizeBase(raw) {
    let value = String(raw || '').trim()
    if (!value) return ''
    if (!/^[a-z]+:\/\//i.test(value)) value = 'https://' + value
    value = value.replace(/\/+$/, '')
    if (!/\/v\d+$/i.test(value)) value += '/v1'
    return value
  }

  function validBase(raw) {
    const value = normalizeBase(raw)
    if (!value) return ''
    let url
    try {
      url = new URL(value)
    } catch {
      return ''
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return value
  }

  let cache

  async function loadSettings() {
    if (cache) return cache
    let stored = {}
    try {
      const raw = await fs.readFile(settingsFile(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') stored = parsed
    } catch {
      /* first run, or unreadable: keep defaults */
    }
    const merged = Object.assign({}, DEFAULT_SETTINGS, configOutputSeed(stored), sanitizeSettings(stored))
    if (!merged.outputDir) merged.outputDir = defaultOutputDir()
    if (!merged.baseUrl) merged.baseUrl = DEFAULT_SETTINGS.baseUrl
    if (!merged.model) merged.model = DEFAULT_SETTINGS.model
    cache = merged
    return merged
  }

  function configOutputSeed(stored) {
    // The bundle config only seeds the very first run; once the user saves their
    // own folder in the panel, the stored value wins.
    if (stored && typeof stored.outputDir === 'string' && stored.outputDir.trim()) return {}
    return {}
  }

  async function saveSettings(patch) {
    const current = await loadSettings()
    const clean = sanitizeSettings(patch)
    if ('baseUrl' in clean) {
      const base = validBase(clean.baseUrl)
      if (!base) throw new Error('Base URL 不合法，需要以 http:// 或 https:// 开头')
      clean.baseUrl = base
    }
    if ('outputDir' in clean && clean.outputDir) {
      clean.outputDir = path.resolve(clean.outputDir)
    }
    const merged = Object.assign({}, current, clean)
    await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
    await fs.writeFile(settingsFile(), JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 })
    cache = merged
    return merged
  }

  function publicSettings(settings) {
    return {
      provider: providerOf(settings),
      baseUrl: settings.baseUrl,
      model: settings.model,
      size: settings.size,
      quality: settings.quality,
      background: settings.background,
      outputDir: settings.outputDir,
      hasKey: !!settings.apiKey,
      keyTail: settings.apiKey ? settings.apiKey.slice(-4) : '',
      configured: !!settings.apiKey,
    }
  }

  /* ------------------------------------------------------------ small utils */

  function json(res, status, body) {
    const text = JSON.stringify(body ?? null)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  function sameOrigin(req) {
    let origin
    try {
      origin = webServer.getOrigin()
    } catch {
      origin = undefined
    }
    const sent = req.headers.origin
    if (typeof sent === 'string' && sent && origin && sent !== origin) return false
    const site = req.headers['sec-fetch-site']
    if (!sent && typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
    return true
  }

  function readJsonBody(req, limit) {
    const cap = limit || MAX_JSON
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > cap) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text.trim()) return resolve(undefined)
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error('请求体不是合法 JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  function int(value, fallback) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value))
  }

  function describeHttp(status, data, text) {
    let message = ''
    if (data && typeof data === 'object') {
      const error = data.error
      if (error && typeof error === 'object') message = String(error.message || error.code || '')
      else if (typeof error === 'string') message = error
      if (!message && typeof data.message === 'string') message = data.message
      if (Array.isArray(data.errors) && data.errors.length) {
        message += (message ? ' — ' : '') + data.errors.map((entry) => entry?.message || entry?.code || JSON.stringify(entry)).join('; ')
      }
    } else if (typeof data === 'string') {
      message = data
    }
    if (!message && typeof text === 'string') message = text
    message = String(message || '').trim().slice(0, 400)
    if (status === 401) return 'API Key 无效或已过期（401）' + (message ? '：' + message : '')
    if (status === 403) return '没有权限（403）' + (message ? '：' + message : '')
    if (status === 404) return '接口不存在（404），请检查 Base URL 是否带 /v1，或中转站是否支持 ' + (message ? '：' + message : '该模型')
    if (status === 429) return '触发限流或额度不足（429）' + (message ? '：' + message : '')
    return 'HTTP ' + status + (message ? '：' + message : '')
  }

  function networkHint(url) {
    let host = url
    try {
      host = new URL(url).host
    } catch {
      /* keep raw */
    }
    return '无法连接 ' + host + '。可能原因：需要代理、该域名被墙，或中转 Base URL 写错。'
  }

  /* ------------------------------------------------------------ API helpers */

  async function requestJson(url, init, apiKey) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
    try {
      const response = await fetch(url, Object.assign({}, init, { signal: controller.signal }))
      const text = await response.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      if (!response.ok) throw new Error(describeHttp(response.status, data, text))
      if (data === null && text) throw new Error('接口返回的不是 JSON：' + text.slice(0, 300))
      return data
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('请求超时（' + Math.round(REQUEST_TIMEOUT / 1000) + ' 秒）。生图通常要 30–120 秒，请检查网络或中转站是否稳定。')
      }
      if (error && /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|certificate/i.test(String(error.message || error))) {
        throw new Error(networkHint(url) + '（' + String(error.message || error) + '）')
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  function apiHeaders(settings) {
    return {
      authorization: 'Bearer ' + settings.apiKey,
    }
  }

  function buildImageBody(settings, input) {
    const model = String(input.model || settings.model || 'gpt-image-1').trim()
    const prompt = String(input.prompt || '').trim()
    if (!prompt) throw new Error('提示词不能为空')
    const requested = clamp(int(input.n, 1), 1, MAX_OUTPUT_IMAGES)
    const rawSize = String(input.size || settings.size || '1024x1024').trim()
    const size = rawSize === 'auto' || /^\d{3,4}x\d{3,4}$/.test(rawSize) ? rawSize : ''
    const quality = String(input.quality || settings.quality || 'high').trim()
    const background = String(input.background || settings.background || 'auto').trim()
    const body = { model, prompt, n: requested }
    if (size) body.size = size

    if (/^dall-e/i.test(model)) {
      body.quality = quality === 'low' || quality === 'medium' ? 'standard' : 'hd'
      body.n = 1
      body.size = size === '1024x1536' ? '1024x1792' : size === '1536x1024' ? '1792x1024' : '1024x1024'
    } else if (/^gpt-image/i.test(model)) {
      body.quality = quality
      if (background && background !== 'auto') body.background = background
      body.output_format = 'png'
    } else {
      /* Other families behind the same relay (gemini / kolors / seedream …) often
         reject OpenAI-only knobs, so send only the portable four fields. */
      if (size) body.size = size
    }
    return { body, model, requested, size, quality }
  }

  function decodeDataUrl(text) {
    const raw = String(text || '')
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(raw)
    if (!match) return undefined
    if (!match[2]) return undefined
    const mime = (match[1] || 'image/png').toLowerCase()
    let buffer
    try {
      buffer = Buffer.from(match[3], 'base64')
    } catch {
      return undefined
    }
    if (!buffer || !buffer.length) return undefined
    return { mime, buffer }
  }

  function extensionFor(mime) {
    if (/jpe?g/.test(mime)) return '.jpg'
    if (/webp/.test(mime)) return '.webp'
    return '.png'
  }

  async function collectImages(payload) {
    const list = Array.isArray(payload?.data) ? payload.data : []
    const out = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      if (typeof item.b64_json === 'string' && item.b64_json) {
        out.push({ buffer: Buffer.from(item.b64_json, 'base64'), revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : '' })
        continue
      }
      if (typeof item.url === 'string' && item.url) {
        const response = await fetch(item.url)
        if (!response.ok) throw new Error('下载返回图片失败：HTTP ' + response.status)
        const buffer = Buffer.from(await response.arrayBuffer())
        out.push({ buffer, revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : '' })
      }
    }
    if (!out.length) {
      const preview = (() => {
        try {
          return JSON.stringify(payload).slice(0, 300)
        } catch {
          return ''
        }
      })()
      throw new Error('接口没有返回图片数据。' + (preview ? '原始返回：' + preview : ''))
    }
    return out
  }

  /* ---------------------------------------------------------------- storage */

  function stamp() {
    const date = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    return (
      date.getFullYear() +
      pad(date.getMonth() + 1) +
      pad(date.getDate()) +
      '-' +
      pad(date.getHours()) +
      pad(date.getMinutes()) +
      pad(date.getSeconds())
    )
  }

  function slugOf(prompt) {
    const cleaned = String(prompt || '')
      .replace(/[\\/:*?"<>|#%&{}$!'@+`=~^[\]]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 26)
    return cleaned || 'image'
  }

  /* Read the real pixel size out of a PNG header so the sidecar records what the
     model actually returned, not what we asked for (relays may snap the size). */
  function pngDimensions(buffer) {
    if (!buffer || buffer.length < 24) return {}
    if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return {}
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }

  async function saveImages(images, meta, settings) {
    const dir = settings.outputDir || defaultOutputDir()
    await fs.mkdir(dir, { recursive: true })
    const prefix = stamp() + '-' + slugOf(meta.prompt)
    const saved = []
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index]
      const extension = extensionFor(image.mime || 'image/png')
      const name = prefix + (images.length > 1 ? '-' + (index + 1) : '') + extension
      const absolute = path.join(dir, name)
      await fs.writeFile(absolute, image.buffer)
      const dims = pngDimensions(image.buffer)
      const record = {
        name,
        prompt: meta.prompt,
        model: meta.model,
        size: dims.width && dims.height ? dims.width + 'x' + dims.height : meta.size,
        requestedSize: meta.size,
        quality: meta.quality,
        referenceCount: meta.referenceCount || 0,
        revisedPrompt: image.revisedPrompt || '',
        createdAt: new Date().toISOString(),
      }
      await fs.writeFile(absolute + '.json', JSON.stringify(record, null, 2), 'utf8')
      saved.push({
        name,
        path: absolute,
        url: BASE + '/file?name=' + encodeURIComponent(name),
        bytes: image.buffer.length,
        revisedPrompt: image.revisedPrompt || '',
      })
    }
    return saved
  }

  function safeFile(name) {
    const base = path.basename(String(name || ''))
    if (!base || base.includes('..')) return undefined
    const extension = path.extname(base).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(extension)) return undefined
    return base
  }

  async function readGallery(limit) {
    const settings = await loadSettings()
    const dir = settings.outputDir || defaultOutputDir()
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return { dir, items: [] }
    }
    const files = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const extension = path.extname(entry.name).toLowerCase()
      if (!IMAGE_EXTENSIONS.has(extension)) continue
      const absolute = path.join(dir, entry.name)
      let stat
      try {
        stat = await fs.stat(absolute)
      } catch {
        continue
      }
      files.push({ name: entry.name, absolute, mtime: stat.mtimeMs, bytes: stat.size })
    }
    files.sort((left, right) => right.mtime - left.mtime)
    const selected = files.slice(0, limit || 24)
    const items = []
    for (const file of selected) {
      let prompt = ''
      let model = ''
      try {
        const record = JSON.parse(await fs.readFile(file.absolute + '.json', 'utf8'))
        prompt = typeof record.prompt === 'string' ? record.prompt : ''
        model = typeof record.model === 'string' ? record.model : ''
      } catch {
        /* no sidecar */
      }
      items.push({
        name: file.name,
        path: file.absolute,
        url: BASE + '/file?name=' + encodeURIComponent(file.name),
        bytes: file.bytes,
        createdAt: new Date(file.mtime).toISOString(),
        prompt,
        model,
      })
    }
    return { dir, items }
  }

  /* -------------------------------------------------------------- generation */

  async function generate(input) {
    const settings = await loadSettings()
    if (!settings.apiKey) throw new Error('还没有配置 API Key：请在面板右上角「设置」里填入。')
    const base = validBase(settings.baseUrl)
    if (!base) throw new Error('Base URL 不合法，请在「设置」里检查。')

    const prompt = String(input.prompt || '').trim()
    if (!prompt) throw new Error('提示词不能为空')
    const { body, model, size, quality } = buildImageBody(settings, input)

    const references = Array.isArray(input.refs) ? input.refs.slice(0, MAX_INPUT_IMAGES) : []
    const decoded = []
    for (const entry of references) {
      const dataUrl = typeof entry === 'string' ? entry : entry && entry.dataUrl
      const image = decodeDataUrl(dataUrl)
      if (!image) continue
      decoded.push(image)
    }

    let payload
    if (providerOf(settings) === 'ark') {
      payload = await requestJson(
        base + '/images/generations',
        {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, apiHeaders(settings)),
          body: JSON.stringify(buildArkBody(model, prompt, size, quality, decoded, body.n)),
        },
        settings.apiKey,
      )
    } else if (decoded.length) {
      if (/^dall-e/i.test(model)) throw new Error('DALL·E 模型不支持参考图，请改用 gpt-image-1，或去掉参考图。')
      const form = new FormData()
      form.append('model', model)
      form.append('prompt', prompt)
      form.append('size', body.size)
      form.append('n', String(body.n))
      if (body.quality) form.append('quality', body.quality)
      if (body.background) form.append('background', body.background)
      form.append('output_format', 'png')
      for (const image of decoded) {
        const extension = extensionFor(image.mime)
        form.append('image[]', new Blob([image.buffer], { type: image.mime }), 'reference' + extension)
      }
      payload = await requestJson(base + '/images/edits', { method: 'POST', headers: apiHeaders(settings), body: form }, settings.apiKey)
    } else {
      payload = await requestJson(
        base + '/images/generations',
        { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, apiHeaders(settings)), body: JSON.stringify(body) },
        settings.apiKey,
      )
    }

    const images = await collectImages(payload)
    const saved = await saveImages(images, { prompt, model, size, quality, referenceCount: decoded.length }, settings)
    return { ok: true, model, size, images: saved, dir: settings.outputDir }
  }

  async function testConnection() {
    const settings = await loadSettings()
    if (!settings.apiKey) throw new Error('还没有配置 API Key。')
    const base = validBase(settings.baseUrl)
    if (!base) throw new Error('Base URL 不合法。')
    try {
      const payload = await requestJson(base + '/models', { method: 'GET', headers: apiHeaders(settings) }, settings.apiKey)
      const count = Array.isArray(payload?.data) ? payload.data.length : 0
      return { ok: true, message: '连接成功' + (count ? '，可用模型 ' + count + ' 个' : '') + '。' }
    } catch (error) {
      const message = String(error?.message || error)
      // Some relays do not implement /models but still serve images; a 404 there
      // means "reachable, unknown endpoint", not a broken configuration.
      if (/（404）/.test(message)) return { ok: true, message: '服务器可达（中转站未实现 /models，可直接试生成）。' }
      throw new Error(message)
    }
  }

  async function revealFolder() {
    const settings = await loadSettings()
    const dir = settings.outputDir || defaultOutputDir()
    await fs.mkdir(dir, { recursive: true })
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    try {
      const child = spawn(command, [dir], { detached: true, stdio: 'ignore' })
      child.unref()
    } catch (error) {
      throw new Error('无法打开文件夹：' + String(error?.message || error))
    }
    return { ok: true, dir }
  }

  /* ----------------------------------------------------------------- routes */

  const routes = [
    {
      path: BASE + '/state',
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          const settings = await loadSettings()
          const gallery = await readGallery(24)
          return json(res, 200, Object.assign({ ok: true, gallery: gallery.items, galleryDir: gallery.dir }, publicSettings(settings)))
        } catch (error) {
          return json(res, 500, { error: String(error?.message || error) })
        }
      },
    },
    {
      path: BASE + '/settings',
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req, MAX_JSON)
        } catch (error) {
          return json(res, 400, { error: String(error.message || error) })
        }
        try {
          const patch = {}
          if (typeof body?.baseUrl === 'string') patch.baseUrl = body.baseUrl
          if (typeof body?.apiKey === 'string' && body.apiKey) patch.apiKey = body.apiKey
          if (body?.clearKey === true) patch.apiKey = ''
          if (typeof body?.model === 'string' && body.model) patch.model = body.model
          if (typeof body?.outputDir === 'string' && body.outputDir) patch.outputDir = body.outputDir
          if (typeof body?.size === 'string' && body.size) patch.size = body.size
          if (typeof body?.quality === 'string' && body.quality) patch.quality = body.quality
          if (typeof body?.background === 'string' && body.background) patch.background = body.background
          const settings = await saveSettings(patch)
          return json(res, 200, { ok: true, settings: publicSettings(settings) })
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: BASE + '/test',
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          const result = await testConnection()
          return json(res, 200, result)
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: BASE + '/generate',
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req, MAX_JSON)
        } catch (error) {
          return json(res, 400, { error: String(error.message || error) })
        }
        try {
          const result = await generate(body || {})
          return json(res, 200, result)
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: BASE + '/file',
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url || '/', 'http://localhost')
        const name = safeFile(url.searchParams.get('name') || '')
        if (!name) return json(res, 400, { error: '文件名不合法' })
        const settings = await loadSettings()
        const dir = settings.outputDir || defaultOutputDir()
        const absolute = path.join(dir, name)
        let buffer
        try {
          buffer = await fs.readFile(absolute)
        } catch {
          return json(res, 404, { error: '图片不存在' })
        }
        const extension = path.extname(name).toLowerCase()
        const type = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png'
        res.writeHead(200, {
          'content-type': type,
          'content-length': buffer.length,
          'cache-control': 'private, max-age=3600',
        })
        res.end(buffer)
      },
    },
    {
      path: BASE + '/gallery',
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          const gallery = await readGallery(48)
          return json(res, 200, { ok: true, dir: gallery.dir, items: gallery.items })
        } catch (error) {
          return json(res, 500, { error: String(error?.message || error) })
        }
      },
    },
    {
      path: BASE + '/reveal',
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          const result = await revealFolder()
          return json(res, 200, result)
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      /* Model catalog for the picker. Kept server-side because only the host
         holds the API key: the page never sees the credential, it just asks for
         the list. */
      path: BASE + '/models',
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          const settings = await loadSettings()
          if (!settings.apiKey) return json(res, 200, { ok: true, models: [], message: '还没有配置 API Key。' })
          const base = validBase(settings.baseUrl)
          if (!base) return json(res, 400, { ok: false, error: 'Base URL 不合法。' })
          let payload
          try {
            payload = await requestJson(base + '/models', { method: 'GET', headers: apiHeaders(settings) }, settings.apiKey)
          } catch (error) {
            const message = String(error?.message || error)
            if (/（404）/.test(message)) return json(res, 200, { ok: true, models: [], message: '该中转站未实现 /models，可直接填模型名。' })
            return json(res, 200, { ok: false, models: [], error: message })
          }
          const items = Array.isArray(payload?.data) ? payload.data : []
          const models = items
            .map((item) => (typeof item === 'string' ? item : item && item.id))
            .filter((id) => typeof id === 'string' && id)
            .sort()
          return json(res, 200, { ok: true, models, baseUrl: base })
        } catch (error) {
          return json(res, 500, { ok: false, models: [], error: String(error?.message || error) })
        }
      },
    },
  ]

  for (const route of routes) {
    try {
      planned.push(webServer.register({ kind: 'exact', path: route.path, handler: route.handler }))
    } catch {
      /* An older instance in this process already owns the path (hot reload without a
         restart). Keep serving through it instead of failing the whole entry. */
    }
  }

  /* ------------------------------------------------------------- host tools */

  const toolService = ctx.get('tools')
  if (toolService && typeof toolService.register === 'function') {
    const output = (schema) => ({
      schema,
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    })

    try {
      toolService.register({
        name: 'imagegen_generate',
        description:
          'Generate images with the configured OpenAI-compatible image API (gpt-image-1 by default) and save ' +
          'them to the panel output folder. Use for 漫剧 character asset sheets: a front full-body anchor ' +
          'first, then headshot / side / back / detail views, reusing the anchor as a reference image. ' +
          'Returns the saved absolute paths so you can reference them in the reply.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Image prompt. Include style, framing, background and lighting.' },
            size: {
              type: 'string',
              description: '1024x1024 (square) | 1536x1024 (landscape) | 1024x1536 (portrait) | auto',
            },
            quality: { type: 'string', description: 'low | medium | high | auto' },
            n: { type: 'number', description: 'How many images, 1-4. Default 1.' },
            model: { type: 'string', description: 'Override the model, e.g. gpt-image-1 or gpt-image-1-mini.' },
            refs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Absolute paths of reference images already on disk (PNG/JPEG/WEBP), for character consistency.',
            },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
        output: output({
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            images: { type: 'array' },
            error: { type: 'string' },
          },
        }),
        execute: async (args) => {
          const input = Object.assign({}, args)
          const paths = Array.isArray(args?.refs) ? args.refs : []
          if (paths.length) {
            const refs = []
            for (const file of paths.slice(0, MAX_INPUT_IMAGES)) {
              const absolute = path.resolve(String(file))
              const buffer = await fs.readFile(absolute)
              const extension = path.extname(absolute).toLowerCase()
              const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png'
              refs.push({ mime, buffer })
            }
            // Reuse the same path as the HTTP route: hand the decoded images over
            // as data URLs so one code path performs the request.
            input.refs = refs.map((ref) => ({
              dataUrl: 'data:' + ref.mime + ';base64,' + ref.buffer.toString('base64'),
            }))
          }
          try {
            const result = await generate(input)
            return { ok: true, images: result.images, dir: result.dir }
          } catch (error) {
            return { ok: false, error: String(error?.message || error) }
          }
        },
      })
    } catch (error) {
      try {
        console.error('[imagegen-panel] tool registration failed:', error)
      } catch {
        /* ignore */
      }
    }
  }

  // Keep the registered handles alive for the plugin lifetime.
  return { routes: planned, methods: [...METHODS] }
}
