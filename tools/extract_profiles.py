"""Extract each driver's side-view silhouette from its vector technical drawing.

For every drawing PDF:
  1. find the front view: the largest round outline (a vector path, or failing that a round blob of outline strokes);
     its diameter against the known frame diameter gives the drawing scale (both views share it);
  2. find the side view: the other big view, below or to the right, on the same axis;
  3. redraw only the strokes drawn at the outline line-weight (dimension / extension lines are thinner), keep the
     driver's drawing pieces (the biggest one plus pieces close to it, inside the frame radius);
  4. read the outer envelope: the radius at every 0.25 mm of depth from the flange face back.
  5. check against the drawing's own stated diameter and depth; profiles that do not match are flagged.

Output: data/profiles.json  {file: {ok, rmax, depth, flange, profile: [[z_mm, r_mm], ...], notes}}
Usage:  python tools/extract_profiles.py [--preview N]
"""
import json, os, sys, glob, warnings
from collections import Counter
warnings.filterwarnings('ignore')
import numpy as np
import pymupdf
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
PX_PER_MM = 6.0


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    a, b = np.array(pts[0], float), np.array(pts[-1], float)
    ab = b - a; L = float(np.hypot(*ab)) or 1.0
    d = [abs(ab[0] * (a[1] - p[1]) - (a[0] - p[0]) * ab[1]) / L for p in pts[1:-1]]
    i = int(np.argmax(d)) + 1
    if d[i - 1] <= eps:
        return [pts[0], pts[-1]]
    return rdp(pts[:i + 1], eps)[:-1] + rdp(pts[i:], eps)


def visible_paths(page):
    m = page.rotation_matrix
    out = []
    for d in page.get_drawings():
        r = d['rect'] * m
        out.append({'d': d, 'r': pymupdf.Rect(r.x0 - 1, r.y0 - 1, r.x1 + 1, r.y1 + 1), 'n': len(d['items']),
                    'w': d.get('width') or 0, 'stroked': d.get('color') is not None})
    return out


def outline_weight(ps):
    """The line weight used for most of the drawing (body outlines), by item count."""
    c = Counter()
    for p in ps:
        if p['stroked'] and p['w'] > 0:
            c[round(p['w'], 2)] += p['n']
    return c.most_common(1)[0][0] if c else 0.5


def draw_strokes(page, ps, region, zoom, wmin, lw):
    m = page.rotation_matrix
    canvas = Image.new('L', (max(1, int(region.width * zoom)), max(1, int(region.height * zoom))), 0)
    dw = ImageDraw.Draw(canvas)
    def P(pt):
        q = pt * m
        return ((q.x - region.x0) * zoom, (q.y - region.y0) * zoom)
    for p in ps:
        if not p['stroked'] or p['w'] < wmin or not region.intersects(p['r']):
            continue
        for it in p['d']['items']:
            k = it[0]
            if k == 'l':
                dw.line([P(it[1]), P(it[2])], fill=255, width=lw)
            elif k == 'c':
                p0, c1, c2, p3 = it[1], it[2], it[3], it[4]
                pts = []
                for t in np.linspace(0.0, 1.0, 12):
                    t = float(t)
                    x = (1 - t) ** 3 * p0.x + 3 * (1 - t) ** 2 * t * c1.x + 3 * (1 - t) * t * t * c2.x + t ** 3 * p3.x
                    y = (1 - t) ** 3 * p0.y + 3 * (1 - t) ** 2 * t * c1.y + 3 * (1 - t) * t * t * c2.y + t ** 3 * p3.y
                    pts.append(P(pymupdf.Point(x, y)))
                dw.line(pts, fill=255, width=lw)
            elif k == 're':
                q = it[1]; dw.line([P(q.tl), P(q.tr), P(q.br), P(q.bl), P(q.tl)], fill=255, width=lw)
            elif k == 'qu':
                q = it[1]; dw.line([P(q.ul), P(q.ur), P(q.lr), P(q.ll), P(q.ul)], fill=255, width=lw)
    return canvas


def components(img, maxn=250):
    lab = img.copy(); arr = np.array(lab); comps = []; v = 1
    while v < maxn:
        ys, xs = np.nonzero(arr == 255)
        if not len(ys):
            break
        ImageDraw.floodfill(lab, (int(xs[0]), int(ys[0])), v)
        arr = np.array(lab)
        yy, xx = np.nonzero(arr == v)
        comps.append({'v': v, 'n': len(yy), 'bb': (int(xx.min()), int(yy.min()), int(xx.max()), int(yy.max()))})
        v += 1
    return arr, comps


