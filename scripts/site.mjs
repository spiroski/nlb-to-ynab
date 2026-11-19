import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const siteDir = join(projectDir, '_site');
const sheetjsUrl = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
const sheetjsHash = 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41';
const sheetjsFile = 'vendor/xlsx.full.min.js';
const text = 'text/plain; charset=utf-8';
const javascript = 'text/javascript; charset=utf-8';
const staticFiles = new Map([
  ['app.js', javascript],
  ['core.js', javascript],
  ['styles.css', 'text/css; charset=utf-8'],
  ['.nojekyll', text],
  ['THIRD_PARTY_NOTICES.md', text],
  ['licenses/Apache-2.0.txt', text],
]);
const contentTypes = new Map([
  ...staticFiles,
  [sheetjsFile, javascript],
  ['index.html', 'text/html; charset=utf-8'],
]);

function isPinnedSheetjs(bytes) {
  return createHash('sha256').update(bytes).digest('hex') === sheetjsHash;
}

async function loadSheetjs() {
  try {
    const cached = await readFile(join(siteDir, sheetjsFile));
    if (isPinnedSheetjs(cached)) return cached;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  console.log(`Downloading SheetJS from ${sheetjsUrl}`);
  const response = await fetch(sheetjsUrl, { signal: AbortSignal.timeout(30_000) }).catch((error) => {
    throw new Error(`SheetJS download failed: ${error.cause?.message ?? error.message}`);
  });
  if (!response.ok) throw new Error(`SheetJS download failed with HTTP ${response.status}.`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!isPinnedSheetjs(bytes)) throw new Error('SheetJS download failed checksum verification.');
  return bytes;
}

async function build() {
  const source = await readFile(join(projectDir, 'index.html'), 'utf8');
  const remoteScriptPolicy = "script-src 'self' https://cdn.sheetjs.com";
  if (!source.includes(`src="${sheetjsUrl}"`) || !source.includes(remoteScriptPolicy)) {
    throw new Error('The SheetJS URL or script policy in index.html has changed. Update the local build to match.');
  }
  const html = source
    .replace(`src="${sheetjsUrl}"`, `src="./${sheetjsFile}"`)
    .replace(remoteScriptPolicy, "script-src 'self'");
  const sheetjs = await loadSheetjs();

  await mkdir(join(siteDir, 'licenses'), { recursive: true });
  await mkdir(join(siteDir, 'vendor'), { recursive: true });
  const stagingDir = await mkdtemp(join(siteDir, '.build-'));
  try {
    await mkdir(join(stagingDir, 'licenses'));
    await mkdir(join(stagingDir, 'vendor'));
    for (const file of staticFiles.keys()) {
      await copyFile(join(projectDir, file), join(stagingDir, file));
    }
    await writeFile(join(stagingDir, sheetjsFile), sheetjs);
    await writeFile(join(stagingDir, 'index.html'), html);

    // Publish the entry point after its assets are in place.
    for (const file of contentTypes.keys()) {
      await rename(join(stagingDir, file), join(siteDir, file));
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
  console.log('Built the site in _site/.');
}

async function serve() {
  try {
    await access(join(siteDir, 'index.html'));
    await access(join(siteDir, sheetjsFile));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('The site build is missing. Run `npm run build` first, or use `npm start`.');
  }

  const host = '127.0.0.1';
  const port = Number(process.env.PORT ?? 8000);
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    const [pathname] = request.url.split('?');
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    const contentType = contentTypes.get(file);
    if (!contentType) {
      response.writeHead(404).end();
      return;
    }

    try {
      const body = await readFile(join(siteDir, file));
      response.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`Serving _site/ at http://${host}:${server.address().port}`);
}

try {
  const command = process.argv[2];
  if (command === 'build') await build();
  else if (command === 'serve') await serve();
  else throw new Error('Use `npm run build` or `npm run serve`.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
