# Slice Horn Lab

**Draw a subwoofer or horn cabinet in 2-D from flat boards and see how it will sound.** Slice Horn Lab is a browser app for designing folded horns, tapped horns, transmission lines, vented and sealed boxes from ¾" birch or MDF "slices". You draw the side view, set the cabinet width, drop in a driver, and it simulates the result with the same 1-D acoustic model as [Hornresp](https://www.hornresp.net/): frequency response, impedance, excursion, group delay, step response, decay and more.

**▶ Open the app:** https://sppank.github.io/slice-horn-lab/

Nothing to install. It's one self-contained HTML page that runs entirely in your browser, works offline once loaded, and keeps your work in the browser's own storage.

---

## Quick start

1. **Open the app.** It starts with the default project: an 18" tapped horn on a B&C 18DS115.
2. **Change the driver** with the search box at the top (filter by **brand** and **size**), or **Import driver…** to add your own.
3. **Edit the cabinet** on the left. Drag board ends, middles or sides; the SPL curve on the right updates as you go.
4. **Read the result** on the chart tabs (SPL, Impedance, Excursion…), the stats boxes under the chart, and the parts list.
5. **Save it.** **File → Download design (.json)** downloads your project; **File → Open** loads it back. Your current design is also kept automatically in this browser.

To start something new, pick from **Start from — preset —**:

| Preset | What it is |
|---|---|
| **Default project** | The 18" tapped horn variant the app opens with (B&C 18DS115). |
| **18" tapped horn (Speaker Box Maker)** | Traced from Speaker Box Maker's published SketchUp views. |
| **1850 folded horn (Rog Mogale)** | Traced from the published side view. |
| **SKRAM 21" (Josh Ricci)** | Josh Ricci's single-21" sub (B&C 21DS115), from his panel layout and 3-D model. Windowed braces and the three vent dividers are left out; the model's vent tuning comes out at about 32 Hz against the published 29.5 Hz with all vents open. |
| **Skhorn 2×21" (Josh Ricci)** | Josh Ricci's dual-opposed 21" sub (2 × B&C 21DS115), sliced from his 3-D model: the drivers fire into a shared wedge throat that turns out to a horn mouth at each end of the front, and each rear chamber has a 3" slot vent. The model's vent tuning comes out at 28.6 Hz against the published 29 Hz (all vents open). |
| **BC118 (All_1)** | All_1's one-driver half of Tom Danley's BC218 (B&C 18SW115, 1500 × 750 × 750 mm), from the dimensioned side view in his diyAudio thread. The driver fires into a 28 mm compression slot that folds back on itself before expanding to the mouth; the real cab's "half-moon" exit can't be drawn in 2-D, so the mouth is the plain right face. Simulates −3 dB at 27 Hz (his target: 28 Hz). |
| *Starting templates* | Tapped horn (3 legs), front-loaded horn, vented box, sealed box, blank. |

The traced designs are approximations for simulation. Build from each designer's own plans.

---

## Drawing the cabinet

The left side is the cabinet's **side view**. Every line you draw is a board with real thickness (set in **Design → Board thickness**, 18 mm by default). The **internal width** of the cabinet (how deep the "extrusion" is into the screen) is **Design → Internal width**.

### Tools (left toolbar)

| Key | Tool | What it does |
|---|---|---|
| **V** | Select | Drag a board's **end** (joined ends follow; hold **Shift** for that end only), its **middle** to move it, or **between** to slide it sideways. Shift-drag box-selects. **Del** deletes. |
| **P** | Board | Click-drag (or click, click) to draw a board. Snaps to corners, faces and the grid. **X** switches which face you draw on; **Shift** frees the angle. |
| **R** | Box | Drag the outside corners; four boards are placed inside that outline. |
| **A** | Air path | Click through the middle of the channel from the closed end/throat to the mouth, then Enter or double-click. Usually not needed: paths are found automatically. |
| **D** | Driver | Click a board to mount a driver; it faces the side you clicked. **F** flips it. |
| **B** | Divider | A line that seals off a chamber without adding wood. |
| **0** | Fit | Zoom to fit. Wheel zooms; right-drag or Space-drag pans. |
| **?** | Help | Opens the quick how-to panel (also the **?** button at the bottom of the toolbar). It opens by itself on your first visit. |
| **Ctrl Z / Ctrl Shift Z** | Undo / redo | Also the Undo / Redo buttons. |

