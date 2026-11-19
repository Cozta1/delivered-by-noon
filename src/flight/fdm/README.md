<!-- Derived from JSBSim FGTable, FGStandardAtmosphere, FGAccelerations, FGPropagate and aircraft/pc7; LGPL-2.1, JSBSim-Team. -->
# A-29 flight dynamics subset, derived from PC-7

Reference: [JSBSim-Team/jsbsim](https://github.com/JSBSim-Team/jsbsim/tree/3f153c18a2518f8472e37c89e70444b1c671b700). The upstream COPYING is copied verbatim as LICENSE-JSBSim.txt. No FlightGear code is used. This is an educational subset with arcade assistance, not the complete JSBSim engine or a validated A-29 simulation.

## Aircraft data

The source PC-7 is a propeller-powered aerobatic trainer with six aerodynamic axes and a 10.40 m span. Its Aeromatic configuration explicitly describes an educational ALPHA model, not manufacturer-validated data. The source files are aircraft/pc7/pc7.xml, Systems/Conventional Controls.xml and Engines/PT6A.xml. aircraft-pc7.json retains all 13 source aerodynamic tables and 21 scalar derivatives, converted geometry, mass, inertia and engine rating. SI factors: ft=0.3048 m; lb=0.45359237 kg; slug ft^2=1.3558179483314004 kg m^2; hp=745.6998715822702 W; lbf=4.4482216152605 N.

The default aircraft-a29.json reuses those PC-7 polars with the requested 3200 kg empty / 5400 kg maximum mass, 19.4 m^2 area, 11.1 m span and 590 km/h target maximum. Reference chord is area/span; nominal flight mass is 3900 kg (3200 empty + 200 payload + 500 fuel). Estimated inertias multiply the PC-7 values by nominal mass ratio, then squared span ratio for roll, squared length ratio for pitch and the average of these squared ratios for yaw. Length is assumed to be 11.38 m. Static thrust scales with shaft power^(2/3) and propeller diameter^(2/3), using 2.39 m versus 2.2 m. The [manufacturer specifies 1600 shp](https://www.embraer.com/defense-security-air/a-29-super-tucano/en); a [USAF publication lists area, maximum mass and maximum speed](https://www.columbus.af.mil/Portals/39/SW191206.pdf). These are targets, not measured A-29 polars or inertias.

The model uses JSON dimensions directly. ASSISTS.mass=0.9 yields 3510 kg effective mass, with the same separate factor applied to inertia. PC-7 remains usable by switching the import in model.ts; its added runtime trimSpeed=70 and maximumSpeed=140 m/s are simulation settings, while stallSpeed converts the source header's 75.05 knots. No runtime aircraft selector was added.

## Physics and assistance

The simulated body is X forward / Y right / Z down, mapped into PlayCanvas local axes as (Y,-Z,-X); rates (p,q,r) map to quaternion axes (q,-r,-p). Body velocity is integrated independently of the nose. table.ts implements FGTable's clamped linear/bilinear lookup; atmosphere.ts implements ISA layers and geopotential conversion. model.ts uses wind-to-body forces, coefficient moments, diagonal rigid-body inertia equations and normalized quaternion increments at 120 Hz.

The subset assumes a flat nonrotating world and constant mass/inertia. It omits fuel burn, landing gear/flaps/ground effect, alpha-dot derivatives, Reynolds-dependent stall yaw initiation, propwash and engine/propeller RPM dynamics. Forces act at the CG; the source aerodynamic reference offset is retained only as metadata. Propulsion is a density-adjusted power/airspeed estimate capped by estimated static thrust. The throttle curve preserves the 60% spawn setting and increases linearly above it. Smooth additional drag above 90% of the target maximum opposes overspeed. The limited source alpha coverage is extended by a flat-plate post-stall blend.

ASSISTS groups mass, power, drag, maneuver lift, surface authority, rate damping, a 70 ms input response and ceiling protection. Commanded rate assistance scales with dynamic pressure, so there is no synthetic full-strength control at zero airspeed. Fixed trim is calculated for 70 m/s at reset and fades before the 40 m/s stall threshold; it no longer demands +1G continuously. Boosted maneuver CL is included in induced drag (CL^2). The A-29's greater mass and corrected drag make loops slower than the previous PC-7 arcade calibration; loop and roll tests still complete. A downward moment ramps from 2300 to 2500 m before the final safety clamp. There is no artificial minimum airspeed.

## Mouse guidance and collision

The instructor runs only in mouse mode with pointer lock on the application canvas. Without capture, keyboard controls remain direct: CameraRig's unlocked aim follows the nose, and feeding that target back with angle-of-attack compensation would otherwise create continuous pitch drift. With capture, keys mix in at 0.35; keyboard mode always bypasses guidance.

Horizontal guidance commands nose heading and bank; vertical guidance follows the flight path, including angle of attack. The old instruction to place the nose exactly on the horizon produced an unintended climb: the regression measured +41 m in 30 s before the fix. With the A-29, the corrected neutral horizon case stays within 1 m; an aim 2 degrees above the horizon climbs about 21 m in 10 s. Bounded pitch feedforward balances the existing static pitching moment only with adequate airflow and an upright attitude; it does not request a +1G load, use an integral, or activate in stalled/inverted flight. Yaw aiming fades with bank; remaining yaw terms coordinate and damp sideslip. Bank is retained through vertical singularities. Rear targets retain a turn side and wait until upright before pulling.

The controller consumes plane.hitbox when supplied and falls back to the previous 28 local contour samples when absent/empty. Points are transformed by orientation before querying groundAt. Spawn, collision/respawn, world containment and the 250 ms frame cap remain in flight.ts.

## Verification

Run npm.cmd run typecheck, npm.cmd test, npm.cmd run build and npm.cmd run build:editor from the project root. Tests cover interpolation and source data, atmosphere, neutral flight, loop/roll, simultaneous controls, reset, fixed steps, model hitbox/fallback, no-lock and captured keyboard modes, low-speed authority/trim, ceiling moment, horizon drift at cruise and full power, gentle upward aim, turning/settling and inverted/vertical guidance. Flight-path elevation and nose heading are checked separately because angle of attack intentionally separates them. Browser feel and comparison with the full JSBSim remain separate checks.
