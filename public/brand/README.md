# Rutgers logo files

The Rutgers Visual Identity System requires the Rutgers R at the top of every web page, and says the
mark must never be redrawn or recreated. So this app does not ship a drawing of it. Drop the official
file in here and every screen picks it up.

1. Sign in at https://signaturegenerator.rutgers.edu with your NetID (or ask OIT communications, or
   email contactus@ucm.rutgers.edu) and download the Office of Information Technology horizontal
   unit signature. Use the **RED and BLACK** color version from the **SVG** folder (`*_H_RED_BLACK.svg`).
   It sits on white everywhere in this app.
2. Save it here as `rutgers-logo.svg`. Don't edit the file.
3. If the file says something other than "Rutgers University, Office of Information Technology"
   (for example a plain Rutgers R with no text), change `BRAND_ALT` in `public/common.js` to match it,
   so screen readers say what the logo says.

Until the file is here, pages show "Rutgers University" in plain text where the logo goes.

The app shows the logo 36 px tall (the digital minimum) with clear space of a quarter of its height on
every side, and never on a colored background.
