#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

/**
 * Review changed screenshot baselines before accepting them.
 *
 * A re-recorded baseline asserts that the new rendering is correct, and a run of the screenshot
 * suite cannot say whether it is. A token change can touch hundreds of images at once, and looking
 * at each pair by eye misses a small unrelated difference among many expected ones. This compares
 * every changed PNG in a repository with the version at a base revision and reports, for each one,
 * how many pixels changed, the separate regions they fall into, and whether the change is a uniform
 * lightening or darkening of neutral pixels or something else. A colour change that recurs across
 * many baselines is listed once, so an expected token change reads as one line and an image whose
 * change it does not explain stands out. Crops of each region, enlarged beside the old rendering
 * and a mask of the changed pixels, can be written for the images that need a closer look.
 *
 * The PNG reader and writer below use only `node:zlib`, so the tool runs in any repository
 * without installing anything.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** How `compareImages` marks each changed pixel in its mask. */
export const DARKER = 1;
export const LIGHTER = 2;
export const COLOUR = 3;

/** The largest per-channel change that still counts as a tone shift rather than new content. */
export const TONE_LIMIT = 48;
/** How far apart a tone shift's three channel changes may be and still count as neutral. */
export const TONE_SPREAD = 6;
/** Changed pixels this close to each other belong to the same region. */
export const REGION_GAP = 4;

export function decodePng(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file');
  let offset = 8;
  let header;
  let palette;
  let transparency;
  const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8],
        colourType: body[9], interlace: body[12],
      };
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
  }
  if (!header) throw new Error('PNG has no IHDR chunk');
  const { width, height, depth, colourType, interlace } = header;
  const channels = CHANNELS[colourType];
  if (depth !== 8 || channels === undefined || interlace !== 0) {
    throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colourType}, interlace ${interlace}`);
  }
  if (colourType === 3 && !palette) throw new Error('palette PNG has no PLTE chunk');
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[i - channels] : 0;
      const up = above ? above[i] : 0;
      const upLeft = above && i >= channels ? above[i - channels] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      out[i] = (line[i] + predictor) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    const t = p * 4;
    if (colourType === 6) rgba.set(rows.subarray(s, s + 4), t);
    else if (colourType === 2) {
      rgba[t] = rows[s]; rgba[t + 1] = rows[s + 1]; rgba[t + 2] = rows[s + 2]; rgba[t + 3] = 255;
    } else if (colourType === 0 || colourType === 4) {
      rgba[t] = rgba[t + 1] = rgba[t + 2] = rows[s];
      rgba[t + 3] = colourType === 4 ? rows[s + 1] : 255;
    } else {
      const index = rows[s];
      rgba[t] = palette[index * 3]; rgba[t + 1] = palette[index * 3 + 1]; rgba[t + 2] = palette[index * 3 + 2];
      rgba[t + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    }
  }
  return { width, height, data: rgba };
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const named = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(named));
  return Buffer.concat([length, named, checksum]);
}

function hex(data, i) {
  const value = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  return `#${value.toString(16).padStart(6, '0')}`;
}

/**
 * Compare two renderings of the same baseline.
 *
 * Each changed pixel is a tone shift when its three colour channels move the same way by nearly the
 * same amount, and by at most `TONE_LIMIT`: a grey line drawn darker, or a neutral surface drawn
 * lighter. Anything else, including a change of opacity, is a colour change. An image whose changed
 * pixels are all darker, or all lighter, is reported as such; the rest are mixed and need looking at.
 */