def front_view(page, ps, wmain):
    for w in [wmain] + [w for w, _ in Counter(round(p['w'], 2) for p in ps if p['stroked'] and p['w'] > 0).most_common(4) if w != wmain]:
        r, wc = _front_view(page, ps, w)
        if r is not None:
            return r, wc
    return None, None


def _front_view(page, ps, wmain):
    # 1) a single round vector path
    best = None
    for p in ps:
        r = p['r']; w, h = r.width - 2, r.height - 2
        if w < 60 or h < 60 or abs(w - h) / max(w, h) > 0.03 or p['n'] < 12:
            continue
        if best is None or w > best[0].width - 2:
            best = (r, p['w'])
    if best:
        r, w = best
        return pymupdf.Rect(r.x0 + 1, r.y0 + 1, r.x1 - 1, r.y1 - 1), w
    # 2) the biggest round blob of outline-weight strokes on the page
    pr = page.rect
    img = draw_strokes(page, ps, pr, 1.0, 0.75 * wmain, 1).filter(ImageFilter.MaxFilter(5))
    arr, comps = components(img)
    cands = [c for c in comps if (c['bb'][2] - c['bb'][0]) > 60 and abs((c['bb'][2] - c['bb'][0]) - (c['bb'][3] - c['bb'][1])) / max(1, (c['bb'][2] - c['bb'][0])) < 0.06]
    if not cands:
        return None, None
    c = max(cands, key=lambda c: c['bb'][2] - c['bb'][0])
    x0, y0, x1, y1 = c['bb']
    return pymupdf.Rect(pr.x0 + x0 + 2, pr.y0 + y0 + 2, pr.x0 + x1 - 2, pr.y0 + y1 - 2), wmain


