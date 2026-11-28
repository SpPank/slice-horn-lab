// Builds the single-file app: dist/SliceHornLab.html (open locally) and dist/artifact.html (web publish body)
const fs = require('fs'), path = require('path');
const root = __dirname;
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---- driver library: WinISD folder + Parts Express scrape (if present)
const lib = [];
const winisd = path.join(process.env.USERPROFILE || '', 'OneDrive', 'Documents', 'WinISD', 'drivers');
const num = (v, s = 1) => (v != null && v !== '' && isFinite(+v) && +v !== 0) ? +(+v * s).toPrecision(6) : undefined;
if (fs.existsSync(winisd)) {
  for (const f of fs.readdirSync(winisd)) {
    if (!/\.wdr$/i.test(f)) continue;
    const kv = {};
    fs.readFileSync(path.join(winisd, f), 'latin1').split(/\r?\n/).forEach((l) => { const m = /^([^=]+)=(.*)$/.exec(l); if (m) kv[m[1].trim()] = m[2].trim(); });
    if (!num(kv.Fs) || !num(kv.Sd)) continue;
    const b = (kv.Brand || '').trim(), m = (kv.Model || f.replace(/\.wdr$/i, '')).trim();
    lib.push({ k: `WinISD:${b} ${m}`, b, m, src: 'WinISD', Fs: num(kv.Fs), Qes: num(kv.Qes), Qms: num(kv.Qms), Vas: num(kv.Vas, 1000), Re: num(kv.Re), Le: num(kv.Le, 1000),
      Sd: num(kv.Sd, 1e4), Mms: num(kv.Mms, 1000), Bl: num(kv.BL), Xmax: num(kv.Xmax, 1000), Pe: num(kv.Pe) });
  }
}
// traced side profiles from the technical drawings (tools/extract_profiles.py)
let PROF = {};
try { PROF = JSON.parse(fs.readFileSync(path.join(root, 'data', 'profiles.json'), 'utf8')); } catch (e) { }
const sheetFiles = fs.existsSync(path.join(root, 'data', 'sheets')) ? fs.readdirSync(path.join(root, 'data', 'sheets')) : [];
const profFor = (rel) => { const p = rel && PROF[rel.split(String.fromCharCode(92)).join('/')]; return p && p.ok && p.profile ? p.profile : undefined; };
const peProf = (sku) => { if (!sku) return undefined; const mine = sheetFiles.filter((n) => n.startsWith(sku + '-')).sort(); const f = mine.find((n) => /draw/i.test(n)); if (f) return profFor('sheets/' + f); const sh = mine.find((n) => /spec-sheet/i.test(n)); return sh ? profFor('sheets/' + sh) : undefined; };   // Lavoce: the drawing is on the spec sheet
const pe = path.join(root, 'data', 'pe_drivers.json');
let peCount = 0;
if (fs.existsSync(pe)) {
  try {
    const peRows = JSON.parse(fs.readFileSync(pe, 'utf8'));
    for (const extra of ['pe_lavoce.json', 'pe_celestion.json', 'pe_beyma.json', 'pe_hifi.json']) {   // more brands (Parts Express + spec sheets)
      const f = path.join(root, 'data', extra);
      if (fs.existsSync(f)) { try { peRows.push(...JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { console.warn(extra + ' not readable:', e.message); } }
    }
    const peCountN = {}; peRows.forEach((d) => { const n = d.brand + ' ' + d.model + '|' + d.source; peCountN[n] = (peCountN[n] || 0) + 1; });
    for (const d0 of peRows) {
      const d = (peCountN[d0.brand + ' ' + d0.model + '|' + d0.source] > 1 && d0.nominal_ohms && !new RegExp('-' + d0.nominal_ohms + '$').test(d0.model)) ? { ...d0, model: `${d0.model} ${d0.nominal_ohms}Ω` } : d0;
      if (!d.Fs || !d.Sd_cm2 || !(d.Qes || d.Qts) || !d.Re) continue;
      const tag = d.source === 'spec_sheet' ? 'PE spec sheet' : 'PE product page';
      const Qes = d.Qes || (d.Qts && d.Qms ? 1 / (1 / d.Qts - 1 / d.Qms) : undefined);
      lib.push({ k: `PE:${d.brand} ${d.model}${d.source === 'spec_sheet' ? ' [sheet]' : ''}`, b: d.brand, m: d.model + (d.source === 'spec_sheet' ? ' (spec sheet)' : ''), src: tag,
        Fs: d.Fs, Qes, Qms: d.Qms, Vas: d.Vas_L, Re: d.Re, Le: d.Le_mH, Sd: d.Sd_cm2, Mms: d.Mms_g, Bl: d.Bl, Xmax: d.Xmax_mm, Pe: d.Pe_W, Z: d.nominal_ohms || undefined, Xlim: d.Xlim_mm || d.Xdamage_mm || undefined, XlimK: d.Xlim_mm ? 'Xlim' : d.Xdamage_mm ? 'Xdamage' : undefined, url: d.url, dims: d.dims || undefined,
        size: d.size_in || undefined, prof: peProf(d.sku),
        mag: /neodymium|\bneo\b/i.test(d.pe_title || '') ? 'neo' : /ferrite/i.test(d.pe_title || '') ? 'ferrite' : undefined });
      peCount++;
    }
  } catch (e) { console.warn('pe_drivers.json not readable yet:', e.message); }
}
// Manufacturer-site datasheets (Faital Pro / Eminence models not stocked by Parts Express)
const mfr = path.join(root, 'data', 'mfr_drivers.json');
let mfrCount = 0;
if (fs.existsSync(mfr)) {
  try {
    const seen = new Set(lib.map((d) => d.k));
    const rows = JSON.parse(fs.readFileSync(mfr, 'utf8'));
    const count = {}; rows.forEach((d) => { const n = d.brand + ' ' + d.model; count[n] = (count[n] || 0) + 1; });
    for (const d of rows) {
      if (!d.Fs || !d.Sd_cm2 || !(d.Qes || d.Qts) || !d.Re) continue;
      // impedance versions share a model name: keep each one, labelled with its impedance
      const model = count[d.brand + ' ' + d.model] > 1 && d.nominal_ohms ? `${d.model} ${d.nominal_ohms}Ω` : d.model;
      const k = `MFR:${d.brand} ${model}`;
      if (seen.has(k)) continue; seen.add(k);
      const Qes = d.Qes || (d.Qts && d.Qms ? 1 / (1 / d.Qts - 1 / d.Qms) : undefined);
      lib.push({ k, b: d.brand, m: model + (d.discontinued ? ' (discontinued)' : ''), src: `${d.brand} datasheet`,
        Fs: d.Fs, Qes, Qms: d.Qms, Vas: d.Vas_L, Re: d.Re, Le: d.Le_mH, Sd: d.Sd_cm2, Mms: d.Mms_g, Bl: d.Bl, Xmax: d.Xmax_mm, Pe: d.Pe_W, Z: d.nominal_ohms || undefined, Xlim: d.Xlim_mm || d.Xdamage_mm || undefined, XlimK: d.Xlim_mm ? 'Xlim' : d.Xdamage_mm ? 'Xdamage' : undefined, url: d.url, dims: d.dims || undefined,
        size: d.size_in || undefined, mag: d.mag || undefined,
        prof: d.prof || (d.drawing_file ? profFor('sheets_mfr/' + path.basename(d.drawing_file)) : undefined) });   // d.prof: an outline read off the drawing by hand
      mfrCount++;
    }
  } catch (e) { console.warn('mfr_drivers.json not readable yet:', e.message); }
}
// Datasheet dimensions for drivers whose source has none (data/dims_overrides.json)
try {
  const ov = JSON.parse(fs.readFileSync(path.join(root, 'data', 'dims_overrides.json'), 'utf8'));
  for (const d of lib) if (ov[d.k]) { const o = { ...ov[d.k] }; delete o._source; d.dims = { ...(d.dims || {}), ...o }; }
} catch (e) { }
// Impedance variants of the same driver share one frame: borrow a traced outline from a sibling (same brand, same base
// model, same frame diameter and depth) when an entry has none of its own.
{
  const base = (d) => (d.b || '') + '|' + String(d.m || '').replace(/\s*\(spec sheet\)|\s*\(discontinued\)/g, '').replace(/\s*\d+\s*Ω$/, '').replace(/-(4|8|16)$/, '').trim().toUpperCase();
  const fit = (a, b) => !a.dims || !b.dims || ((!a.dims.outer_dia || !b.dims.outer_dia || Math.abs(a.dims.outer_dia - b.dims.outer_dia) < 3) && (!a.dims.depth_total || !b.dims.depth_total || Math.abs(a.dims.depth_total - b.dims.depth_total) < 4));
  const withProf = new Map(); for (const d of lib) if (d.prof) { const k = base(d); if (!withProf.has(k)) withProf.set(k, []); withProf.get(k).push(d); }
  let shared = 0;
  for (const d of lib) if (!d.prof) { const sib = (withProf.get(base(d)) || []).find((q) => fit(d, q)); if (sib) { d.prof = sib.prof; shared++; } }
  console.log(`outlines shared between impedance variants: ${shared}`);
}
for (const d of lib) for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
let defJs = '';
try { const dd = JSON.parse(fs.readFileSync(path.join(root, 'data', 'default_design.json'), 'utf8')); defJs = 'window.DEFAULT_PROJECT=' + JSON.stringify(dd) + ';'; } catch (e) { console.warn('no default_design.json:', e.message); }
const libJs = 'window.DRIVER_LIB=' + JSON.stringify(lib) + ';' + defJs;

const page = rd('src/template.html')
  .replace('/*LIB*/', () => libJs)
  .replace('/*CORE*/', () => rd('src/core.js'))
  .replace('/*GEOM*/', () => rd('src/geom.js'))
  .replace('/*V3D*/', () => rd('src/view3d.js'))
  .replace('/*APP*/', () => rd('src/app.js'));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'artifact.html'), page);
fs.writeFileSync(path.join(root, 'dist', 'driver_lib.json'), JSON.stringify(lib));   // the same library, for other local tools
const full = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  page.replace(/<div class="app">/, '</head>\n<body>\n<div class="app">') + '\n</body>\n</html>\n';
fs.writeFileSync(path.join(root, 'SliceHornLab.html'), full);
fs.writeFileSync(path.join(root, 'index.html'), full);   // GitHub Pages entry point
console.log(`drawing profiles: ${lib.filter((d) => d.prof).length}`);
console.log(`built: ${lib.length} drivers (${peCount} from Parts Express, ${mfrCount} from manufacturer sites), ${(full.length / 1024).toFixed(0)} KB`);