export function compareImages(before, after) {
  if (before.width !== after.width || before.height !== after.height) {
    return { kind: 'resized', before: [before.width, before.height], after: [after.width, after.height] };
  }
  const { width, height } = after;
  const mask = new Uint8Array(width * height);
  const transitions = new Map();
  let changed = 0;
  let darker = 0;
  let lighter = 0;
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const dr = after.data[i] - before.data[i];
    const dg = after.data[i + 1] - before.data[i + 1];
    const db = after.data[i + 2] - before.data[i + 2];
    const da = after.data[i + 3] - before.data[i + 3];
    if (dr === 0 && dg === 0 && db === 0 && da === 0) continue;
    changed++;
    const low = Math.min(dr, dg, db);
    const high = Math.max(dr, dg, db);
    const tone = da === 0 && high - low <= TONE_SPREAD && Math.max(-low, high) <= TONE_LIMIT;
    if (tone && high <= 0) { darker++; mask[p] = DARKER; }
    else if (tone && low >= 0) { lighter++; mask[p] = LIGHTER; }
    else mask[p] = COLOUR;
    const key = `${hex(before.data, i)} → ${hex(after.data, i)}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  }
  if (changed === 0) return { kind: 'same-pixels', width, height };
  const colour = changed - darker - lighter;
  const kind = colour > 0 || (darker > 0 && lighter > 0) ? 'mixed' : darker > 0 ? 'darker' : 'lighter';
  return {
    kind, width, height, changed, darker, lighter, colour,
    regions: findRegions(mask, width, height), transitions, mask,
  };
}

/**
 * Group changed pixels into regions, joining pixels at most `gap` apart. Regions holding colour
 * changes come first, most first, so a small unexplained change is not hidden behind a large tone
 * shift; the rest follow by size.
 */
export function findRegions(mask, width, height, gap = REGION_GAP) {
  const seen = new Uint8Array(mask.length);
  const regions = [];
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let [x0, y0, x1, y1] = [width, height, -1, -1];
    let pixels = 0;
    let colour = 0;
    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = (p - x) / width;
      pixels++;
      if (mask[p] === COLOUR) colour++;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (let ny = Math.max(0, y - gap); ny <= Math.min(height - 1, y + gap); ny++) {
        for (let nx = Math.max(0, x - gap); nx <= Math.min(width - 1, x + gap); nx++) {
          const q = ny * width + nx;
          if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; }
        }
      }
    }
    regions.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels, colour });
  }
  return regions.sort((a, b) => b.colour - a.colour || b.pixels - a.pixels);
}

/**
 * Draw one region three times, enlarged: the base rendering, the new one, and the new one faded
 * with its changed pixels in magenta. A small region is widened to `context` pixels, so the crop
 * shows what the change sits in.
 */
export function cropRegion(before, after, mask, region, { padding = 6, context = 40, scale } = {}) {
  const padX = Math.max(padding, Math.ceil((context - region.width) / 2));
  const padY = Math.max(padding, Math.ceil((context - region.height) / 2));
  const x0 = Math.max(0, region.x - padX);
  const y0 = Math.max(0, region.y - padY);
  const x1 = Math.min(after.width - 1, region.x + region.width - 1 + padX);
  const y1 = Math.min(after.height - 1, region.y + region.height - 1 + padY);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const s = scale ?? Math.max(1, Math.min(8, Math.floor(400 / Math.max(w, h))));
  const gap = 4;
  const out = { width: w * s * 3 + gap * 2, height: h * s, data: new Uint8Array((w * s * 3 + gap * 2) * h * s * 4) };
  out.data.fill(255);
  for (let panel = 0; panel < 3; panel++) {
    const source = panel === 0 ? before : after;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y0 + y) * after.width + (x0 + x);
        let [r, g, b] = source.data.subarray(p * 4, p * 4 + 3);
        if (panel === 2) {
          if (mask[p]) [r, g, b] = [255, 0, 255];
          else [r, g, b] = [r, g, b].map(v => 255 - ((255 - v) >> 2));
        }
        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) {
            const j = ((y * s + dy) * out.width + panel * (w * s + gap) + x * s + dx) * 4;
            out.data[j] = r; out.data[j + 1] = g; out.data[j + 2] = b; out.data[j + 3] = 255;
          }
        }
      }
    }
  }
  return out;
}

function git(repository, args, options = {}) {
  const result = spawnSync('git', ['-C', repository, ...args], { maxBuffer: 1 << 30, ...options });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${repository}: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

/** The PNGs that differ between `base` and the working tree, untracked ones included. */
export function changedBaselines(repository, base = 'HEAD', paths = []) {
  const scope = ['--', ...(paths.length ? paths : ['.'])];
  const listed = git(repository, ['diff', '--no-renames', '--name-status', base, ...scope], { encoding: 'utf8' });
  const files = [];
  for (const line of listed.split('\n')) {
    const [status, path] = line.split('\t');
    if (path?.endsWith('.png')) files.push({ path, status: status[0] });
  }
  const untracked = git(repository, ['ls-files', '--others', '--exclude-standard', ...scope], { encoding: 'utf8' });
  for (const path of untracked.split('\n')) if (path.endsWith('.png')) files.push({ path, status: 'A' });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function reviewRepository(repository, { base = 'HEAD', paths = [], crops, cropLimit = 3, scale } = {}) {
  const reviews = [];
  for (const { path, status } of changedBaselines(repository, base, paths)) {
    if (status === 'A') { reviews.push({ path, kind: 'added' }); continue; }
    if (status === 'D') { reviews.push({ path, kind: 'removed' }); continue; }
    const before = decodePng(git(repository, ['show', `${base}:${path}`]));
    const after = decodePng(readFileSync(join(repository, path)));
    const comparison = compareImages(before, after);
    const review = { path, ...comparison };
    if (crops && comparison.regions) {
      review.crops = [];
      comparison.regions.slice(0, cropLimit).forEach((region, n) => {
        const file = join(crops, `${path.replaceAll('/', '__').replace(/\.png$/, '')}--${n + 1}.png`);
        mkdirSync(crops, { recursive: true });
        writeFileSync(file, encodePng(cropRegion(before, after, comparison.mask, region, { scale })));
        review.crops.push(file);
      });
    }
    reviews.push(review);
  }
  return reviews;
}

/** Colour changes found in more than one baseline, most widespread first. */
export function sharedTransitions(reviews, limit = 10) {
  const totals = new Map();
  for (const review of reviews) {
    for (const [key, pixels] of review.transitions ?? []) {
      const total = totals.get(key) ?? { transition: key, pixels: 0, baselines: 0 };
      total.pixels += pixels;
      total.baselines++;
      totals.set(key, total);
    }
  }
  return [...totals.values()].filter(t => t.baselines > 1)
    .sort((a, b) => b.baselines - a.baselines || b.pixels - a.pixels).slice(0, limit);
}

const ORDER = ['resized', 'added', 'removed', 'mixed', 'darker', 'lighter', 'same-pixels'];
const HEADINGS = {
  resized: 'Resized (compare by eye)',
  added: 'New baselines (no earlier version to compare with)',
  removed: 'Removed baselines',
  mixed: 'Mixed changes (review these first)',
  darker: 'Neutral pixels drawn darker, nothing else changed',
  lighter: 'Neutral pixels drawn lighter, nothing else changed',
  'same-pixels': 'File changed, pixels identical',
};

function describe(review) {
  if (review.kind === 'resized') return `${review.before.join('×')} → ${review.after.join('×')}`;
  if (!review.changed) return '';
  const share = (100 * review.changed / (review.width * review.height)).toFixed(2);
  const [first] = review.regions;
  const count = review.regions.length;
  const parts = [`${review.changed.toLocaleString('en-US')} px (${share}%)`];
  if (review.kind === 'mixed' && first.colour > 0) {
    const coloured = review.regions.filter(region => region.colour > 0).length;
    parts.push(`colour changes in ${coloured} of ${count} region${count === 1 ? '' : 's'}, `
      + `most in ${first.width}×${first.height} at ${first.x},${first.y}`);
  } else {
    parts.push(`${count} region${count === 1 ? '' : 's'}, largest ${first.width}×${first.height} at ${first.x},${first.y}`);
  }
  if (review.kind === 'mixed') parts.push(`darker ${review.darker}, lighter ${review.lighter}, colour ${review.colour}`);
  return parts.join('; ');
}

export function formatReport(repository, base, reviews) {
  const lines = [];
  const counts = Object.fromEntries(ORDER.map(kind => [kind, reviews.filter(r => r.kind === kind).length]));
  lines.push(`${reviews.length} changed baseline${reviews.length === 1 ? '' : 's'} in ${repository} against ${base}`);
  lines.push(`  ${ORDER.filter(kind => counts[kind]).map(kind => `${counts[kind]} ${kind}`).join(', ') || 'nothing to review'}`);
  const shared = sharedTransitions(reviews);
  if (shared.length) {
    lines.push('', 'Colour changes found in more than one baseline:');
    for (const t of shared) {
      lines.push(`  ${t.transition}  ${t.pixels.toLocaleString('en-US')} px in ${t.baselines} baselines`);
    }
  }
  for (const kind of ORDER) {
    const group = reviews.filter(r => r.kind === kind);
    if (!group.length) continue;
    if (kind === 'mixed') group.sort((a, b) => b.colour - a.colour);
    lines.push('', `${HEADINGS[kind]}:`);
    for (const review of group) {
      const detail = describe(review);
      lines.push(`  ${review.path}${detail ? `  ${detail}` : ''}`);
      for (const file of review.crops ?? []) lines.push(`    crop: ${file}`);
    }
  }
  return lines.join('\n');
}

function usage() {
  console.error('Usage: review-visual-baselines.mjs [--base <revision>] [--crops <directory>] [--scale <n>] [--json]'
    + ' <repository> [<path>...]');
}

function main(argv) {
  const options = { base: 'HEAD', paths: [] };
  let repository;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--base') options.base = argv[++i];
    else if (argument === '--crops') options.crops = resolve(argv[++i]);
    else if (argument === '--scale') options.scale = Number(argv[++i]);
    else if (argument === '--json') json = true;
    else if (argument.startsWith('--')) { usage(); return 2; }
    else if (repository === undefined) repository = resolve(argument);
    else options.paths.push(argument);
  }
  if (!repository || !options.base || (options.scale !== undefined && !(options.scale >= 1))) {
    usage();
    return 2;
  }
  const reviews = reviewRepository(repository, options);
  if (json) {
    const plain = reviews.map(({ mask, transitions, ...review }) => ({
      ...review, ...(transitions && { transitions: Object.fromEntries(transitions) }),
    }));
    console.log(JSON.stringify({ repository, base: options.base, shared: sharedTransitions(reviews), reviews: plain }, null, 2));
  } else {
    console.log(formatReport(repository, options.base, reviews));
  }
  return 0;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
