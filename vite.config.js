import path from 'path'
import fs from 'fs/promises'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

let buildOutDir = 'dist'

const copyEmuAssets = {
  name: 'copy-emu-assets',
  apply: 'build',
  configResolved(config) {
    buildOutDir = config.build.outDir
  },
  async closeBundle() {
    const assetsDir = path.join(buildOutDir, 'assets')
    await fs.mkdir(path.join(assetsDir, 'disk'), { recursive: true })
    for (const file of ['kernel.bin.zst', 'opensbi.bin.zst', 'riscvemu64-wasm.js', 'riscvemu64-wasm.wasm']) {
      await fs.copyFile(path.join('assets', file), path.join(assetsDir, file))
    }
    const diskSrc = 'assets/disk'
    const diskDst = path.join(assetsDir, 'disk')
    await fs.mkdir(diskDst, { recursive: true })
    for (const entry of await fs.readdir(diskSrc)) {
      if (entry.endsWith('.bin') && !entry.endsWith('.bin.zst')) continue
      await fs.copyFile(path.join(diskSrc, entry), path.join(diskDst, entry))
    }
    await fs.cp('topologies', path.join(buildOutDir, 'topologies'), { recursive: true })
    await fs.copyFile('about.html', path.join(buildOutDir, 'about.html'))
  }
}

const writeStaticPreview = {
  name: 'write-static-preview',
  apply: 'build',
  async closeBundle() {
    const hash = execSync('git rev-parse HEAD').toString().trim()
    const shortHash = hash.slice(0, 6)
    const builtHtml = await fs.readFile(path.join(buildOutDir, 'index.html'), 'utf8')
    await fs.mkdir('dist-static', { recursive: true })
    await fs.writeFile(path.join('dist-static', `index.html`), builtHtml)
  }
}

const cdnPlugin = {
  name: 'cdn-base',
  async config(_config, { command }) {
    if (command !== 'build') return
    const html = readFileSync('./index.html', 'utf8')
    const cdnHost = html.match(/window\.__CDN_HOST__\s*=\s*['"]([^'"]*)['"]/)?.[1] ?? ''
    if (!cdnHost) return
    const dirty = execSync('git status --porcelain').toString().trim()
    if (dirty) throw new Error(`Build aborted: uncommitted changes:\n${dirty}`)
    const hash = execSync('git rev-parse HEAD').toString().trim()
    return { base: `https://${cdnHost}/${hash}/` }
  },
  transformIndexHtml(html) {
    // Strip the __CDN_HOST__ script block — it's only a build-time input
    return html.replace(/\s*<script>[\s\S]*?__CDN_HOST__[\s\S]*?<\/script>/, '')
  }
}

export default {
  base: './',
  worker: {
    format: 'iife',
  },
  server: {
    mimeTypes: {
      '.yaml': 'text/yaml',
    },
    watch: {
      ignored: [
        "**/.git/**",
        "**/assets/**",
        "**/downloads/**",
        "**/emsdk/**",
        "**/linux/**",
        "**/vmsandbox_console.cfg",
        "**/opensbi/**",
        "**/tmp/**"
      ],
    },
  },
  plugins: [
    (() => {
      const justSaved = new Set()
      return {
        name: 'watch-topologies',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.startsWith('/assets/')) {
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
            }
            next()
          })

          server.middlewares.use('/api/save-topology', async (req, res, next) => {
            if (req.method !== 'POST') { next(); return }
            let body = ''
            req.setEncoding('utf8')
            req.on('data', chunk => { body += chunk })
            req.on('end', async () => {
              try {
                const { filename, yaml } = JSON.parse(body)
                if (!filename || filename.includes('..') || filename.includes('/') || filename.includes(path.sep)) {
                  res.writeHead(400, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ error: 'Invalid filename' }))
                  return
                }
                const topologiesDir = path.resolve(process.cwd(), 'topologies')
                const filePath = path.join(topologiesDir, filename)
                if (!filePath.startsWith(topologiesDir + path.sep)) {
                  res.writeHead(400, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ error: 'Path traversal rejected' }))
                  return
                }
                justSaved.add(filename)
                setTimeout(() => justSaved.delete(filename), 3000)
                await fs.writeFile(filePath, yaml, 'utf8')
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
              } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: String(err) }))
              }
            })
          })

          server.watcher.on('change', (file) => {
            if (file.includes(`${path.sep}topologies${path.sep}`)) {
              const basename = path.basename(file)
              if (justSaved.has(basename)) return
              server.ws.send({ type: 'full-reload' })
            }
          })
        }
      }
    })(),
    cdnPlugin,
    copyEmuAssets,
    writeStaticPreview,
  ]
}
