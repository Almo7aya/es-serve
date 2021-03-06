#!/usr/bin/env node
const {join, extname, parse, format} = require('path').posix
const {createReadStream} = require('fs')
const {readFile, stat} = require('./fs-async')
const {transformFileAsync} = require('@babel/core')
const {VERBOSE, IGNORE, EXTS, ROOT, PORT} = require('./options')
const mime = require('mime')
const watcher = require('./watch')
const {rewriteDir} = require('./util')
const stripAnsi = require('strip-ansi')

/** @type {Map<string, {mtime: Date, code: string}>} */
const CACHE = new Map()

const server = require('http').createServer(async (req, res) => {
  // only handle GET requests
  if (req.method != 'GET') {
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8')
    res.statusCode = 405
    return res.end('Method not allowed')
  }

  let path = require('url').parse(`${req.url}`).pathname || '/'

  try {
    if (watcher != null && path == '/_events') {
      res.setHeader('Content-Type', 'text/event-stream')
      /**
       * @param {string} file
       * @return {void}
       */
      const listener = file => {
        if (VERBOSE) console.log('CHANGE', `/${file}`)
        res.write(`event: change\ndata: ${file}\n\n`)
      }
      watcher.addListener('change', listener)
      const interval = setInterval(() => {
        res.write('event: ping\ndata: ping!\n\n')
      }, 10000)
      req.on('close', () => {
        watcher.removeListener('change', listener)
        clearInterval(interval)
      })
      return res.write('event: ping\ndata: ping!\n\n')
    }

    path = rewriteDir(path)

    const ignored = IGNORE.some(ignore => {
      ignore = join('/', ignore, '/')
      return path.substr(0, ignore.length) == ignore
    })

    const convert = EXTS.includes(extname(path))

    if (!ignored && convert) {
      const exts = EXTS.filter(ext => ext != extname(path))
      for (const ext of [extname(path), ...exts]) {
        const {dir, name} = parse(path)
        const file = format({dir, name, ext})
        const mtime = await stat(join(ROOT, file))
          .then(stats => (stats.isFile() ? stats.mtime : undefined))
          .catch(() => undefined)
        if (mtime) {
          const entry = CACHE.get(file)
          res.setHeader('Content-Type', 'text/javascript')
          if (entry && +entry.mtime == +mtime) {
            if (VERBOSE) console.log('200', file, '(cache)')
            return res.end(entry.code)
          }
          else {
            const result = await transformFileAsync(join(ROOT, file), {
              plugins: [[require('babel-plugin-bare-import-rewrite'), {extensions: EXTS}]],
              cwd: ROOT,
            })
            if (!result) throw new Error('Babel transformation failed')
            CACHE.set(file, {code: `${result.code}`, mtime})
            if (VERBOSE) console.log('200', file, '(transform)')
            return res.end(result.code)
          }
        }
      }
    }

    const exists = await stat(join(ROOT, path))
      .then(stats => stats.isFile())
      .catch(() => false)

    if (exists) {
      const mimetype = mime.getType(path)
      if (mimetype != null) res.setHeader('Content-Type', mimetype)
      if (VERBOSE) console.log('200', path)
      return createReadStream(join(ROOT, path)).pipe(res)
    }

    // app index fallback
    if (path.match(/^[/\w-]+$/)) {
      res.setHeader('Content-Type', 'text/html')
      let src = await readFile(join(ROOT, 'index.html'))
      if (watcher != null)
        src = src.replace(
          /<\/body>/i,
          `<script>(() => {
            let t;
            new EventSource("/_events").addEventListener("change", e => {
              console.warn("CHANGE:", e.data);
              if (t != null) clearTimeout(t);
              t = setTimeout(() => location.reload(), 200);
            });
          })()</script></body>`.replace(/\s+/g, ' '),
        )
      if (VERBOSE) console.log('200', path, '(index)')
      return res.end(src)
    }

    if (VERBOSE) console.log('404', path)
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8')
    res.statusCode = 404
    return res.end('Not found')
  }
  catch (err) {
    console.error('500', path, '-', err.message)
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8')
    res.statusCode = 500
    res.end(stripAnsi(err.message))
  }
})

server.listen(8000, () => {
  console.log(`Server running at http://localhost:${PORT}`)
})
