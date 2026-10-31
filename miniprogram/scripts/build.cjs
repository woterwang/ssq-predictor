/** 将原生TS编译到dist，并按文件依赖闭包复制TDesign，避免整库及隐私无关组件进入主包。 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src');
const output = path.join(root, 'dist');
const vendor = path.join(root, 'node_modules/tdesign-miniprogram/miniprogram_dist');
const vendorOutput = path.join(output, 'miniprogram_npm/tdesign-miniprogram');
// TDesign默认图标字体走CDN；此处固定官方0.4.5资源并内联，避免公众页面额外网络请求。
const iconFont = fs.readFileSync(path.join(root, 'assets/tdesign-icons-0.4.5.woff'));
if (createHash('sha256').update(iconFont).digest('hex') !== '377024275d01176d32461000713af752fbefb0d2520c49b0aeda82a3a3150b54') {
  throw new Error('TDesign官方字体资源校验不一致');
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
function checkTypes(noEmit) {
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), ...(noEmit ? ['--noEmit'] : []), '-p', path.join(root, 'tsconfig.json')], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('TypeScript编译未通过，停止构建');
}
checkTypes(true);
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
checkTypes(false);
for (const file of files(source).filter(file => /\.(json|wxml|wxss|wxs|png|svg)$/.test(file))) {
  const destination = path.join(output, path.relative(source, file));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination);
}

const copied = new Set();
function assertVendorFile(file) {
  if (!file.startsWith(`${vendor}${path.sep}`)) throw new Error(`依赖路径越界：${file}`);
}
function copyVendorFile(file) {
  assertVendorFile(file);
  if (copied.has(file)) return;
  if (!fs.existsSync(file)) throw new Error(`缺少TDesign依赖：${file}`);
  copied.add(file);
  const text = /\.(js|json|wxml|wxss|wxs)$/.test(file) ? fs.readFileSync(file, 'utf8') : '';
  const destination = path.join(vendorOutput, path.relative(vendor, file));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (file.endsWith('.js')) {
    // 发布包为ES模块，微信逻辑层使用CommonJS；无需再额外打包Node依赖。
    const transformed = ts.transpileModule(text, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS } });
    fs.writeFileSync(destination, transformed.outputText);
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*|\brequire\s*\()\s*["']([^"']+)["']/g)) {
      const name = match[1];
      if (name.startsWith('.')) copyVendorFile(resolveFile(path.resolve(path.dirname(file), name)));
      else if (name === 'tslib') copyVendorFile(path.join(vendor, 'miniprogram_npm/tslib/index.js'));
      else throw new Error(`尚未支持的外部TDesign依赖：${name}`);
    }
  } else {
    if (file === path.join(vendor, 'icon/icon.wxss')) {
      const face = /@font-face\{[^}]*\}/;
      if (!face.test(text)) throw new Error('TDesign字体声明变化，需人工复核');
      const inlineFont = text.replace(face, `@font-face{font-family:t;src:url(data:font/woff;base64,${iconFont.toString('base64')}) format('woff');font-weight:400;font-style:normal;}`);
      fs.writeFileSync(destination, inlineFont);
    } else fs.copyFileSync(file, destination);
    if (file.endsWith('.json')) {
      const config = JSON.parse(text);
      for (const component of Object.values(config.usingComponents || {})) {
        if (component.startsWith('.')) copyComponent(path.resolve(path.dirname(file), component));
        else throw new Error(`尚未支持的组件路径：${component}`);
      }
    }
    if (file.endsWith('.wxss')) {
      for (const match of text.matchAll(/@import\s+["']([^"']+)["']/g)) copyVendorFile(path.resolve(path.dirname(file), match[1]));
    }
    if (file.endsWith('.wxml') || file.endsWith('.wxs')) {
      for (const match of text.matchAll(/(?:src=|require\()\s*["']([^"']+)["']/g)) {
        if (match[1].startsWith('.')) copyVendorFile(resolveFile(path.resolve(path.dirname(file), match[1])));
      }
    }
  }
}
function resolveFile(base) {
  for (const candidate of [base, `${base}.js`, `${base}.wxs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`无法解析依赖：${base}`);
}
function copyComponent(base) {
  for (const extension of ['.js', '.json', '.wxml', '.wxss']) copyVendorFile(`${base}${extension}`);
}
for (const file of files(source).filter(file => file.endsWith('.json'))) {
  for (const component of Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).usingComponents || {})) {
    if (component.startsWith('tdesign-miniprogram/')) copyComponent(path.join(vendor, component.slice('tdesign-miniprogram/'.length)));
  }
}
// 保留第三方版权/许可证文本，依赖源码只通过npm取得，不手工改动发布包。
for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
  const license = path.join(root, 'node_modules/tdesign-miniprogram', name);
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(vendorOutput, name));
}
// ECharts按需打包（折线+网格+提示框+Canvas），只进入charts分包；保留Apache-2.0许可证与NOTICE。
const echartsOutput = path.join(output, 'charts/lib');
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, 'echarts-entry.mjs')], outfile: path.join(echartsOutput, 'echarts.js'),
  bundle: true, format: 'cjs', platform: 'neutral', target: 'es2017', minify: true, legalComments: 'eof',
  mainFields: ['module', 'main'], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
});
for (const name of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(root, 'node_modules/echarts', name), path.join(echartsOutput, `ECHARTS-${name}`));
fs.copyFileSync(path.join(root, 'node_modules/zrender/LICENSE'), path.join(echartsOutput, 'ZRENDER-LICENSE'));
const allFiles = files(output);
const packageBytes = prefix => allFiles.filter(file => prefix(path.relative(output, file))).reduce((sum, file) => sum + fs.statSync(file).size, 0);
const subPackages = JSON.parse(fs.readFileSync(path.join(source, 'app.json'), 'utf8')).subPackages.map(pack => pack.root);
const bytes = packageBytes(file => !subPackages.some(root => file.startsWith(`${root}${path.sep}`)));
if (bytes >= 2 * 1024 * 1024) throw new Error('本地主包文件体积达到2MiB，停止交付；实际上传体积仍需开发者工具复核');
for (const root of subPackages) {
  const size = packageBytes(file => file.startsWith(`${root}${path.sep}`));
  if (size >= 2 * 1024 * 1024) throw new Error(`本地分包${root}体积达到2MiB`);
  console.log(`subpackage ${root}: ${size} bytes`);
}
console.log(`Built ${allFiles.length} files; TDesign dependency closure ${copied.size} files; local main-package bytes ${bytes}.`);