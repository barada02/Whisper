import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isWatch = process.argv.includes('--watch');

const srcDir = path.join(__dirname, 'src');
const distDir = path.join(__dirname, 'dist');

// Utility to recursively copy directories
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (let entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Utility to copy specific files matching a pattern
function copyMatchingFiles(srcDir, destDir, pattern) {
  fs.mkdirSync(destDir, { recursive: true });
  if (!fs.existsSync(srcDir)) {
    console.warn(`Source directory does not exist: ${srcDir}`);
    return;
  }
  const files = fs.readdirSync(srcDir);
  let count = 0;
  for (const file of files) {
    if (pattern.test(file)) {
      fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
      count++;
    }
  }
  console.log(`Copied ${count} WASM assets from ${srcDir} to ${destDir}`);
}

async function runBuild() {
  console.log('Starting extension build...');

  // Ensure dist directory exists and is clean
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  // 1. Copy Manifest, HTML, CSS files
  fs.copyFileSync(path.join(srcDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
  
  // Create directories for other sub-components
  fs.mkdirSync(path.join(distDir, 'content'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'offscreen'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'options'), { recursive: true });

  // Copy CSS and HTML assets
  fs.copyFileSync(path.join(srcDir, 'content', 'content.css'), path.join(distDir, 'content', 'content.css'));
  fs.copyFileSync(path.join(srcDir, 'offscreen', 'offscreen.html'), path.join(distDir, 'offscreen', 'offscreen.html'));
  fs.copyFileSync(path.join(srcDir, 'options', 'options.html'), path.join(distDir, 'options', 'options.html'));
  fs.copyFileSync(path.join(srcDir, 'options', 'options.css'), path.join(distDir, 'options', 'options.css'));

  // Create icons directory placeholder in dist
  const srcIconsDir = path.join(srcDir, 'icons');
  const distIconsDir = path.join(distDir, 'icons');
  if (fs.existsSync(srcIconsDir)) {
    copyDirSync(srcIconsDir, distIconsDir);
  } else {
    fs.mkdirSync(distIconsDir, { recursive: true });
  }

  // 2. Compile Entry Points with Esbuild
  const entryPoints = [
    { in: path.join(srcDir, 'background.js'), out: 'background' },
    { in: path.join(srcDir, 'content', 'content.js'), out: 'content/content' },
    { in: path.join(srcDir, 'offscreen', 'offscreen.js'), out: 'offscreen/offscreen' },
    { in: path.join(srcDir, 'offscreen', 'worker.js'), out: 'offscreen/worker' },
    { in: path.join(srcDir, 'options', 'options.js'), out: 'options/options' }
  ];

  const buildOptions = {
    entryPoints: entryPoints.map(ep => ep.in),
    bundle: true,
    outdir: distDir,
    entryNames: '[dir]/[name]', // maintain subdirectory structure
    format: 'esm',
    platform: 'browser',
    sourcemap: isWatch ? 'inline' : false,
    minify: !isWatch,
    logLevel: 'info',
    // Externalize chrome APIs so esbuild doesn't try to resolve them
    external: ['chrome'],
    // Define process.env.NODE_ENV
    define: {
      'process.env.NODE_ENV': isWatch ? '"development"' : '"production"'
    }
  };

  try {
    if (isWatch) {
      console.log('Running in watch mode...');
      const ctx = await esbuild.context(buildOptions);
      await ctx.watch();
    } else {
      await esbuild.build(buildOptions);
      console.log('JavaScript compilation completed successfully.');
    }

    // 3. Copy ONNX Runtime WASM assets from node_modules/@huggingface/transformers/dist/
    const transformersDistDir = path.join(__dirname, 'node_modules', '@huggingface', 'transformers', 'dist');
    const destTransformersDir = path.join(distDir, 'transformers');
    
    // Copy any files matching ort-wasm* (wasm binaries and js/mjs wrappers)
    copyMatchingFiles(transformersDistDir, destTransformersDir, /^ort-wasm.*\.(wasm|mjs|js)$/);

    console.log('Extension build completed successfully! Output in dist/');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

runBuild();
