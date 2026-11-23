"""Turn the compact Parts Express scrape (one row per product, read in the browser from each product page's
specification table) into the library's driver records, the same shape as data/pe_lavoce.json.
Usage: python tools/pe_hifi_convert.py tools/raw/pe_hifi_compact.json data/pe_hifi.json

Row layout (units already converted in the browser: Vas in litres, sizes in mm, nominal size in inches):
  sku, brand code, model, size_in, ohms, Fs, Re, Le, Qms, Qes, Qts, Vas_L, Sd_cm2, Mms_g, Bl, Xmax_mm, Pe_W,
  SPL_dB, price_usd, outer_dia, cutout_dia, depth_total, bolt_circle, bolt_count, magnet (n/f/''),
  category (s = subwoofer driver, w = woofer), url slug, title
Records without Fs, Re, Sd and a Q are dropped (build.js would skip them anyway)."""
import json
import sys

BRAND = {"D": "Dayton Audio", "G": "GRS", "H": "HiVi", "V": "Visaton", "T": "Tang Band", "M": "Morel", "A": "Aurum Cantus"}


def convert(row):
    (sku, bc, model, size_in, ohms, fs, re_, le, qms, qes, qts, vas, sd, mms, bl, xmax, pe, spl, price,
     od, cut, dep, bolt, holes, mag, cat, slug, title) = row
    brand = BRAND.get(bc, bc)
    warn = []
    title = title or ("%s %s %s\"" % (brand, model, ('%g' % size_in) if size_in else '')).strip()
    if (sd is None or sd < 0.2 * 3.1416 * (size_in * 25.4 / 2 / 10) ** 2) and vas and mms and fs and size_in:
        # no (or an obviously wrong) Sd on the page: Cms from Fs and Mms, then Sd from Vas = rho c^2 Sd^2 Cms
        cms = 1.0 / ((2 * 3.14159265 * fs) ** 2 * (mms / 1000.0))
        sd = round(((vas / 1000.0) / (1.18 * 343.0 ** 2 * cms)) ** 0.5 * 1e4, 1)
        warn.append("Sd not given (or implausible) on the product page; computed from Vas, Fs and Mms")
    if qts is None and qes and qms:
        qts = round(qes * qms / (qes + qms), 3)
        warn.append("Qts computed from Qes and Qms")
    if mag == "n" and "neo" not in (title or "").lower():
        title = (title or "") + " (neodymium)"
    elif mag == "f" and "ferrite" not in (title or "").lower():
        title = (title or "") + " (ferrite)"          # build.js reads the magnet type from the title
    return {
        "brand": brand, "model": model, "sku": sku, "url": "https://www.parts-express.com/" + slug,
        "size_in": size_in, "nominal_ohms": ohms, "Fs": fs, "Re": re_, "Le_mH": le, "Qms": qms, "Qes": qes, "Qts": qts,
        "Vas_L": vas, "Sd_cm2": sd, "Mms_g": mms, "Bl": bl, "Cms_mm_per_N": None, "Xmax_mm": xmax, "Pe_W": pe,
        "SPL_dB": spl, "price_usd": price, "source": "product_page", "pe_title": title,
        "pe_power_label": "RMS" if pe else None, "pe_sensitivity_ref": None, "spec_sheet_url": None,
        "drawing_url": None, "data_warnings": warn,
        "dims": {"outer_dia": od, "cutout_dia": cut, "cutout_dia_rear": None, "bolt_circle": bolt,
                 "bolt_count": int(holes) if holes else None, "bolt_hole_dia": None, "depth_total": dep,
                 "flange_thickness": None, "magnet_dia": None, "magnet_depth": None, "cone_dia_effective": None,
                 "displacement_L": None},
        "dims_source": "product_page",
        "dims_notes": "Parts Express product page mounting information (inches converted to mm)",
        "sheet_checked": False, "pe_category": "subwoofer-drivers" if cat == "s" else "woofers",
    }


def main(src, dst):
    rows = json.load(open(src, encoding="utf8"))
    for r in rows:                                   # a product listed under a buy-out brand: use the maker
        if r[1] == "Factory Buyouts" and str(r[26]).startswith("Tang-Band"):
            r[1] = "T"
    rows.sort(key=lambda r: r[5] is None)            # when a product came twice, keep the read that has data
    out, skipped, seen = [], [], set()
    for row in rows:
        r = convert(row)
        if r["sku"] in seen:
            continue
        seen.add(r["sku"])
        if r["Fs"] and r["Re"] and r["Sd_cm2"] and (r["Qes"] or r["Qts"]):
            out.append(r)
        else:
            skipped.append(r["pe_title"])
    out.sort(key=lambda r: (r["brand"] or "", r["size_in"] or 0, r["model"]))
    json.dump(out, open(dst, "w", encoding="utf8"), indent=1, ensure_ascii=False)
    print("%d drivers written to %s, %d skipped (no full T/S on the page)" % (len(out), dst, len(skipped)))
    for t in skipped:
        print("  skipped:", t)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