**Tips**
- **Grid** (top bar): `1"`, `0.1"`, `cm` or `mm`. Everything you draw snaps to it, and lengths are shown in that unit.
- **View**: Left / Right mirrors the drawing.
- **Hover a board**: the middle shows its name (Top, Baffle, Horn wall…), elsewhere its length. Overall height and width dimensions are drawn around the cabinet.
- **Right-click a corner** to choose how the two boards join (auto, miter, square, which board runs through).
- **Right-click a driver** to choose front or rear mounting and flip it. Drag it along its board; it turns red and stays put if it would hit another board.
- **Parts list** (right panel): a slider per board to change its length, with names worked out automatically from what each board does. Select a board and pick its **Role** to override.
- **Air paths** are found automatically from the mouths and vents (Design → *Find air paths automatically*). A path you edit by hand stays as you drew it.

### Quantize the build
**Design → Quantize the build (mm · degrees)** rounds every board end to the nearest mm (or any step) and every board angle to the nearest 5° (or any step), while keeping corners and T-joints joined. Handy before cutting. **Ctrl Z** undoes it. Switch the grid to **mm** afterwards so new edits stay on whole millimetres.

---

## Reading the results

Chart tabs above the graph:

| Tab | Shows |
|---|---|
| **SPL** | Sound pressure at 1 m. Defaults to **1 W**; use the **Power** slider on the left (1 W to 10 kW, log scale) to see it louder. Anywhere the cone goes **past Xmax** the curve turns **red** and is shaded, and the line under the legend lists the ranges and peak excursion. The Power slider stays on the left on every tab; it also scales Excursion and Air velocity (the other tabs don't change with level). |
| **Impedance** | Electrical impedance magnitude and phase. The horn and pipe resonances show as peaks. |
| **Excursion** | Peak cone movement at the Power slider's level, with the Xmax line; past Xmax is red. |
| **Cone load** | Acoustic resistance and reactance on the cone. |
| **Group delay** | How late each frequency arrives (ms). |
| **Step / impulse** | Time response: how cleanly it starts and stops. Long tails mean stored energy. |
| **Decay** | Waterfall (CSD). Long bright streaks are resonances that keep ringing. |
| **Air velocity** | Port/mouth air speed, with a 17 m/s port-noise guide. |
| **Max SPL** | Highest output before hitting the thermal (Pe) or excursion (Xmax) limit. |
| **Flare** | Cross-section area along each air path. |

**Hover** any chart for exact values. **Pin curve** keeps the current curve as a grey overlay so you can compare a change. The range menu picks 20–500 Hz, 20–1k or 20–2k.

The stats boxes give passband level, −3/−6 dB points, the low hump, peak excursion, minimum impedance, max SPL and the air path length and areas.

---

## DSP filters

Under the chart (SPL, Excursion, Group delay, Step, Decay and Air velocity tabs):

- **HPF / LPF**: Butterworth, Linkwitz-Riley or Bessel, 6 to 48 dB/oct.
- **PEQ 1–6**: Peak, Low shelf or High shelf, each with frequency, gain and Q.
- Typing a value turns that filter on. **Up/Down arrow keys** nudge frequency by 1/12 octave, gain by 0.5 dB, Q by 0.1.
- The filters' combined response is drawn in **green** on its own right-hand axis (same dB scale as the SPL axis); untick **curve** to hide it. The dashed line is the unfiltered response.
- **Flat EQ** zeroes the PEQs; **Bypass all** turns every filter off.

The filters feed excursion (so the red over-Xmax marking includes them), group delay and the time-response tabs.

---

## Shaping the response: target and auto-tune

On the SPL tab, the **Target** bar lets you draw the response you want:

1. **From current** puts orange handles on today's curve; **Flat** starts from a flat line.
2. Drag the handles like EQ points. Double-click to add or remove one.
3. **Auto-tune re-design** reshapes the cabinet (board positions and driver location) to follow the target. *keep outside size* locks the outer dimensions; *match level too* matches absolute level, not just shape.

**Design → Move the low hump to (Hz) → Tune** resizes the whole side view until the low-frequency hump lands where you ask, e.g. 35 Hz.

---

## Drivers

The built-in library has about 1,285 drivers: B&C, Eminence, Faital Pro and Lavoce 8–21" pro woofers (from Parts Express listings and manufacturer data sheets), plus your WinISD library if you build it yourself. About 175 have real outlines traced from their technical drawings, so the basket you see is the actual shape; the rest are drawn from their stated frame, cutout and depth.

**Import driver…** (next to Brand) adds your own from:
- a **Hornresp** driver or record file (including the advanced semi-inductance and frequency-dependent damping parameters),
- a **WinISD** `.wdr` file,
- a **spec sheet** PDF or pasted text (the T/S parameters are read out for you to check).

You review every value before saving. Imported drivers appear under **Brand → User** and stay in this browser.

**Driver panel**: select a driver to see and edit its T/S parameters, the number of drivers and wiring, and the **Advanced driver model (Hornresp)** section (semi-inductance voice coil and frequency-dependent damping). Editing makes a copy of the driver inside your design, so the library stays untouched.

---

## Design settings

Right panel → **Design**: name, internal width, board thickness, material (Baltic birch / MDF), radiation space (4π, 2π floor, 1π floor + wall, ½π corner), vent leakage QL, wall friction losses, automatic air paths and the hump tuner.

## Saving and exporting (File menu)

- **Download design (.json)** / **Open .json / import .wdr…**: your project file.
- **Copy design JSON** / **Load pasted design**: move a design by copy and paste.
- **Download side profile (.dxf)**: the cabinet outline for CAD or CNC.
- **Cut list**: every board grouped by role, with length, thickness and edge bevel angles.
- **Download response (.csv)**: the simulated curves.
- **Hornresp cross-check numbers**: the equivalent Hornresp input values, so you can check a design in Hornresp itself.

Designs live in your browser's storage. Clearing site data, or using a different browser or computer, starts from the default project. Use **Download design** to keep a copy.

---

## How the simulation works

- The air path is sampled every 8 mm to measure its cross-section. That becomes a chain of exact acoustic **two-port segments** (cylinders, cones, exponentials), with **lumped chambers** for closed volumes.
- The driver is a full electro-mechanical model (Thiele–Small, with optional semi-inductance and frequency-dependent damping) between its front and rear air nodes.
- Mouths and ports radiate as baffled pistons into the chosen space, and SPL is the radiated power response, as in Hornresp.
- Constants: c = 344 m/s, ρ = 1.205 kg/m³; vent leakage QL = 7.
- **Checked against Hornresp exports:** a front-loaded horn matches to 0.000 dB; a vented box matches to about 0.05 dB RMS.

**Limits.** It's a 1-D (plane-wave) model like Hornresp. It doesn't model the cabinet in 3-D, panel flex, port compression or driver non-linearity. Above Xmax the real driver compresses while the model keeps going, so treat red over-excursion as "not really reachable". Bends and very wide flares are approximations.

---

## Running and building it yourself

```bash
git clone https://github.com/SpPank/slice-horn-lab.git
cd slice-horn-lab
node serve.js            # then open http://localhost:8765
```

Or just open `index.html` in a browser.

The app is built from `src/` into one file:

```bash
node build.js            # writes index.html and SliceHornLab.html
node test/dsp_test.js    # filter maths
node test/semi_test.js   # advanced driver model
node test/geomtest.js    # geometry engine
```

`test/validate.js` compares against Hornresp exports and needs them in `C:/Hornresp/Export`.

| Path | What's in it |
|---|---|
| `src/core.js` | Acoustic solver: two-ports, radiation, driver models, DSP filters |
| `src/geom.js` | Geometry engine: boards, joints, cross-sections, chambers, auto air paths |
| `src/app.js` | Editor, charts, import, DSP and target UI |
| `src/template.html` | Page markup and styles |
| `data/*.json` | Driver library, traced driver outlines, default project |
| `tools/extract_profiles.py` | Traces driver outlines from vector technical drawings |

The default project is `data/default_design.json`. Replace its `design` with any downloaded design file and rebuild to change what new visitors start with.

---

## Credits and data

- **SKRAM** and **Skhorn** are designed by Josh Ricci (ZOD Audio); the SKRAM plans were shared by [TinkerandParty](https://tinkerandparty.com/) and the Skhorn plans are hosted by [JW Sound](https://www.jwsound.live/designs/riccis-skhorn-subwoofer), both with his permission. Please credit Josh if you use it commercially. **18" tapped horn** design by Speaker Box Maker; **1850 folded horn** by Rog Mogale. **BC118** by All_1 on diyAudio ([thread](https://www.diyaudio.com/community/threads/boundary-control-bc-subwoofer-bc218-2-design.413237/)), after Tom Danley's BC218.
- Acoustic model after David McBean's **Hornresp**; this is an independent re-implementation, not affiliated with it.
- Advanced driver model after Thorborg & Futtrup, *JAES* 2011.
- Driver data from Parts Express product listings and B&C, Eminence, Faital Pro and Lavoce data sheets. Check critical numbers against the current manufacturer data sheet.