def profile_from(page, ps, circ, wline, outer_dia, gap_mm, depth_clip=None):
    D = circ.width
    cx, cy = (circ.x0 + circ.x1) / 2, (circ.y0 + circ.y1) / 2
    pr = page.rect
    right = pymupdf.Rect(circ.x1 + 0.02 * D, cy - 0.62 * D, min(pr.x1, circ.x1 + 1.3 * D), cy + 0.62 * D)
    below = pymupdf.Rect(cx - 0.62 * D, circ.y1 + 0.02 * D, cx + 0.62 * D, min(pr.y1, circ.y1 + 1.3 * D))
    cnt = lambda reg: sum(p['n'] for p in ps if reg.contains(pymupdf.Point((p['r'].x0 + p['r'].x1) / 2, (p['r'].y0 + p['r'].y1) / 2)))
    nr, nb = cnt(right), cnt(below)
    if max(nr, nb) < 40:
        return None, 'side view not found'
    horiz = nr >= nb
    region = right if horiz else below
    zoom = PX_PER_MM * outer_dia / D
    canvas = draw_strokes(page, ps, region, zoom, 0.75 * wline, max(2, int(round(0.5 * PX_PER_MM))))
    if np.array(canvas).max() == 0:
        return None, 'no outline strokes in side view'
    arr, comps = components(canvas.filter(ImageFilter.MaxFilter(7)))
    if not comps:
        return None, 'side view not found'
    main = max(comps, key=lambda c: c['n'])
    axis = ((cy - region.y0) if horiz else (cx - region.x0)) * zoom
    Rpx = 1.06 * outer_dia / 2 * PX_PER_MM
    gap = gap_mm * PX_PER_MM
    keep = {main['v']}; bb = list(main['bb'])
    for _ in range(4):
        for c in comps:
            if c['v'] in keep:
                continue
            x0, y0, x1, y1 = c['bb']
            lo, hi = (y0, y1) if horiz else (x0, x1)
            if lo < axis - Rpx or hi > axis + Rpx:
                continue
            if x0 > bb[2] + gap or x1 < bb[0] - gap or y0 > bb[3] + gap or y1 < bb[1] - gap:
                continue
            keep.add(c['v']); bb = [min(bb[0], x0), min(bb[1], y0), max(bb[2], x1), max(bb[3], y1)]
    body = np.isin(arr, list(keep))
    if horiz:
        idx = np.nonzero(body.any(axis=0))[0]
        half = lambda i: (lambda ys: max(abs(ys.min() - axis), abs(ys.max() + 1 - axis)) if len(ys) else 0)(np.nonzero(body[:, i])[0])
    else:
        idx = np.nonzero(body.any(axis=1))[0]
        half = lambda i: (lambda xs: max(abs(xs.min() - axis), abs(xs.max() + 1 - axis)) if len(xs) else 0)(np.nonzero(body[i, :])[0])
    r = np.clip((np.array([half(i) for i in range(idx.min(), idx.max() + 1)], float) - 3) / PX_PER_MM, 0, None)
    if len(r) > 8:
        r = r[3:-3]
    e = max(3, len(r) // 25)
    if r[-e:].max() > r[:e].max():      # the flange (widest end) is the front
        r = r[::-1]
    z = np.arange(len(r)) / PX_PER_MM
    if depth_clip:
        keepz = z <= depth_clip
        z, r = z[keepz], r[keepz]
    rmax, depth = float(r.max()), float(z[-1] + 1 / PX_PER_MM)
    fl = float(z[np.argmax(r < 0.95 * rmax)]) if (r < 0.95 * rmax).any() else 0.0
    pts = [[round(float(zz), 1), round(float(rr), 1)] for zz, rr in zip(z, r)]
    pts = [[0.0, pts[0][1]]] + pts + [[round(depth, 1), 0.0]]
    return {'rmax': round(rmax, 1), 'depth': round(depth, 1), 'flange': round(fl, 1), 'layout': 'side-right' if horiz else 'side-below',
            'profile': rdp(pts, 0.35), 'body': body}, None


def fit_to_dims(res, dims):
    """Fit the traced outline to the sheet's numbers: flange diameter (radial scale), overall depth (axial scale),
    flange thickness (where the flange step sits), magnet diameter (checked). Returns (profile, fit-notes, consistent)."""
    prof = [list(p) for p in res['profile']]
    notes, ok = [], True
    od, dep, flt, mag = dims.get('outer_dia'), dims.get('depth_total'), dims.get('flange_thickness'), dims.get('magnet_dia')
    sr = (od / 2) / res['rmax'] if od and res['rmax'] else 1.0
    sz = dep / res['depth'] if dep and res['depth'] else sr
    if abs(sr - sz) > 0.08 * max(sr, sz):
        ok = False; notes.append(f'radial scale {sr:.3f} and depth scale {sz:.3f} disagree')
    if abs(sr - 1) > 0.10 or abs(sz - 1) > 0.10:
        ok = False; notes.append(f'scale off by more than 10 % (radial {sr:.3f}, depth {sz:.3f})')
    fl_meas = res['flange'] * sz
    def zmap(z):
        z = z * sz
        if flt and 0.4 * flt < fl_meas < 2.2 * flt:    # put the flange step exactly where the sheet says
            Dm = (res['depth'] * sz)
            return z * flt / fl_meas if z <= fl_meas else flt + (z - fl_meas) * (Dm - flt) / max(1e-6, Dm - fl_meas)
        return z
    prof = [[round(zmap(z), 2), round(r * sr, 2)] for z, r in prof]
    if mag:
        back = [r for z, r in prof if z > 0.6 * prof[-1][0] and r > 0]
        if back:
            rb = max(back)
            if abs(rb - mag / 2) / (mag / 2) > 0.25:
                notes.append(f'magnet radius {rb:.0f} vs stated {mag / 2:.0f}')
            else:
                notes.append(f'magnet radius {rb:.0f} (stated {mag / 2:.0f})')
    notes.append(f'fitted: radial x{sr:.3f}, depth x{sz:.3f}' + (f', flange {flt:g} mm' if flt else ''))
    return prof, notes, ok


def judge(res, outer_dia, depth_hint):
    notes = []
    ok = abs(res['rmax'] - outer_dia / 2) / (outer_dia / 2) < 0.05
    if not ok:
        notes.append(f"radius {res['rmax']:.0f} vs stated {outer_dia / 2:.0f}")
    if depth_hint:
        if abs(res['depth'] - depth_hint) / depth_hint > 0.08:
            ok = False; notes.append(f"depth {res['depth']:.0f} vs stated {depth_hint:.0f}")
    return ok, notes


def extract(pdf, outer_dia, depth_hint=None, preview=None, dims=None):
    doc = pymupdf.open(pdf)
    last = {'ok': False, 'notes': ['no front view found']}
    for pno in range(len(doc)):
        page = doc[pno]
        ps = visible_paths(page)
        wmain = outline_weight(ps)
        circ, wcirc = front_view(page, ps, wmain)
        if circ is None or circ.width < 60:
            continue
        wline = wcirc or wmain
        tries = []
        for gap in (6, 14):
            res, err = profile_from(page, ps, circ, wline, outer_dia, gap)
            if err:
                last = {'ok': False, 'notes': [err]}; continue
            ok, notes = judge(res, outer_dia, depth_hint)
            tries.append((ok, res, notes))
            if ok:
                break
            # too long against the drawing's own depth: extra lines behind the motor -> clip at the stated depth
            if depth_hint and res['depth'] > 1.08 * depth_hint:
                res2, err2 = profile_from(page, ps, circ, wline, outer_dia, gap, depth_clip=depth_hint * 1.01)
                if not err2:
                    ok2, notes2 = judge(res2, outer_dia, depth_hint)
                    if ok2:
                        tries.append((True, res2, ['clipped at the drawing\'s stated depth'])); break
        if not tries:
            continue
        ok, res, notes = next((t for t in tries if t[0]), tries[-1])
        if preview:
            Image.fromarray((res['body'] * 255).astype(np.uint8)).save(preview)
        res = {k: v for k, v in res.items() if k != 'body'}
        if ok:
            prof, fnotes, consistent = fit_to_dims(res, dims or {'outer_dia': outer_dia, 'depth_total': depth_hint})
            res['profile_traced'] = res['profile']; res['profile'] = prof; notes = notes + fnotes
            ok = consistent
        res.update({'ok': ok, 'page': pno, 'notes': notes, 'outline_weight': wline})
        return res
    return last


def jobs():
    out = []
    pe = json.load(open(os.path.join(DATA, 'pe_drivers.json'), encoding='utf8'))
    for d in pe:
        dims = d.get('dims') or {}
        if not dims.get('outer_dia') or not d.get('sku'):
            continue
        cands = sorted(glob.glob(os.path.join(DATA, 'sheets', d['sku'] + '-*draw*.pdf')) + glob.glob(os.path.join(DATA, 'sheets', d['sku'] + '-*draw*.PDF')))
        if cands:
            out.append((os.path.relpath(cands[0], DATA), dims['outer_dia'], dims.get('depth_total'), dims))
    lv = os.path.join(DATA, 'pe_lavoce.json')   # Lavoce: no separate drawing, the dimension drawing is on the spec sheet
    if os.path.exists(lv):
        for d in json.load(open(lv, encoding='utf8')):
            dims = d.get('dims') or {}
            if d.get('source') != 'product_page' or not dims.get('outer_dia'):
                continue
            c = sorted(glob.glob(os.path.join(DATA, 'sheets', d['sku'] + '-*spec-sheet.pdf')))
            if c:
                out.append((os.path.relpath(c[0], DATA), dims['outer_dia'], dims.get('depth_total'), dims))
    mf = os.path.join(DATA, 'mfr_drivers.json')
    if os.path.exists(mf):
        for d in json.load(open(mf, encoding='utf8')):
            dims = d.get('dims') or {}
            f = d.get('drawing_file')
            if f and dims.get('outer_dia'):
                f = os.path.join(DATA, 'sheets_mfr', os.path.basename(f))
                if os.path.exists(f):
                    out.append((os.path.relpath(f, DATA), dims['outer_dia'], dims.get('depth_total'), dims))
    return out


def main():
    prev_n = int(sys.argv[sys.argv.index('--preview') + 1]) if '--preview' in sys.argv else 0
    only = sys.argv[sys.argv.index('--only') + 1].lower() if '--only' in sys.argv else None
    out, seen = {}, set()
    if only and os.path.exists(os.path.join(DATA, 'profiles.json')):
        out = json.load(open(os.path.join(DATA, 'profiles.json')))   # keep everything else, redo only the matching files
    for i, (rel, od, dep, dims) in enumerate(jobs()):
        if only and only not in rel.lower():
            continue
        key = rel.replace('\\', '/')
        if key in seen:
            continue
        seen.add(key)
        prev = os.path.join(DATA, 'profile_previews', os.path.basename(rel).rsplit('.', 1)[0] + '.png') if i < prev_n else None
        if prev:
            os.makedirs(os.path.dirname(prev), exist_ok=True)
        try:
            out[key] = extract(os.path.join(DATA, rel), od, dep, prev, dims)
        except Exception as e:
            out[key] = {'ok': False, 'notes': [f'error: {e}']}
        r = out[key]
        print(f"{'OK ' if r.get('ok') else 'BAD'} {os.path.basename(rel)[:48]:48s} r={r.get('rmax')} d={r.get('depth')} fl={r.get('flange')} {r.get('layout', '')} pts={len(r.get('profile', []))} {'; '.join(r.get('notes', []))}", flush=True)
    json.dump(out, open(os.path.join(DATA, 'profiles.json'), 'w'), indent=0)
    good = sum(1 for v in out.values() if v.get('ok'))
    print(f'\n{good} of {len(out)} drawings gave a checked profile')


if __name__ == '__main__':
    main()
